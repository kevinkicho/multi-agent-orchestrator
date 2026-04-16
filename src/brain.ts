import type { Orchestrator } from "./orchestrator"
import type { DashboardLog } from "./dashboard"
import {
  loadBrainMemory,
  addMemoryEntry,
  addProjectNote,
  formatMemoryForPrompt,
} from "./brain-memory"
import { extractLastAssistantText, formatRecentMessages, trimConversation } from "./message-utils"
import { recordPrompt } from "./prompt-ledger"
import { llmCall, parseModelRef, type LLMResponse } from "./providers"
import {
  type NudgeState, type CircuitBreakerState,
  createNudgeState, resetNudge, createCircuitBreaker,
  recordFailure, recordSuccess,
  buildEmptyNudge, buildNoParseNudge, fuzzyExtractCommands,
  BRAIN_COMMANDS, BRAIN_DEFAULT_CMD,
} from "./command-recovery"

export type BrainConfig = {
  /** Ollama API base URL (legacy — used when model has no provider prefix) */
  ollamaUrl: string
  /** Model to use for the orchestrator brain. Can be "provider:model" or just "model" (defaults to ollama) */
  model: string
  /** The high-level objective the orchestrator should pursue */
  objective: string
  /** Max rounds before stopping (safety limit). Default: 50 */
  maxRounds?: number
  /** Callback for brain's thinking/decisions */
  onThinking?: (thought: string) => void
  /** Dashboard log for emitting prompt events */
  dashboardLog?: DashboardLog
}

type Message = {
  role: "system" | "user" | "assistant"
  content: string
}

const SYSTEM_PROMPT = `You are an orchestrator agent managing multiple AI coding agents. Each agent works on a separate software project.

You can issue these commands (one per line, in a \`\`\`commands code block):

  PROMPT <agent-name> <message>     — Send a task or follow-up to an agent
  PROMPT_ALL <message>              — Send the same message to all agents
  STATUS                            — Check status of all agents
  MESSAGES <agent-name>             — Read recent messages from an agent
  WAIT                              — Wait for busy agents to finish before deciding
  NOTE <agent-name> <text>          — Save a persistent note about a project/agent
  DONE <summary>                    — You've completed the objective (include a brief summary of what was accomplished)

Rules:
- You can issue multiple commands in one response.
- After issuing commands, you'll receive the results and can decide next steps.
- When agents are busy (WAIT), you'll be notified when they finish with their responses.
- Review agent responses carefully before sending follow-ups.
- If an agent's work has issues, send corrections.
- When all agents have completed their tasks satisfactorily, issue DONE with a summary.
- Think step by step about what each agent should do.
- Be specific in your prompts to agents — include file paths, requirements, and acceptance criteria.
- Use NOTE to save important discoveries about projects for future sessions.
- You may be given context from previous sessions — use it to avoid repeating work.
`

// ---------------------------------------------------------------------------
// Model warmup — preload weights to avoid cold-start latency
// ---------------------------------------------------------------------------

const warmedModels = new Set<string>()

/** Warm up an Ollama model by sending a minimal request to preload weights.
 *  No-op if model was already warmed this session or if it's a cloud provider. */
export async function warmupModel(ollamaUrl: string, model: string): Promise<void> {
  const ref = parseModelRef(model)
  if (ref.provider !== "ollama") return // only Ollama needs warmup
  if (warmedModels.has(ref.model)) return

  try {
    // Use the /api/generate endpoint with a tiny prompt — this loads the model into memory
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ref.model,
        prompt: "hi",
        stream: false,
        options: { num_predict: 1 }, // generate exactly 1 token
      }),
      signal: AbortSignal.timeout(60_000), // 60s timeout for model loading
    })
    if (res.ok) {
      warmedModels.add(ref.model)
    }
  } catch {
    // Warmup failure is non-fatal — first real call will just be slower
  }
}

/** Check if a model has been warmed up this session */
export function isModelWarmed(model: string): boolean {
  const ref = parseModelRef(model)
  return warmedModels.has(ref.model)
}

// Cache model context sizes to avoid repeated API calls
const modelInfoCache = new Map<string, { contextSize: number; fetchedAt: number }>()

