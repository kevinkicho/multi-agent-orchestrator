import { resolve } from "path"
import { mkdirSync } from "fs"
import { createHash } from "crypto"
import { readJsonFile, writeJsonFile } from "./file-utils"
import { readFileOrNull } from "./file-utils"
import type { ProgressAssessment } from "./progress-assessor"
import { parseSummarySections, SUMMARY_SECTIONS } from "./transcript-compressor"

export type BrainMemoryEntry = {
  timestamp: number
  objective: string
  summary: string
  agentLearnings: Record<string, string[]>
}

/** Source of a behavioral note — where in the learning loop it came from. */
export type BehavioralNoteSource = "review" | "meta-reflection" | "manual" | "legacy"

/** Provenance of a behavioral note — where/when/why it was created. */
export type BehavioralNoteProvenance = {
  source: BehavioralNoteSource
  cycle: number | null
  createdAt: number
}

/** A single firing — a cycle in which this note was judged relevant to context. */
export type BehavioralNoteFire = {
  cycle: number
  at: number
}

/** Marker on notes archived by the prune pass (zero fires after 20 cycles). */
export type BehavioralNoteArchiveMarker = {
  at: number
  cycle: number
  reason: "no-fires"
}

/** Marker on notes promoted by the prune/promote pass when fire evidence
 *  meets the threshold (≥3 fires across ≥2 distinct cycles). */
export type BehavioralNotePromotionMarker = {
  at: number
  cycle: number
  /** Original note text before any LLM clarity rewrite. */
  originalText: string
  /** True if a clarity-rewrite LLM call actually changed the text. */
  clarified: boolean
}

/** Structured behavioral note. Replaces the legacy `string` shape. */
export type BehavioralNote = {
  id: string
  text: string
  provenance: BehavioralNoteProvenance
  fires: BehavioralNoteFire[]
  /** Set when prune moves this note to the archived pool (unused). */
  archivedAt?: BehavioralNoteArchiveMarker
  /** Set when the note has earned principle status via fire evidence. */
  promotedAt?: BehavioralNotePromotionMarker
}

export type BrainMemoryStore = {
  /** @deprecated Flat entries — kept for migration from old format */
  entries: BrainMemoryEntry[]
  /** Per-agent session summaries, keyed by agent name, cap 20 each */
  agentEntries?: Record<string, BrainMemoryEntry[]>
  /** Persistent notes the brain has accumulated about the projects */
  projectNotes: Record<string, string[]>
  /** Behavioral notes about how agents work best (injected into supervisor system prompts) */
  behavioralNotes?: Record<string, BehavioralNote[]>
  /** Archived behavioral notes — zero fires after 20 cycles. Never injected
   *  into prompts; visible in the Memory tab under a collapsed section. */
  archivedBehavioralNotes?: Record<string, BehavioralNote[]>
  /** Per-agent progress assessments from the progress assessor, cap 10 each */
  progressAssessments?: Record<string, ProgressAssessment[]>
}

export type AgentMemoryArchive = {
  agentName: string
  /** SHA-256 hash of the resolved directory path — prevents cross-project memory leaks */
  directoryHash: string
  directory?: string
  archivedAt: number
  behavioralNotes: BehavioralNote[]
  projectNotes: string[]
  sessionSummaries: BrainMemoryEntry[]
  lastDirective?: string
}

const DEFAULT_STORE: BrainMemoryStore = {
  entries: [],
  agentEntries: {},
  projectNotes: {},
}

function getMemoryPath(): string {
  return resolve(process.cwd(), ".orchestrator-memory.json")
}

function getArchiveDir(): string {
  return resolve(process.cwd(), ".orchestrator", "archives")
}

function ensureArchiveDir(): void {
  try { mkdirSync(getArchiveDir(), { recursive: true }) } catch {}
}

/** Hash a directory path to a short hex string for use in filenames */
function hashDirectory(directory: string): string {
  return createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 12)
}

function archivePath(agentName: string, directory?: string): string {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (directory) {
    return resolve(getArchiveDir(), `${safe}-${hashDirectory(directory)}.json`)
  }
  // Legacy path (no directory) — used for backward compat lookup
  return resolve(getArchiveDir(), `${safe}.json`)
}

// Simple async write lock to prevent concurrent read-modify-write races
// when multiple parallel supervisors save memory simultaneously
let writeLock: Promise<void> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn) // run fn after previous write completes (even if it errored)
  writeLock = next.then(() => {}, () => {}) // update lock, swallow errors
  return next
}

