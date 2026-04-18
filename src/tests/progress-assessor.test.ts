import { describe, test, expect } from "bun:test"
import {
  assessProgress,
  computeTrend,
  parseGitDiffStat,
  addAssessmentRecord,
  type AssessmentRecord,
  type GitDelta,
  type ValidationResult,
} from "../progress-assessor"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyDelta: GitDelta = {
  filesChanged: [], linesAdded: 0, linesRemoved: 0, isEmpty: true, hasNewCommits: false,
}

const activeDelta: GitDelta = {
  filesChanged: ["src/auth.ts"], linesAdded: 45, linesRemoved: 12, isEmpty: false, hasNewCommits: true,
}

const noValidation: ValidationResult = null

const passValidation: ValidationResult = {
  passed: true, command: "bun test", exitCode: 0, stdoutPreview: "3 tests passed",
}

const failValidation: ValidationResult = {
  passed: false, command: "bun test", exitCode: 1, stdoutPreview: "2/3 tests failed",
}

function makeRecord(overrides: Partial<AssessmentRecord> = {}): AssessmentRecord {
  return {
    cycleNumber: 1,
    gitDelta: emptyDelta,
    validation: noValidation,
    directiveChanged: false,
    notesCount: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// parseGitDiffStat
// ---------------------------------------------------------------------------

describe("parseGitDiffStat", () => {
  test("parses empty diff", () => {
    const result = parseGitDiffStat("", false)
    expect(result.filesChanged).toEqual([])
    expect(result.linesAdded).toBe(0)
    expect(result.linesRemoved).toBe(0)
    expect(result.isEmpty).toBe(true)
    expect(result.hasNewCommits).toBe(false)
  })

  test("parses diff with file changes and insertion/deletion counts", () => {
    const raw = ` src/auth.ts | 5 +++--
 2 files changed, 12 insertions(+), 3 deletions(-)`
    const result = parseGitDiffStat(raw, true)
    expect(result.filesChanged).toEqual(["src/auth.ts"])
    expect(result.linesAdded).toBe(12)
    expect(result.linesRemoved).toBe(3)
    expect(result.isEmpty).toBe(false)
    expect(result.hasNewCommits).toBe(true)
  })

  test("parses diff with no insertions/deletions line", () => {
    const raw = ` src/foo.ts | 2 +-
 1 file changed, 2 insertions(+), 2 deletions(-)`
    const result = parseGitDiffStat(raw, false)
    expect(result.filesChanged).toEqual(["src/foo.ts"])
    expect(result.linesAdded).toBe(2)
    expect(result.linesRemoved).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// computeTrend
// ---------------------------------------------------------------------------

describe("computeTrend", () => {
  test("returns stable with no records", () => {
    expect(computeTrend([])).toBe("stable")
  })

  test("returns stalled when all recent cycles have no changes", () => {
    const records = [
      makeRecord({ gitDelta: emptyDelta }),
      makeRecord({ gitDelta: emptyDelta }),
      makeRecord({ gitDelta: emptyDelta }),
    ]
    expect(computeTrend(records)).toBe("stalled")
  })

  test("returns improving when validation passes consistently with activity", () => {
    const records = [
      makeRecord({ gitDelta: activeDelta, validation: passValidation }),
      makeRecord({ gitDelta: activeDelta, validation: passValidation }),
      makeRecord({ gitDelta: activeDelta, validation: passValidation }),
    ]
    expect(computeTrend(records)).toBe("improving")
  })

  test("returns declining when validation fails consistently", () => {
    const records = [
      makeRecord({ gitDelta: activeDelta, validation: failValidation }),
      makeRecord({ gitDelta: activeDelta, validation: failValidation }),
      makeRecord({ gitDelta: activeDelta, validation: failValidation }),
    ]
    expect(computeTrend(records)).toBe("declining")
  })

  test("returns declining when validation transitions from pass to fail", () => {
    const records = [
      makeRecord({ gitDelta: activeDelta, validation: passValidation }),
      makeRecord({ gitDelta: activeDelta, validation: failValidation }),
    ]
    expect(computeTrend(records)).toBe("declining")
  })

  test("returns improving when validation transitions from fail to pass", () => {
    const records = [
      makeRecord({ gitDelta: activeDelta, validation: failValidation }),
      makeRecord({ gitDelta: activeDelta, validation: passValidation }),
    ]
    expect(computeTrend(records)).toBe("improving")
  })

  test("returns stable with mixed results and only 1 active cycle in window", () => {
    const records = [
      makeRecord({ gitDelta: emptyDelta, validation: noValidation }),
      makeRecord({ gitDelta: activeDelta, validation: noValidation }),
      makeRecord({ gitDelta: emptyDelta, validation: noValidation }),
    ]
    expect(computeTrend(records)).toBe("stable")
  })

  test("returns stable with 2+ active cycles but no validation", () => {
    const records = [
      makeRecord({ gitDelta: activeDelta, validation: noValidation }),
      makeRecord({ gitDelta: activeDelta, validation: noValidation }),
      makeRecord({ gitDelta: emptyDelta, validation: noValidation }),
    ]
    // 2 active out of 3 => stable (not stalled, not improving)
    expect(computeTrend(records)).toBe("stable")
  })
})

// ---------------------------------------------------------------------------
// assessProgress
// ---------------------------------------------------------------------------

describe("assessProgress", () => {
  test("produces assessment with no prior records — single cycle gets stable trend", () => {
    const result = assessProgress(1, activeDelta, passValidation, ["fixed auth bug"], false, [])
    expect(result.cycleNumber).toBe(1)
    expect(result.trend).toBe("stable")
    expect(result.assessmentText).toContain("Cycle 1 assessment:")
    expect(result.assessmentText).toContain("45 lines added")
    expect(result.assessmentText).toContain("Validation: PASSED")
  })

  test("produces stalled assessment with empty delta and no validation", () => {
    const result = assessProgress(3, emptyDelta, noValidation, [], false, [])
    expect(result.trend).toBe("stalled")
    expect(result.assessmentText).toContain("no changes this cycle")
    expect(result.assessmentText).toContain("Stalled")
  })

  test("includes directive-changed flag", () => {
    const result = assessProgress(2, activeDelta, noValidation, [], true, [])
    expect(result.assessmentText).toContain("Directive was updated this cycle")
  })

  test("generates suggestion for stalled trend", () => {
    const records = [
      makeRecord({ cycleNumber: 1, gitDelta: emptyDelta }),
      makeRecord({ cycleNumber: 2, gitDelta: emptyDelta }),
    ]
    const result = assessProgress(3, emptyDelta, noValidation, [], false, records)
    expect(result.suggestionText).toContain("No code changes")
    expect(result.suggestionText).toContain("pivoting")
  })

  test("generates suggestion for declining trend", () => {
    const records = [
      makeRecord({ cycleNumber: 1, gitDelta: activeDelta, validation: failValidation }),
      makeRecord({ cycleNumber: 2, gitDelta: activeDelta, validation: failValidation }),
    ]
    const result = assessProgress(3, activeDelta, failValidation, [], false, records)
    expect(result.suggestionText).toContain("Validation results are trending worse")
  })

  test("generates suggestion for improving trend with no directive change", () => {
    const records = [
      makeRecord({ cycleNumber: 1, gitDelta: activeDelta, validation: passValidation, directiveChanged: false }),
      makeRecord({ cycleNumber: 2, gitDelta: activeDelta, validation: passValidation, directiveChanged: false }),
    ]
    const result = assessProgress(3, activeDelta, passValidation, [], false, records)
    expect(result.suggestionText).toContain("stretch goals")
  })

  test("generates suggestion for 5+ cycles with stable directive", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ cycleNumber: i + 1, gitDelta: activeDelta, validation: passValidation, directiveChanged: false })
    )
    const result = assessProgress(6, activeDelta, passValidation, [], false, records)
    expect(result.suggestionText).toContain("directive has been stable")
  })

  test("generates suggestion for stuck-sounding notes", () => {
    const result = assessProgress(2, activeDelta, noValidation, ["worker got stuck on type errors"], false, [])
    expect(result.suggestionText).toContain("difficulty")
  })

  test("generates substantial-changes suggestion for large uncommitted diff", () => {
    const largeDelta: GitDelta = {
      filesChanged: ["a.ts", "b.ts", "c.ts"],
      linesAdded: 180, linesRemoved: 50, isEmpty: false, hasNewCommits: false,
    }
    const result = assessProgress(2, largeDelta, noValidation, [], false, [])
    expect(result.suggestionText).toContain("Substantial uncommitted changes")
  })

  test("generates committed-but-no-uncommitted suggestion", () => {
    const committedDelta: GitDelta = {
      filesChanged: [], linesAdded: 0, linesRemoved: 0, isEmpty: true, hasNewCommits: true,
    }
    const result = assessProgress(2, committedDelta, noValidation, [], false, [])
    expect(result.suggestionText).toContain("New commits but no uncommitted")
  })

  test("does not generate duplicate suggestions", () => {
    // Both stalled-heuristic and 5-cycle-stable-directive could fire together,
    // but that's fine — they're different suggestions. Just make sure no
    // *identical* suggestion appears twice.
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ cycleNumber: i + 1, gitDelta: emptyDelta, directiveChanged: false })
    )
    const result = assessProgress(6, emptyDelta, noValidation, [], false, records)
    const lines = result.suggestionText.split("[DIRECTION] ")[1]?.split("\n") ?? []
    const unique = new Set(lines.map(l => l.trim()).filter(Boolean))
    expect(unique.size).toBe(lines.filter(l => l.trim()).length)
  })

  test("empty suggestion when no heuristics match", () => {
    const result = assessProgress(1, activeDelta, noValidation, [], false, [])
    // With only 1 cycle and an active delta, most heuristics won't fire.
    // The "1 active cycle" heuristic doesn't exist — we need 2+ for
    // most trends. So suggestionText should be empty or minimal.
    // Actually, the large-diff heuristic won't fire (only 45 lines, not 200+),
    // and the "stuck notes" heuristic won't fire (no notes).
    // So: only the committed-but-no-uncommitted or improving might fire.
    // With a single record, trend is "stable" so no improving/declining suggestion.
    // No 3-stalled check, no 5-stable-directive check. Result: no suggestions.
    expect(result.suggestionText).toBe("")
  })
})

