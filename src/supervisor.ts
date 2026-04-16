import type { Orchestrator } from "./orchestrator"
import type { DashboardLog } from "./dashboard"
import { chatCompletion } from "./brain"
import {
  loadBrainMemory,
  addMemoryEntry,
  addProjectNote,
  addBehavioralNote,
  formatMemoryForPrompt,
} from "./brain-memory"
import { extractLastAssistantText, formatRecentMessages } from "./message-utils"
import { logPerformance } from "./performance-log"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Message = { role: "system" | "user" | "assistant"; content: string }

export type ProjectRole = {
  /** The primary coding agent for this project */
  coder: string
  /** Optional dedicated reviewer agent (Phase 3). Falls back to self-review. */
  reviewer?: string
}

export type AgentSupervisorConfig = {
  ollamaUrl: string
  model: string
  /** Agent name this supervisor manages */
  agentName: string
  /** Project directory (for context in prompts) */
  directory: string
  /** High-level directive */
  directive: string
  /** Seconds between cycles. Default: 30 */
  cyclePauseSeconds?: number
  /** Max LLM rounds per cycle. Default: 30 */
  maxRoundsPerCycle?: number
  /** Enable the REVIEW command. Default: true */
  reviewEnabled?: boolean
  /** Optional separate reviewer agent name (Phase 3) */
  reviewerAgent?: string
  /** Callbacks */
  onThinking?: (thought: string) => void
  dashboardLog?: DashboardLog
  /** Abort signal for hard stop */
  signal?: AbortSignal
  /** Mutable soft-stop flag */
  softStop?: { requested: boolean }
  /** Callback when supervisor updates the directive */
  onDirectiveUpdate?: (newDirective: string) => void
  /** Callback when supervisor stops with a failure (for escalation) */
  onSupervisorStop?: (agentName: string, summary: string, isFailure: boolean) => void
  /** Callback to get unread user comments on the directive */
  getUnreadComments?: () => string[]
}

export type ParallelSupervisorsConfig = {
  ollamaUrl: string
  model: string
  directive: string
  cyclePauseSeconds?: number
  maxRoundsPerCycle?: number
  reviewEnabled?: boolean
  /** Optional project role mapping: { agentName: { coder, reviewer? } } */
  projects?: Record<string, ProjectRole>
  onThinking?: (agentName: string, thought: string) => void
  dashboardLog?: DashboardLog
  signal?: AbortSignal
  softStop?: { requested: boolean }
}

// ---------------------------------------------------------------------------
// System prompt — focused on a single agent/project
// ---------------------------------------------------------------------------