// ---------------------------------------------------------------------------
// Migration: legacy string[] behavioralNotes → BehavioralNote[]
// ---------------------------------------------------------------------------

/** Stable short ID for a note. Hash of text keeps replays deterministic. */
function makeNoteId(text: string, createdAt: number): string {
  return createHash("sha256").update(`${createdAt}:${text}`).digest("hex").slice(0, 12)
}

/** Wrap a legacy string entry as a BehavioralNote with source="legacy". */
function wrapLegacyBehavioralNote(text: string): BehavioralNote {
  return {
    id: makeNoteId(text, 0),
    text,
    provenance: { source: "legacy", cycle: null, createdAt: 0 },
    fires: [],
  }
}

/** Structural check — a widened note has .text/.provenance/.fires. */
function isBehavioralNote(v: unknown): v is BehavioralNote {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return typeof o.text === "string"
    && typeof o.provenance === "object"
    && Array.isArray(o.fires)
}

/** Migrate the behavioralNotes map, wrapping any legacy string entries. */
function migrateBehavioralNotes(
  raw: Record<string, unknown> | undefined,
): Record<string, BehavioralNote[]> | undefined {
  if (!raw) return undefined
  const out: Record<string, BehavioralNote[]> = {}
  for (const [agent, val] of Object.entries(raw)) {
    if (!Array.isArray(val)) continue
    out[agent] = val.map(item => {
      if (typeof item === "string") return wrapLegacyBehavioralNote(item)
      if (isBehavioralNote(item)) return item
      // Unknown shape — drop silently rather than crash on load
      return null
    }).filter((n): n is BehavioralNote => n !== null)
  }
  return out
}

// ---------------------------------------------------------------------------
// Migration: flat entries[] → per-agent agentEntries{}
// ---------------------------------------------------------------------------

function migrateBrainMemory(store: BrainMemoryStore): BrainMemoryStore {
  // Already migrated — agentEntries exists and entries is empty
  if (store.agentEntries && Object.keys(store.agentEntries).length > 0 && store.entries.length === 0) {
    return store
  }
  // Nothing to migrate
  if (!store.entries || store.entries.length === 0) {
    return { ...store, agentEntries: store.agentEntries ?? {} }
  }
  // Distribute entries into per-agent buckets
  const agentEntries: Record<string, BrainMemoryEntry[]> = { ...(store.agentEntries ?? {}) }
  for (const entry of store.entries) {
    const agents = Object.keys(entry.agentLearnings)
    if (agents.length === 0) {
      // No agent attribution — put in _global
      agentEntries["_global"] = [...(agentEntries["_global"] ?? []), entry]
    } else {
      for (const agent of agents) {
        agentEntries[agent] = [...(agentEntries[agent] ?? []), entry]
      }
    }
  }
  // Cap each bucket at 20
  for (const key of Object.keys(agentEntries)) {
    agentEntries[key] = agentEntries[key]!.slice(-20)
  }
  return { ...store, entries: [], agentEntries }
}

// ---------------------------------------------------------------------------
// Core load/save
// ---------------------------------------------------------------------------

export async function loadBrainMemory(): Promise<BrainMemoryStore> {
  const raw = await readJsonFile<BrainMemoryStore>(getMemoryPath(), { ...DEFAULT_STORE, entries: [], projectNotes: {} })
  const migrated = migrateBrainMemory(raw)
  const behavioralNotes = migrateBehavioralNotes(raw.behavioralNotes as Record<string, unknown> | undefined)
  const archivedBehavioralNotes = migrateBehavioralNotes(raw.archivedBehavioralNotes as Record<string, unknown> | undefined)
  return { ...migrated, behavioralNotes, archivedBehavioralNotes }
}

export async function saveBrainMemory(store: BrainMemoryStore): Promise<void> {
  await writeJsonFile(getMemoryPath(), store)
}

// ---------------------------------------------------------------------------
// Add entries / notes
// ---------------------------------------------------------------------------

export async function addMemoryEntry(
  _store: BrainMemoryStore,
  entry: BrainMemoryEntry,
  agentName?: string,
): Promise<BrainMemoryStore> {
  return withWriteLock(async () => {
    const fresh = await loadBrainMemory()
    const bucket = agentName || "_global"
    const existing = fresh.agentEntries?.[bucket] ?? []
    const result: BrainMemoryStore = {
      ...fresh,
      agentEntries: {
        ...(fresh.agentEntries ?? {}),
        [bucket]: [...existing, entry].slice(-20), // 20 per agent
      },
    }
    await saveBrainMemory(result)
    return result
  })
}

