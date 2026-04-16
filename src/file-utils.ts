import { resolve, dirname } from "path"
import { existsSync, mkdirSync, renameSync, unlinkSync } from "fs"

/** Atomically write a file by writing to a temp path then renaming.
 *  Prevents corruption if the process crashes mid-write. */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tmpPath = filePath + `.tmp.${Date.now()}`
  try {
    await Bun.write(tmpPath, content)
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
