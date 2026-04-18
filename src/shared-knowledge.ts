/**
 * Shared knowledge store — cross-agent discoveries, progress summaries,
 * and explicit knowledge shares.
 *
 * Unlike BrainMemoryStore (which is per-agent), this is a shared resource
 * that all supervisors can read and write. It persists to
 * `.orchestrator-shared.json` and uses a write lock for concurrency safety.
 *
 * Write paths:
 *   - Auto-published progress summaries (supervisor @done: time)
 *   - Explicit @share: notes from supervisors (behavioral discoveries worth broadcasting)
 *
 * Read paths:
 *   - formatRelevantKnowledge() filters shared entries by file-path overlap
 *     with the reading agent's @intent declarations, injects into system prompt
 */

import { resolve } from "path"
import { readJsonFile, writeJsonFile } from "./file-utils"
import { readFileOrNull } from "./file-utils"
import type { ProgressAssessment } from "./progress-assessor"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SharedNote = {
  /** Who published this note */
  source: string
  /** When it was published (Date.now()) */
  publishedAt: number
  /** The discovery or observation worth sharing */
  text: string
  /** Files mentioned in the note (for relevance filtering) */
  files: string[]
  /** Whether this was auto-published or explicitly shared */
  kind: "discovery" | "lesson" | "observation"
}

export type SharedProgressEntry = {
  /** Agent name */
  agent: string
  /** When this progress was recorded */
  recordedAt: number
  /** The assessment (trend, git delta, validation) */
  assessment: ProgressAssessment
}

export type SharedKnowledgeStore = {
  /** Cross-agent discoveries, lessons, and observations */
  notes: SharedNote[]
  /** Latest progress summary from each agent */
  progress: SharedProgressEntry[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SHARED_NOTES = 50
const MAX_PROGRESS_ENTRIES = 20 // per agent, but we store globally and dedupe

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function getSharedKnowledgePath(): string {
  return resolve(process.cwd(), ".orchestrator-shared.json")
}

// Simple async write lock to prevent concurrent read-modify-write races
let writeLock: Promise<void> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn)
  writeLock = next.then(() => {}, () => {})
  return next
}