function buildSupervisorPrompt(agentName: string, directory: string, reviewEnabled: boolean, hasReviewer: boolean, behavioralNotes: string[]): string {
  const reviewCmd = reviewEnabled
    ? `  REVIEW                    — ${hasReviewer ? "Send work to the dedicated reviewer agent" : "Ask your agent to critically self-review its recent changes"}\n`
    : ""

  const behavioralSection = behavioralNotes.length > 0
    ? `\n## IMPORTANT — Agent Behavioral Notes (from previous cycles)\n${behavioralNotes.map(n => `- ${n}`).join("\n")}\nApply these lessons when interacting with your agent.\n`
    : ""

  return `You are a dedicated supervisor for a single AI coding agent working on a software project.

Agent: ${agentName}
Project: ${directory}
${behavioralSection}
You can issue these commands (one per line, in a \`\`\`commands code block):

  PROMPT <message>          — Send a task, question, or feedback to your agent
  WAIT                      — Wait for your agent to finish its current work
  MESSAGES                  — Read your agent's recent conversation
${reviewCmd}  RESTART                   — Restart the agent's session (use when agent is stuck, unresponsive, or in a bad state)
  ABORT                     — Cancel whatever the agent is currently doing
  NOTE <text>               — Save a persistent note about this project
  NOTE_BEHAVIOR <text>      — Save a behavioral note about how this agent works best (injected into future system prompts)
  DIRECTIVE <text>          — Update the project directive (evolves as project progresses)
  CYCLE_DONE <summary>      — End this supervision cycle (a new one starts after a pause)
  STOP <summary>            — Permanently stop supervising this agent

Each cycle you should:
1. Check MESSAGES to see your agent's recent work
2. Review their output thoroughly — look for bugs, missing edge cases, incomplete features
3. Give specific, actionable feedback with file paths and code references
4. Assign new tasks when the agent is idle
${reviewEnabled ? "5. Use REVIEW after significant changes to catch issues the agent may have missed\n" : ""}6. Save NOTEs about important project state for future cycles
7. Issue CYCLE_DONE with a summary when you've reviewed everything and the agent has direction

IMPORTANT — if the agent appears stuck (busy for a long time with no output, or not executing commands):
- First try ABORT to cancel its current work
- If still unresponsive after a new PROMPT, use RESTART to get a fresh session
- Save a NOTE_BEHAVIOR about what caused the agent to get stuck so future cycles avoid it
- Do NOT issue 5+ prompts to a stuck agent — escalate with RESTART after 2-3 failed attempts

IMPORTANT — CYCLE_DONE and STOP summaries must be specific and actionable:
- BAD: "Cycle completed." / "Done." / "ANALYZING AND START FIXING"
- GOOD: "Fixed SSRF vulnerability in ai-brief route. Agent now working on P1 test failures. 63/297 tests passing."
- Include: what was accomplished, what's in progress, what's next

Guidelines:
- Be a thorough code reviewer — your agent is capable but benefits from oversight
- Give specific feedback: file paths, function names, line numbers, code snippets
- Don't micromanage — describe WHAT needs to happen, let the agent decide HOW
- If the agent is stuck or producing poor results, try ABORT then rephrase the task
- If the agent is completely unresponsive, use RESTART — don't keep prompting a dead agent
- Prioritize: bugs > missing features > code quality > polish
- Track project progress with NOTEs so you remember across cycles
- Use NOTE_BEHAVIOR for agent-specific lessons (e.g., "keep prompts to one action at a time")
- Use DIRECTIVE to update the project direction as phases complete
- You manage ONLY this one agent — focus all your attention on this project
`
}

// ---------------------------------------------------------------------------
// Command parsing — simplified (no agent names needed)
// ---------------------------------------------------------------------------

type SupervisorCommand =
  | { type: "prompt"; message: string }
  | { type: "wait" }
  | { type: "messages" }
  | { type: "review" }
  | { type: "restart" }
  | { type: "abort" }
  | { type: "note"; text: string }
  | { type: "note_behavior"; text: string }
  | { type: "directive"; text: string }
  | { type: "cycle_done"; summary: string }
  | { type: "stop"; summary: string }

function parseSupervisorCommands(response: string): SupervisorCommand[] {
  const commands: SupervisorCommand[] = []

  const codeBlockMatch = response.match(/```commands?\n([\s\S]*?)```/)
  const lines = codeBlockMatch
    ? codeBlockMatch[1]!.split("\n")
    : response.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("PROMPT ")) {
      commands.push({ type: "prompt", message: trimmed.slice(7) })
    } else if (trimmed === "WAIT") {
      commands.push({ type: "wait" })
    } else if (trimmed === "MESSAGES") {
      commands.push({ type: "messages" })
    } else if (trimmed === "REVIEW") {
      commands.push({ type: "review" })
    } else if (trimmed === "RESTART") {
      commands.push({ type: "restart" })
    } else if (trimmed === "ABORT") {
      commands.push({ type: "abort" })
    } else if (trimmed.startsWith("NOTE_BEHAVIOR ")) {
      commands.push({ type: "note_behavior", text: trimmed.slice(14) })
    } else if (trimmed.startsWith("NOTE ")) {
      commands.push({ type: "note", text: trimmed.slice(5) })
    } else if (trimmed.startsWith("DIRECTIVE ")) {
      commands.push({ type: "directive", text: trimmed.slice(10) })
    } else if (trimmed.startsWith("CYCLE_DONE")) {
      commands.push({ type: "cycle_done", summary: trimmed.slice(10).trim() || "Cycle completed." })
    } else if (trimmed.startsWith("STOP")) {
      commands.push({ type: "stop", summary: trimmed.slice(4).trim() || "Supervisor stopped." })
    }
  }

  return commands
}