export async function addProjectNote(
  _store: BrainMemoryStore,
  agentName: string,
  note: string,
): Promise<BrainMemoryStore> {
  return withWriteLock(async () => {
    const fresh = await loadBrainMemory()
    const notes = fresh.projectNotes[agentName] ?? []
    const result: BrainMemoryStore = {
      ...fresh,
      projectNotes: {
        ...fresh.projectNotes,
        [agentName]: [...notes, note].slice(-20),
      },
    }
    await saveBrainMemory(result)
    return result
  })
}

/** Extract meaningful keywords from a note (>3 chars, lowercased, no numbers-only).
 *  Exported so the fire-tracker can reuse the same tokenization heuristic. */
export function extractKeywords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 3 && !/^\d+$/.test(w))
  )
}

/** Keyword overlap similarity — returns 0..1. Exported for fire-tracker reuse. */
export function keywordSimilarity(a: string, b: string): number {
  const wordsA = extractKeywords(a)
  const wordsB = extractKeywords(b)
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let overlap = 0
  for (const w of wordsA) { if (wordsB.has(w)) overlap++ }
  return overlap / Math.min(wordsA.size, wordsB.size)
}

/** Check if two notes cover the same topic (e.g., both about non-responsiveness/restarts) */
function isSameTopic(a: string, b: string): boolean {
  if (keywordSimilarity(a, b) >= 0.6) return true
  const categories = [
    /non-responsive|empty.?response|unresponsive|zero output|restart/i,
    /simple.?prompt|single.?action|one.?action|multi.?step/i,
    /circuit.?breaker|restart.?cap|failed.?cycle/i,
  ]
  for (const pattern of categories) {
    if (pattern.test(a) && pattern.test(b)) return true
  }
  return false
}

export type AddBehavioralNoteOptions = {
  source?: BehavioralNoteSource
  cycle?: number | null
}

export async function addBehavioralNote(
  _store: BrainMemoryStore,
  agentName: string,
  note: string,
  options?: AddBehavioralNoteOptions,
): Promise<BrainMemoryStore> {
  return withWriteLock(async () => {
    const fresh = await loadBrainMemory()
    const notes = fresh.behavioralNotes?.[agentName] ?? []
    const createdAt = Date.now()
    const source: BehavioralNoteSource = options?.source ?? "manual"
    const cycle = options?.cycle ?? null

    const sameTopicIdx = notes.findIndex(existing => isSameTopic(existing.text, note))

    let updated: BehavioralNote[]
    if (sameTopicIdx !== -1) {
      const existing = notes[sameTopicIdx]!
      if (note.length >= existing.text.length) {
        // Replace the text but preserve ID + fires + original provenance. Fire
        // history is a property of the topic, not the specific wording.
        updated = [...notes]
        updated[sameTopicIdx] = { ...existing, text: note }
      } else {
        return fresh
      }
    } else {
      const fresh_note: BehavioralNote = {
        id: makeNoteId(note, createdAt),
        text: note,
        provenance: { source, cycle, createdAt },
        fires: [],
      }
      updated = [...notes, fresh_note]
    }

    const result: BrainMemoryStore = {
      ...fresh,
      behavioralNotes: {
        ...(fresh.behavioralNotes ?? {}),
        [agentName]: capBehavioralNotes(updated),
      },
    }
    await saveBrainMemory(result)
    return result
  })
}

/** Cap the active notes list: promoted notes are never dropped; non-promoted
 *  notes keep the last 10 by insertion order. Preserves original ordering. */
function capBehavioralNotes(notes: BehavioralNote[]): BehavioralNote[] {
  const NONPROMOTED_CAP = 10
  const promoted = notes.filter(n => n.promotedAt)
  const regular = notes.filter(n => !n.promotedAt)
  if (regular.length <= NONPROMOTED_CAP) return notes
  const keptRegularIds = new Set(regular.slice(-NONPROMOTED_CAP).map(n => n.id))
  return notes.filter(n => n.promotedAt || keptRegularIds.has(n.id))
}

