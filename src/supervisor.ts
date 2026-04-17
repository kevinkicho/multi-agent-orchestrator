import type { Orchestrator } from "./orchestrator"
import type { DashboardLog } from "./dashboard"
import { chatCompletion, chatCompletionWithUsage, warmupModel } from "./brain"
import {
  loadBrainMemory,
  addMemoryEntry,
  addProjectNote,
  addBehavioralNote,
  formatMemoryForPrompt,
} from "./brain-memory"
import { extractLastAssistantText, formatRecentMessages, trimConversation } from "./message-utils"
import { logPerformance } from "./performance-log"
import { checkpointSupervisor } from "./session-state"
import { startSession, recordCycle, endSession } from "./analytics"
import { recordPrompt } from "./prompt-ledger"
import type { PauseState } from "./pause-service"
import { isPauseRequested, awaitResume, requestPause } from "./pause-service"
import { gitDiffStat, gitDiffNameOnly, gitLatestCommit } from "./git-utils"
import type { EventBus, BusEvent, BusPattern } from "./event-bus"
import type { ResourceManager } from "./resource-manager"
import type { TokenTracker } from "./token-tracker"
import { saveConversationCheckpoint, loadConversationCheckpoint, clearConversationCheckpoint } from "./conversation-checkpoint"
import {
  type NudgeState, createNudgeState, resetNudge,
  buildEmptyNudge, buildNoParseNudge, fuzzyExtractCommands,
  SUPERVISOR_COMMANDS, SUPERVISOR_DEFAULT_CMD,
} from "./command-recovery"

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

/** Tunable limits for the supervisor — all optional with sensible defaults */
export type SupervisorLimits = {
  maxRestartsPerCycle?: number
  maxConsecutiveFailedCycles?: number
  restartBackoffBaseMs?: number
  maxConversationMessages?: number
  cyclePauseSeconds?: number
  maxRoundsPerCycle?: number
  stuckThresholdMs?: number
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
  /** Configurable limits */
  limits?: SupervisorLimits
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
  /** Max cycles before this supervisor exits (for sequential rotation). 0 = unlimited. */
  maxCycles?: number
  /** Callback fired after each CYCLE_DONE with the supervisor's summary (used by TeamManager) */
  onCycleSummary?: (summary: string) => void
  /** Mutable directive ref — if provided, supervisor reads .value each cycle instead of the static `directive` string.
   *  This allows the TeamManager to push directive updates into a running supervisor. */
  directiveRef?: { value: string }
  /** Mutable pause state — if provided, supervisor checks for pause requests and blocks at CYCLE_DONE */
  pauseState?: PauseState
  /** Callback fired when analytics session starts, so callers can capture the session ID */
  onSessionStart?: (sessionId: string) => void
  /** Callback fired after each cycle with cycle number — used by A/B test to auto-pause after N cycles */
  onCycleComplete?: (cycleNumber: number) => void
  /** Post-cycle validation: run a command after each CYCLE_DONE and inject results.
   *  Use `command` for a custom shell command, or `preset` for built-in presets. */
  postCycleValidation?: {
    command?: string
    /** Built-in preset: "test", "typecheck", "lint", "build", or "test+typecheck" */
    preset?: ValidationPreset
    timeoutMs?: number
    failAction?: "warn" | "inject" | "pause"
  }
  /** Shared event bus for cross-agent coordination */
  eventBus?: EventBus
  /** Shared resource manager for file locks and LLM semaphore */
  resourceManager?: ResourceManager
  /** Use JSON-mode for LLM calls (reduces parse failures). Default: false */
  structuredOutput?: boolean
  /** Token usage tracker — records tokens per call for budget monitoring */
  tokenTracker?: TokenTracker
  /** Probe agent capabilities on first cycle. Default: true */
  probeCapabilities?: boolean
  /** Patterns for urgent bus events to inject between rounds */
  urgentEventPatterns?: BusPattern[]
  /** Handler to convert urgent bus events into injectable text. Return null to skip. */
  onUrgentEvent?: (event: BusEvent) => string | null
}

/**
 * Scheduling mode controls how supervisors are run:
 * - "parallel" (default): All supervisors run simultaneously. Fast but burns API quota.
 * - "sequential": Run one agent at a time, rotating through all. Lightest on API quota.
 *   Use `concurrency` to control how many run at once (default: 1).
 */
export type SchedulingMode = "parallel" | "sequential"

export type ParallelSupervisorsConfig = {
  ollamaUrl: string
  model: string
  directive: string
  cyclePauseSeconds?: number
  maxRoundsPerCycle?: number
  reviewEnabled?: boolean
  /** Configurable limits passed to each supervisor */
  supervisorLimits?: SupervisorLimits
  /** Optional project role mapping: { agentName: { coder, reviewer? } } */
  projects?: Record<string, ProjectRole>
  onThinking?: (agentName: string, thought: string) => void
  dashboardLog?: DashboardLog
  signal?: AbortSignal
  softStop?: { requested: boolean }
  /** Scheduling mode: "parallel" (all at once) or "sequential" (rotate). Default: "parallel" */
  scheduling?: SchedulingMode
  /** For sequential mode: how many agents to run concurrently. Default: 1 */
  concurrency?: number
  /** For sequential mode: max cycles per agent before rotating. Default: 2 */
  cyclesPerRotation?: number
}

// ---------------------------------------------------------------------------
// System prompt — Socratic dialogue mode
// ---------------------------------------------------------------------------

function buildSocraticPrompt(agentName: string, directory: string, reviewEnabled: boolean, hasReviewer: boolean, behavioralNotes: string[]): string {
  const reviewAction = reviewEnabled
    ? `- @review — ${hasReviewer ? "Send work to a dedicated reviewer" : "Ask the worker to self-review recent changes"}\n`
    : ""

  const behavioralSection = behavioralNotes.length > 0
    ? `\n## Lessons from Previous Cycles\n${behavioralNotes.map(n => `- ${n}`).join("\n")}\n`
    : ""

  return `You are a thinking partner and supervisor for an AI coding agent ("the worker") on a software project.

Worker: ${agentName}
Project: ${directory}
${behavioralSection}
## How to work

Think freely. Reason out loud. Ask yourself questions: "What is the real problem here?", "What assumptions am I making?", "Is this the right approach, or am I missing something?" Your natural-language reasoning is preserved between rounds — use it to build understanding across the conversation.

When you're ready to take an action, use one of these markers on its own line:

### Talking to the worker
- @worker: <message> — Talk to the worker. Ask questions, give tasks, provide feedback, suggest alternatives. Multi-line: everything until the next @ marker is sent.
- @check — Read the worker's recent messages to see what they've been doing.
${reviewAction}
### Agent lifecycle
- @abort — Cancel the worker's current task.
- @restart — Restart the worker's session (use when truly stuck/unresponsive).

### Memory & coordination
- @note: <text> — Save a project note for future cycles.
- @lesson: <text> — Save a behavioral lesson about how this worker operates best.
- @directive: <text> — Evolve the project direction as understanding deepens.
- @broadcast: <text> — Send a message to all other supervisors.
- @intent: <description> [files: f1, f2] — Declare planned work to avoid conflicts with other agents.

### Cycle control
- @done: <summary> — End this cycle. Summary must be specific: what was accomplished, what's next.
- @stop: <summary> — Permanently stop supervising this worker.

## Your approach

**Think before acting.** Before sending work to the worker, reason about:
- What's the current state? What has the worker already done?
- What's the highest-value next step? Why this over alternatives?
- Are there risks, edge cases, or assumptions worth questioning?

**Engage with the worker's reasoning.** When the worker responds, don't just check-mark it and move on. Push back if something seems off: "You mentioned X but I don't see how that handles Y..." Build on good ideas: "That's a solid approach for the core case — what about when Z happens?"

**Evolve your understanding.** Your first take on a problem may not be right. As you see the worker's output and the code's actual state, update your mental model. Use @directive to capture how your understanding of the project direction has shifted.

**Be a Socratic partner, not a task dispatcher.** The best outcomes come from genuine dialogue — probing questions, building on each other's ideas, challenging assumptions. The worker is a capable reasoning agent, not a command executor.

## Practical guidelines
- Start each cycle by checking in: @check to see recent work, then think about what you learn.
- Give the worker context and reasoning, not just bare instructions. "We need to fix X because Y, and I think the approach should be Z because..." is better than "Fix X."
- If the worker is stuck, don't just retry — think about WHY it's stuck and try a different angle.
- If stuck/unresponsive: @abort first, then rephrase. If still dead: @restart. Save a @lesson about what caused it.
- Don't send 5+ messages to an unresponsive worker — escalate.
- NEVER tell the worker to start background processes with "&". Use single commands: "node server.js & sleep 2 && npx playwright test; kill %1"
- Prioritize: bugs > missing features > code quality > polish
- @done summaries must be specific: "Fixed auth bypass in /api/login. Worker implementing rate limiting. 12/15 tests passing." NOT "Done." or "Cycle completed."
- You manage ONLY this worker — give it your full attention.
`
}

/** Legacy prompt builder — kept for reference/fallback */
function buildSupervisorPrompt(agentName: string, directory: string, reviewEnabled: boolean, hasReviewer: boolean, behavioralNotes: string[]): string {
  return buildSocraticPrompt(agentName, directory, reviewEnabled, hasReviewer, behavioralNotes)
}

// ---------------------------------------------------------------------------
// Command types — shared by both Socratic and legacy parsers
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
  | { type: "notify"; message: string }
  | { type: "intent"; description: string; files: string[] }
  | { type: "cycle_done"; summary: string }
  | { type: "stop"; summary: string }

// ---------------------------------------------------------------------------
// Socratic response parser — extracts actions from natural language + @ markers
// ---------------------------------------------------------------------------