// ---------------------------------------------------------------------------
// Conversation management
// ---------------------------------------------------------------------------

/** Trim conversation to stay within model context limits.
 *  Keeps the system prompt (index 0) and the most recent messages.
 *  Inserts a summary marker so the LLM knows context was trimmed. */
function trimConversation(messages: Message[], maxMessages = 60): void {
  if (messages.length <= maxMessages) return
  // Keep system prompt + last (maxMessages - 2) messages + a summary marker
  const keep = maxMessages - 2
  const trimmed = messages.splice(1, messages.length - 1 - keep)
  const roundsTrimmed = Math.floor(trimmed.length / 2)
  messages.splice(1, 0, {
    role: "user",
    content: `[Context trimmed: ${roundsTrimmed} earlier rounds removed to stay within context limits. Recent conversation follows.]`,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for a single agent to finish (not all agents) */
async function waitForAgent(orchestrator: Orchestrator, agentName: string, timeoutMs = 300_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const statuses = await orchestrator.status()
    const s = statuses.get(agentName)
    if (!s || s.status !== "busy") return
    await new Promise(r => setTimeout(r, 2000))
  }
}


const REVIEW_PROMPT = `Review your most recent changes critically. Examine the code you just wrote or modified:

1. **Correctness**: Are there bugs, logic errors, or incorrect assumptions?
2. **Edge cases**: What inputs or scenarios might break the code?
3. **Error handling**: Are errors caught and handled appropriately?
4. **Security**: Are there injection, XSS, or data exposure risks?
5. **Tests**: Are the changes adequately tested? If not, what tests are missing?
6. **Performance**: Are there obvious inefficiencies?

Be specific — include file paths, line numbers, and code snippets for every issue you find.
Do not be polite or vague. If everything genuinely looks good, say so and explain why.`

// ---------------------------------------------------------------------------
// Per-agent supervisor loop (Phase 1 + Phase 2)
// ---------------------------------------------------------------------------

export async function runAgentSupervisor(
  orchestrator: Orchestrator,
  config: AgentSupervisorConfig,
): Promise<void> {
  const {
    agentName,
    directory,
    ollamaUrl,
    model,
    reviewEnabled = true,
    reviewerAgent,
  } = config
  let directive = config.directive
  const baseCyclePause = (config.cyclePauseSeconds ?? 30) * 1000
  let cyclePause = baseCyclePause
  const maxRoundsPerCycle = config.maxRoundsPerCycle ?? 30
  const hasReviewer = !!reviewerAgent
  let cycleCount = 0
  let consecutiveEmptyResponses = 0
  let consecutiveIdleCycles = 0 // tracks cycles where agent was idle/no work done

  const emit = (text: string) => {
    config.onThinking?.(text)
    config.dashboardLog?.push({ type: "supervisor-thinking", agent: agentName, text })
  }

  const emitStatus = (status: "running" | "idle" | "done" | "reviewing") => {
    config.dashboardLog?.push({ type: "supervisor-status", agent: agentName, status })
  }

  emit(`Supervisor started for ${agentName}. Directive: "${directive}"`)
  emitStatus("running")
  logPerformance({ timestamp: Date.now(), projectName: directory, agentName, model, event: "supervisor_start" })

  while (!config.signal?.aborted) {
    cycleCount++
    const cycleStartTime = Date.now()
    emit(`\n===== ${agentName} — CYCLE ${cycleCount} =====\n`)

    let memory = loadBrainMemory()
    const memoryContext = formatMemoryForPrompt(memory)

    // Extract behavioral notes for this agent to inject into system prompt
    const behavioralNotes = (memory.behavioralNotes?.[agentName] ?? []).slice(-10)

    // Get agent status
    const statuses = await orchestrator.status()
    const agentStatus = statuses.get(agentName)
    const statusLine = agentStatus
      ? `Agent status: ${agentStatus.status} (session: ${agentStatus.sessionID ?? "none"})`
      : "Agent status: unknown"

    // On first cycle, add resume context so the supervisor orients the agent
    const projectNotes = memory.projectNotes[agentName] ?? []
    const isResume = cycleCount === 1 && (projectNotes.length > 0 || memory.entries.length > 0)
    const resumeBlock = isResume
      ? `\n## RESUMING FROM PREVIOUS SESSION\nThis project was previously worked on. Before assigning new tasks:\n1. Use MESSAGES to check the agent's current state\n2. Review project notes below for context on what was done\n3. Ask the agent to run \`git status\` and \`git log --oneline -5\` to understand current state\n4. Orient the agent on where to pick up — don't repeat completed work\n${projectNotes.length > 0 ? `\nLatest project notes:\n${projectNotes.slice(-5).map(n => `- ${n}`).join("\n")}` : ""}`
      : ""

    // Check for unread user comments on the directive
    const unreadComments = config.getUnreadComments?.() ?? []
    const commentBlock = unreadComments.length > 0
      ? `\n## User Feedback on Directive\nThe human user has left comments for you to review:\n${unreadComments.map(c => `> "${c}"`).join("\n")}\nPlease acknowledge this feedback and adjust your approach accordingly.`
      : ""

    const initialContent = [
      statusLine,
      memoryContext ? `\n## Memory from Previous Cycles\n${memoryContext}` : "",
      resumeBlock,
      commentBlock,
      `\nDirective: ${directive}`,
      isResume
        ? `\nThis is supervision cycle #${cycleCount} (resuming). Check the agent's current state before assigning work.`
        : `\nThis is supervision cycle #${cycleCount}. Check in with your agent, review their work, and keep them productive.`,
    ].filter(Boolean).join("\n")

    const systemPrompt = buildSupervisorPrompt(agentName, directory, reviewEnabled, hasReviewer, behavioralNotes)
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: initialContent },
    ]

    let cycleDone = false
    let stopped = false

    for (let round = 0; round < maxRoundsPerCycle && !cycleDone && !stopped; round++) {
      if (config.signal?.aborted) break

      trimConversation(messages)

      let response: string
      try {
        response = await chatCompletion(ollamaUrl, model, messages)
      } catch (err) {
        emit(`LLM request failed (round ${round + 1}): ${err}`)
        // Wait and retry once
        await new Promise(r => setTimeout(r, 5000))
        try {
          response = await chatCompletion(ollamaUrl, model, messages)
        } catch (retryErr) {
          emit(`LLM retry failed — skipping to next cycle: ${retryErr}`)
          logPerformance({
            timestamp: Date.now(), projectName: directory, agentName, model,
            event: "cycle_error", cycleNumber: cycleCount, details: String(retryErr),
          })
          break
        }
      }

      if (!response) {
        emit(`LLM returned empty response (round ${round + 1}), nudging...`)
        messages.push({ role: "user", content: "Your previous response was empty. Please issue commands." })
        continue
      }

      messages.push({ role: "assistant", content: response })

      emit(`--- ${agentName} cycle ${cycleCount}, round ${round + 1} ---\n${response}\n`)

      const commands = parseSupervisorCommands(response)
      if (commands.length === 0) {
        messages.push({
          role: "user",
          content: "Please issue commands in a ```commands code block. Check MESSAGES and review your agent's work.",
        })
        continue
      }

      const results: string[] = []
      let shouldWait = false

      // Record message count before prompts so we can detect new responses
      let messageCountBefore = 0
      try {
        const msgs = await orchestrator.getMessages(agentName)
        messageCountBefore = msgs.length
      } catch { /* ignore */ }

      for (const cmd of commands) {
        switch (cmd.type) {
          case "prompt": {
            try {
              config.dashboardLog?.push({ type: "agent-prompt", agent: agentName, text: cmd.message })
              await orchestrator.prompt(agentName, cmd.message)
              results.push(`Sent to ${agentName}: "${cmd.message.slice(0, 120)}..."`)
            } catch (err) {
              results.push(`Error sending to ${agentName}: ${err}`)
            }
            break
          }

          case "wait": {
            shouldWait = true
            break
          }

          case "messages": {
            try {
              const msgs = await orchestrator.getMessages(agentName)
              const formatted = formatRecentMessages(msgs, 6, 3000)
              results.push(`Recent messages from ${agentName}:\n${formatted.join("\n\n")}`)
            } catch (err) {
              results.push(`Error reading messages: ${err}`)
            }
            break
          }

          case "review": {
            if (!reviewEnabled) {
              results.push("REVIEW command is disabled.")
              break
            }

            emitStatus("reviewing")
            const targetAgent = reviewerAgent ?? agentName

            if (reviewerAgent) {
              // Phase 3: Dedicated reviewer agent — tell it to inspect the project
              const reviewerPrompt = `You are a code reviewer. Review the recent changes in this project.
Run \`git diff\` to see what changed, read the modified files, and check for:
- Bugs, logic errors, incorrect assumptions
- Missing error handling and edge cases
- Security vulnerabilities
- Missing or inadequate tests
- Performance issues

Be specific with file paths, line numbers, and code snippets.`
              emit(`Sending review to dedicated reviewer: ${reviewerAgent}`)
              config.dashboardLog?.push({ type: "agent-prompt", agent: reviewerAgent, text: "[REVIEW] " + reviewerPrompt })
              try {
                await orchestrator.prompt(reviewerAgent, reviewerPrompt)
              } catch (err) {
                results.push(`Error sending review to ${reviewerAgent}: ${err}`)
                emitStatus("running")
                break
              }
            } else {
              // Phase 2: Self-review — same agent reviews its own work
              emit(`Requesting self-review from ${agentName}...`)
              config.dashboardLog?.push({ type: "agent-prompt", agent: agentName, text: "[REVIEW] " + REVIEW_PROMPT })
              try {
                await orchestrator.prompt(agentName, REVIEW_PROMPT)
              } catch (err) {
                results.push(`Error requesting review: ${err}`)
                emitStatus("running")
                break
              }
            }

            // Wait for review to complete
            await waitForAgent(orchestrator, targetAgent)

            // Get review response
            const reviewMsgs = await orchestrator.getMessages(targetAgent)
            const reviewText = extractLastAssistantText(reviewMsgs)
            if (reviewText) {
              const truncated = reviewText.slice(0, 5000)
              results.push(`Review results from ${targetAgent}:\n${truncated}`)
              config.dashboardLog?.push({ type: "agent-response", agent: targetAgent, text: reviewText })
            } else {
              results.push("Review produced no output.")
            }
            emitStatus("running")
            break
          }

          case "restart": {
            emit(`Restarting ${agentName} session...`)
            try {
              const newSession = await orchestrator.restartAgent(agentName)
              results.push(`Agent ${agentName} restarted successfully. New session: ${newSession}`)
              emit(`Agent restarted. New session: ${newSession}`)
              logPerformance({
                timestamp: Date.now(), projectName: directory, agentName, model,
                event: "restart", cycleNumber: cycleCount,
              })
            } catch (err) {
              results.push(`Error restarting ${agentName}: ${err}`)
            }
            break
          }

          case "abort": {
            emit(`Aborting ${agentName} current work...`)
            try {
              await orchestrator.abortAgent(agentName)
              results.push(`Agent ${agentName} aborted. It is now idle.`)
            } catch (err) {
              results.push(`Error aborting ${agentName}: ${err}`)
            }
            break
          }

          case "note": {
            memory = await addProjectNote(memory, agentName, cmd.text)
            results.push(`Saved note: "${cmd.text}"`)
            emit(`Note saved: ${cmd.text}`)
            break
          }

          case "note_behavior": {
            memory = await addBehavioralNote(memory, agentName, cmd.text)
            results.push(`Saved behavioral note: "${cmd.text}" — this will be injected into future system prompts.`)
            emit(`Behavioral note saved: ${cmd.text}`)
            break
          }

          case "directive": {
            directive = cmd.text
            config.onDirectiveUpdate?.(cmd.text)
            results.push(`Directive updated to: "${cmd.text.slice(0, 150)}..."`)
            emit(`Directive updated: ${cmd.text}`)
            break
          }

          case "cycle_done": {
            // Summary validation — reject garbage summaries
            if (cmd.summary.length < 20 || /^(cycle|done|completed|analyzing|working|start)/i.test(cmd.summary.trim())) {
              results.push(`Your CYCLE_DONE summary is too vague: "${cmd.summary}". Please provide a specific summary: what was accomplished, what's in progress, what's next.`)
              // Don't end the cycle — ask for a better summary
              break
            }
            cycleDone = true
            await addMemoryEntry(memory, {
              timestamp: Date.now(),
              objective: `${agentName} cycle ${cycleCount}: ${directive}`,
              summary: cmd.summary,
              agentLearnings: {},
            })
            emit(`Cycle ${cycleCount} complete: ${cmd.summary}`)
            config.dashboardLog?.push({
              type: "cycle-summary",
              cycle: cycleCount,
              agent: agentName,
              summary: cmd.summary,
            })
            logPerformance({
              timestamp: Date.now(), projectName: directory, agentName, model,
              event: "cycle_complete", cycleNumber: cycleCount,
              durationMs: Date.now() - cycleStartTime, summary: cmd.summary,
            })
            break
          }

          case "stop": {
            // Summary validation for STOP too
            if (cmd.summary.length < 20) {
              results.push(`Your STOP summary is too vague. Please explain why you are stopping and what needs to happen next.`)
              break
            }
            stopped = true
            // Detect if this is a failure stop (mentions non-responsive, stuck, failure, cannot, etc.)
            const isFailure = /non-responsive|stuck|fail|cannot|unable|broken|crash|unresponsive|dead/i.test(cmd.summary)
            await addMemoryEntry(memory, {
              timestamp: Date.now(),
              objective: `${agentName} supervisor: ${directive}`,
              summary: cmd.summary,
              agentLearnings: {},
            })
            emit(`Supervisor stopping: ${cmd.summary}`)
            config.dashboardLog?.push({
              type: "cycle-summary",
              cycle: cycleCount,
              agent: agentName,
              summary: `[FINAL] ${cmd.summary}`,
            })
            // Escalate to project manager
            config.onSupervisorStop?.(agentName, cmd.summary, isFailure)
            logPerformance({
              timestamp: Date.now(), projectName: directory, agentName, model,
              event: "supervisor_stop", cycleNumber: cycleCount,
              summary: cmd.summary, details: isFailure ? "failure" : "normal",
            })
            if (isFailure) {
              config.dashboardLog?.push({
                type: "supervisor-alert",
                agent: agentName,
                text: `SUPERVISOR STOPPED (failure): ${cmd.summary}`,
              } as any)
            }
            break
          }
        }
      }

      if (cycleDone || stopped) break

      // Wait for agent to finish, then collect response
      if (shouldWait) {
        emit(`Waiting for ${agentName} to finish...`)
        await waitForAgent(orchestrator, agentName)

        // Collect new response (only messages added after our prompt)
        try {
          const msgs = await orchestrator.getMessages(agentName)
          const newMsgs = msgs.slice(messageCountBefore)
          const lastText = extractLastAssistantText(newMsgs)
          if (lastText) {
            consecutiveEmptyResponses = 0
            results.push(`${agentName} response:\n${lastText.slice(0, 5000)}`)
            config.dashboardLog?.push({ type: "agent-response", agent: agentName, text: lastText })
          } else {
            // Agent responded with empty content — track and escalate
            consecutiveEmptyResponses++
            emit(`WARNING: ${agentName} returned empty response (${consecutiveEmptyResponses} consecutive)`)

            if (consecutiveEmptyResponses >= 3) {
              // After 3 empties, restart the agent session
              const emptyCount = consecutiveEmptyResponses
              emit(`Agent ${agentName} has returned ${emptyCount} consecutive empty responses — restarting session...`)
              try {
                const newSession = await orchestrator.restartAgent(agentName)
                consecutiveEmptyResponses = 0
                results.push(`Agent was non-responsive (${emptyCount} empty responses). Session restarted: ${newSession}. Re-send your last task.`)
                logPerformance({
                  timestamp: Date.now(), projectName: directory, agentName, model,
                  event: "restart", cycleNumber: cycleCount, details: "empty-response escalation",
                })
                await addBehavioralNote(memory, agentName, `Agent went non-responsive with empty outputs. Had to restart session. Consider simpler, single-action prompts.`)
              } catch (err) {
                results.push(`Agent non-responsive and restart failed: ${err}`)
              }
            } else if (consecutiveEmptyResponses >= 2) {
              // After 2 empties, abort and retry
              emit(`Aborting ${agentName} and retrying...`)
              try {
                await orchestrator.abortAgent(agentName)
                results.push(`Agent returned empty. Aborted current work. Try rephrasing with a simpler, single-step command.`)
              } catch (err) {
                results.push(`Agent returned empty. Abort failed: ${err}`)
              }
            } else {
              results.push(`Agent returned an empty response. This may indicate the agent is struggling with the task. Try breaking it into smaller steps or rephrasing.`)
            }
          }
        } catch { /* ignore */ }
      }

      // Feed results back to LLM
      if (results.length > 0) {
        messages.push({ role: "user", content: results.join("\n\n") })
      }
    }

    if (stopped || config.signal?.aborted) break

    // Dynamic cycle pause — adjust based on agent activity
    if (consecutiveEmptyResponses > 0) {
      // Agent struggling — back off to give it more time
      consecutiveIdleCycles++
      cyclePause = Math.min(baseCyclePause * Math.min(consecutiveIdleCycles + 1, 4), 120_000)
      emit(`Agent responsiveness low — next cycle pause: ${Math.round(cyclePause / 1000)}s`)
    } else {
      // Agent productive — use shorter pause to keep momentum
      consecutiveIdleCycles = 0
      cyclePause = baseCyclePause
    }

    // Check soft stop
    if (config.softStop?.requested) {
      emit(`Soft stop — ${agentName} supervisor finishing after cycle ${cycleCount}.`)
      await addMemoryEntry(loadBrainMemory(), {
        timestamp: Date.now(),
        objective: `${agentName} supervisor: ${directive}`,
        summary: `Soft-stopped after cycle ${cycleCount}.`,
        agentLearnings: {},
      })
      break
    }

    // Pause between cycles
    emit(`Pausing ${cyclePause / 1000}s before next cycle...`)
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(softCheck)
        config.signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, cyclePause)
      config.signal?.addEventListener("abort", done)
      const softCheck = setInterval(() => {
        if (config.softStop?.requested) done()
      }, 1000)
    })
  }

  emit(`${agentName} supervisor ended after ${cycleCount} cycles.`)
  emitStatus("done")
}

