import { resolve } from "path"
import { readJsonFile, writeJsonFile } from "./file-utils"

export type BrainMemoryEntry = {
  timestamp: number
  objective: string
  summary: string
  agentLearnings: Record<string, string[]>
}

export type BrainMemoryStore = {
  entries: BrainMemoryEntry[]
  /** Persistent notes the brain has accumulated about the projects */
  projectNotes: Record<string, string[]>
  /** Behavioral notes about how agents work best (injected into supervisor system prompts) */
  behavioralNotes?: Record<string, string[]>
}

const DEFAULT_STORE: BrainMemoryStore = {
  entries: [],
  projectNotes: {},
}

function getMemoryPath(): string {
  return resolve(process.cwd(), ".orchestrator-memory.json")
}

// Simple async write lock to prevent concurrent read-modify-write races
// when multiple parallel supervisors save memory simultaneously
let writeLock: Promise<void> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn) // run fn after previous write completes (even if it errored)
  writeLock = next.then(() => {}, () => {}) // update lock, swallow errors
  return next
}

export async function loadBrainMemory(): Promise<BrainMemoryStore> {
  return readJsonFile<BrainMemoryStore>(getMemoryPath(), { ...DEFAULT_STORE, entries: [], projectNotes: {} })
}

export async function saveBrainMemory(store: BrainMemoryStore): Promise<void> {
  await writeJsonFile(getMemoryPath(), store)
}

export async function addMemoryEntry(
  _store: BrainMemoryStore,
  entry: BrainMemoryEntry,
): Promise<BrainMemoryStore> {
  // Re-read from disk inside the lock to prevent concurrent write races
  return withWriteLock(async () => {
    const fresh = await loadBrainMemory()
    const result: BrainMemoryStore = {
      ...fresh,
      entries: [...fresh.entries, entry].slice(-50), // keep last 50 sessions
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
  // Re-read from disk inside the lock to prevent concurrent write races
  return withWriteLock(async () => {
    const fresh = await loadBrainMemory()
    const notes = fresh.projectNotes[agentName] ?? []
    const result: BrainMemoryStore = {
      ...fresh,
      projectNotes: {
        ...fresh.projectNotes,
        [agentName]: [...notes, note].slice(-20), // keep last 20 notes per agent
      },
    }
    await saveBrainMemory(result)
    return result
  })
}

/** Simple similarity check — returns true if two notes share enough keywords to be duplicates */
function isSimilarNote(a: string, b: string, threshold = 0.6): boolean {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3))
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3))
  if (wordsA.size === 0 || wordsB.size === 0) return false
  let overlap = 0
  for (const w of wordsA) { if (wordsB.has(w)) overlap++ }
  const similarity = overlap / Math.min(wordsA.size, wordsB.size)
  return similarity >= threshold
}

export async function addBehavioralNote(
  _store: BrainMemoryStore,
  agentName: string,
  note: string,
): Promise<BrainMemoryStore> {
  return withWriteLock(async () => {
    const fresh = await loadBrainMemory()
    const notes = fresh.behavioralNotes?.[agentName] ?? []
    // Deduplicate — skip if a similar note already exists
    if (notes.some(existing => isSimilarNote(existing, note))) {
      return fresh
    }
    const result: BrainMemoryStore = {
      ...fresh,
      behavioralNotes: {
        ...(fresh.behavioralNotes ?? {}),
        [agentName]: [...notes, note].slice(-10),
      },
    }
    await saveBrainMemory(result)
    return result
  })
}

export function formatMemoryForPrompt(store: BrainMemoryStore): string {
  const lines: string[] = []

  if (store.entries.length > 0) {
    lines.push("## Previous Session Summaries (most recent first)")
    const recent = store.entries.slice(-5).reverse()
    for (const entry of recent) {
      const date = new Date(entry.timestamp).toLocaleString()
      lines.push(`\n### ${date} — "${entry.objective}"`)
      lines.push(entry.summary)
      for (const [agent, learnings] of Object.entries(entry.agentLearnings)) {
        if (learnings.length > 0) {
          lines.push(`  ${agent}: ${learnings.join("; ")}`)
        }
      }
    }
  }

  if (Object.keys(store.projectNotes).length > 0) {
    lines.push("\n## Project Notes")
    for (const [agent, notes] of Object.entries(store.projectNotes)) {
      if (notes.length > 0) {
        lines.push(`\n### ${agent}`)
        for (const note of notes.slice(-10)) {
          lines.push(`- ${note}`)
        }
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : ""
}
