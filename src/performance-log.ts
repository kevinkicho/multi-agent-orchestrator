import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { resolve, dirname } from "path"

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

function getPerfPath(): string {
  return resolve(process.cwd(), PERF_FILE)
}

function getArchiveDir(): string {
  return resolve(process.cwd(), PERF_ARCHIVE_DIR)
}

export function loadPerformanceLog(): PerformanceLog {
  const path = getPerfPath()
  if (!existsSync(path)) return { entries: [] }
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return { entries: [] }
  }
}

export function savePerformanceLog(log: PerformanceLog): void {
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
        let existing: PerformanceEntry[] = []
        if (existsSync(archivePath)) {
          try { existing = JSON.parse(readFileSync(archivePath, "utf-8")) } catch {}
        }
        writeFileSync(archivePath, JSON.stringify([...existing, ...entries], null, 2))
      }
    } catch (err) {
      console.error(`[performance-log] Failed to archive: ${err}`)
    }
  }

  // Keep only recent entries in active log, capped at MAX_ACTIVE_ENTRIES
  log.entries = recent.slice(-MAX_ACTIVE_ENTRIES)

  try {
    writeFileSync(getPerfPath(), JSON.stringify(log, null, 2))
  } catch (err) {
    console.error(`[performance-log] Failed to save: ${err}`)
  }
}

export function logPerformance(entry: PerformanceEntry): void {
  const log = loadPerformanceLog()
  log.entries.push(entry)
  savePerformanceLog(log)
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

  const result: Record<string, any> = {}
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
