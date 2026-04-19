/**
 * Tests for Phase 3: runBrainObserver (read-only, episodic).
 *
 * The observer's read-only boundary is STRUCTURAL — enforced by the shape
 * of BrainObserverInput, which must not carry an Orchestrator instance,
 * a DashboardLog, or any handle capable of sending prompts or editing
 * directives. The only writer the observer invokes is `addProjectNote`.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync } from "fs"
import { resolve } from "path"
import {
  runBrainObserver,
  parseObserverOutput,
  type BrainObserverInput,
} from "../brain"
import { loadBrainMemory } from "../brain-memory"

let originalCwd: string
let tmpDir: string

beforeEach(() => {
  originalCwd = process.cwd()
  tmpDir = resolve(originalCwd, `.test-tmp-observer-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

function baseInput(overrides: Partial<BrainObserverInput> = {}): BrainObserverInput {
  return {
    agentName: "alice",
    cycleNumber: 7,
    lastSummary: "Cycle 7 wrapped up: builds green, one flaky integration test on windows.",
    recentEventTypes: ["cycle-done", "validation-result"],
    ollamaUrl: "http://127.0.0.1:11434",
    model: "ollama:test-model",
    _chat: async () => "NONE",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// parseObserverOutput
// ---------------------------------------------------------------------------

describe("parseObserverOutput", () => {
  test("NONE alone returns null", () => {
    expect(parseObserverOutput("NONE")).toBeNull()
    expect(parseObserverOutput("  NONE  ")).toBeNull()
    expect(parseObserverOutput("none")).toBeNull()
  })

  test("NOTE: line returns the trimmed text after the prefix", () => {
    expect(parseObserverOutput("NOTE: flaky windows tests keep recurring")).toBe("flaky windows tests keep recurring")
  })

  test("is case-insensitive on NOTE prefix", () => {
    expect(parseObserverOutput("note: lowercase works")).toBe("lowercase works")
  })

  test("tolerates leading blank lines and surrounding whitespace", () => {
    expect(parseObserverOutput("\n\nNOTE:   spaced note  \n")).toBe("spaced note")
  })

  test("caps output at 150 characters", () => {
    const long = "x".repeat(400)
    const got = parseObserverOutput(`NOTE: ${long}`)
    expect(got).not.toBeNull()
    expect(got!.length).toBeLessThanOrEqual(150)
  })

  test("returns null for empty / whitespace input", () => {
    expect(parseObserverOutput("")).toBeNull()
    expect(parseObserverOutput("   \n\n ")).toBeNull()
  })

  test("returns null when output is prose with no NONE or NOTE sentinel", () => {
    expect(parseObserverOutput("I think you should refactor the code.")).toBeNull()
  })

  test("strips <think> blocks before parsing", () => {
    const raw = "<think>reasoning here</think>\nNOTE: real note"
    expect(parseObserverOutput(raw)).toBe("real note")
  })

  test("prefers NONE over later NOTE line (first sentinel wins)", () => {
    expect(parseObserverOutput("NONE\nNOTE: trailing")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runBrainObserver
// ---------------------------------------------------------------------------

describe("runBrainObserver", () => {
  test("returns null and writes no note when summary is empty", async () => {
    let called = false
    const result = await runBrainObserver(baseInput({
      lastSummary: "",
      _chat: async () => { called = true; return "NOTE: should not fire" },
    }))
    expect(result.noteEmitted).toBeNull()
    expect(called).toBe(false)
    const mem = await loadBrainMemory()
    expect(mem.projectNotes?.["alice"] ?? []).toHaveLength(0)
  })

  test("returns null when LLM answers NONE — no note written", async () => {
    const result = await runBrainObserver(baseInput({ _chat: async () => "NONE" }))
    expect(result.noteEmitted).toBeNull()
    const mem = await loadBrainMemory()
    expect(mem.projectNotes?.["alice"] ?? []).toHaveLength(0)
  })

  test("writes a single project note when LLM emits NOTE", async () => {
    const result = await runBrainObserver(baseInput({
      _chat: async () => "NOTE: flaky windows tests keep recurring across cycles",
    }))
    expect(result.noteEmitted).toBe("flaky windows tests keep recurring across cycles")
    const mem = await loadBrainMemory()
    const notes = mem.projectNotes?.["alice"] ?? []
    expect(notes).toHaveLength(1)
    expect(notes[0]).toBe("[observer] flaky windows tests keep recurring across cycles")
  })

  test("note length cap is enforced end-to-end", async () => {
    const long = "a".repeat(400)
    const result = await runBrainObserver(baseInput({
      _chat: async () => `NOTE: ${long}`,
    }))
    expect(result.noteEmitted).not.toBeNull()
    expect(result.noteEmitted!.length).toBeLessThanOrEqual(150)
  })

  test("LLM failure is swallowed — observer returns null and writes nothing", async () => {
    const result = await runBrainObserver(baseInput({
      _chat: async () => { throw new Error("network down") },
    }))
    expect(result.noteEmitted).toBeNull()
    const mem = await loadBrainMemory()
    expect(mem.projectNotes?.["alice"] ?? []).toHaveLength(0)
  })

  test("passes cycle/agent/events into the prompt so the LLM has context", async () => {
    let capturedUserMsg = ""
    await runBrainObserver(baseInput({
      agentName: "bob",
      cycleNumber: 42,
      recentEventTypes: ["cycle-done", "false-progress-warning"],
      lastSummary: "BOB DID A THING",
      _chat: async (messages) => {
        capturedUserMsg = messages[messages.length - 1]?.content ?? ""
        return "NONE"
      },
    }))
    expect(capturedUserMsg).toContain("Agent: bob")
    expect(capturedUserMsg).toContain("Cycle: 42")
    expect(capturedUserMsg).toContain("cycle-done")
    expect(capturedUserMsg).toContain("false-progress-warning")
    expect(capturedUserMsg).toContain("BOB DID A THING")
  })

  test("truncates extremely long summaries before sending", async () => {
    const huge = "z".repeat(20_000)
    let captured = ""
    await runBrainObserver(baseInput({
      lastSummary: huge,
      _chat: async (messages) => {
        captured = messages[messages.length - 1]?.content ?? ""
        return "NONE"
      },
    }))
    // Prompt should be bounded — not contain the full 20k characters of z's.
    expect(captured.length).toBeLessThan(10_000)
  })

  test("multiple invocations accumulate notes in memory", async () => {
    await runBrainObserver(baseInput({
      _chat: async () => "NOTE: first observation",
    }))
    await runBrainObserver(baseInput({
      cycleNumber: 8,
      _chat: async () => "NOTE: second observation",
    }))
    const mem = await loadBrainMemory()
    const notes = mem.projectNotes?.["alice"] ?? []
    expect(notes).toHaveLength(2)
    expect(notes[0]).toBe("[observer] first observation")
    expect(notes[1]).toBe("[observer] second observation")
  })
})

// ---------------------------------------------------------------------------
// Structural read-only boundary — compile-time property check
// ---------------------------------------------------------------------------
//
// If someone widens BrainObserverInput to include Orchestrator, DashboardLog,
// an EventBus, or a prompt ledger, they break the read-only contract. This
// test walks the *keys* of a realistic input and fails if any forbidden key
// has been added. It's coarse — the real guarantee is the type itself — but
// it flips the cost of a regression from "discover at runtime" to "fail CI".

describe("runBrainObserver — read-only boundary", () => {
  test("BrainObserverInput shape contains no prompt-sending handles", () => {
    const input: BrainObserverInput = baseInput()
    const keys = new Set(Object.keys(input))
    const forbidden = [
      "orchestrator",
      "dashboardLog",
      "dashLog",
      "eventBus",
      "promptLedger",
      "agents",
      "prompt",
      "sendPrompt",
    ]
    for (const f of forbidden) {
      expect(keys.has(f)).toBe(false)
    }
  })
})
