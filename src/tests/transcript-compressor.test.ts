import { describe, test, expect } from "bun:test"
import {
  estimateTokens,
  estimateMessagesTokens,
  selectMiddleZone,
  shouldCompress,
  parseSummarySections,
  isWellFormedSummary,
  createCompressorState,
  SUMMARY_SECTIONS,
  type LLMMessage,
} from "../transcript-compressor"

describe("estimateTokens", () => {
  test("zero for empty string", () => {
    expect(estimateTokens("")).toBe(0)
  })

  test("char/4 heuristic", () => {
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcdefgh")).toBe(2)
    // Ceil so a single char still counts as 1 token
    expect(estimateTokens("a")).toBe(1)
  })
})

describe("estimateMessagesTokens", () => {
  test("sums content plus per-message overhead", () => {
    const msgs: LLMMessage[] = [
      { role: "system", content: "abcd" },       // 1 + 4 = 5
      { role: "user", content: "abcdefgh" },     // 2 + 4 = 6
      { role: "assistant", content: "" },        // 0 + 4 = 4
    ]
    expect(estimateMessagesTokens(msgs)).toBe(15)
  })
})

describe("selectMiddleZone", () => {
  test("returns null when transcript is too short to compress", () => {
    const msgs: LLMMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]
    expect(selectMiddleZone(msgs, 2, 8)).toBeNull()
  })

  test("protects head + tail, returns middle window", () => {
    const msgs: LLMMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `m${i}`,
    }))
    msgs.unshift({ role: "system", content: "sys" })
    const zone = selectMiddleZone(msgs, 2, 8)
    expect(zone).not.toBeNull()
    expect(zone!.startIdx).toBe(3)          // 1 (system) + 2 (headProtect)
    expect(zone!.endIdx).toBe(21 - 8)       // length - tailProtect
  })

  test("handles transcripts without a system prompt", () => {
    const msgs: LLMMessage[] = Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `m${i}`,
    }))
    const zone = selectMiddleZone(msgs, 2, 5)
    expect(zone).not.toBeNull()
    expect(zone!.startIdx).toBe(2)          // 0 + headProtect
    expect(zone!.endIdx).toBe(10)           // 15 - 5
  })
})

describe("shouldCompress", () => {
  test("skips below threshold", () => {
    const state = createCompressorState()
    const result = shouldCompress(state, 10_000, 40_000)
    expect(result.compress).toBe(false)
    expect(result.reason).toContain("below threshold")
  })

  test("compresses when over threshold and no prior state", () => {
    const state = createCompressorState()
    const result = shouldCompress(state, 50_000, 40_000)
    expect(result.compress).toBe(true)
  })

  test("skips due to anti-thrash when last save was weak and growth was small", () => {
    const state = createCompressorState()
    state.lastSaveRatio = 0.05  // last compression only saved 5%
    state.postCompressionTokens = 45_000
    // Currently at 48k — only grew by 6.6% since last compression
    const result = shouldCompress(state, 48_000, 40_000)
    expect(result.compress).toBe(false)
    expect(result.reason).toContain("anti-thrash")
  })

  test("compresses when last save was strong even if growth is small", () => {
    const state = createCompressorState()
    state.lastSaveRatio = 0.40  // last compression saved 40%
    state.postCompressionTokens = 24_000
    const result = shouldCompress(state, 42_000, 40_000)
    expect(result.compress).toBe(true)
  })

  test("compresses when conversation grew substantially even if last save was weak", () => {
    const state = createCompressorState()
    state.lastSaveRatio = 0.05
    state.postCompressionTokens = 20_000
    // Grew to 50k — 2.5x since last compression
    const result = shouldCompress(state, 50_000, 40_000)
    expect(result.compress).toBe(true)
  })
})

describe("parseSummarySections", () => {
  const wellFormed = `## Active Task
Migrating auth middleware to the new pattern.

## Goal
Comply with legal requirements for session token storage.

## Completed Actions
- Updated src/auth.ts to use secure cookie flags
- Wrote tests in src/tests/auth.test.ts

## Active State
Branch: auth-migration, tests passing, 2 commits ahead of main.

## Resolved Questions
- Q: should tokens persist across sessions? A: no, session-only.

## Pending Asks
(none)

## Remaining Work
- Remove legacy token storage code
- Update downstream consumers`

  test("parses all seven sections", () => {
    const parsed = parseSummarySections(wellFormed)
    for (const section of SUMMARY_SECTIONS) {
      expect(parsed[section]).toBeDefined()
    }
    expect(parsed["Active Task"]).toContain("Migrating auth")
    expect(parsed["Remaining Work"]).toContain("legacy token storage")
  })

  test("accepts well-formed summary", () => {
    expect(isWellFormedSummary(wellFormed)).toBe(true)
  })

  test("rejects summary missing too many sections", () => {
    const minimal = `## Active Task
Something`
    expect(isWellFormedSummary(minimal)).toBe(false)
  })

  test("accepts summary with 5+ sections (LLMs sometimes skip empty ones)", () => {
    const fiveSections = `## Active Task
A
## Goal
B
## Completed Actions
- x
## Active State
C
## Remaining Work
- y`
    expect(isWellFormedSummary(fiveSections)).toBe(true)
  })

  test("rejects plain prose", () => {
    expect(isWellFormedSummary("Here is a summary of what happened...")).toBe(false)
  })
})
