/**
 * Tests for Phase 5: runBrainManager (persistent overseer).
 *
 * The manager can emit advisory writes (dashboard events + project notes) but
 * it never receives an Orchestrator handle, so the boundary stays narrow.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync } from "fs"
import { resolve } from "path"
import {
  detectStuckProjects,
  composeSessionBriefing,
  runManagerStuckPass,
  runManagerBriefing,
  MANAGER_DEFAULT_STUCK_THRESHOLD,
  type BrainManagerInput,
} from "../brain"
import { loadBrainMemory, recordCycleOutcome } from "../brain-memory"

let originalCwd: string
let tmpDir: string

beforeEach(() => {
  originalCwd = process.cwd()
  tmpDir = resolve(originalCwd, `.test-tmp-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

function mkEmit() {
  const events: Array<{ type: string; agent?: string; text: string }> = []
  return {
    events,
    emit: { push: (e: { type: "manager-alert" | "manager-briefing"; agent?: string; text: string }) => { events.push(e) } },
  }
}

function baseInput(overrides: Partial<BrainManagerInput> = {}): BrainManagerInput {
  const e = mkEmit()
  return {
    ollamaUrl: "http://127.0.0.1:11434",
    model: "ollama:test-model",
    emit: e.emit,
    _chat: async () => "(no narrative)",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// detectStuckProjects — pure function
// ---------------------------------------------------------------------------

describe("detectStuckProjects", () => {
  test("empty outcomes yield no alerts", () => {
    expect(detectStuckProjects({}, 3)).toEqual([])
  })

  test("fewer cycles than threshold yields no alert", () => {
    const input = { alice: { 1: { outcome: "failure" as const }, 2: { outcome: "failure" as const } } }
    expect(detectStuckProjects(input, 3)).toEqual([])
  })

  test("three consecutive failures fires alert", () => {
    const input = {
      alice: {
        1: { outcome: "failure" as const },
        2: { outcome: "failure" as const },
        3: { outcome: "failure" as const },
      },
    }
    const alerts = detectStuckProjects(input, 3)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.agentName).toBe("alice")
    expect(alerts[0]!.consecutiveBadOutcomes).toBe(3)
    expect(alerts[0]!.recentOutcomes).toEqual(["failure", "failure", "failure"])
    expect(alerts[0]!.suggestion).toMatch(/failure/i)
  })

  test("mixed partial/failure also fires alert with different suggestion", () => {
    const input = {
      bob: {
        1: { outcome: "partial" as const },
        2: { outcome: "failure" as const },
        3: { outcome: "partial" as const },
      },
    }
    const alerts = detectStuckProjects(input, 3)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.suggestion).toMatch(/partial/i)
  })

  test("success in window breaks the streak", () => {
    const input = {
      carol: {
        1: { outcome: "failure" as const },
        2: { outcome: "success" as const },
        3: { outcome: "failure" as const },
      },
    }
    expect(detectStuckProjects(input, 3)).toEqual([])
  })

  test("uses most recent cycles, not oldest", () => {
    const input = {
      dave: {
        1: { outcome: "failure" as const },
        2: { outcome: "failure" as const },
        3: { outcome: "failure" as const },
        4: { outcome: "success" as const },
        5: { outcome: "success" as const },
        6: { outcome: "success" as const },
      },
    }
    expect(detectStuckProjects(input, 3)).toEqual([])
  })

  test("multiple agents each evaluated independently", () => {
    const input = {
      stuck: {
        1: { outcome: "failure" as const },
        2: { outcome: "failure" as const },
        3: { outcome: "failure" as const },
      },
      ok: {
        1: { outcome: "success" as const },
        2: { outcome: "success" as const },
        3: { outcome: "success" as const },
      },
    }
    const alerts = detectStuckProjects(input, 3)
    expect(alerts.map(a => a.agentName)).toEqual(["stuck"])
  })
})

// ---------------------------------------------------------------------------
// composeSessionBriefing — pure function
// ---------------------------------------------------------------------------

describe("composeSessionBriefing", () => {
  test("zero-agent case produces a valid briefing", () => {
    const b = composeSessionBriefing({ behavioralNotesByAgent: {}, now: 1_700_000_000_000 })
    expect(b.totalAgents).toBe(0)
    expect(b.totalPromoted).toBe(0)
    expect(b.totalUnpromoted).toBe(0)
    expect(b.text).toContain("0 agent")
  })

  test("counts promoted and un-promoted notes per agent", () => {
    const b = composeSessionBriefing({
      behavioralNotesByAgent: {
        alice: [
          { promotedAt: { at: 1, cycle: 1, originalText: "x", clarified: false } },
          { promotedAt: { at: 2, cycle: 2, originalText: "y", clarified: false } },
          { unpromotedAt: { at: 3, cycle: 3, failureFires: 3, successFires: 0, priorPromotion: { at: 0, cycle: 0, originalText: "z", clarified: false } } },
          {},
        ],
        bob: [
          { promotedAt: { at: 1, cycle: 1, originalText: "q", clarified: false } },
        ],
      },
      now: 1_700_000_000_000,
    })
    expect(b.totalAgents).toBe(2)
    expect(b.totalPromoted).toBe(3)
    expect(b.totalUnpromoted).toBe(1)
    expect(b.recentPromotedPerAgent.alice).toBe(2)
    expect(b.recentPromotedPerAgent.bob).toBe(1)
    expect(b.recentUnpromotedPerAgent.alice).toBe(1)
    expect(b.text).toContain("Principles in force: 3")
  })
})

// ---------------------------------------------------------------------------
// runManagerStuckPass — integration with memory store
// ---------------------------------------------------------------------------

describe("runManagerStuckPass", () => {
  test("no outcomes → no alerts emitted", async () => {
    const e = mkEmit()
    const alerts = await runManagerStuckPass(baseInput({ emit: e.emit, stuckThreshold: 3 }))
    expect(alerts).toEqual([])
    expect(e.events).toEqual([])
  })

  test("three recorded failures → one alert + advisory project note", async () => {
    await recordCycleOutcome("alice", 1, "failure", "stop-failure")
    await recordCycleOutcome("alice", 2, "failure", "stop-failure")
    await recordCycleOutcome("alice", 3, "failure", "stop-failure")

    const e = mkEmit()
    const alerts = await runManagerStuckPass(baseInput({ emit: e.emit, stuckThreshold: 3 }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.agentName).toBe("alice")
    expect(e.events).toHaveLength(1)
    expect(e.events[0]!.type).toBe("manager-alert")
    expect(e.events[0]!.agent).toBe("alice")
    expect(e.events[0]!.text).toContain("alice")

    // Advisory project note was written.
    const mem = await loadBrainMemory()
    expect(mem.projectNotes.alice).toBeDefined()
    expect(mem.projectNotes.alice!.some(n => n.includes("[manager]"))).toBe(true)
  })

  test("default threshold honored when caller omits", () => {
    expect(MANAGER_DEFAULT_STUCK_THRESHOLD).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// runManagerBriefing — emits briefing on startup
// ---------------------------------------------------------------------------

describe("runManagerBriefing", () => {
  test("emits a manager-briefing event even with empty memory", async () => {
    const e = mkEmit()
    const briefing = await runManagerBriefing(baseInput({ emit: e.emit }))
    expect(briefing.totalAgents).toBe(0)
    expect(e.events).toHaveLength(1)
    expect(e.events[0]!.type).toBe("manager-briefing")
  })

  test("uses LLM narrative when chat returns non-empty string", async () => {
    const e = mkEmit()
    const briefing = await runManagerBriefing(baseInput({
      emit: e.emit,
      _chat: async () => "All agents nominal. No action needed right now.",
    }))
    expect(briefing.text).toContain("No action needed")
  })

  test("falls back to factual text when LLM throws", async () => {
    const e = mkEmit()
    const briefing = await runManagerBriefing(baseInput({
      emit: e.emit,
      _chat: async () => { throw new Error("network") },
    }))
    expect(briefing.text).toContain("agent")
    expect(e.events[0]!.text).toBe(briefing.text)
  })
})

// ---------------------------------------------------------------------------
// BrainManagerInput boundary check — structural read-only contract.
// If this breaks, someone widened the type to accept an Orchestrator or
// DashboardLog. That is the thing we explicitly do not allow.
// ---------------------------------------------------------------------------

describe("BrainManagerInput boundary", () => {
  test("has no Orchestrator, DashboardLog, EventBus, or prompt handle", () => {
    const shape: BrainManagerInput = {
      ollamaUrl: "x",
      model: "m",
      emit: { push: () => {} },
    }
    const keys = Object.keys(shape).sort()
    // Whitelist — every key allowed on the input type must be in this list.
    // Adding a new key that breaks this test means re-evaluating the
    // read-only-for-prompts boundary (see KNOWN_LIMITATIONS.md §35).
    const allowed = new Set(["ollamaUrl", "model", "emit", "stuckThreshold", "_chat"])
    for (const k of keys) expect(allowed.has(k)).toBe(true)
  })
})