/** Record that one or more behavioral notes fired in a given cycle. Updates
 *  the `fires[]` trace for each matched note and persists atomically. */
export async function recordBehavioralNoteFires(
  agentName: string,
  noteIds: string[],
  cycle: number,
): Promise<BrainMemoryStore | null> {
  if (noteIds.length === 0) return null
  return withWriteLock(async () => {
    const fresh = await loadBrainMemory()
    const notes = fresh.behavioralNotes?.[agentName] ?? []
    if (notes.length === 0) return fresh
    const idSet = new Set(noteIds)
    const at = Date.now()
    let changed = false
    const updated = notes.map(n => {
      if (!idSet.has(n.id)) return n
      changed = true
      return { ...n, fires: [...n.fires, { cycle, at }] }
    })
    if (!changed) return fresh
    const result: BrainMemoryStore = {
      ...fresh,
      behavioralNotes: {
        ...(fresh.behavioralNotes ?? {}),
        [agentName]: updated,
      },
    }
    await saveBrainMemory(result)
    return result
  })
}

// ---------------------------------------------------------------------------
// Prune + promote
//
// Evidence-driven upgrade/downgrade of behavioral notes:
//   - Promote: a note with ≥3 fires across ≥2 distinct cycles earns principle
//     status. An optional `clarifier` may rewrite the text for concision;
//     `promotedAt.originalText` preserves the pre-rewrite wording.
//   - Archive: a note with 0 fires whose age ≥ ARCHIVE_THRESHOLD_CYCLES moves
//     out of the active pool into `archivedBehavioralNotes`. Archived notes
//     are never injected into prompts but remain visible in the Memory tab.
// Legacy notes (provenance.cycle === null) use cycle 0 as their baseline.
// ---------------------------------------------------------------------------

export const PROMOTE_FIRE_COUNT_THRESHOLD = 3
export const PROMOTE_DISTINCT_CYCLES_THRESHOLD = 2
export const ARCHIVE_THRESHOLD_CYCLES = 20

export type NoteClarifier = (input: {
  noteText: string
  agentName: string
}) => Promise<string | null>

export type PruneAndPromoteResult = {
  promoted: BehavioralNote[]
  archived: BehavioralNote[]
}

/** Should this note be promoted based on fire evidence? */
export function shouldPromote(note: BehavioralNote): boolean {
  if (note.promotedAt) return false
  if (note.archivedAt) return false
  if (note.fires.length < PROMOTE_FIRE_COUNT_THRESHOLD) return false
  const distinctCycles = new Set(note.fires.map(f => f.cycle)).size
  return distinctCycles >= PROMOTE_DISTINCT_CYCLES_THRESHOLD
}

/** Should this note be archived based on cycle age + lack of fires? */
export function shouldArchive(note: BehavioralNote, currentCycle: number): boolean {
  if (note.promotedAt) return false
  if (note.archivedAt) return false
  if (note.fires.length > 0) return false
  const baseline = note.provenance.cycle ?? 0
  return (currentCycle - baseline) >= ARCHIVE_THRESHOLD_CYCLES
}

/** Evaluate every active note for the agent; promote those with sufficient
 *  fire evidence and archive those that have sat unused for too long. Safe to
 *  call every cycle; no-op when there's nothing to change. */
