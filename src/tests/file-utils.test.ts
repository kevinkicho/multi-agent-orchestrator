import { describe, test, expect, afterEach } from "bun:test"
import { resolve } from "path"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import {
  atomicWrite, readFileOrNull, readJsonFile, writeJsonFile,
  appendErrorLog, readErrorLog, type ErrorLogEntry,
} from "../file-utils"

const TEST_DIR = resolve(import.meta.dir, ".test-tmp-" + Date.now())

// Ensure test dir exists
mkdirSync(TEST_DIR, { recursive: true })

afterEach(() => {
  // Clean up test dir after all tests
})

// Clean up at the end
process.on("exit", () => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
})

describe("atomicWrite", () => {
  test("writes a new file", async () => {
    const path = resolve(TEST_DIR, "atomic-new.txt")
    await atomicWrite(path, "hello world")
    const content = await Bun.file(path).text()
    expect(content).toBe("hello world")
  })

  test("overwrites an existing file", async () => {
    const path = resolve(TEST_DIR, "atomic-overwrite.txt")
    await atomicWrite(path, "first")
    await atomicWrite(path, "second")
    const content = await Bun.file(path).text()
    expect(content).toBe("second")
  })

  test("creates parent directories if needed", async () => {
    const path = resolve(TEST_DIR, "sub", "dir", "deep.txt")
    await atomicWrite(path, "deep content")
    const content = await Bun.file(path).text()
    expect(content).toBe("deep content")
  })

  test("no temp file left behind on success", async () => {
    const path = resolve(TEST_DIR, "atomic-clean.txt")
    await atomicWrite(path, "clean")
    // Check no .tmp files exist
    const dir = resolve(TEST_DIR)
    const files = await Array.fromAsync(new Bun.Glob("atomic-clean.txt.tmp.*").scan(dir))
    expect(files.length).toBe(0)
  })
})

describe("readFileOrNull", () => {
  test("returns content for existing file", async () => {
    const path = resolve(TEST_DIR, "read-exists.txt")
    await atomicWrite(path, "content here")
    const result = await readFileOrNull(path)
    expect(result).toBe("content here")
  })

  test("returns null for non-existent file", async () => {
    const result = await readFileOrNull(resolve(TEST_DIR, "does-not-exist.txt"))
    expect(result).toBeNull()
  })
})

describe("readJsonFile", () => {
  test("parses valid JSON", async () => {
    const path = resolve(TEST_DIR, "valid.json")
    await atomicWrite(path, JSON.stringify({ key: "value", num: 42 }))
    const result = await readJsonFile<{ key: string; num: number }>(path, { key: "", num: 0 })
    expect(result.key).toBe("value")
    expect(result.num).toBe(42)
  })

  test("returns fallback for non-existent file", async () => {
    const result = await readJsonFile(resolve(TEST_DIR, "nope.json"), { default: true })
    expect(result).toEqual({ default: true })
  })

  test("returns fallback for invalid JSON", async () => {
    const path = resolve(TEST_DIR, "invalid.json")
    await atomicWrite(path, "not json {{{")
    const result = await readJsonFile(path, { fallback: true })
    expect(result).toEqual({ fallback: true })
  })
})

describe("writeJsonFile", () => {
  test("writes pretty-printed JSON", async () => {
    const path = resolve(TEST_DIR, "pretty.json")
    await writeJsonFile(path, { a: 1, b: "hello" })
    const text = await Bun.file(path).text()
    expect(text).toContain("  ") // indented
    const parsed = JSON.parse(text)
    expect(parsed.a).toBe(1)
    expect(parsed.b).toBe("hello")
  })

  test("roundtrips with readJsonFile", async () => {
    const path = resolve(TEST_DIR, "roundtrip.json")
    const data = { items: [1, 2, 3], nested: { key: "val" } }
    await writeJsonFile(path, data)
    const result = await readJsonFile<typeof data | null>(path, null)
    expect(result).toEqual(data)
  })
})

describe("appendErrorLog / readErrorLog", () => {
  // Each test gets its own subdir so the .orchestrator-errors.jsonl files
  // don't collide and the rollover test starts from an empty log.
  function freshDir(label: string): string {
    const dir = resolve(TEST_DIR, `errlog-${label}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  test("readErrorLog returns [] when no log file exists", () => {
    const dir = freshDir("empty")
    expect(readErrorLog(dir)).toEqual([])
  })

  test("appendErrorLog creates the file and readErrorLog returns the entry", () => {
    const dir = freshDir("create")
    appendErrorLog(dir, { message: "first error", source: "test" })
    const entries = readErrorLog(dir)
    expect(entries.length).toBe(1)
    expect(entries[0]!.message).toBe("first error")
    expect(entries[0]!.source).toBe("test")
    expect(typeof entries[0]!.timestamp).toBe("number")
  })

  test("readErrorLog returns entries in chronological order", () => {
    const dir = freshDir("order")
    appendErrorLog(dir, { message: "one" })
    appendErrorLog(dir, { message: "two" })
    appendErrorLog(dir, { message: "three" })
    const entries = readErrorLog(dir)
    expect(entries.map(e => e.message)).toEqual(["one", "two", "three"])
  })

  test("readErrorLog skips malformed lines and returns the valid ones", () => {
    const dir = freshDir("malformed")
    const filePath = resolve(dir, ".orchestrator-errors.jsonl")
    const valid1: ErrorLogEntry = { timestamp: 1, message: "good-1" }
    const valid2: ErrorLogEntry = { timestamp: 2, message: "good-2" }
    writeFileSync(
      filePath,
      JSON.stringify(valid1) + "\n" + "{not json}\n" + JSON.stringify(valid2) + "\n",
    )
    const entries = readErrorLog(dir)
    expect(entries.map(e => e.message)).toEqual(["good-1", "good-2"])
  })

  test("rolls over at ERROR_LOG_MAX_ENTRIES (500)", () => {
    const dir = freshDir("rollover")
    // Write 502 entries — the oldest 2 should be trimmed.
    for (let i = 0; i < 502; i++) {
      appendErrorLog(dir, { message: `entry-${i}` })
    }
    const entries = readErrorLog(dir)
    expect(entries.length).toBe(500)
    // Oldest two trimmed → first surviving message is entry-2.
    expect(entries[0]!.message).toBe("entry-2")
    expect(entries[entries.length - 1]!.message).toBe("entry-501")
  })

  test("rollover does not leave a temp file behind", async () => {
    const dir = freshDir("rollover-clean")
    for (let i = 0; i < 501; i++) {
      appendErrorLog(dir, { message: `e-${i}` })
    }
    const tmpFiles = await Array.fromAsync(
      new Bun.Glob(".orchestrator-errors.jsonl.tmp.*").scan(dir),
    )
    expect(tmpFiles.length).toBe(0)
  })
})