/** All recognized @ markers (order matters — longer prefixes first to avoid partial matches) */
const SOCRATIC_MARKERS = [
  { prefix: "@worker:", type: "prompt" as const, hasBody: true },
  { prefix: "@check", type: "messages" as const, hasBody: false },
  { prefix: "@review", type: "review" as const, hasBody: false },
  { prefix: "@restart", type: "restart" as const, hasBody: false },
  { prefix: "@abort", type: "abort" as const, hasBody: false },
  { prefix: "@lesson:", type: "note_behavior" as const, hasBody: true },
  { prefix: "@note:", type: "note" as const, hasBody: true },
  { prefix: "@directive:", type: "directive" as const, hasBody: true },
  { prefix: "@broadcast:", type: "broadcast" as const, hasBody: true },
  { prefix: "@intent:", type: "intent" as const, hasBody: true },
  { prefix: "@done:", type: "cycle_done" as const, hasBody: true },
  { prefix: "@stop:", type: "stop" as const, hasBody: true },
] as const

function matchMarker(line: string): { marker: typeof SOCRATIC_MARKERS[number]; rest: string } | null {
  const trimmed = line.trim()
  for (const m of SOCRATIC_MARKERS) {
    if (m.hasBody) {
      if (trimmed.startsWith(m.prefix)) {
        return { marker: m, rest: trimmed.slice(m.prefix.length).trim() }
      }
    } else {
      // Exact match (possibly with trailing whitespace/punctuation)
      if (trimmed === m.prefix || trimmed.startsWith(m.prefix + " ") || trimmed === m.prefix + ".") {
        return { marker: m, rest: "" }
      }
    }
  }
  return null
}

function parseSocraticResponse(response: string): { commands: SupervisorCommand[]; thinking: string } {
  const commands: SupervisorCommand[] = []
  const thinkingLines: string[] = []

  // Strip LLM think tags
  const cleaned = response.replace(/<\/?think>/gi, "\n")
  const lines = cleaned.split("\n")

  let currentMarker: { marker: typeof SOCRATIC_MARKERS[number]; bodyLines: string[] } | null = null

  function flushCurrent() {
    if (!currentMarker) return
    const body = currentMarker.bodyLines.join("\n").trim()
    const m = currentMarker.marker

    switch (m.type) {
      case "prompt":
        if (body) commands.push({ type: "prompt", message: body })
        // Implicit wait after every @worker message
        commands.push({ type: "wait" })
        break
      case "messages":
        commands.push({ type: "messages" })
        break
      case "review":
        commands.push({ type: "review" })
        break
      case "restart":
        commands.push({ type: "restart" })
        break
      case "abort":
        commands.push({ type: "abort" })
        break
      case "note":
        if (body) commands.push({ type: "note", text: body })
        break
      case "note_behavior":
        if (body) commands.push({ type: "note_behavior", text: body })
        break
      case "directive":
        if (body) commands.push({ type: "directive", text: body })
        break
      case "broadcast":
        if (body) commands.push({ type: "notify", message: body })
        break
      case "intent": {
        const filesMatch = body.match(/\[files?:\s*([^\]]+)\]/)
        const files = filesMatch
          ? filesMatch[1]!.split(",").map(f => f.trim()).filter(Boolean)
          : []
        const description = body.replace(/\[files?:\s*[^\]]+\]/, "").trim()
        if (description) commands.push({ type: "intent", description, files })
        break
      }
      case "cycle_done":
        commands.push({ type: "cycle_done", summary: body || "Cycle completed." })
        break
      case "stop":
        commands.push({ type: "stop", summary: body || "Supervisor stopped." })
        break
    }
    currentMarker = null
  }

  for (const line of lines) {
    const match = matchMarker(line)
    if (match) {
      // Flush any pending marker
      flushCurrent()
      // Start new marker
      currentMarker = { marker: match.marker, bodyLines: match.rest ? [match.rest] : [] }
      // No-body markers can be flushed immediately
      if (!match.marker.hasBody) {
        flushCurrent()
      }
    } else if (currentMarker && currentMarker.marker.hasBody) {
      // Continuation line for a multi-line marker body
      currentMarker.bodyLines.push(line)
    } else {
      // Free thinking — preserved as context
      thinkingLines.push(line)
    }
  }

  // Flush any trailing marker
  flushCurrent()

  return { commands, thinking: thinkingLines.join("\n").trim() }
}

// ---------------------------------------------------------------------------
// Legacy command parsing — fallback for older command format
// ---------------------------------------------------------------------------

const LEGACY_COMMAND_PREFIXES = [
  "PROMPT ", "WAIT", "MESSAGES", "REVIEW", "RESTART", "ABORT",
  "NOTE_BEHAVIOR ", "NOTE ", "DIRECTIVE ", "NOTIFY ", "INTENT ",
  "CYCLE_DONE", "STOP",
]

function isCommandLine(trimmed: string): boolean {
  return LEGACY_COMMAND_PREFIXES.some(p => trimmed === p.trim() || trimmed.startsWith(p))
}

function parseLegacyCommands(response: string): SupervisorCommand[] {
  const commands: SupervisorCommand[] = []
  const cleaned = response.replace(/<\/?think>/gi, "\n")

  const codeBlockMatch = cleaned.match(/```commands?\n([\s\S]*?)```/)
  const lines = codeBlockMatch
    ? codeBlockMatch[1]!.split("\n")
    : cleaned.split("\n")

  let lastPrompt: { type: "prompt"; message: string } | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("PROMPT ")) {
      lastPrompt = { type: "prompt", message: trimmed.slice(7) }
      commands.push(lastPrompt)
    } else if (trimmed === "WAIT") {
      lastPrompt = null
      commands.push({ type: "wait" })
    } else if (trimmed === "MESSAGES") {
      lastPrompt = null
      commands.push({ type: "messages" })
    } else if (trimmed === "REVIEW") {
      lastPrompt = null
      commands.push({ type: "review" })
    } else if (trimmed === "RESTART") {
      lastPrompt = null
      commands.push({ type: "restart" })
    } else if (trimmed === "ABORT") {
      lastPrompt = null
      commands.push({ type: "abort" })
    } else if (trimmed.startsWith("NOTE_BEHAVIOR ")) {
      lastPrompt = null
      commands.push({ type: "note_behavior", text: trimmed.slice(14) })
    } else if (trimmed.startsWith("NOTE ")) {
      lastPrompt = null
      commands.push({ type: "note", text: trimmed.slice(5) })
    } else if (trimmed.startsWith("DIRECTIVE ")) {
      lastPrompt = null
      commands.push({ type: "directive", text: trimmed.slice(10) })
    } else if (trimmed.startsWith("NOTIFY ")) {
      lastPrompt = null
      commands.push({ type: "notify", message: trimmed.slice(7) })
    } else if (trimmed.startsWith("INTENT ")) {
      lastPrompt = null
      const rest = trimmed.slice(7)
      const filesMatch = rest.match(/\[files?:\s*([^\]]+)\]/)
      const files = filesMatch
        ? filesMatch[1]!.split(",").map(f => f.trim()).filter(Boolean)
        : []
      const description = rest.replace(/\[files?:\s*[^\]]+\]/, "").trim()
      commands.push({ type: "intent", description, files })
    } else if (trimmed.startsWith("CYCLE_DONE")) {
      lastPrompt = null
      commands.push({ type: "cycle_done", summary: trimmed.slice(10).trim() || "Cycle completed." })
    } else if (trimmed.startsWith("STOP")) {
      lastPrompt = null
      commands.push({ type: "stop", summary: trimmed.slice(4).trim() || "Supervisor stopped." })
    } else if (lastPrompt) {
      lastPrompt.message += "\n" + trimmed
    }
  }

  return commands
}

/** Unified parser: try Socratic @ markers first, fall back to legacy UPPERCASE commands */
function parseSupervisorCommands(response: string): SupervisorCommand[] {
  // Try Socratic parsing first
  const socratic = parseSocraticResponse(response)
  if (socratic.commands.length > 0) return socratic.commands

  // Fall back to legacy command format
  return parseLegacyCommands(response)
}

/**
 * Parse JSON-mode responses: LLM returns { commands: ["CMD arg", ...], thinking?: "..." }
 * Falls back to text parsing if JSON is malformed.
 */
function parseJsonCommands(response: string): SupervisorCommand[] {
  try {
    const parsed = JSON.parse(response) as { commands?: string[]; actions?: string[]; thinking?: string }
    const items = parsed.actions ?? parsed.commands
    if (Array.isArray(items)) {
      // Convert JSON array to newline-separated text and parse through unified parser
      const asText = items.join("\n")
      return parseSupervisorCommands(asText)
    }
  } catch {
    // Not valid JSON — fall through to text parsing
  }
  return parseSupervisorCommands(response)
}

/** JSON-mode instruction appended to system prompt when structuredOutput is enabled */
const JSON_MODE_INSTRUCTION = `

IMPORTANT: You MUST respond with a JSON object. Format:
{"actions": ["@check", "@worker: your message here"], "thinking": "your reasoning"}

Example:
{"actions": ["@check"], "thinking": "Let me see what the worker has been doing before deciding next steps"}

Every action goes as a string in the "actions" array, using the @ marker format documented above.
Do NOT use a code block — respond with pure JSON only.`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Validation presets
// ---------------------------------------------------------------------------

export type ValidationPreset = "test" | "typecheck" | "lint" | "build" | "test+typecheck"

const VALIDATION_PRESETS: Record<ValidationPreset, { command: string; timeoutMs: number }> = {
  test:             { command: "bun test", timeoutMs: 120_000 },
  typecheck:        { command: "bun x tsc --noEmit", timeoutMs: 60_000 },
  lint:             { command: "bun x eslint . --max-warnings 0", timeoutMs: 60_000 },
  build:            { command: "bun run build", timeoutMs: 180_000 },
  "test+typecheck": { command: "bun test && bun x tsc --noEmit", timeoutMs: 180_000 },
}

