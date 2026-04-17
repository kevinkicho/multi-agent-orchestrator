import { describe, test, expect } from "bun:test"
import {
  createNudgeState, resetNudge,
  buildEmptyNudge, buildNoParseNudge, fuzzyExtractCommands,
  createCircuitBreaker, recordFailure, recordSuccess, isTripped,
  SUPERVISOR_COMMANDS, BRAIN_COMMANDS, MANAGER_COMMANDS,
  SUPERVISOR_DEFAULT_CMD, BRAIN_DEFAULT_CMD, MANAGER_DEFAULT_CMD,
} from "../command-recovery"

// ---------------------------------------------------------------------------
// Escalating empty nudges
// ---------------------------------------------------------------------------

describe("buildEmptyNudge — escalating", () => {
  test("level 1: gentle reminder", () => {
    const state = createNudgeState()
    const msg = buildEmptyNudge(state, SUPERVISOR_COMMANDS, SUPERVISOR_DEFAULT_CMD)
    expect(msg).toContain("empty")
    expect(msg).toContain("@")
    expect(state.consecutiveEmpty).toBe(1)
  })

  test("level 2: includes format example", () => {
    const state = createNudgeState()
    buildEmptyNudge(state, BRAIN_COMMANDS, BRAIN_DEFAULT_CMD) // level 1
    const msg = buildEmptyNudge(state, BRAIN_COMMANDS, BRAIN_DEFAULT_CMD) // level 2
    expect(msg).toContain("@check")
    expect(state.consecutiveEmpty).toBe(2)
  })

  test("level 3+: forces default command", () => {
    const state = createNudgeState()
    buildEmptyNudge(state, MANAGER_COMMANDS, MANAGER_DEFAULT_CMD) // 1
    buildEmptyNudge(state, MANAGER_COMMANDS, MANAGER_DEFAULT_CMD) // 2
    const msg = buildEmptyNudge(state, MANAGER_COMMANDS, MANAGER_DEFAULT_CMD) // 3
    expect(msg).toContain(MANAGER_DEFAULT_CMD)
    expect(state.consecutiveEmpty).toBe(3)
  })

  test("level 4 still forces default command", () => {
    const state = createNudgeState()
    for (let i = 0; i < 3; i++) buildEmptyNudge(state, BRAIN_COMMANDS, BRAIN_DEFAULT_CMD)
    const msg = buildEmptyNudge(state, BRAIN_COMMANDS, BRAIN_DEFAULT_CMD)
    expect(msg).toContain("4 empty responses")
    expect(msg).toContain(BRAIN_DEFAULT_CMD)
  })
})

// ---------------------------------------------------------------------------
// Escalating no-parse nudges
// ---------------------------------------------------------------------------

