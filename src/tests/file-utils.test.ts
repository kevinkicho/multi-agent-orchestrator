import { describe, test, expect, afterEach } from "bun:test"
import { resolve } from "path"
import { existsSync, mkdirSync, rmSync } from "fs"
import { atomicWrite, readFileOrNull, readJsonFile, writeJsonFile } from "../file-utils"

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
