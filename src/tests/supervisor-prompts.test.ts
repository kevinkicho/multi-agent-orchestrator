/**
 * Smoke tests for the extracted supervisor-prompts module. Asserts the prompt
 * builder injects the expected sections and that pickNotesForPrompt surfaces
 * promoted principles before recent notes.
 */
import { describe, test, expect } from "bun:test"
import {
  buildSupervisorPrompt,
  pickNotesForPrompt,
  REVIEW_PROMPT,
} from "../supervisor-prompts"
import type { BehavioralNote } from "../brain-memory"

function makeNote(overrides: Partial<BehavioralNote> & { id: string; text: string }): BehavioralNote {
  return {
    timestamps: [Date.now()],
    fires: [],
    provenance: { source: "review", cycle: null, createdAt: Date.now() },
    ...overrides,
  } as BehavioralNote
}

describe("buildSupervisorPrompt", () => {
  test("includes agent name and directory", () => {
    const out = buildSupervisorPrompt("coder-1", "/tmp/proj", false, false, [])
    expect(out).toContain("coder-1")
    expect(out).toContain("/tmp/proj")
  })

  test("omits @review bullet when review is disabled", () => {
    const out = buildSupervisorPrompt("coder-1", "/tmp/proj", false, false, [])
    expect(out).not.toContain("@review")
  })

  test("includes @review bullet when review is enabled", () => {
    const out = buildSupervisorPrompt("coder-1", "/tmp/proj", true, false, [])
    expect(out).toContain("@review")
    expect(out).toContain("self-review")
  })

  test("switches review wording when dedicated reviewer is configured", () => {
    const out = buildSupervisorPrompt("coder-1", "/tmp/proj", true, true, [])
    expect(out).toContain("dedicated reviewer")
  })

  test("renders Lessons section with promoted [principle] badge", () => {
    const notes: BehavioralNote[] = [
      makeNote({ id: "a", text: "always write tests first" }),
      makeNote({
        id: "b",
        text: "restart aggressively when the worker goes silent",
        promotedAt: { at: 1, cycle: 4, originalText: "restart", clarified: false },
      }),
    ]
    const out = buildSupervisorPrompt("coder-1", "/tmp/proj", false, false, notes)
    expect(out).toContain("## Lessons from Previous Cycles")
    expect(out).toContain("[principle]")
    expect(out).toContain("always write tests first")
  })
})

describe("pickNotesForPrompt", () => {
  test("returns empty array for empty input", () => {
    expect(pickNotesForPrompt([], 3)).toEqual([])
  })

  test("returns empty array for non-positive limit", () => {
    const notes = [makeNote({ id: "a", text: "note a" })]
    expect(pickNotesForPrompt(notes, 0)).toEqual([])
  })

  test("places promoted notes before recent non-promoted", () => {
    const notes: BehavioralNote[] = [
      makeNote({ id: "old", text: "old non-promoted" }),
      makeNote({
        id: "promoted",
        text: "principle",
        promotedAt: { at: 1, cycle: 4, originalText: "principle", clarified: false },
      }),
      makeNote({ id: "recent", text: "recent non-promoted" }),
    ]
    const picked = pickNotesForPrompt(notes, 3).map(n => n.id)
    expect(picked[0]).toBe("promoted")
    expect(picked).toContain("recent")
  })

  test("filters out archived notes", () => {
    const notes: BehavioralNote[] = [
      makeNote({ id: "live", text: "still active" }),
      makeNote({
        id: "archived",
        text: "old",
        archivedAt: { at: 1, cycle: 1, reason: "no-fires" },
      }),
    ]
    const picked = pickNotesForPrompt(notes, 5).map(n => n.id)
    expect(picked).toEqual(["live"])
  })
})

describe("REVIEW_PROMPT", () => {
  test("contains the six review dimensions", () => {
    expect(REVIEW_PROMPT).toContain("Correctness")
    expect(REVIEW_PROMPT).toContain("Edge cases")
    expect(REVIEW_PROMPT).toContain("Error handling")
    expect(REVIEW_PROMPT).toContain("Security")
    expect(REVIEW_PROMPT).toContain("Tests")
    expect(REVIEW_PROMPT).toContain("Performance")
  })
})