/** Fetch model info from Ollama to get context size */
async function getModelContextSize(ollamaUrl: string, model: string): Promise<number> {
  const cached = modelInfoCache.get(model)
  if (cached && Date.now() - cached.fetchedAt < 300_000) return cached.contextSize // 5 min cache

  try {
    const res = await fetch(`${ollamaUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(10_000), // 10s timeout for model info
    })
    if (res.ok) {
      const data = await res.json() as { model_info?: Record<string, unknown> }
      // Ollama prefixes context_length with the model architecture (e.g. "qwen2.context_length", "llama.context_length")
      // Scan all model_info keys for one ending in ".context_length" or "context_length" exactly
      let ctx = 0
      const mi = data.model_info
      if (mi && typeof mi === "object") {
        for (const key of Object.keys(mi)) {
          if (key === "context_length" || key.endsWith(".context_length")) {
            const val = mi[key]
            if (typeof val === "number" && val > 0) { ctx = val; break }
          }
        }
      }
      if (ctx > 0) {
        modelInfoCache.set(model, { contextSize: ctx, fetchedAt: Date.now() })
        return ctx
      }
    }
  } catch {}
  return 0 // unknown
}

export type TokenUsage = { promptTokens?: number; completionTokens?: number; totalTokens?: number }

/**
 * Strip reasoning/think tags that some models (e.g. glm-5.1) leak into output.
 * Removes the tags and any content wrapped inside <think>...</think> blocks.
 */
function stripThinkTags(text: string): string {
  // First remove <think>...</think> blocks (reasoning content)
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "")
  // Then strip any orphaned opening/closing tags
  cleaned = cleaned.replace(/<\/?think>/gi, "")
  return cleaned.trim()
}

export async function chatCompletion(
  ollamaUrl: string,
  model: string,
  messages: Message[],
  opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
): Promise<string> {
  const result = await chatCompletionWithUsage(ollamaUrl, model, messages, opts)
  return stripThinkTags(result.content)
}

/** Like chatCompletion but also returns token usage stats */
export async function chatCompletionWithUsage(
  ollamaUrl: string,
  model: string,
  messages: Message[],
  opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
): Promise<{ content: string; usage?: TokenUsage }> {
  const ref = parseModelRef(model)

  // For Ollama provider, try dynamic context size detection
  if (ref.provider === "ollama") {
    const contextSize = await getModelContextSize(ollamaUrl, ref.model)
    const maxTokens = opts?.maxTokens ?? (contextSize > 0 ? Math.min(Math.floor(contextSize / 4), 16384) : 16384)

    try {
      const result = await llmCall({
        provider: ref.provider,
        model: ref.model,
        messages,
        temperature: opts?.temperature,
        maxTokens,
        jsonMode: opts?.jsonMode,
      })
      return { content: result.content, usage: result.usage }
    } catch (err) {
      // Fallback: direct Ollama call if provider system fails (e.g., first run before providers.json exists)
      const content = await directOllamaCall(ollamaUrl, ref.model, messages, opts?.temperature ?? 0.3, maxTokens, opts?.jsonMode)
      return { content }
    }
  }

  // Cloud provider — route through provider system
  const result = await llmCall({
    provider: ref.provider,
    model: ref.model,
    messages,
    temperature: opts?.temperature,
    maxTokens: opts?.maxTokens,
    jsonMode: opts?.jsonMode,
  })
  return { content: result.content, usage: result.usage }
}

/** Direct Ollama call — fallback when provider system is unavailable */
async function directOllamaCall(
  ollamaUrl: string,
  model: string,
  messages: Message[],
  temperature: number,
  maxTokens: number,
  jsonMode?: boolean,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 300_000)

  const body: Record<string, unknown> = { model, messages, temperature, max_tokens: maxTokens }
  if (jsonMode) body.format = "json"

  let response: Response
  try {
    response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (controller.signal.aborted) {
      throw new Error(`Ollama request timed out after 5 minutes`)
    }
    throw err
  }
  clearTimeout(timeout)

  if (!response.ok) {
    const body = await response.text()
    const err = new Error(`Ollama API error: ${response.status} ${body}`) as Error & { statusCode?: number }
    err.statusCode = response.status
    throw err
  }

  type OllamaChatResponse = { choices?: Array<{ message?: { content?: string } }> }
  const data = await response.json() as OllamaChatResponse
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    throw new Error(`Ollama returned unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return content
}


type ParsedCommand =
  | { type: "prompt"; agent: string; message: string }
  | { type: "prompt_all"; message: string }
  | { type: "status" }
  | { type: "messages"; agent: string }
  | { type: "wait" }
  | { type: "note"; agent: string; text: string }
  | { type: "done"; summary: string }

function parseCommands(response: string): ParsedCommand[] {
  const commands: ParsedCommand[] = []

  // Extract commands from code blocks
  const codeBlockMatch = response.match(/```commands?\n([\s\S]*?)```/)
  const lines = codeBlockMatch
    ? codeBlockMatch[1]!.split("\n")
    : response.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("PROMPT_ALL ")) {
      commands.push({ type: "prompt_all", message: trimmed.slice(11) })
    } else if (trimmed.startsWith("PROMPT ")) {
      const rest = trimmed.slice(7)
      const spaceIdx = rest.indexOf(" ")
      if (spaceIdx !== -1) {
        commands.push({
          type: "prompt",
          agent: rest.slice(0, spaceIdx),
          message: rest.slice(spaceIdx + 1),
        })
      }
    } else if (trimmed === "STATUS") {
      commands.push({ type: "status" })
    } else if (trimmed.startsWith("MESSAGES ")) {
      commands.push({ type: "messages", agent: trimmed.slice(9).trim() })
    } else if (trimmed.startsWith("NOTE ")) {
      const rest = trimmed.slice(5)
      const spaceIdx = rest.indexOf(" ")
      if (spaceIdx !== -1) {
        commands.push({
          type: "note",
          agent: rest.slice(0, spaceIdx),
          text: rest.slice(spaceIdx + 1),
        })
      }
    } else if (trimmed === "WAIT") {
      commands.push({ type: "wait" })
    } else if (trimmed.startsWith("DONE")) {
      commands.push({ type: "done", summary: trimmed.slice(4).trim() || "Objective completed." })
    }
  }

  return commands
}