export async function pruneAndPromoteBehavioralNotes(
  agentName: string,
  currentCycle: number,
  clarifier?: NoteClarifier,
): Promise<PruneAndPromoteResult> {
  const now = Date.now()
  // Determine what will change under a snapshot of memory (LLM calls may run
  // outside the write lock). We re-validate under the lock before persisting
  // so a concurrent write can't lose our work.
  const snapshot = await loadBrainMemory()
  const snapshotNotes = snapshot.behavioralNotes?.[agentName] ?? []
  const pendingPromotions: Array<{ id: string; clarified?: string }> = []
  const pendingArchives = new Set<string>()
  for (const note of snapshotNotes) {
    if (shouldPromote(note)) pendingPromotions.push({ id: note.id })
    else if (shouldArchive(note, currentCycle)) pendingArchives.add(note.id)
  }
  if (pendingPromotions.length === 0 && pendingArchives.size === 0) {
    return { promoted: [], archived: [] }
  }

  // Run the optional LLM clarifier outside the write lock — one call per
  // newly-promoted note. Failures are non-fatal (leave text unchanged).
  if (clarifier && pendingPromotions.length > 0) {
    for (const pending of pendingPromotions) {
      const note = snapshotNotes.find(n => n.id === pending.id)
      if (!note) continue
      try {
        const rewritten = await clarifier({ noteText: note.text, agentName })
        if (rewritten && rewritten.trim() && rewritten.trim() !== note.text.trim()) {
          pending.clarified = rewritten.trim()
        }
      } catch {
        // Best-effort: leave text unchanged on any failure
      }
    }
  }

  return withWriteLock(async () => {
    const fresh = await loadBrainMemory()
    const activeNotes = fresh.behavioralNotes?.[agentName] ?? []
    if (activeNotes.length === 0) return { promoted: [], archived: [] }

    const promotionMap = new Map(pendingPromotions.map(p => [p.id, p.clarified]))
    const promoted: BehavioralNote[] = []
    const archived: BehavioralNote[] = []
    const keptActive: BehavioralNote[] = []

    for (const note of activeNotes) {
      if (promotionMap.has(note.id) && shouldPromote(note)) {
        const clarified = promotionMap.get(note.id)
        const updated: BehavioralNote = {
          ...note,
          text: clarified ?? note.text,
          promotedAt: {
            at: now,
            cycle: currentCycle,
            originalText: note.text,
            clarified: Boolean(clarified),
          },
        }
        promoted.push(updated)
        keptActive.push(updated)
      } else if (pendingArchives.has(note.id) && shouldArchive(note, currentCycle)) {
        const updated: BehavioralNote = {
          ...note,
          archivedAt: { at: now, cycle: currentCycle, reason: "no-fires" },
        }
        archived.push(updated)
      } else {
        keptActive.push(note)
      }
    }

    if (promoted.length === 0 && archived.length === 0) {
      // Everything we planned got cancelled by a concurrent write — exit clean.
      return { promoted: [], archived: [] }
    }

    const existingArchived = fresh.archivedBehavioralNotes?.[agentName] ?? []
    const ARCHIVED_CAP = 50
    const nextArchived = [...existingArchived, ...archived].slice(-ARCHIVED_CAP)

    const result: BrainMemoryStore = {
      ...fresh,
      behavioralNotes: {
        ...(fresh.behavioralNotes ?? {}),
        [agentName]: keptActive,
      },
      archivedBehavioralNotes: {
        ...(fresh.archivedBehavioralNotes ?? {}),
        [agentName]: nextArchived,
      },
    }
    await saveBrainMemory(result)
    return { promoted, archived }
  })
}

// ---------------------------------------------------------------------------
// Progress assessment persistence
// ---------------------------------------------------------------------------

const MAX_ASSESSMENT_RECORDS = 10

export async function saveProgressAssessment(
  _store: BrainMemoryStore,
  agentName: string,
  assessment: ProgressAssessment,
): Promise<BrainMemoryStore> {
  return withWriteLock(async () => {
    const fresh = await loadBrainMemory()
    const existing = fresh.progressAssessments?.[agentName] ?? []
    const updated = [...existing, assessment].slice(-MAX_ASSESSMENT_RECORDS)

    const result: BrainMemoryStore = {
      ...fresh,
      progressAssessments: {
        ...(fresh.progressAssessments ?? {}),
        [agentName]: updated,
      },
    }
    await saveBrainMemory(result)
    return result
  })
}

export function getProgressAssessments(
  store: BrainMemoryStore,
  agentName: string,
): ProgressAssessment[] {
  return store.progressAssessments?.[agentName] ?? []
}

// ---------------------------------------------------------------------------
// Structured session summaries
//
// Session summaries (BrainMemoryEntry.summary) are free-form strings, but the
// supervisor and brain prompts now ask for a seven-section markdown schema
// shared with transcript-compressor. parseSessionSummary detects when a
// summary follows that schema so downstream rendering (and, later,
// meta-reflection) can operate on structured fields rather than raw prose.
// Legacy prose summaries are returned as { raw } with no sections.
// ---------------------------------------------------------------------------

export type StructuredSessionSummary = {
  raw: string
  sections?: Record<string, string>
}

const MIN_STRUCTURED_SECTIONS = 2

export function parseSessionSummary(raw: string): StructuredSessionSummary {
  if (!raw) return { raw: "" }
  const sections = parseSummarySections(raw)
  if (Object.keys(sections).length >= MIN_STRUCTURED_SECTIONS) {
    return { raw, sections }
  }
  return { raw }
}

