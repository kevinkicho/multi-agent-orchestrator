import type { Orchestrator } from "./orchestrator"
import type { DashboardLog } from "./dashboard"
import {
  loadBrainMemory,
  addMemoryEntry,
  addProjectNote,
  formatMemoryForPrompt,
} from "./brain-memory"
import { extractLastAssistantText, formatRecentMessages } from "./message-utils"

export type BrainConfig = {
  /** Ollama API base URL */
  ollamaUrl: string
  /** Model to use for the orchestrator brain */
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

export async function chatCompletion(
  ollamaUrl: string,
  model: string,
  messages: Message[],
): Promise<string> {
  const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 4096,
    }),
  })

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${await response.text()}`)
  }

  let data: any
  try {
    data = await response.json()
  } catch {
    throw new Error(`Ollama returned invalid JSON (status ${response.status})`)
  }
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    throw new Error(`Ollama returned unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return content
}

/** Trim conversation to stay within model context limits. */
function trimConversation(messages: Message[], maxMessages = 40): void {
  if (messages.length <= maxMessages) return
  const keep = maxMessages - 2
  const trimmed = messages.splice(1, messages.length - 1 - keep)
  const roundsTrimmed = Math.floor(trimmed.length / 2)
  messages.splice(1, 0, {
    role: "user",
    content: `[Context trimmed: ${roundsTrimmed} earlier rounds removed to stay within context limits. Recent conversation follows.]`,
  })
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
  let memory = loadBrainMemory()
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

  config.onThinking?.(
    memoryContext
      ? "Brain started with memory from previous sessions. Thinking about initial plan..."
      : "Brain started. Thinking about initial plan...",
  )

  for (let round = 0; round < maxRounds; round++) {
    // Get LLM decision
    trimConversation(messages)

    let response: string
    try {
      response = await chatCompletion(config.ollamaUrl, config.model, messages)
    } catch (err) {
      config.onThinking?.(`LLM request failed (round ${round + 1}): ${err}`)
      // Wait and retry once
      await new Promise(r => setTimeout(r, 5000))
      try {
        response = await chatCompletion(config.ollamaUrl, config.model, messages)
      } catch (retryErr) {
        config.onThinking?.(`LLM retry failed — stopping brain: ${retryErr}`)
        break
      }
    }

    if (!response) {
      messages.push({
        role: "user",
        content: "Your previous response was empty. Please issue commands in a ```commands code block.",
      })
      continue
    }

    messages.push({ role: "assistant", content: response })

    config.onThinking?.(`\n--- Brain (round ${round + 1}) ---\n${response}\n`)

    // Parse and execute commands
    const commands = parseCommands(response)
    if (commands.length === 0) {
      // LLM didn't issue commands — nudge it
      messages.push({
        role: "user",
        content: "Please issue commands in a ```commands code block. What would you like to do next?",
      })
      continue
    }

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
          summary: (commands.find((c) => c.type === "done") as any)?.summary ?? "Objective completed.",
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