function formatAgentInfo(orchestrator: Orchestrator): string {
  const lines: string[] = ["Available agents:"]
  for (const [name, agent] of orchestrator.agents) {
    lines.push(`  - ${name}: project at ${agent.config.directory} [${agent.status}]`)
  }
  return lines.join("\n")
}

export async function runBrain(
  orchestrator: Orchestrator,
  config: BrainConfig,
): Promise<void> {
  const maxRounds = config.maxRounds ?? 50
  let memory = await loadBrainMemory()
  const memoryContext = formatMemoryForPrompt(memory)

  const initialContent = [
    formatAgentInfo(orchestrator),
    memoryContext ? `\n## Memory from Previous Sessions\n${memoryContext}` : "",
    `\nObjective: ${config.objective}`,
  ]
    .filter(Boolean)
    .join("\n")

  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: initialContent },
  ]

  // Warm up the model before first call
  warmupModel(config.ollamaUrl, config.model).catch(() => {})

  config.onThinking?.(
    memoryContext
      ? "Brain started with memory from previous sessions. Thinking about initial plan..."
      : "Brain started. Thinking about initial plan...",
  )

  let consecutiveLlmFailures = 0
  const nudge = createNudgeState()
  const circuitBreaker = createCircuitBreaker(5) // stop brain after 5 consecutive parse failures

  for (let round = 0; round < maxRounds; round++) {
    // Get LLM decision
    trimConversation(messages)

    let response: string
    // Ledger: record brain outbound prompt
    const lastMsg = messages[messages.length - 1]
    if (lastMsg) {
      recordPrompt({
        source: "brain", target: "llm", direction: "outbound",
        model: config.model, content: lastMsg.content,
      }).catch(() => {})
    }
    try {
      response = await chatCompletion(config.ollamaUrl, config.model, messages)
      consecutiveLlmFailures = 0
      // Ledger: record brain inbound response
      recordPrompt({
        source: "brain", target: "brain", direction: "inbound",
        model: config.model, content: response,
      }).catch(() => {})
    } catch (err) {
      consecutiveLlmFailures++
      const retryDelay = Math.min(5000 * Math.pow(2, consecutiveLlmFailures - 1), 60_000)
      config.onThinking?.(`LLM request failed (round ${round + 1}, failure #${consecutiveLlmFailures}): ${err}`)
      config.onThinking?.(`Retrying in ${retryDelay / 1000}s...`)
      await new Promise(r => setTimeout(r, retryDelay))
      try {
        response = await chatCompletion(config.ollamaUrl, config.model, messages)
        consecutiveLlmFailures = 0
      } catch (retryErr) {
        config.onThinking?.(`LLM retry failed (failure #${consecutiveLlmFailures}): ${retryErr}`)
        if (consecutiveLlmFailures >= 3) {
          // Escalating backoff like supervisor: pause before next round
          const pauseMs = Math.min(30_000 * consecutiveLlmFailures, 300_000)
          config.onThinking?.(`Ollama persistently unreachable (${consecutiveLlmFailures} failures) — pausing ${pauseMs / 1000}s`)
          await new Promise(r => setTimeout(r, pauseMs))
        }
        if (consecutiveLlmFailures >= 5) {
          config.onThinking?.(`Circuit breaker: ${consecutiveLlmFailures} consecutive LLM failures — stopping brain`)
          break
        }
        continue // try again next round instead of hard-stopping
      }
    }

    if (!response) {
      config.onThinking?.(`Brain empty response (round ${round + 1}), nudge level ${nudge.consecutiveEmpty + 1}`)
      messages.push({
        role: "user",
        content: buildEmptyNudge(nudge, BRAIN_COMMANDS, BRAIN_DEFAULT_CMD),
      })
      if (recordFailure(circuitBreaker)) {
        config.onThinking?.(`Circuit breaker: ${circuitBreaker.consecutiveFailures} consecutive empty/unparseable responses — stopping brain`)
        break
      }
      continue
    }

    messages.push({ role: "assistant", content: response })

    config.onThinking?.(`\n--- Brain (round ${round + 1}) ---\n${response}\n`)

    // Parse and execute commands
    let commands = parseCommands(response)

    // Fuzzy recovery: try extracting commands from prose
    if (commands.length === 0) {
      const fuzzyLines = fuzzyExtractCommands(response, BRAIN_COMMANDS)
      if (fuzzyLines.length > 0) {
        const wrapped = "```commands\n" + fuzzyLines.join("\n") + "\n```"
        commands = parseCommands(wrapped)
        if (commands.length > 0) {
          config.onThinking?.(`Recovered ${commands.length} command(s) from prose`)
        }
      }
    }

    if (commands.length === 0) {
      config.onThinking?.(`Brain no-parse (round ${round + 1}), nudge level ${nudge.consecutiveNoParse + 1}`)
      messages.push({
        role: "user",
        content: buildNoParseNudge(nudge, response, BRAIN_COMMANDS, BRAIN_DEFAULT_CMD),
      })
      if (recordFailure(circuitBreaker)) {
        config.onThinking?.(`Circuit breaker: ${circuitBreaker.consecutiveFailures} consecutive unparseable responses — stopping brain`)
        break
      }
      continue
    }

    // Successful parse — reset escalation
    resetNudge(nudge)
    recordSuccess(circuitBreaker)

    const results: string[] = []
    let shouldWait = false
    let isDone = false

    // Record message counts before sending prompts so we can detect new responses
    const messageCountsBefore = new Map<string, number>()
    for (const [name] of orchestrator.agents) {
      try {
        const msgs = await orchestrator.getMessages(name)
        messageCountsBefore.set(name, msgs.length)
      } catch {
        messageCountsBefore.set(name, 0)
      }
    }

    for (const cmd of commands) {
      switch (cmd.type) {
        case "prompt": {
          try {
            config.dashboardLog?.push({ type: "agent-prompt", agent: cmd.agent, text: cmd.message })
            await orchestrator.prompt(cmd.agent, cmd.message)
            results.push(`Sent to ${cmd.agent}: "${cmd.message.slice(0, 100)}..."`)
            recordPrompt({
              source: "brain", target: cmd.agent, direction: "outbound",
              agentName: cmd.agent, model: config.model,
              content: cmd.message,
            }).catch(() => {})
          } catch (err) {
            results.push(`Error sending to ${cmd.agent}: ${err}`)
          }
          break
        }
        case "prompt_all": {
          const names = Array.from(orchestrator.agents.keys())
          for (const n of names) {
            config.dashboardLog?.push({ type: "agent-prompt", agent: n, text: cmd.message })
          }
          await orchestrator.promptAll(names.map((n) => ({ agentName: n, text: cmd.message })))
          results.push(`Sent to all agents: "${cmd.message.slice(0, 100)}..."`)
          break
        }
        case "status": {
          const statuses = await orchestrator.status()
          const lines: string[] = []
          for (const [name, s] of statuses) {
            lines.push(`  ${name}: ${s.status} (session: ${s.sessionID ?? "none"})`)
          }
          results.push("Agent status:\n" + lines.join("\n"))
          break
        }
        case "messages": {
          try {
            const msgs = await orchestrator.getMessages(cmd.agent)
            const formatted = formatRecentMessages(msgs, 3, 1000)
            results.push(`Messages from ${cmd.agent}:\n${formatted.join("\n\n")}`)
          } catch (err) {
            results.push(`Error reading messages from ${cmd.agent}: ${err}`)
          }
          break
        }
        case "note": {
          memory = await addProjectNote(memory, cmd.agent, cmd.text)
          results.push(`Saved note for ${cmd.agent}: "${cmd.text}"`)
          config.onThinking?.(`Brain: noted for ${cmd.agent} — ${cmd.text}`)
          break
        }
        case "wait": {
          shouldWait = true
          break
        }
        case "done": {
          isDone = true
          // Save session summary to memory
          const agentLearnings: Record<string, string[]> = {}
          for (const [name] of orchestrator.agents) {
            agentLearnings[name] = memory.projectNotes[name]?.slice(-3) ?? []
          }
          memory = await addMemoryEntry(memory, {
            timestamp: Date.now(),
            objective: config.objective,
            summary: cmd.summary,
            agentLearnings,
          })
          config.onThinking?.(`Brain: saved session summary — "${cmd.summary}"`)
          break
        }
      }
    }

    if (isDone) {
      // Emit summary to each agent's dashboard panel
      for (const [name] of orchestrator.agents) {
        config.dashboardLog?.push({
          type: "cycle-summary",
          cycle: 0,
          agent: name,
          summary: (commands.find((c): c is Extract<ParsedCommand, { type: "done" }> => c.type === "done"))?.summary ?? "Objective completed.",
        })
      }
      config.onThinking?.("Brain: objective complete.")
      return
    }

    // Wait for busy agents to finish
    if (shouldWait) {
      config.onThinking?.("Brain: waiting for agents to finish...")
      await waitForAgents(orchestrator)

      // Collect only NEW responses (after prompts were sent)
      const responses: string[] = []
      for (const [name] of orchestrator.agents) {
        try {
          const msgs = await orchestrator.getMessages(name)
          const beforeCount = messageCountsBefore.get(name) ?? 0
          const newMsgs = msgs.slice(beforeCount)
          const text = extractLastAssistantText(newMsgs)
          if (text) {
            responses.push(`${name} response:\n${text.slice(0, 2000)}`)
          }
        } catch {}
      }
      if (responses.length > 0) {
        results.push("Agent responses after waiting:\n\n" + responses.join("\n\n---\n\n"))
      }
    }

    // Feed results back to the LLM
    if (results.length > 0) {
      messages.push({ role: "user", content: results.join("\n\n") })
    }
  }

  // Save partial progress even if we hit max rounds
  await addMemoryEntry(memory, {
    timestamp: Date.now(),
    objective: config.objective,
    summary: `Reached max rounds (${maxRounds}) without completing. Partial progress made.`,
    agentLearnings: {},
  })
  config.onThinking?.(`Brain: reached max rounds (${maxRounds}). Stopping. Progress saved to memory.`)
}

// --- Helpers ---

async function waitForAgents(orchestrator: Orchestrator, timeoutMs = 300_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const statuses = await orchestrator.status()
    const allIdle = Array.from(statuses.values()).every((s) => s.status !== "busy")
    if (allIdle) return
    await new Promise((r) => setTimeout(r, 2000))
  }
}
