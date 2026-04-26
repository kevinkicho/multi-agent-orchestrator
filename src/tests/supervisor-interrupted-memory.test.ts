import { describe, test, expect, beforeEach, mock } from "bun:test"
import * as realBrainMemory from "../brain-memory"

// Capture every addMemoryEntry call so the tests can inspect the shape
// the supervisor records on early-exit paths.
type CapturedCall = {
  entry: { objective: string; summary: string; agentLearnings: Record<string, string[]> }
  agentName: string
}
const captured: CapturedCall[] = []
let nextThrows: Error | null = null

// Spread the real module so transitive importers (meta-reflection, etc.)
// still see every export they need; only override the two functions whose
// behavior these tests care about.
mock.module("../brain-memory", () => ({
  ...realBrainMemory,
  loadBrainMemory: async () => ({ entries: [], projectNotes: {}, behavioralNotes: [] }),
  addMemoryEntry: async (
    _store: unknown,
    entry: CapturedCall["entry"],
    agentName: string,
  ) => {
    if (nextThrows) {
      const err = nextThrows
      nextThrows = null
      throw err
    }
    captured.push({ entry, agentName })
    return { entries: [entry], projectNotes: {}, behavioralNotes: [] }
  },
}))

beforeEach(() => {
  captured.length = 0
  nextThrows = null
})

describe("recordInterruption", () => {
  test("writes a memory entry with agentLearnings as Record<string, string[]>", async () => {
    const { recordInterruption } = await import("../supervisor")
    await recordInterruption(
      "agent-a",
      "build the thing",
      "Interrupted: LLM provider failing — circuit breaker (5/10)",
      "llm-provider-call",
      "circuit-breaker-llm",
    )

    expect(captured.length).toBe(1)
    const { entry, agentName } = captured[0]!
    expect(agentName).toBe("agent-a")
    expect(entry.objective).toBe("agent-a supervisor: build the thing")
    expect(entry.summary).toContain("circuit breaker")
    // The shape that broke before the fix — must be string[], not string.
    expect(entry.agentLearnings.status).toEqual(["interrupted"])
    expect(entry.agentLearnings.lastAction).toEqual(["llm-provider-call"])
    expect(entry.agentLearnings.reason).toEqual(["circuit-breaker-llm"])
    // Every value must be an array — guards against future regressions
    // where someone "simplifies" back to bare strings.
    for (const v of Object.values(entry.agentLearnings)) {
      expect(Array.isArray(v)).toBe(true)
    }
  })

  test("swallows errors from addMemoryEntry without re-throwing", async () => {
    const { recordInterruption } = await import("../supervisor")
    nextThrows = new Error("disk full")

    // Must not throw — early-exit paths are best-effort and a memory write
    // failure should not crash the already-failing supervisor.
    await expect(
      recordInterruption("agent-b", "d", "s", "la", "r"),
    ).resolves.toBeUndefined()

    expect(captured.length).toBe(0)
  })

  test("uses distinct lastAction/reason for the failed-cycle circuit breaker", async () => {
    const { recordInterruption } = await import("../supervisor")
    await recordInterruption(
      "agent-c",
      "ship it",
      "Interrupted: circuit breaker — 3 consecutive failed cycles",
      "cycle-execution",
      "circuit-breaker-failed-cycles",
    )

    expect(captured.length).toBe(1)
    const { entry } = captured[0]!
    expect(entry.agentLearnings.lastAction).toEqual(["cycle-execution"])
    expect(entry.agentLearnings.reason).toEqual(["circuit-breaker-failed-cycles"])
  })
})
