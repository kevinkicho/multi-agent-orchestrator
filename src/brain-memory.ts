import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { resolve, dirname } from "path"

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
function withWriteLock<T>(fn: () => T): Promise<T> {
  const next = writeLock.then(fn, fn) // run fn after previous write completes (even if it errored)
  writeLock = next.then(() => {}, () => {}) // update lock, swallow errors
  return next
}

export function loadBrainMemory(): BrainMemoryStore {
  const path = getMemoryPath()
  if (!existsSync(path)) return { ...DEFAULT_STORE, entries: [], projectNotes: {} }
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return { ...DEFAULT_STORE, entries: [], projectNotes: {} }
  }
}

export function saveBrainMemory(store: BrainMemoryStore): void {
  const path = getMemoryPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2))
}

export async function addMemoryEntry(
  _store: BrainMemoryStore,
  entry: BrainMemoryEntry,
): Promise<BrainMemoryStore> {
  // Re-read from disk inside the lock to prevent concurrent write races
  return withWriteLock(() => {
    const fresh = loadBrainMemory()
    const result: BrainMemoryStore = {
      ...fresh,
      entries: [...fresh.entries, entry].slice(-50), // keep last 50 sessions
    }
    saveBrainMemory(result)
    return result
  })
}

export async function addProjectNote(
  _store: BrainMemoryStore,
  agentName: string,
  note: string,
): Promise<BrainMemoryStore> {
  // Re-read from disk inside the lock to prevent concurrent write races
  return withWriteLock(() => {
    const fresh = loadBrainMemory()
    const notes = fresh.projectNotes[agentName] ?? []
    const result: BrainMemoryStore = {
      ...fresh,
      projectNotes: {
        ...fresh.projectNotes,
        [agentName]: [...notes, note].slice(-20), // keep last 20 notes per agent
      },
    }
    saveBrainMemory(result)
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
