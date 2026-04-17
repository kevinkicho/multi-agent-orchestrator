// ---------------------------------------------------------------------------
// Command Recovery — shared LLM resilience utilities for all 3 orchestration layers
// ---------------------------------------------------------------------------
// Provides: escalating nudges, parse feedback, fuzzy command extraction, circuit breaker

/** Tracks nudge escalation state for a single LLM conversation loop */
export type NudgeState = {
  consecutiveEmpty: number   // empty responses (no text at all)
  consecutiveNoParse: number // responses with text but no parseable commands
  lastFailedLines: string[]  // lines that didn't parse (for feedback)
}

export function createNudgeState(): NudgeState {
  return { consecutiveEmpty: 0, consecutiveNoParse: 0, lastFailedLines: [] }
}

/** Reset nudge state (call after a successful parse) */
export function resetNudge(state: NudgeState): void {
  state.consecutiveEmpty = 0
  state.consecutiveNoParse = 0
  state.lastFailedLines = []
}

// ---------------------------------------------------------------------------
// Escalating nudge messages
// ---------------------------------------------------------------------------

/**
 * Build an escalating nudge message for empty LLM responses.
 * Level 1: gentle reminder. Level 2: show format. Level 3: forced simple command.
 */
export function buildEmptyNudge(state: NudgeState, validCommands: string[], defaultCommand: string): string {
  state.consecutiveEmpty++

  if (state.consecutiveEmpty === 1) {
    return "Your previous response was empty. Think about the current situation and then take an action using an @ marker, like @check to see what the worker has been doing."
  }

  if (state.consecutiveEmpty === 2) {
    return `Your response was empty again. Please respond with your thinking followed by an action. For example:

Let me check what the worker has been up to.

@check`
  }

  // Level 3+: force the simplest possible action
  return `You have sent ${state.consecutiveEmpty} empty responses in a row. Please respond with:

${defaultCommand}`
}

/**
 * Build an escalating nudge for responses that contain text but no parseable commands.
 * Includes feedback about which lines failed to parse.
 */
export function buildNoParseNudge(
  state: NudgeState,
  response: string,
  validCommands: string[],
  defaultCommand: string,
): string {
  state.consecutiveNoParse++

  // Collect unparseable non-empty lines for feedback
  const lines = response.split("\n").map(l => l.trim()).filter(l => l.length > 0)
  // Keep up to 3 failed lines for context
  state.lastFailedLines = lines.slice(0, 3)

  const failedFeedback = state.lastFailedLines.length > 0
    ? `\nThese lines were not recognized as commands:\n${state.lastFailedLines.map(l => `  ❌ "${l.slice(0, 80)}"`).join("\n")}\n`
    : ""

  if (state.consecutiveNoParse === 1) {
    return `${failedFeedback}
I couldn't find any actions in your response. Use @ markers to take action. For example:

@check

to see what the worker has been doing, or:

@worker: Your message to the worker here

Available markers: @worker:, @check, @review, @restart, @abort, @note:, @lesson:, @directive:, @broadcast:, @intent:, @done:, @stop:`
  }

  if (state.consecutiveNoParse === 2) {
    return `${failedFeedback}
Your response still had no recognizable actions. Each action must start with @ at the beginning of a line. Example:

@check

Or to talk to the worker:

@worker: Please check the current test results and report what's failing.

Try using ${defaultCommand} now.`
  }

  // Level 3+: force action
  return `${failedFeedback}
You have not issued a valid action ${state.consecutiveNoParse} times. Please respond with ONLY this:

${defaultCommand}`
}

// ---------------------------------------------------------------------------
// Fuzzy command extraction — attempt to recover commands from prose
// ---------------------------------------------------------------------------

/**
 * Try to extract commands from prose text that lacks a code block.
 * Looks for lines that start with known command keywords even without ``` wrapping.
 * Returns extracted lines (caller runs them through the normal parser).
 */
export function fuzzyExtractCommands(response: string, knownPrefixes: string[]): string[] {
  const extracted: string[] = []
  const lines = response.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Strip common prose patterns: "1.", "- ", "* ", "> "
    const cleaned = trimmed
      .replace(/^\d+\.\s*/, "")
      .replace(/^[-*>]\s*/, "")
      .replace(/^`+/, "")
      .replace(/`+$/, "")
      .trim()

    for (const prefix of knownPrefixes) {
      if (cleaned.startsWith(prefix + " ") || cleaned === prefix) {
        extracted.push(cleaned)
        break
      }
    }
  }

  return extracted
}

// ---------------------------------------------------------------------------
// Circuit breaker — generic consecutive-failure tracker
// ---------------------------------------------------------------------------

export type CircuitBreakerState = {
  consecutiveFailures: number
  threshold: number
  lastFailureAt: number
  tripped: boolean
}

export function createCircuitBreaker(threshold: number): CircuitBreakerState {
  return { consecutiveFailures: 0, threshold, lastFailureAt: 0, tripped: false }
}

/** Record a failure. Returns true if the circuit breaker just tripped. */
export function recordFailure(cb: CircuitBreakerState): boolean {
  cb.consecutiveFailures++
  cb.lastFailureAt = Date.now()
  if (cb.consecutiveFailures >= cb.threshold && !cb.tripped) {
    cb.tripped = true
    return true
  }
  return false
}

/** Record a success — resets the counter. */
export function recordSuccess(cb: CircuitBreakerState): void {
  cb.consecutiveFailures = 0
  cb.tripped = false
}

/** Check if the breaker is currently tripped. */
export function isTripped(cb: CircuitBreakerState): boolean {
  return cb.tripped
}

// ---------------------------------------------------------------------------
// Command lists for each layer (used by nudges and fuzzy extraction)
// ---------------------------------------------------------------------------

export const SUPERVISOR_COMMANDS = [
  // Socratic @ markers (primary)
  "@worker:", "@check", "@review", "@restart", "@abort",
  "@note:", "@lesson:", "@directive:", "@broadcast:", "@intent:",
  "@done:", "@stop:",
  // Legacy UPPERCASE commands (fallback)
  "PROMPT", "WAIT", "MESSAGES", "REVIEW", "RESTART", "ABORT",
  "NOTE", "NOTE_BEHAVIOR", "DIRECTIVE", "NOTIFY", "INTENT",
  "CYCLE_DONE", "STOP",
]

export const BRAIN_COMMANDS = [
  "PROMPT", "PROMPT_ALL", "STATUS", "MESSAGES", "WAIT", "NOTE", "DONE",
]

export const MANAGER_COMMANDS = [
  "DIRECTIVE", "PRIORITIZE", "NOTE", "HIRE", "DISSOLVE",
  "STATUS_CHECK", "MANAGER_DONE",
]

export const SUPERVISOR_DEFAULT_CMD = "@check"
export const BRAIN_DEFAULT_CMD = "STATUS"
export const MANAGER_DEFAULT_CMD = "STATUS_CHECK"
