import { resolve } from "path"
import { mkdirSync } from "fs"
import { createHash } from "crypto"
import { readJsonFile, writeJsonFile } from "./file-utils"
import { readFileOrNull } from "./file-utils"
import type { ProgressAssessment } from "./progress-assessor"

export type BrainMemoryEntry = {
  timestamp: number
  objective: string
  summary: string
  agentLearnings: Record<string, string[]>
}

export type BrainMemoryStore = {
  /** @deprecated Flat entries — kept for migration from old format */
  entries: BrainMemoryEntry[]
  /** Per-agent session summaries, keyed by agent name, cap 20 each */
  agentEntries?: Record<string, BrainMemoryEntry[]>
  /** Persistent notes the brain has accumulated about the projects */
  projectNotes: Record<string, string[]>
  /** Behavioral notes about how agents work best (injected into supervisor system prompts) */
  behavioralNotes?: Record<string, string[]>
  /** Per-agent progress assessments from the progress assessor, cap 10 each */
  progressAssessments?: Record<string, ProgressAssessment[]>
}

export type AgentMemoryArchive = {
  agentName: string
  /** SHA-256 hash of the resolved directory path — prevents cross-project memory leaks */
  directoryHash: string
  directory?: string
  archivedAt: number
  behavioralNotes: string[]
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
  return migrateBrainMemory(raw)
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

/** Extract meaningful keywords from a note (>3 chars, lowercased, no numbers-only) */
function extractKeywords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 3 && !/^\d+$/.test(w))
  )
}

/** Keyword overlap similarity — returns 0..1 */
function keywordSimilarity(a: string, b: string): number {
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

export async function addBehavioralNote(
  _store: BrainMemoryStore,
  agentName: string,
  note: string,
): Promise<BrainMemoryStore> {
  return withWriteLock(async () => {
    const fresh = await loadBrainMemory()
    const notes = fresh.behavioralNotes?.[agentName] ?? []

    const sameTopicIdx = notes.findIndex(existing => isSameTopic(existing, note))

    let updated: string[]
    if (sameTopicIdx !== -1) {
      const existing = notes[sameTopicIdx]!
      if (note.length >= existing.length) {
        updated = [...notes]
        updated[sameTopicIdx] = note
      } else {
        return fresh
      }
    } else {
      updated = [...notes, note]
    }

    const result: BrainMemoryStore = {
      ...fresh,
      behavioralNotes: {
        ...(fresh.behavioralNotes ?? {}),
        [agentName]: updated.slice(-10),
      },
    }
    await saveBrainMemory(result)
    return result
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
      lines.push(entry.summary)
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
      const archive = JSON.parse(content) as AgentMemoryArchive
      if (!archive.agentName || !Array.isArray(archive.behavioralNotes)) continue
      // If both the archive and the request have directory info, verify they match
      if (directory && archive.directoryHash) {
        const expected = hashDirectory(directory)
        if (archive.directoryHash !== expected) continue // wrong project — skip
      }
      return archive
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
