import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs"
import { resolve, join } from "path"
import { readJsonFile, writeJsonFile } from "./file-utils"

export type PerformanceEntry = {
  timestamp: number
  projectName: string
  agentName: string
  model: string
  event: "cycle_complete" | "cycle_error" | "restart" | "stuck" | "supervisor_stop" | "supervisor_start"
  cycleNumber?: number
  summary?: string
  durationMs?: number
  details?: string
}

export type PerformanceLog = {
  entries: PerformanceEntry[]
}

const PERF_FILE = "orchestrator-performance.json"
const PERF_ARCHIVE_DIR = "orchestrator-performance-archive"
const MAX_ACTIVE_ENTRIES = 500
const ARCHIVE_AGE_DAYS = 7
const MAX_ARCHIVE_AGE_DAYS = 30

function getPerfPath(): string {
  return resolve(process.cwd(), PERF_FILE)
}

function getArchiveDir(): string {
  return resolve(process.cwd(), PERF_ARCHIVE_DIR)
}

export async function loadPerformanceLog(): Promise<PerformanceLog> {
  return readJsonFile<PerformanceLog>(getPerfPath(), { entries: [] })
}

export async function savePerformanceLog(log: PerformanceLog): Promise<void> {
  // Archive entries older than ARCHIVE_AGE_DAYS
  const cutoff = Date.now() - ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000
  const old = log.entries.filter(e => e.timestamp < cutoff)
  const recent = log.entries.filter(e => e.timestamp >= cutoff)

  if (old.length > 0) {
    try {
      const archiveDir = getArchiveDir()
      if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
      // Group by date and append to daily archive files
      const byDate: Record<string, PerformanceEntry[]> = {}
      for (const entry of old) {
        const day = new Date(entry.timestamp).toISOString().slice(0, 10) // YYYY-MM-DD
        ;(byDate[day] ??= []).push(entry)
      }
      for (const [day, entries] of Object.entries(byDate)) {
        const archivePath = resolve(archiveDir, `perf-${day}.json`)
        const existing = await readJsonFile<PerformanceEntry[]>(archivePath, [])
        await writeJsonFile(archivePath, [...existing, ...entries])
      }
    } catch (err) {
      console.error(`[performance-log] Failed to archive: ${err}`)
    }
  }

  // Clean up archive files older than MAX_ARCHIVE_AGE_DAYS
  try {
    const archiveDir = getArchiveDir()
    if (existsSync(archiveDir)) {
      const maxAge = Date.now() - MAX_ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000
      for (const file of readdirSync(archiveDir)) {
        if (!file.startsWith("perf-") || !file.endsWith(".json")) continue
        try {
          const filePath = join(archiveDir, file)
          const stat = statSync(filePath)
          if (stat.mtimeMs < maxAge) {
            unlinkSync(filePath)
          }
        } catch { /* best-effort: skip files that disappear or are locked */ }
      }
    }
  } catch { /* best-effort: archive directory may not exist */ }

  // Keep only recent entries in active log, capped at MAX_ACTIVE_ENTRIES
  log.entries = recent.slice(-MAX_ACTIVE_ENTRIES)
  await writeJsonFile(getPerfPath(), log)
}

// Write lock to prevent concurrent read-modify-write races from parallel supervisors
let writeLock: Promise<void> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn)
  writeLock = next.then(() => {}, () => {})
  return next
}

export async function logPerformance(entry: PerformanceEntry): Promise<void> {
  await withWriteLock(async () => {
    const log = await loadPerformanceLog()
    log.entries.push(entry)
    await savePerformanceLog(log)
  })
}

/** Aggregate performance stats by model */
export function getModelStats(log: PerformanceLog): Record<string, {
  model: string
  totalCycles: number
  totalErrors: number
  totalRestarts: number
  totalStuck: number
  totalStops: number
  avgCycleDurationMs: number
  projects: string[]
  firstUsed: number
  lastUsed: number
}> {
  const stats: Record<string, {
    model: string
    totalCycles: number
    totalErrors: number
    totalRestarts: number
    totalStuck: number
    totalStops: number
    cycleDurations: number[]
    projects: Set<string>
    firstUsed: number
    lastUsed: number
  }> = {}

  for (const entry of log.entries) {
    if (!stats[entry.model]) {
      stats[entry.model] = {
        model: entry.model,
        totalCycles: 0,
        totalErrors: 0,
        totalRestarts: 0,
        totalStuck: 0,
        totalStops: 0,
        cycleDurations: [],
        projects: new Set(),
        firstUsed: entry.timestamp,
        lastUsed: entry.timestamp,
      }
    }
    const s = stats[entry.model]!
    s.projects.add(entry.projectName)
    s.lastUsed = Math.max(s.lastUsed, entry.timestamp)
    s.firstUsed = Math.min(s.firstUsed, entry.timestamp)

    switch (entry.event) {
      case "cycle_complete":
        s.totalCycles++
        if (entry.durationMs) s.cycleDurations.push(entry.durationMs)
        break
      case "cycle_error":
        s.totalErrors++
        break
      case "restart":
        s.totalRestarts++
        break
      case "stuck":
        s.totalStuck++
        break
      case "supervisor_stop":
        s.totalStops++
        break
    }
  }

  const result: ReturnType<typeof getModelStats> = {}
  for (const [model, s] of Object.entries(stats)) {
    result[model] = {
      model: s.model,
      totalCycles: s.totalCycles,
      totalErrors: s.totalErrors,
      totalRestarts: s.totalRestarts,
      totalStuck: s.totalStuck,
      totalStops: s.totalStops,
      avgCycleDurationMs: s.cycleDurations.length > 0
        ? Math.round(s.cycleDurations.reduce((a, b) => a + b, 0) / s.cycleDurations.length)
        : 0,
      projects: Array.from(s.projects),
      firstUsed: s.firstUsed,
      lastUsed: s.lastUsed,
    }
  }
  return result
}