describe("buildNoParseNudge — escalating with feedback", () => {
  test("level 1: shows failed lines and mentions @ markers", () => {
    const state = createNudgeState()
    const badResponse = "I think we should do something\nLet me check the status"
    const msg = buildNoParseNudge(state, badResponse, SUPERVISOR_COMMANDS, SUPERVISOR_DEFAULT_CMD)
    expect(msg).toContain("not recognized")
    expect(msg).toContain("I think we should do something")
    expect(msg).toContain("@ markers")
    expect(state.consecutiveNoParse).toBe(1)
    expect(state.lastFailedLines.length).toBeGreaterThan(0)
  })

  test("level 2: shows format example", () => {
    const state = createNudgeState()
    buildNoParseNudge(state, "bad", BRAIN_COMMANDS, BRAIN_DEFAULT_CMD)
    const msg = buildNoParseNudge(state, "still bad", BRAIN_COMMANDS, BRAIN_DEFAULT_CMD)
    expect(msg).toContain("@worker:")
    expect(msg).toContain(BRAIN_DEFAULT_CMD)
    expect(state.consecutiveNoParse).toBe(2)
  })

  test("level 3+: forces default command", () => {
    const state = createNudgeState()
    for (let i = 0; i < 2; i++) buildNoParseNudge(state, "x", MANAGER_COMMANDS, MANAGER_DEFAULT_CMD)
    const msg = buildNoParseNudge(state, "still nothing", MANAGER_COMMANDS, MANAGER_DEFAULT_CMD)
    expect(msg).toContain(MANAGER_DEFAULT_CMD)
    expect(msg).toContain("not issued a valid action 3 times")
  })

  test("truncates long failed lines", () => {
    const state = createNudgeState()
    const longLine = "A".repeat(200)
    const msg = buildNoParseNudge(state, longLine, SUPERVISOR_COMMANDS, SUPERVISOR_DEFAULT_CMD)
    // Line should be truncated to 80 chars in the feedback
    expect(msg).not.toContain("A".repeat(200))
    expect(msg).toContain("A".repeat(80))
  })
})

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("resetNudge", () => {
  test("clears all counters", () => {
    const state = createNudgeState()
    buildEmptyNudge(state, BRAIN_COMMANDS, BRAIN_DEFAULT_CMD)
    buildNoParseNudge(state, "bad", BRAIN_COMMANDS, BRAIN_DEFAULT_CMD)
    expect(state.consecutiveEmpty).toBe(1)
    expect(state.consecutiveNoParse).toBe(1)

    resetNudge(state)
    expect(state.consecutiveEmpty).toBe(0)
    expect(state.consecutiveNoParse).toBe(0)
    expect(state.lastFailedLines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Fuzzy command extraction
// ---------------------------------------------------------------------------

describe("fuzzyExtractCommands", () => {
  test("extracts commands from numbered list", () => {
    const prose = `Here's what I'll do:
1. MESSAGES
2. PROMPT Fix the bug in auth.ts
3. WAIT`
    const extracted = fuzzyExtractCommands(prose, SUPERVISOR_COMMANDS)
    expect(extracted).toEqual(["MESSAGES", "PROMPT Fix the bug in auth.ts", "WAIT"])
  })

  test("extracts commands from bullet points", () => {
    const prose = `My plan:
- STATUS
- PROMPT agent-1 Do the thing
- WAIT`
    const extracted = fuzzyExtractCommands(prose, BRAIN_COMMANDS)
    expect(extracted).toEqual(["STATUS", "PROMPT agent-1 Do the thing", "WAIT"])
  })

  test("extracts commands from backtick-wrapped lines", () => {
    const prose = "I'll run:\n`MESSAGES`\nthen:\n`WAIT`"
    const extracted = fuzzyExtractCommands(prose, SUPERVISOR_COMMANDS)
    expect(extracted).toEqual(["MESSAGES", "WAIT"])
  })

  test("ignores non-command prose", () => {
    const prose = "I think the agent needs to focus on testing.\nThe current approach seems good."
    const extracted = fuzzyExtractCommands(prose, SUPERVISOR_COMMANDS)
    expect(extracted).toEqual([])
  })

  test("handles mixed prose and commands", () => {
    const prose = `Let me update the directive.
DIRECTIVE frontend Focus on the login page
Then we'll wait for results.`
    const extracted = fuzzyExtractCommands(prose, MANAGER_COMMANDS)
    expect(extracted).toEqual(["DIRECTIVE frontend Focus on the login page"])
  })

  test("extracts standalone keyword commands", () => {
    const prose = "> STATUS_CHECK"
    const extracted = fuzzyExtractCommands(prose, MANAGER_COMMANDS)
    expect(extracted).toEqual(["STATUS_CHECK"])
  })
})

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  test("starts untripped with zero failures", () => {
    const cb = createCircuitBreaker(3)
    expect(cb.consecutiveFailures).toBe(0)
    expect(cb.tripped).toBe(false)
    expect(isTripped(cb)).toBe(false)
  })

  test("trips after threshold failures", () => {
    const cb = createCircuitBreaker(3)
    expect(recordFailure(cb)).toBe(false) // 1
    expect(recordFailure(cb)).toBe(false) // 2
    expect(recordFailure(cb)).toBe(true)  // 3 — trips
    expect(isTripped(cb)).toBe(true)
    expect(cb.consecutiveFailures).toBe(3)
  })

  test("does not re-trip after already tripped", () => {
    const cb = createCircuitBreaker(2)
    recordFailure(cb) // 1
    expect(recordFailure(cb)).toBe(true) // 2 — trips
    expect(recordFailure(cb)).toBe(false) // 3 — already tripped
    expect(cb.consecutiveFailures).toBe(3)
  })

  test("success resets counter and untrips", () => {
    const cb = createCircuitBreaker(3)
    recordFailure(cb)
    recordFailure(cb)
    recordSuccess(cb)
    expect(cb.consecutiveFailures).toBe(0)
    expect(isTripped(cb)).toBe(false)
  })

  test("can trip again after reset", () => {
    const cb = createCircuitBreaker(2)
    recordFailure(cb)
    expect(recordFailure(cb)).toBe(true) // trips
    recordSuccess(cb) // reset
    recordFailure(cb)
    expect(recordFailure(cb)).toBe(true) // trips again
  })

  test("records failure timestamp", () => {
    const cb = createCircuitBreaker(3)
    const before = Date.now()
    recordFailure(cb)
    expect(cb.lastFailureAt).toBeGreaterThanOrEqual(before)
  })
})

// ---------------------------------------------------------------------------
// Command lists are non-empty
// ---------------------------------------------------------------------------

describe("command lists", () => {
  test("all command lists are populated", () => {
    expect(SUPERVISOR_COMMANDS.length).toBeGreaterThan(5)
    expect(BRAIN_COMMANDS.length).toBeGreaterThan(3)
    expect(MANAGER_COMMANDS.length).toBeGreaterThan(3)
  })

  test("default commands are in their respective lists", () => {
    expect(SUPERVISOR_COMMANDS).toContain(SUPERVISOR_DEFAULT_CMD)
    expect(BRAIN_COMMANDS).toContain(BRAIN_DEFAULT_CMD)
    expect(MANAGER_COMMANDS).toContain(MANAGER_DEFAULT_CMD)
  })
})