const DEFAULT_STORE: SharedKnowledgeStore = {
  notes: [],
  progress: [],
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

export async function loadSharedKnowledge(): Promise<SharedKnowledgeStore> {
  const content = await readFileOrNull(getSharedKnowledgePath())
  if (!content) return { ...DEFAULT_STORE }
  try {
    const parsed = JSON.parse(content)
    return {
      notes: parsed.notes ?? [],
      progress: parsed.progress ?? [],
    }
  } catch {
    return { ...DEFAULT_STORE }
  }
}

async function saveSharedKnowledge(store: SharedKnowledgeStore): Promise<void> {
  await writeJsonFile(getSharedKnowledgePath(), store)
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/** Publish a progress summary. Replaces any previous entry for the same agent. */
export async function publishProgress(
  _store: SharedKnowledgeStore,
  agent: string,
  assessment: ProgressAssessment,
): Promise<SharedKnowledgeStore> {
  return withWriteLock(async () => {
    const store = await loadSharedKnowledge()
    // Remove any previous entry for this agent
    const progress = store.progress.filter(e => e.agent !== agent)
    const entry: SharedProgressEntry = {
      agent,
      recordedAt: Date.now(),
      assessment,
    }
    progress.push(entry)
    // Cap at MAX_PROGRESS_ENTRIES total (oldest first)
    const result: SharedKnowledgeStore = {
      notes: store.notes,
      progress: progress.slice(-MAX_PROGRESS_ENTRIES),
    }
    await saveSharedKnowledge(result)
    return result
  })
}

/** Publish an explicit shared note (from @share: command). */
export async function publishNote(
  _store: SharedKnowledgeStore,
  source: string,
  text: string,
  files: string[],
  kind: SharedNote["kind"] = "discovery",
): Promise<SharedKnowledgeStore> {
  return withWriteLock(async () => {
    const store = await loadSharedKnowledge()
    const note: SharedNote = {
      source,
      publishedAt: Date.now(),
      text,
      files,
      kind,
    }
    const notes = [...store.notes, note].slice(-MAX_SHARED_NOTES)
    const result: SharedKnowledgeStore = {
      notes,
      progress: store.progress,
    }
    await saveSharedKnowledge(result)
    return result
  })
}

/** Remove all entries for an agent (when project is removed). */
export async function clearAgentKnowledge(agent: string): Promise<void> {
  return withWriteLock(async () => {
    const store = await loadSharedKnowledge()
    const result: SharedKnowledgeStore = {
      notes: store.notes.filter(n => n.source !== agent),
      progress: store.progress.filter(e => e.agent !== agent),
    }
    await saveSharedKnowledge(result)
  })
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Format shared knowledge relevant to an agent.
 *
 * Filters notes by file-path overlap with the agent's declared intent or
 * current file locks, and includes the latest progress summary from each
 * other agent. Returns a formatted string suitable for injection into the
 * supervisor system prompt.
 *
 * @param store - The shared knowledge store
 * @param agentName - The agent reading the knowledge (excluded from results)
 * @param relevantFiles - Files this agent is working on (from @intent + file locks)
 * @param maxNotes - Maximum number of notes to include (default 10)
 */
export function formatRelevantKnowledge(
  store: SharedKnowledgeStore,
  agentName: string,
  relevantFiles: string[],
  maxNotes: number = 10,
): string {
  const parts: string[] = []

  // --- Progress summaries from other agents ---
  const otherProgress = store.progress.filter(e => e.agent !== agentName)
  if (otherProgress.length > 0) {
    parts.push("### Other Agents' Progress")
    for (const entry of otherProgress) {
      const a = entry.assessment
      const trendEmoji = { improving: "📈", declining: "📉", stable: "➡️", stalled: "🛑" }[a.trend]
      parts.push(`- **${entry.agent}**: ${trendEmoji} ${a.trend} — ${a.assessmentText.replace("[PROGRESS] ", "")}`)
    }
  }

  // --- Shared notes filtered by relevance ---
  const otherNotes = store.notes
    .filter(n => n.source !== agentName)
    .sort((a, b) => b.publishedAt - a.publishedAt) // newest first

  if (otherNotes.length === 0) return parts.length > 0 ? parts.join("\n") : ""

  // Score each note by relevance to the agent's current work
  const scored = otherNotes.map(note => {
    let score = 0

    // File overlap: highest signal
    if (relevantFiles.length > 0 && note.files.length > 0) {
      const overlap = note.files.filter(f =>
        relevantFiles.some(rf => filesOverlap(f, rf))
      )
      score += overlap.length * 10
    }

    // Recency bonus: newer notes are more relevant
    const ageMs = Date.now() - note.publishedAt
    if (ageMs < 300_000) score += 5 // last 5 minutes
    else if (ageMs < 3_600_000) score += 2 // last hour

    // Kind bonus: lessons are more actionable than observations
    if (note.kind === "lesson") score += 3
    if (note.kind === "discovery") score += 1

    return { note, score }
  })

  // Take top N by relevance score, minimum score 1 (must be at least slightly relevant)
  const relevant = scored
    .filter(s => s.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxNotes)

  if (relevant.length > 0) {
    parts.push("### Shared Knowledge from Other Agents")
    for (const { note } of relevant) {
      const kindLabel = note.kind === "lesson" ? "Lesson" : note.kind === "discovery" ? "Discovery" : "Note"
      const fileList = note.files.length > 0 ? ` (${note.files.join(", ")})` : ""
      parts.push(`- **[${kindLabel}]** ${note.text}${fileList}`)
    }
  }

  return parts.length > 0 ? parts.join("\n") : ""
}

// ---------------------------------------------------------------------------
// File path overlap heuristic
// ---------------------------------------------------------------------------

/**
 * Determine if two file paths are "related enough" to share knowledge about.
 *
 * Matches if:
 * - Paths are identical
 * - One is a subdirectory of the other (e.g., "src/" overlaps "src/auth.ts")
 * - Paths share the same directory and the filename stem matches
 *   (e.g., "src/auth.ts" overlaps "src/auth.test.ts")
 */
function filesOverlap(fileA: string, fileB: string): boolean {
  // Normalize separators
  const a = fileA.replace(/\\/g, "/").toLowerCase()
  const b = fileB.replace(/\\/g, "/").toLowerCase()

  // Exact match
  if (a === b) return true

  // Directory prefix match (src/ overlaps src/auth.ts)
  if (a.endsWith("/") && b.startsWith(a)) return true
  if (b.endsWith("/") && a.startsWith(b)) return true

  // Same directory, related filename stem
  const dirA = a.substring(0, a.lastIndexOf("/") + 1)
  const dirB = b.substring(0, b.lastIndexOf("/") + 1)
  if (dirA !== dirB) return false

  const stemA = a.substring(a.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "")
  const stemB = b.substring(b.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "")

  // e.g., "auth" matches "auth.test" or "auth-utils"
  return stemA.startsWith(stemB) || stemB.startsWith(stemA)
}