// ---------------------------------------------------------------------------
// Parallel supervisors — one per agent (Phase 1 orchestration)
// ---------------------------------------------------------------------------

export async function runParallelSupervisors(
  orchestrator: Orchestrator,
  config: ParallelSupervisorsConfig,
): Promise<void> {
  const agents = Array.from(orchestrator.agents.entries())

  config.dashboardLog?.push({ type: "brain-status", status: "running" })
  config.dashboardLog?.push({
    type: "brain-thinking",
    text: `Starting ${agents.length} parallel supervisors. Directive: "${config.directive}"`,
  })

  const supervisors = agents.map(([agentName, agentState]) => {
    // Phase 3: look up project role config for this agent
    const projectRole = config.projects?.[agentName]
    const reviewerAgent = projectRole?.reviewer

    return runAgentSupervisor(orchestrator, {
      ollamaUrl: config.ollamaUrl,
      model: config.model,
      agentName,
      directory: agentState.config.directory,
      directive: config.directive,
      cyclePauseSeconds: config.cyclePauseSeconds,
      maxRoundsPerCycle: config.maxRoundsPerCycle,
      reviewEnabled: config.reviewEnabled ?? true,
      reviewerAgent,
      onThinking: (thought) => config.onThinking?.(agentName, thought),
      dashboardLog: config.dashboardLog,
      signal: config.signal,
      softStop: config.softStop,
    })
  })

  // All supervisors run in parallel — wait for all to finish
  const results = await Promise.allSettled(supervisors)

  // Log any failures
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    if (r.status === "rejected") {
      const name = agents[i]![0]
      const errMsg = `Supervisor for ${name} failed: ${r.reason}`
      config.dashboardLog?.push({ type: "brain-thinking", text: errMsg })
      config.onThinking?.(name, errMsg)
    }
  }

  config.dashboardLog?.push({
    type: "brain-thinking",
    text: `All ${agents.length} supervisors finished.`,
  })
}