/** Resolve validation config — preset overrides command if both set */
function resolveValidation(config: { command?: string; preset?: ValidationPreset; timeoutMs?: number; failAction?: "warn" | "inject" | "pause" }): { command: string; timeoutMs: number; failAction: "warn" | "inject" | "pause" } {
  if (config.preset && VALIDATION_PRESETS[config.preset]) {
    const preset = VALIDATION_PRESETS[config.preset]
    return {
      command: config.command || preset.command,
      timeoutMs: config.timeoutMs ?? preset.timeoutMs,
      failAction: config.failAction ?? "inject",
    }
  }
  return {
    command: config.command ?? "echo 'no validation command'",
    timeoutMs: config.timeoutMs ?? 60_000,
    failAction: config.failAction ?? "inject",
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if an error is a 429 rate-limit error from Ollama */
function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const statusCode = (err as Error & { statusCode?: number }).statusCode
    if (statusCode === 429) return true
    // Also match the error message pattern from the logs
    if (/429|rate.?limit|session usage limit/i.test(err.message)) return true
  }
  return typeof err === "string" && /429|rate.?limit|session usage limit/i.test(err)
}

/** Check if an error was caused by a request timeout (AbortError) */
function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true
  if (err instanceof Error && err.message.includes("timed out")) return true
  return false
}

/** Check if an error indicates the agent is not registered in the orchestrator */
function isUnknownAgentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /unknown agent/i.test(msg)
}

/** How long to wait for a single LLM response before aborting (3 minutes) */
const LLM_CALL_TIMEOUT_MS = 180_000

/** Wait for a single agent to finish (not all agents) */
type WaitResult = {
  /** Why the wait ended */
  reason: "idle" | "timeout" | "stale" | "aborted" | "paused" | "disconnected" | "user-feedback"
  /** Seconds the agent was silent (no SSE events) when wait ended. 0 if agent finished normally. */
  silentSeconds: number
}

/** How long an agent can be "busy" with zero SSE events before we consider it stale/dead */
const STALE_BUSY_THRESHOLD_MS = 45_000