// ---------------------------------------------------------------------------
// addAssessmentRecord
// ---------------------------------------------------------------------------

describe("addAssessmentRecord", () => {
  test("adds record to empty list", () => {
    const record = makeRecord({ cycleNumber: 1 })
    const result = addAssessmentRecord(undefined, record)
    expect(result).toEqual([record])
  })

  test("caps at 10 records", () => {
    const existing: AssessmentRecord[] = Array.from({ length: 12 }, (_, i) =>
      makeRecord({ cycleNumber: i + 1 })
    )
    const newRecord = makeRecord({ cycleNumber: 13 })
    const result = addAssessmentRecord(existing, newRecord)
    expect(result.length).toBe(10)
    expect(result[0]!.cycleNumber).toBe(4) // oldest 3 trimmed
    expect(result[9]!.cycleNumber).toBe(13)
  })

  test("preserves order when under cap", () => {
    const existing: AssessmentRecord[] = [
      makeRecord({ cycleNumber: 1 }),
      makeRecord({ cycleNumber: 2 }),
    ]
    const newRecord = makeRecord({ cycleNumber: 3 })
    const result = addAssessmentRecord(existing, newRecord)
    expect(result.length).toBe(3)
    expect(result.map(r => r.cycleNumber)).toEqual([1, 2, 3])
  })
})