/** Render a session summary for injection into an LLM prompt. For structured
 *  summaries, surface the highest-signal sections; fall back to raw prose. */
function renderSummaryForPrompt(raw: string): string {
  const parsed = parseSessionSummary(raw)
  if (!parsed.sections) return raw.trim()
  const preferred = ["Active Task", "Completed Actions", "Active State", "Remaining Work"] as const
  const lines: string[] = []
  for (const section of preferred) {
    const body = parsed.sections[section]
    if (body && body.toLowerCase() !== "(none)") {
      lines.push(`**${section}:** ${body.replace(/\n+/g, " ").trim()}`)
    }
  }
  // If none of the preferred sections had content, fall back to any available section
  if (lines.length === 0) {
    for (const section of SUMMARY_SECTIONS) {
      const body = parsed.sections[section]
      if (body && body.toLowerCase() !== "(none)") {
        lines.push(`**${section}:** ${body.replace(/\n+/g, " ").trim()}`)
        break
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : raw.trim()
}

// ---------------------------------------------------------------------------
// Format for LLM context
// ---------------------------------------------------------------------------

/**
 * Format memory for LLM context.
 * @param store — the full memory store
 * @param agentName — if provided, only include notes for this agent
 */
export function formatMemoryForPrompt(store: BrainMemoryStore, agentName?: string): string {
  const lines: string[] = []

  // Per-agent entries (new format) or fallback to legacy flat entries
  const entries = agentName
    ? (store.agentEntries?.[agentName] ?? store.entries.filter(e =>
        e.objective.includes(agentName) || agentName in e.agentLearnings
      ))
    : mergeAllEntries(store)

  if (entries.length > 0) {
    lines.push("## Previous Session Summaries (most recent first)")
    const recent = entries.slice(-5).reverse()
    for (const entry of recent) {
      const date = new Date(entry.timestamp).toLocaleString()
      lines.push(`\n### ${date} — "${entry.objective}"`)
      lines.push(renderSummaryForPrompt(entry.summary))
      if (agentName) {
        const learnings = entry.agentLearnings[agentName]
        if (learnings?.length) {
          lines.push(`  ${agentName}: ${learnings.join("; ")}`)
        }
      } else {
        for (const [agent, learnings] of Object.entries(entry.agentLearnings)) {
          if (learnings.length > 0) {
            lines.push(`  ${agent}: ${learnings.join("; ")}`)
          }
        }
      }
    }
  }

  if (Object.keys(store.projectNotes).length > 0) {
    lines.push("\n## Project Notes")
    const agentsToShow = agentName
      ? [[agentName, store.projectNotes[agentName] ?? []] as const]
      : Object.entries(store.projectNotes)
    for (const [agent, notes] of agentsToShow) {
      if (notes.length > 0) {
        lines.push(`\n### ${agent}`)
        for (const note of notes.slice(-5)) {
          lines.push(`- ${note}`)
        }
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : ""
}

/** Merge all per-agent entries, sort by timestamp, return last 5 */
function mergeAllEntries(store: BrainMemoryStore): BrainMemoryEntry[] {
  const all: BrainMemoryEntry[] = []
  for (const entries of Object.values(store.agentEntries ?? {})) {
    all.push(...entries)
  }
  // Also include legacy entries if they exist
  all.push(...(store.entries ?? []))
  all.sort((a, b) => a.timestamp - b.timestamp)
  // Deduplicate by timestamp+objective
  const seen = new Set<string>()
  const unique = all.filter(e => {
    const key = `${e.timestamp}:${e.objective}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.slice(-5)
}

// ---------------------------------------------------------------------------
// Archive / Restore
// ---------------------------------------------------------------------------

/** Archive an agent's memory to a per-agent file and remove from active store */
export async function archiveAgentMemory(
  agentName: string,
  lastDirective?: string,
  directory?: string,
): Promise<void> {
  return withWriteLock(async () => {
    const store = await loadBrainMemory()
    const dirHash = directory ? hashDirectory(directory) : ""
    const archive: AgentMemoryArchive = {
      agentName,
      directoryHash: dirHash,
      directory,
      archivedAt: Date.now(),
      behavioralNotes: store.behavioralNotes?.[agentName] ?? [],
      projectNotes: store.projectNotes[agentName] ?? [],
      sessionSummaries: store.agentEntries?.[agentName] ?? [],
      lastDirective,
    }
    // Only write archive if there's something to save
    if (archive.behavioralNotes.length || archive.projectNotes.length || archive.sessionSummaries.length) {
      ensureArchiveDir()
      await writeJsonFile(archivePath(agentName, directory), archive)
    }
    // Remove agent data from active store
    const { [agentName]: _bn, ...restBehavioral } = store.behavioralNotes ?? {}
    const { [agentName]: _pn, ...restProject } = store.projectNotes
    const { [agentName]: _ae, ...restEntries } = store.agentEntries ?? {}
    const cleaned: BrainMemoryStore = {
      entries: store.entries,
      agentEntries: restEntries,
      projectNotes: restProject,
      behavioralNotes: restBehavioral,
    }
    await saveBrainMemory(cleaned)
  })
}

/** Load an agent's archive. Returns null if none exists or directory doesn't match. */
export async function loadAgentArchive(agentName: string, directory?: string): Promise<AgentMemoryArchive | null> {
  // Try directory-specific path first, then fall back to legacy (no-hash) path
  const paths = directory
    ? [archivePath(agentName, directory), archivePath(agentName)]
    : [archivePath(agentName)]
  for (const path of paths) {
    const content = await readFileOrNull(path)
    if (!content) continue
    try {
      const rawArchive = JSON.parse(content) as AgentMemoryArchive & { behavioralNotes?: unknown[] }
      if (!rawArchive.agentName || !Array.isArray(rawArchive.behavioralNotes)) continue
      // If both the archive and the request have directory info, verify they match
      if (directory && rawArchive.directoryHash) {
        const expected = hashDirectory(directory)
        if (rawArchive.directoryHash !== expected) continue // wrong project — skip
      }
      // Wrap any legacy string behavioral notes in the archive
      const notes: BehavioralNote[] = rawArchive.behavioralNotes.map(item =>
        typeof item === "string"
          ? wrapLegacyBehavioralNote(item)
          : isBehavioralNote(item) ? item : null
      ).filter((n): n is BehavioralNote => n !== null)
      return { ...rawArchive, behavioralNotes: notes }
    } catch {
      continue
    }
  }
  return null
}

/** Check if an agent has an archived memory file matching the given directory */
export async function hasAgentArchive(agentName: string, directory?: string): Promise<boolean> {
  return (await loadAgentArchive(agentName, directory)) !== null
}

/** Restore an agent's archived memory back into the active store and delete the archive file */
export async function restoreAgentMemory(agentName: string, directory?: string): Promise<boolean> {
  const archive = await loadAgentArchive(agentName, directory)
  if (!archive) return false
  return withWriteLock(async () => {
    const store = await loadBrainMemory()
    const result: BrainMemoryStore = {
      entries: store.entries,
      agentEntries: {
        ...(store.agentEntries ?? {}),
        [agentName]: [...(store.agentEntries?.[agentName] ?? []), ...archive.sessionSummaries].slice(-20),
      },
      projectNotes: {
        ...store.projectNotes,
        [agentName]: [...(store.projectNotes[agentName] ?? []), ...archive.projectNotes].slice(-20),
      },
      behavioralNotes: {
        ...(store.behavioralNotes ?? {}),
        [agentName]: [...(store.behavioralNotes?.[agentName] ?? []), ...archive.behavioralNotes].slice(-10),
      },
    }
    await saveBrainMemory(result)
    // Delete the archive file after successful restore — try both hashed and legacy paths
    const { unlinkSync } = await import("fs")
    try { unlinkSync(archivePath(agentName, directory)) } catch {}
    try { unlinkSync(archivePath(agentName)) } catch {}
    return true
  })
}

/** List all available archives */
export async function listArchives(): Promise<Array<{ agentName: string; archivedAt: number; lastDirective?: string }>> {
  try {
    const { readdirSync } = await import("fs")
    const files = readdirSync(getArchiveDir()).filter(f => f.endsWith(".json"))
    const results: Array<{ agentName: string; archivedAt: number; lastDirective?: string }> = []
    for (const file of files) {
      const content = await readFileOrNull(resolve(getArchiveDir(), file))
      if (!content) continue
      try {
        const archive = JSON.parse(content) as AgentMemoryArchive
        results.push({ agentName: archive.agentName, archivedAt: archive.archivedAt, lastDirective: archive.lastDirective })
      } catch {}
    }
    return results
  } catch {
    return []
  }
}
