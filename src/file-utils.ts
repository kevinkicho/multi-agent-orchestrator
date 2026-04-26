import { resolve, dirname } from "path"
import { existsSync, mkdirSync, renameSync, unlinkSync, appendFileSync, readFileSync, writeFileSync } from "fs"

/** Atomically write a file by writing to a temp path then renaming.
 *  Prevents corruption if the process crashes mid-write.
 *  On Windows, renameSync fails if the target exists (unlike POSIX),
 *  so we delete the target first. The window between unlink and rename
 *  is unavoidable on Windows but is very short (~microseconds). */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tmpPath = filePath + `.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`
  try {
    await Bun.write(tmpPath, content)
    // On Windows, rename over an existing file throws EPERM/EEXIST.
    // Remove the target first so rename succeeds on all platforms.
    try { unlinkSync(filePath) } catch {}
    renameSync(tmpPath, filePath)
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
}

/** Read a file as text, returning null if it doesn't exist or is unreadable. */
export async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    const file = Bun.file(filePath)
    if (await file.exists()) {
      return await file.text()
    }
    return null
  } catch {
    return null
  }
}

/** Read and parse a JSON file, returning the fallback if it doesn't exist or is invalid. */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  const text = await readFileOrNull(filePath)
  if (text === null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** Write a JSON file atomically with pretty-printing. */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2))
}

const ERROR_LOG_FILE = ".orchestrator-errors.jsonl"
const ERROR_LOG_MAX_ENTRIES = 500

export type ErrorLogEntry = {
  timestamp: number
  message: string
  detail?: string
  agent?: string
  source?: string
}

// Cached line count per log path. Avoids reading the entire file after every
// append just to check whether we need to trim. The cache is populated on the
// first append per path (or after a trim), so rollover stays correct across
// process restarts even though the count is in-memory.
const errorLogLineCounts = new Map<string, number>()

/** Append an error entry to the project's .orchestrator-errors.jsonl file.
 *  Keeps the file capped at ERROR_LOG_MAX_ENTRIES lines by trimming the oldest
 *  entries when the cap is exceeded. */
export function appendErrorLog(
  projectDir: string,
  entry: Omit<ErrorLogEntry, "timestamp"> & { timestamp?: number },
): void {
  const filePath = resolve(projectDir, ERROR_LOG_FILE)
  const record: ErrorLogEntry = { timestamp: Date.now(), ...entry } as ErrorLogEntry
  const line = JSON.stringify(record) + "\n"
  try {
    appendFileSync(filePath, line)
    let count = errorLogLineCounts.get(filePath)
    if (count === undefined) {
      // First append this process — sync the count from disk once.
      try {
        const content = readFileSync(filePath, "utf-8")
        count = content.split("\n").filter(l => l.length > 0).length
      } catch {
        count = 1
      }
    } else {
      count++
    }
    if (count > ERROR_LOG_MAX_ENTRIES) {
      const content = readFileSync(filePath, "utf-8")
      const lines = content.split("\n").filter(l => l.length > 0)
      const trimmed = lines.slice(-ERROR_LOG_MAX_ENTRIES).join("\n") + "\n"
      const tmpPath = filePath + `.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`
      writeFileSync(tmpPath, trimmed)
      try { unlinkSync(filePath) } catch {}
      renameSync(tmpPath, filePath)
      count = ERROR_LOG_MAX_ENTRIES
    }
    errorLogLineCounts.set(filePath, count)
  } catch {
    // Best-effort: if we can't write the error log, silently skip
  }
}

/** Read recent error log entries from .orchestrator-errors.jsonl.
 *  Returns entries in chronological order (oldest first). */
export function readErrorLog(projectDir: string): ErrorLogEntry[] {
  const filePath = resolve(projectDir, ERROR_LOG_FILE)
  try {
    if (!existsSync(filePath)) return []
    const content = readFileSync(filePath, "utf-8")
    if (!content.trim()) return []
    return content
      .trim()
      .split("\n")
      .map((line: string) => {
        try { return JSON.parse(line) as ErrorLogEntry }
        catch { return null }
      })
      .filter((e: ErrorLogEntry | null): e is ErrorLogEntry => e !== null)
  } catch {
    return []
  }
}
