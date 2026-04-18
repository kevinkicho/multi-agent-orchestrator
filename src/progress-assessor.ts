/**
 * Progress assessor — deterministic signal processing for directive evolution.
 *
 * Computes a structured assessment after each supervisor cycle by analyzing
 * git diff stats, validation results, behavioral notes, and trend across recent
 * cycles. Produces a [PROGRESS] block and optional [DIRECTION] suggestion that
 * are injected into the supervisor's next system prompt, giving the LLM a
 * compass for directive adjustments.
 *
 * No LLM calls — this is pure rule-based signal processing.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GitDelta = {
  filesChanged: string[]
  linesAdded: number
  linesRemoved: number
  isEmpty: boolean
  hasNewCommits: boolean
}

export type ValidationResult = {
  passed: boolean
  command: string
  exitCode: number
  stdoutPreview: string
} | null

export type ProgressTrend = "improving" | "declining" | "stable" | "stalled"

export type ProgressAssessment = {
  cycleNumber: number
  gitDelta: GitDelta
  validation: ValidationResult
  newNotes: string[]
  directiveChanged: boolean
  trend: ProgressTrend
  assessmentText: string
  suggestionText: string
}

// Internal: lightweight record stored in memory for trend computation
export type AssessmentRecord = {
  cycleNumber: number
  gitDelta: GitDelta
  validation: ValidationResult
  directiveChanged: boolean
  notesCount: number
}

// ---------------------------------------------------------------------------
// Parse git diff stat output into a structured GitDelta
// ---------------------------------------------------------------------------

export function parseGitDiffStat(
  rawStat: string,
  hasNewCommits: boolean,
): GitDelta {
  const filesChanged: string[] = []
  let linesAdded = 0
  let linesRemoved = 0

  for (const line of rawStat.split("\n")) {
    const fileMatch = line.match(/^\s*(.+?)\s*\|/)
    if (fileMatch?.[1]) filesChanged.push(fileMatch[1].trim())

    const numMatch = line.match(/\|\s*(\d+)/)
    if (numMatch?.[1]) {
      const total = parseInt(numMatch[1], 10)
      // Git --stat only gives total changes, not add/remove split
      // Approximate: use the final summary line if present
    }

    // Try to parse insertions/deletions from summary line like "5 files changed, 12 insertions(+), 3 deletions(-)"
    const insMatch = line.match(/(\d+)\s+insertions?/)
    if (insMatch?.[1]) linesAdded += parseInt(insMatch[1], 10)
    const delMatch = line.match(/(\d+)\s+deletions?/)
    if (delMatch?.[1]) linesRemoved += parseInt(delMatch[1], 10)
  }

  return {
    filesChanged,
    linesAdded,
    linesRemoved,
    isEmpty: filesChanged.length === 0 && !hasNewCommits,
    hasNewCommits,
  }
}

// ---------------------------------------------------------------------------
// Trend computation — looks at the last N assessments
// ---------------------------------------------------------------------------

const TREND_WINDOW = 3

export function computeTrend(records: AssessmentRecord[]): ProgressTrend {
  if (records.length === 0) return "stable"

  const recent = records.slice(-TREND_WINDOW)

  // Stalled: no git changes in any of the recent cycles
  if (recent.every(r => r.gitDelta.isEmpty && !r.gitDelta.hasNewCommits)) {
    return "stalled"
  }

  // Check validation trend — oldest first, newest last
  const validations = recent.filter(r => r.validation !== null)
  if (validations.length >= 2) {
    const allPassing = validations.every(r => r.validation!.passed)
    const allFailing = validations.every(r => !r.validation!.passed)

    // Trend: earliest → latest
    const earliest = validations[0]!.validation!
    const latest = validations[validations.length - 1]!.validation!
    const trendWorsening = earliest.passed && !latest.passed
    const trendImproving = !earliest.passed && latest.passed

    if (allPassing && recent.some(r => !r.gitDelta.isEmpty)) return "improving"
    if (allFailing) return "declining"
    if (trendWorsening) return "declining"
    if (trendImproving) return "improving"
  }

  // Check git activity trend
  const activeCycles = recent.filter(r => !r.gitDelta.isEmpty).length
  if (activeCycles >= 2) return "stable"

  // Only 1 active cycle in recent window — could be stalled
  if (activeCycles === 0) return "stalled"

  return "stable"
}

// ---------------------------------------------------------------------------
// Heuristic suggestions — data-driven, not if/else chain
// ---------------------------------------------------------------------------

type Heuristic = {
  condition: (records: AssessmentRecord[], trend: ProgressTrend, delta: GitDelta, notes: string[], directiveChanged: boolean) => boolean
  suggestion: string
}

const HEURISTICS: Heuristic[] = [
  {
    condition: (records, _trend, _delta, _notes, _directiveChanged) => {
      const stalled = records.slice(-3)
      return stalled.length >= 3 && stalled.every(r => r.gitDelta.isEmpty && !r.gitDelta.hasNewCommits)
    },
    suggestion: "No code changes in the last 3 cycles. Consider pivoting your approach — try a different strategy, break the task into smaller steps, or use @check to re-examine the current state.",
  },
  {
    condition: (_records, trend, _delta, _notes, _directiveChanged) =>
      trend === "declining",
    suggestion: "Validation results are trending worse. Consider simplifying the directive to focus on fixing what's broken before adding new functionality.",
  },
  {
    condition: (_records, trend, _delta, _notes, _directiveChanged) =>
      trend === "improving" && !_directiveChanged,
    suggestion: "Good progress trend — the current approach is working. Consider evolving the directive to target stretch goals or address the next priority.",
  },
  {
    condition: (_records, _trend, delta, _notes, _directiveChanged) =>
      !delta.isEmpty && !delta.hasNewCommits && delta.linesAdded + delta.linesRemoved > 200,
    suggestion: "Substantial uncommitted changes but no commits yet. Consider asking the worker to commit current progress before making more changes.",
  },
  {
    condition: (records, _trend, _delta, _notes, _directiveChanged) => {
      const recent = records.slice(-5)
      return recent.length >= 5 && recent.every(r => !r.directiveChanged)
    },
    suggestion: "The directive has been stable for 5+ cycles. If the work is progressing well, consider using @directive to capture what you've learned and evolve the project direction.",
  },
  {
    condition: (_records, _trend, _delta, notes, _directiveChanged) =>
      notes.some(n => /stuck|retry|failed|couldn't|unable|blocked/i.test(n)),
    suggestion: "Behavioral notes mention difficulty. Consider breaking the directive into smaller, more focused tasks or adjusting the approach entirely.",
  },
  {
    condition: (_records, _trend, delta, _notes, _directiveChanged) =>
      delta.isEmpty && delta.hasNewCommits,
    suggestion: "New commits but no uncommitted changes — work was committed. Good cadence. Consider whether the next cycle should build on this or pivot to a different area.",
  },
]

function generateSuggestions(
  records: AssessmentRecord[],
  trend: ProgressTrend,
  delta: GitDelta,
  notes: string[],
  directiveChanged: boolean,
): string {
  const suggestions = HEURISTICS
    .filter(h => h.condition(records, trend, delta, notes, directiveChanged))
    .map(h => h.suggestion)

  return suggestions.join("\n")
}

// ---------------------------------------------------------------------------
// Main assessment function
// ---------------------------------------------------------------------------

export function assessProgress(
  cycleNumber: number,
  gitDelta: GitDelta,
  validation: ValidationResult,
  newNotes: string[],
  directiveChanged: boolean,
  previousRecords: AssessmentRecord[],
): ProgressAssessment {
  const record: AssessmentRecord = {
    cycleNumber,
    gitDelta,
    validation,
    directiveChanged,
    notesCount: newNotes.length,
  }

  const allRecords = [...previousRecords, record]
  const trend = computeTrend(allRecords)

  const parts: string[] = []
  parts.push(`Cycle ${cycleNumber} assessment:`)

  if (!gitDelta.isEmpty) {
    parts.push(`- Codebase: ${gitDelta.linesAdded} lines added, ${gitDelta.linesRemoved} lines removed across ${gitDelta.filesChanged.length} file(s)`)
  } else if (gitDelta.hasNewCommits) {
    parts.push("- Codebase: new commits (no uncommitted changes)")
  } else {
    parts.push("- Codebase: no changes this cycle")
  }

  if (validation) {
    const status = validation.passed ? "PASSED" : "FAILED"
    parts.push(`- Validation: ${status} (exit ${validation.exitCode})`)
  }

  if (newNotes.length > 0) {
    parts.push(`- Notes: ${newNotes.map(n => `"${n.slice(0, 60)}"`).join(", ")}`)
  }

  const trendLabel = { improving: "📈 Improving", declining: "📉 Declining", stable: "➡️ Stable", stalled: "🛑 Stalled" }[trend]
  parts.push(`- Trend: ${trendLabel}`)

  if (directiveChanged) {
    parts.push("- Directive was updated this cycle")
  }

  const suggestionText = generateSuggestions(allRecords, trend, gitDelta, newNotes, directiveChanged)

  return {
    cycleNumber,
    gitDelta,
    validation,
    newNotes,
    directiveChanged,
    trend,
    assessmentText: `[PROGRESS] ${parts.join("\n")}`,
    suggestionText: suggestionText ? `[DIRECTION] ${suggestionText}` : "",
  }
}

// ---------------------------------------------------------------------------
// Record management — for persisting in brain memory
// ---------------------------------------------------------------------------

const MAX_ASSESSMENT_RECORDS = 10

export function addAssessmentRecord(
  existing: AssessmentRecord[] | undefined,
  record: AssessmentRecord,
): AssessmentRecord[] {
  const records = [...(existing ?? []), record]
  return records.slice(-MAX_ASSESSMENT_RECORDS)
}