async function waitForAgent(
  orchestrator: Orchestrator,
  agentName: string,
  timeoutMs = 300_000,
  opts?: { signal?: AbortSignal; pauseState?: PauseState; getUnreadComments?: () => string[] },
): Promise<WaitResult> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (opts?.signal?.aborted) return { reason: "aborted", silentSeconds: 0 }
    if (opts?.pauseState && isPauseRequested(opts.pauseState)) return { reason: "paused", silentSeconds: 0 }

    // Break out of wait if user sent feedback — let the supervisor see it immediately
    const comments = opts?.getUnreadComments?.() ?? []
    if (comments.length > 0) return { reason: "user-feedback", silentSeconds: 0 }

    const statuses = await orchestrator.status()
    const s = statuses.get(agentName)
    if (!s) return { reason: "disconnected", silentSeconds: 0 }
    if (s.status !== "busy") return { reason: "idle", silentSeconds: 0 }

    // Stale-busy detection: agent says "busy" but no SSE events flowing
    const silenceMs = Date.now() - s.lastEventAt
    if (silenceMs > STALE_BUSY_THRESHOLD_MS) {
      return { reason: "stale", silentSeconds: Math.round(silenceMs / 1000) }
    }

    await new Promise(r => setTimeout(r, 2000))
  }
  // Timed out — compute how long the agent has been silent
  const statuses = await orchestrator.status()
  const s = statuses.get(agentName)
  const silenceMs = s ? Date.now() - s.lastEventAt : 0
  return { reason: "timeout", silentSeconds: Math.round(silenceMs / 1000) }
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
    limits = {},
  } = config
  let directive = config.directiveRef?.value ?? config.directive
  const baseCyclePause = (config.cyclePauseSeconds ?? limits.cyclePauseSeconds ?? 30) * 1000
  let cyclePause = baseCyclePause
  const maxRoundsPerCycle = config.maxRoundsPerCycle ?? limits.maxRoundsPerCycle ?? 12
  const maxCycles = config.maxCycles ?? 0 // 0 = unlimited
  const maxConversationMessages = limits.maxConversationMessages ?? 60
  const hasReviewer = !!reviewerAgent
  let cycleCount = 0
  let consecutiveEmptyResponses = 0
  let consecutiveIdleCycles = 0 // tracks cycles where agent was idle/no work done
  let cycleRestartCount = 0 // restarts within the current cycle (capped)
  let consecutiveFailedCycles = 0 // cycles that hit the restart cap without progress

  const MAX_RESTARTS_PER_CYCLE = limits.maxRestartsPerCycle ?? 3
  const MAX_CONSECUTIVE_FAILED_CYCLES = limits.maxConsecutiveFailedCycles ?? 3
  const RESTART_BACKOFF_BASE = limits.restartBackoffBaseMs ?? 30_000
  let consecutiveLlmFailures = 0 // tracks persistent Ollama failures across cycles
  let consecutive429s = 0 // tracks consecutive rate-limit (429) errors — distinct from other failures

  const emit = (text: string) => {
    config.onThinking?.(text)
    config.dashboardLog?.push({ type: "supervisor-thinking", agent: agentName, text })
  }

  const emitStatus = (status: "running" | "idle" | "done" | "reviewing" | "paused") => {
    config.dashboardLog?.push({ type: "supervisor-status", agent: agentName, status })
  }

  emit(`Supervisor started for ${agentName}. Directive: "${directive}"`)
  emitStatus("running")

  // Warm up the Ollama model to avoid cold-start latency on first LLM call
  warmupModel(ollamaUrl, model).then(() => {
    emit(`Model "${model}" warmed up and ready`)
  }).catch(() => {}) // Intentionally silent: best-effort model warmup
  logPerformance({ timestamp: Date.now(), projectName: directory, agentName, model, event: "supervisor_start" })

  // Analytics session tracking — await so sessionId is available before first cycle
  let analyticsSessionId: string | null = null
  try {
    analyticsSessionId = await startSession(agentName, directory, model, directive)
    if (analyticsSessionId) config.onSessionStart?.(analyticsSessionId)
  } catch (err) {
    console.error(`[${agentName}] Failed to start analytics session: ${err}`)
  }

  let loggedStop = false
  let pauseInjected = false
  let pauseInjectedAtRound = -1  // track which round pause was injected

  // Agent capability probing — run once on startup
  let agentCapabilities = ""
  if (config.probeCapabilities !== false) {
    try {
      // Send a capability probe and collect the response
      const agentStatuses = await orchestrator.status()
      const agentSt = agentStatuses.get(agentName)
      if (agentSt?.status === "idle" || agentSt?.status === "ready") {
        await orchestrator.prompt(agentName, "List the tools and commands you have access to (git, test runners, linters, build tools, package managers). Reply with a brief list, no explanation needed.")
        await waitForAgent(orchestrator, agentName, 30_000, { signal: config.signal, pauseState: config.pauseState }) // short timeout for probe
        const probeMessages = await orchestrator.getMessages(agentName)
        const probeResponse = extractLastAssistantText(probeMessages)
        if (probeResponse && probeResponse.length > 10) {
          agentCapabilities = probeResponse.slice(0, 500)
          emit(`Capability probe result: ${agentCapabilities.slice(0, 200)}`)
          // Save as behavioral note for persistence
          await addBehavioralNote(await loadBrainMemory(), agentName, `Available tools: ${agentCapabilities.slice(0, 300)}`)
        }
      }
    } catch {
      // Probe failure is non-fatal — supervisor continues without capability info
    }
  }

  while (!config.signal?.aborted) {
    // Sequential mode: exit after maxCycles so the scheduler can rotate to the next agent
    if (maxCycles > 0 && cycleCount >= maxCycles) {
      emit(`Completed ${cycleCount} cycles (maxCycles=${maxCycles}). Yielding for rotation.`)
      break
    }
    cycleCount++
    // Re-read directive from mutable ref if present (allows TeamManager to push updates between cycles)
    if (config.directiveRef) directive = config.directiveRef.value
    cycleRestartCount = 0 // Reset per-cycle restart counter
    consecutiveEmptyResponses = 0 // Reset empty counter for new cycle
    let cycleHadProgress = false // Track if agent produced useful output this cycle
    let lastRestartTimestamp = 0 // Prevent rapid-fire restarts from any path
    const cycleStartTime = Date.now()
    const injectedEventIds = new Set<string>() // Dedup urgent bus events within a cycle
    let cycleStartCommit = "" // Capture commit at cycle start for false-progress detection
    try { cycleStartCommit = await gitLatestCommit(directory) } catch { /* not a git repo */ }
    emit(`\n===== ${agentName} — CYCLE ${cycleCount} =====\n`)
    config.eventBus?.emit({
      type: "cycle-start",
      source: "supervisor",
      agentName,
      data: { cycleNumber: cycleCount, directive },
    })
    // Checkpoint at cycle start so crash recovery knows we were on this cycle
    checkpointSupervisor({
      agentName, cycleNumber: cycleCount, lastSummary: "",
      directive, status: "running", updatedAt: Date.now(),
    }).catch(err => console.error(`[${agentName}] Failed to checkpoint supervisor state: ${err}`))

    let memory = await loadBrainMemory()
    const memoryContext = formatMemoryForPrompt(memory, agentName)

    // Extract behavioral notes for this agent to inject into system prompt
    const behavioralNotes = (memory.behavioralNotes?.[agentName] ?? []).slice(-3)

    // Get agent status — and bail immediately if agent isn't registered
    const statuses = await orchestrator.status()
    const agentStatus = statuses.get(agentName)
    if (!agentStatus) {
      // Agent not found in orchestrator — don't waste a cycle
      const stopMsg = `Agent "${agentName}" is not registered in the orchestrator. Stopping supervision immediately — add the agent to orchestrator.json and restart.`
      emit(`UNKNOWN AGENT: ${stopMsg}`)
      logPerformance({
        timestamp: Date.now(), projectName: directory, agentName, model,
        event: "supervisor_stop", cycleNumber: cycleCount,
        summary: stopMsg, details: "unknown-agent",
      })
      config.onSupervisorStop?.(agentName, stopMsg, true)
      config.dashboardLog?.push({
        type: "supervisor-alert",
        agent: agentName,
        text: `SUPERVISOR STOPPED: Agent "${agentName}" is not registered.`,
      })
      break
    }
    const statusLine = `Agent status: ${agentStatus.status} (session: ${agentStatus.sessionID ?? "none"})`

    // On first cycle, add resume context so the supervisor orients the agent
    const projectNotes = memory.projectNotes[agentName] ?? []
    const isResume = cycleCount === 1 && (projectNotes.length > 0 || memory.entries.length > 0)
    const resumeBlock = isResume
      ? `\n## Resuming from previous session\nThis project was previously worked on. Before diving in, take a moment to orient yourself:\n- Use @check to see what the worker has been doing\n- Review the project notes below for context\n- Consider asking the worker to run \`git status\` and \`git log --oneline -5\`\n- Think about where to pick up — what's the highest-value next step?\n${projectNotes.length > 0 ? `\nLatest project notes:\n${projectNotes.slice(-5).map(n => `- ${n}`).join("\n")}` : ""}`
      : ""

    // Check for unread user comments on the directive
    const unreadComments = config.getUnreadComments?.() ?? []
    const commentBlock = unreadComments.length > 0
      ? `\n## User feedback\nThe human user left you a message:\n${unreadComments.map(c => `> "${c}"`).join("\n")}\nThink about what they're telling you and how it should shape your approach.`
      : ""

    // Inject other agents' declared work intents so this supervisor can avoid overlap
    const intentSummary = config.resourceManager?.formatIntentSummary(agentName) ?? ""
    const intentBlock = intentSummary && !intentSummary.includes("(no other agents")
      ? `\n## Other agents' work\n${intentSummary}\nConsider using @intent: before starting significant work to avoid stepping on other agents' toes.`
      : ""

    const capabilityBlock = agentCapabilities && cycleCount === 1
      ? `\n## Worker capabilities\n${agentCapabilities}\nKeep these in mind when thinking about what to ask the worker to do.`
      : ""

    const initialContent = [
      statusLine,
      memoryContext ? `\n## Memory from previous cycles\n${memoryContext}` : "",
      resumeBlock,
      commentBlock,
      intentBlock,
      capabilityBlock,
      `\nDirective: ${directive}`,
      isResume
        ? `\nThis is cycle #${cycleCount} (resuming). Start by understanding where things stand before deciding what to do next.`
        : `\nThis is cycle #${cycleCount}. Start by checking in with the worker (@check), then think about the best path forward.`,
    ].filter(Boolean).join("\n")

    const baseSystemPrompt = buildSupervisorPrompt(agentName, directory, reviewEnabled, hasReviewer, behavioralNotes)
    const systemPrompt = config.structuredOutput
      ? baseSystemPrompt + JSON_MODE_INSTRUCTION
      : baseSystemPrompt
    let messages: Message[]

    // On first cycle, try to warm-start from a conversation checkpoint
    if (cycleCount === 1) {
      const checkpoint = await loadConversationCheckpoint(agentName).catch(() => null)
      if (checkpoint && checkpoint.messages.length > 2) {
        // Restore previous conversation with fresh system prompt
        messages = [
          { role: "system", content: systemPrompt },
          ...checkpoint.messages.filter(m => m.role !== "system"),
          { role: "user", content: `[Conversation restored from checkpoint — cycle ${checkpoint.cycleNumber}]\n${initialContent}` },
        ]
        emit(`Restored conversation from checkpoint (cycle ${checkpoint.cycleNumber}, ${checkpoint.messages.length} messages)`)
      } else {
        messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: initialContent },
        ]
      }
    } else {
      messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: initialContent },
      ]
    }

    let cycleDone = false
    let stopped = false
    let restartCapHit = false
    const commandCounts: Record<string, number> = {} // analytics: track commands per cycle
    const nudge = createNudgeState() // escalating nudge state for this cycle

    for (let round = 0; round < maxRoundsPerCycle && !cycleDone && !stopped && !restartCapHit; round++) {
      if (config.signal?.aborted) break
      // Check soft stop inside the round loop — don't wait until cycle boundary
      // for long cycles (12 rounds x 5min LLM calls = 60min delay otherwise)
      if (config.softStop?.requested) {
        emit(`Soft stop detected mid-cycle (round ${round + 1}) — finishing cycle early.`)
        break
      }

      // Pause hard break — if LLM didn't CYCLE_DONE within 2 rounds of pause injection, force-end
      if (pauseInjected && pauseInjectedAtRound >= 0 && round - pauseInjectedAtRound >= 2) {
        emit(`Pause grace period expired (${round - pauseInjectedAtRound} rounds since injection) — force-ending cycle.`)
        break
      }

      // Pause: inject wrap-up message once per pause request
      if (config.pauseState && isPauseRequested(config.pauseState) && !pauseInjected) {
        pauseInjected = true
        pauseInjectedAtRound = round
        const pauseMsg = "A pause has been requested by the user. Wrap up your current thinking — make sure the worker is at a clean stopping point (no half-done changes, tests passing, code committed). Then use @done: with a detailed summary of what was accomplished and what's next. Don't start new tasks."
        messages.push({ role: "user", content: pauseMsg })
        emit(`Pause requested — injecting wrap-up directive into conversation.`)
        recordPrompt({
          source: "system", target: agentName, direction: "outbound",
          projectName: directory, agentName, model, cycleNumber: cycleCount,
          sessionId: analyticsSessionId ?? undefined,
          content: pauseMsg, tags: ["pause-request"],
        }).catch(() => {}) // Intentionally silent: best-effort prompt ledger
      }

      // Mid-cycle user feedback — check every round so users can redirect a stuck supervisor
      const midCycleComments = config.getUnreadComments?.() ?? []
      if (midCycleComments.length > 0) {
        const feedbackMsg = `The human user just sent you direct feedback:\n\n${midCycleComments.map(c => `> "${c}"`).join("\n")}\n\nThis is real-time input from the person who owns this project. Stop what you're doing and think about what they're telling you. Adjust your approach based on their feedback — they can see things you can't.`
        messages.push({ role: "user", content: feedbackMsg })
        emit(`Injected ${midCycleComments.length} user comment(s) mid-cycle`)
      }

      // Urgent events from bus — inject between rounds for fast cross-agent coordination
      // Uses injectedEventIds set to avoid re-injecting the same event on subsequent rounds
      if (config.eventBus && config.urgentEventPatterns?.length && config.onUrgentEvent) {
        const urgentEvents = config.eventBus.getSince(cycleStartTime, undefined)
          .filter(e => e.agentName !== agentName) // skip own events
          .filter(e => !injectedEventIds.has(e.id)) // dedup
          .filter(e => config.urgentEventPatterns!.some(p => {
            if (p.type !== undefined) {
              if (p.type instanceof RegExp ? !p.type.test(e.type) : e.type !== p.type) return false
            }
            if (p.source !== undefined && e.source !== p.source) return false
            if (p.agentName !== undefined && e.agentName !== p.agentName) return false
            return true
          }))
        for (const evt of urgentEvents.slice(0, 3)) {
          const injected = config.onUrgentEvent(evt)
          if (injected) {
            injectedEventIds.add(evt.id)
            messages.push({ role: "user", content: `[URGENT from ${evt.agentName ?? evt.source}] ${injected}` })
            emit(`Injected urgent event: ${evt.type} from ${evt.agentName ?? evt.source}`)
          }
        }
      }

      // Ledger: record outbound prompt to LLM BEFORE trimming so we capture the actual last message
      const lastMsg = messages[messages.length - 1]
      if (lastMsg) {
        recordPrompt({
          source: "supervisor", target: "llm", direction: "outbound",
          projectName: directory, agentName, model, cycleNumber: cycleCount,
          sessionId: analyticsSessionId ?? undefined,
          content: lastMsg.content,
        }).catch(() => {}) // Intentionally silent: best-effort prompt ledger
      }

      trimConversation(messages, maxConversationMessages)

      // Budget check — skip LLM call if over budget
      if (config.tokenTracker && !config.tokenTracker.checkBudget(agentName)) {
        emit(`TOKEN BUDGET EXCEEDED for ${agentName} — ending cycle early`)
        break
      }

      // Preemptive rate-limit check — if another agent hit 429, back off before trying
      if (config.resourceManager) {
        const cooldown = config.resourceManager.getRateLimitCooldown()
        if (cooldown > 0) {
          emit(`Rate-limit cooldown active (another agent hit 429) — waiting ${Math.round(cooldown / 1000)}s`)
          await new Promise(r => setTimeout(r, cooldown))
        }
      }

      let response: string = ""
      let llmBreakCycle = false

      // LLM call: semaphore is held only during the actual API call, not during backoff.
      // On failure, we release the slot, back off, then re-acquire for retry.
      const llmCallFn = () => chatCompletionWithUsage(ollamaUrl, model, messages, { ...(config.structuredOutput ? { jsonMode: true } : {}), timeoutMs: LLM_CALL_TIMEOUT_MS })

      let llmResult: { content: string; usage?: import("./brain").TokenUsage } | null = null

      try {
        llmResult = config.resourceManager
          ? await config.resourceManager.withLlmSlot(llmCallFn)
          : await llmCallFn()
        consecutiveLlmFailures = 0
        consecutive429s = 0
      } catch (err) {
        if (isTimeoutError(err)) {
          consecutiveLlmFailures++
          emit(`LLM request timed out after ${Math.round(LLM_CALL_TIMEOUT_MS / 1000)}s (round ${round + 1}, failure #${consecutiveLlmFailures})`)
          logPerformance({
            timestamp: Date.now(), projectName: directory, agentName, model,
            event: "cycle_error", cycleNumber: cycleCount,
            details: `llm-timeout (${Math.round(LLM_CALL_TIMEOUT_MS / 1000)}s)`,
          })
          if (consecutiveLlmFailures >= 3) {
            const pauseMs = Math.min(30_000 * consecutiveLlmFailures, 300_000)
            emit(`LLM persistently timing out (${consecutiveLlmFailures} timeouts) — pausing ${Math.round(pauseMs / 1000)}s before next cycle`)
            // Backoff happens OUTSIDE the semaphore slot — other agents can proceed
            await new Promise(r => setTimeout(r, pauseMs))
          }
          llmBreakCycle = true
        } else if (isRateLimitError(err)) {
          consecutive429s++
          config.resourceManager?.reportRateLimit(agentName)
          const cooldownMs = Math.min(30_000 * Math.pow(2, consecutive429s - 1), 300_000)
          emit(`RATE LIMITED (429) — attempt ${consecutive429s}, cooling down ${cooldownMs / 1000}s then skipping to next cycle`)
          logPerformance({
            timestamp: Date.now(), projectName: directory, agentName, model,
            event: "cycle_error", cycleNumber: cycleCount,
            details: `rate-limit-429 (consecutive: ${consecutive429s})`,
          })
          // Backoff outside semaphore — other agents can use the slot
          await new Promise(r => setTimeout(r, cooldownMs))
          llmBreakCycle = true
        } else {
          consecutiveLlmFailures++
          const retryDelay = Math.min(5000 * Math.pow(2, consecutiveLlmFailures - 1), 60_000)
          emit(`LLM request failed (round ${round + 1}, failure #${consecutiveLlmFailures}): ${err}`)
          emit(`Retrying in ${retryDelay / 1000}s...`)
          // Backoff OUTSIDE the semaphore slot — release slot so other agents can proceed
          await new Promise(r => setTimeout(r, retryDelay))
          try {
            // Re-acquire slot for retry attempt
            const retryResult = config.resourceManager
              ? await config.resourceManager.withLlmSlot(llmCallFn)
              : await llmCallFn()
            llmResult = retryResult
            consecutiveLlmFailures = 0
          } catch (retryErr) {
            emit(`LLM retry failed — skipping to next cycle: ${retryErr}`)
            logPerformance({
              timestamp: Date.now(), projectName: directory, agentName, model,
              event: "cycle_error", cycleNumber: cycleCount, details: String(retryErr),
            })
            if (consecutiveLlmFailures >= 3) {
              const pauseMs = Math.min(30_000 * consecutiveLlmFailures, 300_000)
              emit(`Ollama persistently unreachable (${consecutiveLlmFailures} failures) — pausing ${pauseMs / 1000}s before next cycle`)
              await new Promise(r => setTimeout(r, pauseMs))
            }
            llmBreakCycle = true
          }
        }
      }

      if (llmBreakCycle || !llmResult) {
        if (llmBreakCycle) break
      } else {
        response = llmResult.content
        config.tokenTracker?.record(agentName, model, llmResult.usage, cycleCount, analyticsSessionId ?? undefined)
        recordPrompt({
          source: "supervisor", target: agentName, direction: "inbound",
          projectName: directory, agentName, model, cycleNumber: cycleCount,
          sessionId: analyticsSessionId ?? undefined,
          content: response,
        }).catch(() => {}) // Intentionally silent: best-effort prompt ledger
      }

      if (!response) {
        emit(`LLM returned empty response (round ${round + 1}), nudging (level ${nudge.consecutiveEmpty + 1})...`)
        messages.push({ role: "user", content: buildEmptyNudge(nudge, SUPERVISOR_COMMANDS, SUPERVISOR_DEFAULT_CMD) })
        continue
      }

      messages.push({ role: "assistant", content: response })

      emit(`--- ${agentName} cycle ${cycleCount}, round ${round + 1} ---\n${response}\n`)

      let commands = config.structuredOutput
        ? parseJsonCommands(response)
        : parseSupervisorCommands(response)

      // Fuzzy recovery: if no code block parsed, try extracting commands from prose
      if (commands.length === 0) {
        const fuzzyLines = fuzzyExtractCommands(response, SUPERVISOR_COMMANDS)
        if (fuzzyLines.length > 0) {
          const wrapped = "```commands\n" + fuzzyLines.join("\n") + "\n```"
          commands = parseSupervisorCommands(wrapped)
          if (commands.length > 0) {
            emit(`Recovered ${commands.length} command(s) from prose (no code block)`)
          }
        }
      }

      if (commands.length === 0) {
        emit(`No parseable commands (round ${round + 1}), nudging (level ${nudge.consecutiveNoParse + 1})...`)
        messages.push({
          role: "user",
          content: buildNoParseNudge(nudge, response, SUPERVISOR_COMMANDS, SUPERVISOR_DEFAULT_CMD),
        })
        continue
      }

      // Successful parse — reset nudge escalation
      resetNudge(nudge)

      const results: string[] = []
      let shouldWait = false

      // Record message count before prompts so we can detect new responses
      let messageCountBefore = 0
      try {
        const msgs = await orchestrator.getMessages(agentName)
        messageCountBefore = msgs.length
      } catch { /* Intentionally silent: best-effort baseline count, falls back to 0 */ }

      for (const cmd of commands) {
        commandCounts[cmd.type] = (commandCounts[cmd.type] ?? 0) + 1
        switch (cmd.type) {
          case "prompt": {
            try {
              config.dashboardLog?.push({ type: "agent-prompt", agent: agentName, text: cmd.message })
              await orchestrator.prompt(agentName, cmd.message)
              results.push(`Message sent to the worker. Waiting for their response...`)
              recordPrompt({
                source: "supervisor", target: agentName, direction: "outbound",
                projectName: directory, agentName, model, cycleNumber: cycleCount,
                sessionId: analyticsSessionId ?? undefined,
                content: cmd.message, tags: ["agent-prompt"],
              }).catch(() => {}) // Intentionally silent: best-effort prompt ledger
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
              results.push(`Here's what the worker has been up to recently:\n\n${formatted.join("\n\n")}\n\nStudy this carefully. What's the worker's current state? Are they making progress, stuck, or going in a wrong direction?`)
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
            const reviewWait = await waitForAgent(orchestrator, targetAgent, 300_000, { signal: config.signal, pauseState: config.pauseState })
            if (reviewWait.reason === "stale") {
              emit(`Review agent ${targetAgent} went stale (silent ${reviewWait.silentSeconds}s) — skipping review`)
              results.push(`Review skipped: agent was unresponsive (silent ${reviewWait.silentSeconds}s)`)
              break
            }

            // Get review response
            const reviewMsgs = await orchestrator.getMessages(targetAgent)
            const reviewText = extractLastAssistantText(reviewMsgs)
            if (reviewText) {
              const truncated = reviewText.slice(0, 5000)
              results.push(`Review from ${targetAgent}:\n\n${truncated}\n\nConsider: do you agree with this review? Are there points the reviewer missed, or do they raise valid concerns that should be addressed?`)
              config.dashboardLog?.push({ type: "agent-response", agent: targetAgent, text: reviewText })
              recordPrompt({
                source: "agent", target: "supervisor", direction: "inbound",
                projectName: directory, agentName: targetAgent, model, cycleNumber: cycleCount,
                sessionId: analyticsSessionId ?? undefined,
                content: reviewText, tags: ["review"],
              }).catch(() => {}) // Intentionally silent: best-effort prompt ledger
            } else {
              results.push("Review produced no output.")
            }
            emitStatus("running")
            break
          }

          case "restart": {
            if (cycleRestartCount >= MAX_RESTARTS_PER_CYCLE) {
              results.push(`Cannot restart — already hit per-cycle cap of ${MAX_RESTARTS_PER_CYCLE} restarts. Ending cycle early.`)
              emit(`RESTART CAP: Supervisor-issued restart blocked at ${MAX_RESTARTS_PER_CYCLE} restarts this cycle`)
              restartCapHit = true
              break
            }
            // Enforce minimum gap between restarts (prevents interleaved rapid-fire from multiple paths)
            const timeSinceLastRestart = Date.now() - lastRestartTimestamp
            const minRestartGapMs = RESTART_BACKOFF_BASE // at least 30s between any two restarts
            if (lastRestartTimestamp > 0 && timeSinceLastRestart < minRestartGapMs) {
              const waitMs = minRestartGapMs - timeSinceLastRestart
              emit(`Throttling restart — only ${Math.round(timeSinceLastRestart / 1000)}s since last restart, waiting ${Math.round(waitMs / 1000)}s...`)
              await new Promise(r => setTimeout(r, waitMs))
            }
            emit(`Restarting ${agentName} session...`)
            const backoffMs = RESTART_BACKOFF_BASE * Math.pow(2, Math.min(cycleRestartCount, 4))
            await new Promise(r => setTimeout(r, backoffMs))
            try {
              const newSession = await orchestrator.restartAgent(agentName)
              cycleRestartCount++
              lastRestartTimestamp = Date.now()
              results.push(`Agent ${agentName} restarted successfully (attempt ${cycleRestartCount}/${MAX_RESTARTS_PER_CYCLE}). New session: ${newSession}`)
              emit(`Agent restarted (attempt ${cycleRestartCount}/${MAX_RESTARTS_PER_CYCLE}). New session: ${newSession}`)
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
            // Also update directiveRef so TeamManager (or any external reader) sees the change
            if (config.directiveRef) config.directiveRef.value = cmd.text
            config.onDirectiveUpdate?.(cmd.text)
            config.eventBus?.emit({ type: "directive-updated", source: "supervisor", agentName, data: { directive: cmd.text } })
            results.push(`Directive updated to: "${cmd.text.slice(0, 150)}..."`)
            emit(`Directive updated: ${cmd.text}`)
            break
          }

          case "notify": {
            if (config.eventBus) {
              config.eventBus.emit({
                type: "agent-notification",
                source: "supervisor",
                agentName,
                projectId: directory,
                data: { message: cmd.message },
              })
              results.push(`Notification broadcast: "${cmd.message.slice(0, 120)}"`)
              emit(`NOTIFY: ${cmd.message}`)
            } else {
              results.push("Event bus not available — notification not sent.")
            }
            break
          }

          case "intent": {
            if (config.resourceManager) {
              config.resourceManager.declareIntent(agentName, cmd.description, cmd.files)
              const conflicts = config.resourceManager.getIntentConflicts(agentName)
              if (conflicts.length > 0) {
                const conflictLines = conflicts.map(c =>
                  `- ${c.theirIntent.agentName} is working on: ${c.theirIntent.description} (overlapping files: ${c.overlappingFiles.join(", ")})`
                ).join("\n")
                const otherWork = config.resourceManager.formatIntentSummary(agentName)
                const redirect = `[REDIRECT] Your intended work overlaps with other agents:\n${conflictLines}\n\nAll active agent intents:\n${otherWork}\n\nAdjust your plan to focus on non-overlapping files/tasks. You can still proceed if the overlap is intentional (e.g., reading shared files), but coordinate to avoid conflicting writes.`
                results.push(redirect)
                emit(`[intent-conflict] ${agentName} overlaps with: ${conflicts.map(c => c.theirIntent.agentName).join(", ")}`)
                config.eventBus?.emit({
                  type: "intent-conflict",
                  source: "supervisor",
                  agentName,
                  data: { conflicts: conflicts.map(c => ({ agent: c.theirIntent.agentName, files: c.overlappingFiles })) },
                })
              } else {
                results.push(`Intent registered: ${cmd.description}${cmd.files.length > 0 ? ` [files: ${cmd.files.join(", ")}]` : ""}`)
              }
              emit(`INTENT: ${cmd.description} [${cmd.files.join(", ")}]`)
            } else {
              results.push("Resource manager not available — intent not tracked.")
            }
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
            cycleHadProgress = true
            // Defer persisting cycle results until post-cycle validation passes.
            // If validation fails with "inject" action, cycleDone is set back to false
            // and these saves must not happen — they would create duplicate entries.
            const cycleSummary = cmd.summary
            const cycleCompleteActions = async () => {
              await addMemoryEntry(memory, {
                timestamp: Date.now(),
                objective: `${agentName} cycle ${cycleCount}: ${directive}`,
                summary: cycleSummary,
                agentLearnings: {},
              }, agentName)
              saveConversationCheckpoint(agentName, cycleCount, directive, messages).catch(err => console.error(`[${agentName}] Failed to save conversation checkpoint: ${err}`))
              emit(`Cycle ${cycleCount} complete: ${cycleSummary}`)
              config.dashboardLog?.push({
                type: "cycle-summary",
                cycle: cycleCount,
                agent: agentName,
                summary: cycleSummary,
              })
              logPerformance({
                timestamp: Date.now(), projectName: directory, agentName, model,
                event: "cycle_complete", cycleNumber: cycleCount,
                durationMs: Date.now() - cycleStartTime, summary: cycleSummary,
              })
              checkpointSupervisor({
                agentName, cycleNumber: cycleCount, lastSummary: cycleSummary,
                directive, status: "running", updatedAt: Date.now(),
              }).catch(err => console.error(`[${agentName}] Failed to checkpoint supervisor state: ${err}`))
              if (analyticsSessionId) {
                recordCycle(analyticsSessionId, cycleCount, cycleSummary, Date.now() - cycleStartTime, { ...commandCounts }).catch(() => {}) // Intentionally silent: best-effort telemetry
              }
              config.onCycleSummary?.(cycleSummary)
              config.onCycleComplete?.(cycleCount)
            }

            // --- Post-cycle validation ---
            if (config.postCycleValidation && (config.postCycleValidation.command || config.postCycleValidation.preset)) {
              const val = resolveValidation(config.postCycleValidation)
              const { timeoutMs, failAction } = val
              emit(`Running post-cycle validation: ${val.command}`)

              try {
                // Use shell to handle paths with spaces, pipes, etc.
                const isWin = process.platform === "win32"
                const shellCmd = isWin
                  ? ["cmd", "/c", val.command]
                  : ["sh", "-c", val.command]
                const proc = Bun.spawn(shellCmd, {
                  cwd: directory,
                  stdout: "pipe",
                  stderr: "pipe",
                })

                const timeoutId = setTimeout(() => { proc.kill() }, timeoutMs)
                const [valStdout, valStderr] = await Promise.all([
                  new Response(proc.stdout).text(),
                  new Response(proc.stderr).text(),
                ])
                clearTimeout(timeoutId)

                const exitCode = await proc.exited
                const passed = exitCode === 0
                const resultText = `[VALIDATION] POST-CYCLE ${passed ? "PASSED" : "FAILED"} (exit ${exitCode}):\n${valStdout.slice(0, 2000)}${valStderr ? "\nSTDERR: " + valStderr.slice(0, 1000) : ""}`

                emit(resultText)
                config.dashboardLog?.push({
                  type: "supervisor-thinking",
                  agent: agentName,
                  text: `[validation] ${passed ? "PASSED" : "FAILED"}: ${val.command}`,
                })
                config.eventBus?.emit({
                  type: "validation-result",
                  source: "supervisor",
                  agentName,
                  data: { passed, command: val.command, exitCode, stdout: valStdout.slice(0, 500) },
                })

                if (!passed) {
                  if (failAction === "inject") {
                    messages.push({ role: "user", content: resultText })
                    cycleDone = false // Re-enter cycle so LLM can fix
                  } else if (failAction === "pause" && config.pauseState) {
                    requestPause(config.pauseState)
                  }
                  // "warn" just logs, doesn't re-enter
                }
              } catch (err) {
                emit(`Validation error: ${err}`)
              }
            }

            // Only persist cycle results if validation passed (or wasn't run).
            // If validation failed with "inject" action, cycleDone was set back to false
            // and we skip this — preventing duplicate memory entries.
            if (cycleDone) {
              await cycleCompleteActions()
            }

            // --- False progress detection ---
            if (cycleDone) {
              try {
                const diffStat = await gitDiffStat(directory)
                const latestCommit = await gitLatestCommit(directory)
                const summaryClaimsWork = cmd.summary.length > 50 &&
                  !/no changes|no progress|blocked|waiting|investigating|reading|reviewing|analyzed/i.test(cmd.summary)

                const hasNewCommits = cycleStartCommit !== "" && latestCommit !== cycleStartCommit
                if (summaryClaimsWork && diffStat.isEmpty && !hasNewCommits) {
                  const warning = `[WARNING] Your cycle summary claims progress but git shows no file changes and no new commits (last commit: ${latestCommit}). Please verify actual state before proceeding.`
                  messages.push({ role: "user", content: warning })
                  emit(`[false-progress] ${warning}`)
                  config.eventBus?.emit({
                    type: "false-progress-warning",
                    source: "supervisor",
                    agentName,
                    data: { summary: cmd.summary, gitEmpty: true, latestCommit },
                  })
                }
              } catch {
                // git not available or not a git repo — skip silently
              }
            }

            // --- Factual diff-based cycle summary ---
            // Generate an objective summary from git to complement the LLM's narrative
            let factualSummary = ""
            if (cycleDone) {
              try {
                const diffStat = await gitDiffStat(directory)
                const latestCommit = await gitLatestCommit(directory)
                const hasNewCommits = cycleStartCommit !== "" && latestCommit !== cycleStartCommit
                const parts: string[] = []
                if (!diffStat.isEmpty) {
                  parts.push(`Files changed: ${diffStat.filesChanged.join(", ")}`)
                  parts.push(`Diff summary: ${diffStat.summary}`)
                }
                if (hasNewCommits) parts.push(`New commits since cycle start (latest: ${latestCommit.slice(0, 8)})`)
                if (diffStat.isEmpty && !hasNewCommits) parts.push("No file changes or new commits this cycle")
                factualSummary = parts.join("; ")
                if (factualSummary) {
                  emit(`[factual-summary] ${factualSummary}`)
                  config.dashboardLog?.push({
                    type: "cycle-summary",
                    cycle: cycleCount,
                    agent: agentName,
                    summary: `[GIT] ${factualSummary}`,
                  })
                }
              } catch {
                // git not available — skip
              }
            }

            // Clear intent on cycle end — agent will re-declare next cycle
            config.resourceManager?.clearIntent(agentName)

            // Emit cycle-done bus event
            config.eventBus?.emit({
              type: "cycle-done",
              source: "supervisor",
              agentName,
              data: { cycleNumber: cycleCount, summary: cmd.summary, factualSummary },
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
            config.resourceManager?.clearIntent(agentName)
            // Detect if this is a failure stop (mentions non-responsive, stuck, failure, cannot, etc.)
            const isFailure = /non-responsive|stuck|fail|cannot|unable|broken|crash|unresponsive|dead/i.test(cmd.summary)
            await addMemoryEntry(memory, {
              timestamp: Date.now(),
              objective: `${agentName} supervisor: ${directive}`,
              summary: cmd.summary,
              agentLearnings: {},
            }, agentName)
            emit(`Supervisor stopping: ${cmd.summary}`)
            config.dashboardLog?.push({
              type: "cycle-summary",
              cycle: cycleCount,
              agent: agentName,
              summary: `[FINAL] ${cmd.summary}`,
            })
            // Checkpoint final state for crash recovery
            checkpointSupervisor({
              agentName, cycleNumber: cycleCount, lastSummary: cmd.summary,
              directive, status: isFailure ? "error" : "done", updatedAt: Date.now(),
            }).catch(err => console.error(`[${agentName}] Failed to checkpoint final supervisor state: ${err}`))
            // Clear conversation checkpoint on clean stop
            clearConversationCheckpoint(agentName).catch(err => console.error(`[${agentName}] Failed to clear conversation checkpoint: ${err}`))
            // Escalate to project manager
            config.onSupervisorStop?.(agentName, cmd.summary, isFailure)
            config.eventBus?.emit({
              type: "supervisor-stop",
              source: "supervisor",
              agentName,
              data: { summary: cmd.summary, isFailure, cycleNumber: cycleCount },
            })
            logPerformance({
              timestamp: Date.now(), projectName: directory, agentName, model,
              event: "supervisor_stop", cycleNumber: cycleCount,
              summary: cmd.summary, details: isFailure ? "failure" : "normal",
              })
              loggedStop = true
              if (isFailure) {
                config.dashboardLog?.push({
                  type: "supervisor-alert",
                  agent: agentName,
                  text: `SUPERVISOR STOPPED (failure): ${cmd.summary}`,
                })
            }
            break
          }
        }
      }

      if (cycleDone || stopped) break

      // Detect unregistered agent — if any command got "Unknown agent", stop immediately
      // This prevents the supervisor from spinning for 5+ cycles against a nonexistent agent
      if (results.some(r => /Unknown agent/i.test(r))) {
        const stopMsg = `Agent "${agentName}" is not registered in the orchestrator. Cannot send commands, read messages, or restart. Stopping supervision — the agent must be added before this supervisor can work.`
        emit(`UNKNOWN AGENT: ${stopMsg}`)
        stopped = true
        logPerformance({
          timestamp: Date.now(), projectName: directory, agentName, model,
          event: "supervisor_stop", cycleNumber: cycleCount,
          summary: stopMsg, details: "unknown-agent",
        })
        loggedStop = true
        config.onSupervisorStop?.(agentName, stopMsg, true)
        config.dashboardLog?.push({
          type: "supervisor-alert",
          agent: agentName,
          text: `SUPERVISOR STOPPED: Agent "${agentName}" is not registered. Add it to orchestrator.json and restart.`,
        })
        break
      }

      // Wait for agent to finish, then collect response
      if (shouldWait) {
        emit(`Waiting for ${agentName} to finish...`)
        const waitResult = await waitForAgent(orchestrator, agentName, 300_000, { signal: config.signal, pauseState: config.pauseState, getUnreadComments: config.getUnreadComments })

        // Stale-busy: agent claims busy but no SSE events — process likely dead
        if (waitResult.reason === "stale") {
          emit(`STALE AGENT: ${agentName} has been silent for ${waitResult.silentSeconds}s while "busy" — likely dead. Restarting.`)
          results.push(`[STALE AGENT] ${agentName} was unresponsive for ${waitResult.silentSeconds}s with no activity. Automatically restarted.`)
          try {
            await orchestrator.prompt(agentName, "/abort")
            await new Promise(r => setTimeout(r, 2000))
          } catch {} // Intentionally silent: best-effort abort on stale agent
          try {
            orchestrator.forceResetAgentStatus(agentName)
          } catch (err) {
            console.error(`[${agentName}] Failed to force-reset agent status after stale detection: ${err}`)
          }
          cycleRestartCount++
          await addBehavioralNote(memory, agentName, `Agent went stale (silent ${waitResult.silentSeconds}s while busy). May need simpler prompts or the opencode process may be unstable.`)
          continue // Skip response collection — retry with next round
        }

        if (waitResult.reason === "user-feedback") {
          emit(`User feedback received — interrupting wait to process it immediately`)
          // Abort current agent work so we can redirect
          try { await orchestrator.prompt(agentName, "/abort") } catch {} // Intentionally silent: best-effort abort to redirect agent
          await new Promise(r => setTimeout(r, 1000))
          // Don't collect response — go straight to next round where mid-cycle feedback injection will fire
          results.push(`[USER FEEDBACK] Interrupted current work to process user feedback.`)
          continue
        }

        // Pause: stop waiting and force-break the cycle — don't keep prompting the LLM
        if (waitResult.reason === "paused") {
          emit(`Pause active — breaking out of agent wait to end cycle.`)
          break
        }

        if (waitResult.reason === "timeout") {
          emit(`TIMEOUT: ${agentName} still busy after 5 minutes (silent for ${waitResult.silentSeconds}s). Will collect whatever is available.`)
        }

        // Collect new response (only messages added after our prompt)
        try {
          const msgs = await orchestrator.getMessages(agentName)
          const newMsgs = msgs.slice(messageCountBefore)
          const lastText = extractLastAssistantText(newMsgs)
          if (lastText) {
            consecutiveEmptyResponses = 0
            cycleHadProgress = true
            // Present worker response as dialogue for Socratic engagement
            results.push(`Worker ${agentName} replied:\n\n${lastText.slice(0, 5000)}\n\nReflect on this response. What did the worker do well? What might they have missed? What should happen next?`)
            config.dashboardLog?.push({ type: "agent-response", agent: agentName, text: lastText })
            recordPrompt({
              source: "agent", target: "supervisor", direction: "inbound",
              projectName: directory, agentName, model, cycleNumber: cycleCount,
              sessionId: analyticsSessionId ?? undefined,
              content: lastText,
            }).catch(() => {}) // Intentionally silent: best-effort prompt ledger
          } else {
            // Agent responded with empty content — track and escalate
            consecutiveEmptyResponses++
            emit(`WARNING: ${agentName} returned empty response (${consecutiveEmptyResponses} consecutive)`)

            if (consecutiveEmptyResponses >= 3) {
              // Check restart cap FIRST — before attempting any restart
              if (cycleRestartCount >= MAX_RESTARTS_PER_CYCLE) {
                // Hit the per-cycle restart cap — end this cycle immediately
                emit(`RESTART CAP: ${agentName} hit ${MAX_RESTARTS_PER_CYCLE} restarts this cycle — ending cycle early`)
                results.push(`Agent hit restart cap (${MAX_RESTARTS_PER_CYCLE} restarts this cycle). Ending cycle — will retry next cycle with longer pause.`)
                // Only save behavioral note once per cap-hit (not every empty response)
                if (!restartCapHit) {
                  await addBehavioralNote(memory, agentName, `Agent hit restart cap (${MAX_RESTARTS_PER_CYCLE} restarts in cycle ${cycleCount}). Agent needs much simpler prompts — one action per prompt, no multi-step tasks.`)
                }
                restartCapHit = true
                break
              }

              // Check if this might be a rate-limit issue rather than a stuck agent
              // If we've been getting 429s recently, don't restart — just wait longer
              if (consecutive429s > 0) {
                const rateLimitPause = Math.min(60_000 * consecutive429s, 300_000)
                emit(`Agent ${agentName} empty responses likely caused by rate-limiting (${consecutive429s} recent 429s) — waiting ${rateLimitPause / 1000}s instead of restarting`)
                results.push(`Agent empty responses appear to be rate-limit related. Waiting ${rateLimitPause / 1000}s before retrying. Not restarting — the agent isn't broken, just throttled.`)
                await new Promise(r => setTimeout(r, rateLimitPause))
                consecutiveEmptyResponses = 0
              } else {
                // Genuine non-responsiveness — restart with enforced backoff
                const emptyCount = consecutiveEmptyResponses
                // Enforce minimum gap between restarts (prevents interleaved rapid-fire)
                const timeSinceLast = Date.now() - lastRestartTimestamp
                const minGapMs = RESTART_BACKOFF_BASE
                if (lastRestartTimestamp > 0 && timeSinceLast < minGapMs) {
                  const gapWait = minGapMs - timeSinceLast
                  emit(`Throttling auto-restart — only ${Math.round(timeSinceLast / 1000)}s since last restart, waiting ${Math.round(gapWait / 1000)}s...`)
                  await new Promise(r => setTimeout(r, gapWait))
                }
                // Escalating backoff: 30s, 60s, 120s, 240s
                const backoffMs = RESTART_BACKOFF_BASE * Math.pow(2, Math.min(cycleRestartCount, 4))
                emit(`Agent ${agentName} has returned ${emptyCount} consecutive empty responses — restarting session (attempt ${cycleRestartCount + 1}/${MAX_RESTARTS_PER_CYCLE}, backoff ${backoffMs / 1000}s)...`)
                await new Promise(r => setTimeout(r, backoffMs))
                try {
                  const newSession = await orchestrator.restartAgent(agentName)
                  cycleRestartCount++
                  lastRestartTimestamp = Date.now()
                  consecutiveEmptyResponses = 0
                  results.push(`Agent was non-responsive (${emptyCount} empty responses). Session restarted (attempt ${cycleRestartCount}/${MAX_RESTARTS_PER_CYCLE}): ${newSession}. Re-send your last task.`)
                  logPerformance({
                    timestamp: Date.now(), projectName: directory, agentName, model,
                    event: "restart", cycleNumber: cycleCount, details: "empty-response escalation",
                  })
                  // Only save behavioral note on first restart, not every one
                  if (cycleRestartCount === 1) {
                    await addBehavioralNote(memory, agentName, `Agent non-responsive (${emptyCount} empty responses in cycle ${cycleCount}). Restarted session. Use short, single-action prompts. Avoid multi-step instructions.`)
                  }
                } catch (err) {
                  results.push(`Agent non-responsive and restart failed: ${err}`)
                }
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
        } catch (err) {
          emit(`WARNING: Failed to collect agent response: ${err}`)
        }
      }

      // --- Resource contention check + auto-redirect ---
      if (config.resourceManager && cycleHadProgress) {
        try {
          const changedFiles = await gitDiffNameOnly(directory)
          if (changedFiles.length > 0) {
            config.resourceManager.acquireFiles(agentName, changedFiles)
            const conflicts = config.resourceManager.getConflicts(agentName, changedFiles)
            if (conflicts.length > 0) {
              const conflictMsg = conflicts.map(c =>
                `- ${c.file} is also being modified by ${c.heldBy}`
              ).join("\n")
              const otherIntents = config.resourceManager.formatIntentSummary(agentName)
              const redirect = `[REDIRECT] File contention detected — these files are also being modified by another agent:\n${conflictMsg}\n\nOther agents' declared work:\n${otherIntents}\n\nRedirect your next task to non-overlapping files. If you must edit a contested file, use NOTIFY to coordinate timing with the other agent.`
              results.push(redirect)
              config.eventBus?.emit({
                type: "resource-contention",
                source: "supervisor",
                agentName,
                data: { conflicts, changedFiles },
              })
            }
          }
        } catch { /* git unavailable — skip */ }
      }

      // Feed results back to LLM
      if (results.length > 0) {
        messages.push({ role: "user", content: results.join("\n\n") })
      }
    }

    if (stopped || config.signal?.aborted) break

    // Pause service: if pause was requested, block here until resumed
    if (config.pauseState && isPauseRequested(config.pauseState)) {
      emit(`Pause active — ${agentName} supervisor paused after cycle ${cycleCount}. Waiting for resume...`)
      emitStatus("paused")
      recordPrompt({
        source: "system", target: agentName, direction: "outbound",
        projectName: directory, agentName, model, cycleNumber: cycleCount,
        sessionId: analyticsSessionId ?? undefined,
        content: `Supervisor paused after cycle ${cycleCount}`,
        tags: ["pause-entered"],
      }).catch(() => {}) // Intentionally silent: best-effort prompt ledger
      config.eventBus?.emit({ type: "pause-entered", source: "supervisor", agentName, data: { cycleNumber: cycleCount } })
      await awaitResume(config.pauseState, config.signal)
      pauseInjected = false // reset so next pause request can inject again
      emit(`${agentName} supervisor resumed.`)
      emitStatus("running")
      config.eventBus?.emit({ type: "pause-exited", source: "supervisor", agentName, data: { cycleNumber: cycleCount } })
      continue // skip normal timer, start next cycle immediately
    }

    // Dynamic cycle pause — adjust based on agent activity
    if (consecutive429s > 0) {
      // Rate-limited — longer pause but don't count as agent failure
      // The agent isn't broken, the API is throttling us
      const rateLimitPause = Math.min(60_000 * consecutive429s, 300_000) // 60s, 120s, ... up to 5min
      cyclePause = Math.max(rateLimitPause, baseCyclePause)
      emit(`Rate-limited (${consecutive429s} consecutive 429s) — next cycle pause: ${Math.round(cyclePause / 1000)}s`)
      // Reset 429 counter after applying the pause — we've already backed off, and if the API
      // is still rate-limiting, the next 429 will re-increment the counter.
      consecutive429s = 0
      // Don't increment consecutiveIdleCycles — this isn't the agent's fault
    } else if (consecutiveEmptyResponses > 0 || cycleRestartCount > 0) {
      // Agent genuinely struggling — exponential backoff
      consecutiveIdleCycles++
      const backoffMultiplier = Math.min(consecutiveIdleCycles, 6)
      cyclePause = Math.min(baseCyclePause * backoffMultiplier, 300_000) // cap at 5 minutes
      emit(`Agent responsiveness low — next cycle pause: ${Math.round(cyclePause / 1000)}s`)
    } else if (cycleHadProgress) {
      // Agent productive — reset backoff
      consecutiveIdleCycles = 0
      cyclePause = baseCyclePause
    }

    // Circuit breaker — if too many consecutive failed cycles, pause supervision
    if (restartCapHit) {
      consecutiveFailedCycles++
      if (consecutiveFailedCycles >= MAX_CONSECUTIVE_FAILED_CYCLES) {
        emit(`CIRCUIT BREAKER: ${agentName} has hit restart caps ${consecutiveFailedCycles} cycles in a row — pausing supervision`)
        config.dashboardLog?.push({
          type: "supervisor-alert",
          agent: agentName,
          text: `CIRCUIT BREAKER: Supervisor paused after ${consecutiveFailedCycles} consecutive failed cycles. Agent ${agentName} is persistently non-responsive. Consider adjusting directive or restarting the project.`,
        })
        logPerformance({
          timestamp: Date.now(), projectName: directory, agentName, model,
          event: "supervisor_stop", cycleNumber: cycleCount,
          summary: `Circuit breaker: ${consecutiveFailedCycles} consecutive failed cycles, agent persistently non-responsive`,
          details: "circuit-breaker",
        })
        loggedStop = true
        await addBehavioralNote(memory, agentName, `CRITICAL: Agent was persistently non-responsive across ${consecutiveFailedCycles} cycles. Circuit breaker triggered. This agent needs fundamentally different prompts — keep to one simple action, or consider restructuring the directive.`)
        // Stop this supervisor — the project manager can restart it or the user can intervene
        config.onSupervisorStop?.(agentName, `Circuit breaker triggered after ${consecutiveFailedCycles} consecutive failed cycles — agent is persistently non-responsive`, true)
        break
      }
    } else if (cycleRestartCount === 0) {
      // Reset failed cycle counter if the cycle had no restarts at all
      consecutiveFailedCycles = 0
    }

    // Check soft stop — intentionally before pause check: soft stop (exit) takes priority over pause (hold)
    if (config.softStop?.requested) {
      emit(`Soft stop — ${agentName} supervisor finishing after cycle ${cycleCount}.`)
      await addMemoryEntry(await loadBrainMemory(), {
        timestamp: Date.now(),
        objective: `${agentName} supervisor: ${directive}`,
        summary: `Soft-stopped after cycle ${cycleCount}.`,
        agentLearnings: {},
      }, agentName)
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
  if (!loggedStop) {
    logPerformance({
      timestamp: Date.now(), projectName: directory, agentName, model,
      event: "supervisor_stop", cycleNumber: cycleCount,
      summary: `Supervisor ended after ${cycleCount} cycles`,
      details: consecutiveFailedCycles > 0 ? "completed-with-failures" : "normal",
    })
  }

  // End analytics session
  if (analyticsSessionId) {
    const sessionStatus = consecutiveFailedCycles > 0 ? "failed" as const : "completed" as const
    endSession(analyticsSessionId, sessionStatus).catch(err => console.error(`[${agentName}] Failed to end analytics session: ${err}`))
  }
}

// ---------------------------------------------------------------------------
// Supervisor scheduling — parallel or sequential
// ---------------------------------------------------------------------------

/** Build a supervisor config for a single agent */
function buildAgentSupervisorConfig(
  orchestrator: Orchestrator,
  config: ParallelSupervisorsConfig,
  agentName: string,
  agentDirectory: string,
  maxCycles?: number,
): Parameters<typeof runAgentSupervisor>[1] {
  const projectRole = config.projects?.[agentName]
  return {
    ollamaUrl: config.ollamaUrl,
    model: config.model,
    agentName,
    directory: agentDirectory,
    directive: config.directive,
    cyclePauseSeconds: config.cyclePauseSeconds,
    maxRoundsPerCycle: config.maxRoundsPerCycle,
    reviewEnabled: config.reviewEnabled ?? true,
    reviewerAgent: projectRole?.reviewer,
    limits: config.supervisorLimits,
    onThinking: (thought) => config.onThinking?.(agentName, thought),
    dashboardLog: config.dashboardLog,
    signal: config.signal,
    softStop: config.softStop,
    maxCycles,
  }
}

/** Run all supervisors in parallel (original behavior) */
async function runAllParallel(
  orchestrator: Orchestrator,
  config: ParallelSupervisorsConfig,
  agents: [string, { config: { directory: string } }][],
): Promise<void> {
  config.dashboardLog?.push({
    type: "brain-thinking",
    text: `[parallel] Starting ${agents.length} supervisors simultaneously`,
  })

  const supervisors = agents.map(([name, state]) =>
    runAgentSupervisor(orchestrator, buildAgentSupervisorConfig(orchestrator, config, name, state.config.directory))
  )

  const results = await Promise.allSettled(supervisors)
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    if (r.status === "rejected") {
      const name = agents[i]![0]
      const errMsg = `Supervisor for ${name} failed: ${r.reason}`
      config.dashboardLog?.push({ type: "brain-thinking", text: errMsg })
      config.onThinking?.(name, errMsg)
    }
  }
}

/**
 * Run supervisors sequentially in batches, rotating through agents.
 * Each agent gets `cyclesPerRotation` cycles before the next batch starts.
 * Only `concurrency` agents run at a time, dramatically reducing API pressure.
 */
async function runSequential(
  orchestrator: Orchestrator,
  config: ParallelSupervisorsConfig,
  agents: [string, { config: { directory: string } }][],
): Promise<void> {
  const concurrency = config.concurrency ?? 1
  const cyclesPerRotation = config.cyclesPerRotation ?? 2

  if (agents.length === 0) {
    config.dashboardLog?.push({ type: "brain-thinking", text: "[sequential] No agents to supervise — exiting." })
    return
  }

  config.dashboardLog?.push({
    type: "brain-thinking",
    text: `[sequential] Rotating ${agents.length} agents, ${concurrency} at a time, ${cyclesPerRotation} cycles each`,
  })

  // Keep rotating until stopped
  let rotationCount = 0
  while (!config.signal?.aborted && !config.softStop?.requested) {
    rotationCount++
    config.dashboardLog?.push({
      type: "brain-thinking",
      text: `[sequential] Rotation #${rotationCount} — cycling through ${agents.length} agents`,
    })

    // Process agents in batches of `concurrency`
    for (let i = 0; i < agents.length; i += concurrency) {
      if (config.signal?.aborted || config.softStop?.requested) break

      const batch = agents.slice(i, i + concurrency)
      const batchNames = batch.map(([name]) => name).join(", ")
      config.onThinking?.(batch[0]![0], `[sequential] Running batch: ${batchNames} (${cyclesPerRotation} cycles each)`)

      const batchSupervisors = batch.map(([name, state]) =>
        runAgentSupervisor(
          orchestrator,
          buildAgentSupervisorConfig(orchestrator, config, name, state.config.directory, cyclesPerRotation),
        )
      )

      const results = await Promise.allSettled(batchSupervisors)
      for (let j = 0; j < results.length; j++) {
        const r = results[j]!
        if (r.status === "rejected") {
          const name = batch[j]![0]
          const errMsg = `Supervisor for ${name} failed: ${r.reason}`
          config.dashboardLog?.push({ type: "brain-thinking", text: errMsg })
          config.onThinking?.(name, errMsg)
        }
      }

      // Brief pause between batches to let API quotas recover
      if (i + concurrency < agents.length && !config.signal?.aborted && !config.softStop?.requested) {
        const batchPauseMs = 5_000
        await new Promise(r => setTimeout(r, batchPauseMs))
      }
    }
  }
}

export async function runParallelSupervisors(
  orchestrator: Orchestrator,
  config: ParallelSupervisorsConfig,
): Promise<void> {
  const agents = Array.from(orchestrator.agents.entries())
  const mode = config.scheduling ?? "parallel"

  config.dashboardLog?.push({ type: "brain-status", status: "running" })
  config.dashboardLog?.push({
    type: "brain-thinking",
    text: `Starting ${agents.length} supervisors in ${mode} mode. Directive: "${config.directive}"`,
  })

  if (mode === "sequential") {
    await runSequential(orchestrator, config, agents)
  } else {
    await runAllParallel(orchestrator, config, agents)
  }

  config.dashboardLog?.push({
    type: "brain-thinking",
    text: `All ${agents.length} supervisors finished (${mode} mode).`,
  })
}
