import { resolve } from "path"
import { readJsonFile, writeJsonFile } from "./file-utils"

export type LedgerEntry = {
  id: string
  timestamp: number
  source: "user" | "brain" | "supervisor" | "manager" | "agent" | "system"
  target?: string
  direction: "outbound" | "inbound"
  projectName?: string
  agentName?: string
  model?: string
  cycleNumber?: number
  sessionId?: string
  content: string
  contentLength: number
  tags?: string[]
}

export type LedgerStore = {
  entries: LedgerEntry[]
}

export type LedgerQuery = {
  source?: string
  agentName?: string
  since?: number
  until?: number
  search?: string
  tags?: string[]
  limit?: number
  offset?: number
}

const MAX_ENTRIES = 2000
const MAX_CONTENT_LENGTH = 2000

function getLedgerPath(): string {
  return resolve(process.cwd(), ".orchestrator-ledger.json")
}

// Write lock — same pattern as brain-memory.ts
let writeLock: Promise<void> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn)
  writeLock = next.then(() => {}, () => {})
  return next
}

function generateId(): string {
  return `led-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export async function loadLedger(): Promise<LedgerStore> {
  return readJsonFile<LedgerStore>(getLedgerPath(), { entries: [] })
}

export async function recordPrompt(
  entry: Omit<LedgerEntry, "id" | "timestamp" | "content" | "contentLength"> & { content: string }
): Promise<void> {
  await withWriteLock(async () => {
    const store = await loadLedger()
    const fullLength = entry.content.length
    const truncated = entry.content.length > MAX_CONTENT_LENGTH
      ? entry.content.slice(0, MAX_CONTENT_LENGTH) + "…"
      : entry.content

    store.entries.push({
      ...entry,
      id: generateId(),
      timestamp: Date.now(),
      content: truncated,
      contentLength: fullLength,
    })

    // Cap at MAX_ENTRIES — drop oldest
    if (store.entries.length > MAX_ENTRIES) {
      store.entries = store.entries.slice(store.entries.length - MAX_ENTRIES)
    }

    await writeJsonFile(getLedgerPath(), store)
  })
}

export function queryLedger(
  store: LedgerStore,
  query: LedgerQuery
): { entries: LedgerEntry[]; total: number } {
  let filtered = store.entries

  if (query.source) {
    filtered = filtered.filter(e => e.source === query.source)
  }
  if (query.agentName) {
    filtered = filtered.filter(e => e.agentName === query.agentName)
  }
  if (query.since) {
    filtered = filtered.filter(e => e.timestamp >= query.since!)
  }
  if (query.until) {
    filtered = filtered.filter(e => e.timestamp <= query.until!)
  }
  if (query.search) {
    const lower = query.search.toLowerCase()
    filtered = filtered.filter(e => e.content.toLowerCase().includes(lower))
  }
  if (query.tags && query.tags.length > 0) {
    filtered = filtered.filter(e =>
      e.tags && query.tags!.some(t => e.tags!.includes(t))
    )
  }

  const total = filtered.length

  // Sort newest first
  filtered = [...filtered].sort((a, b) => b.timestamp - a.timestamp)

  // Paginate
  const offset = query.offset ?? 0
  const limit = query.limit ?? 25
  filtered = filtered.slice(offset, offset + limit)

  return { entries: filtered, total }
}

export function getLedgerStats(store: LedgerStore): {
  bySource: Record<string, number>
  byAgent: Record<string, number>
  byHour: Record<string, number>
} {
  const bySource: Record<string, number> = {}
  const byAgent: Record<string, number> = {}
  const byHour: Record<string, number> = {}

  for (const e of store.entries) {
    bySource[e.source] = (bySource[e.source] ?? 0) + 1
    if (e.agentName) {
      byAgent[e.agentName] = (byAgent[e.agentName] ?? 0) + 1
    }
    const hour = new Date(e.timestamp).toISOString().slice(0, 13) // "2026-04-16T14"
    byHour[hour] = (byHour[hour] ?? 0) + 1
  }

  return { bySource, byAgent, byHour }
}
