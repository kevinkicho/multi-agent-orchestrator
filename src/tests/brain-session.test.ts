/**
 * brain-session — the human's pick of brain model for this session. The
 * gate every cycle-driving path blocks on, so the invariants here decide
 * whether `bun run start` can silently commit to a bad model (it can't).
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import {
  loadBrainSession,
  getBrainSession,
  setBrainSession,
  clearBrainSession,
  awaitBrainSession,
  onBrainSessionChange,
  _resetBrainSessionForTests,
} from "../brain-session"

// The module writes to `<cwd>/.orchestrator-brain.json`. Redirect cwd into a
// tmp dir for each test so we don't clobber a real session file.
const BRAIN_FILE_NAME = ".orchestrator-brain.json"
let tmpCwd: string
const originalCwd = process.cwd()

beforeEach(() => {
  tmpCwd = mkdtempSync(resolve(tmpdir(), "brain-sess-"))
  process.chdir(tmpCwd)
  _resetBrainSessionForTests()
})

afterAll(() => {
  process.chdir(originalCwd)
  // Individual beforeEach dirs are orphaned once we chdir out — sweep the
  // tmp root of anything matching the prefix. Bun test runs one file at a
  // time so no cross-test leakage.
})

describe("brain-session persistence", () => {
  test("returns null when no file exists", () => {
    expect(loadBrainSession()).toBeNull()
    expect(getBrainSession()).toBeNull()
  })

  test("setBrainSession persists ref to .orchestrator-brain.json", () => {
    setBrainSession("opencode-go:glm-5.1")
    const path = resolve(tmpCwd, BRAIN_FILE_NAME)
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    expect(parsed.ref).toBe("opencode-go:glm-5.1")
    expect(typeof parsed.pickedAt).toBe("number")
  })

  test("loadBrainSession hydrates in-memory state from disk", () => {
    writeFileSync(
      resolve(tmpCwd, BRAIN_FILE_NAME),
      JSON.stringify({ ref: "ollama:llama3:8b", pickedAt: Date.now() }),
    )
    expect(loadBrainSession()).toBe("ollama:llama3:8b")
    expect(getBrainSession()).toBe("ollama:llama3:8b")
  })

  test("corrupt json file is treated as unset, not a crash", () => {
    writeFileSync(resolve(tmpCwd, BRAIN_FILE_NAME), "{not-json")
    expect(loadBrainSession()).toBeNull()
    expect(getBrainSession()).toBeNull()
  })

  test("empty-ref file is treated as unset (defensive — don't boot with empty ref)", () => {
    writeFileSync(resolve(tmpCwd, BRAIN_FILE_NAME), JSON.stringify({ ref: "", pickedAt: Date.now() }))
    expect(loadBrainSession()).toBeNull()
  })

  test("clearBrainSession removes the file and resets state", () => {
    setBrainSession("x:y")
    expect(existsSync(resolve(tmpCwd, BRAIN_FILE_NAME))).toBe(true)
    clearBrainSession()
    expect(existsSync(resolve(tmpCwd, BRAIN_FILE_NAME))).toBe(false)
    expect(getBrainSession()).toBeNull()
  })

  test("clearBrainSession when file doesn't exist is a no-op (not a crash)", () => {
    expect(() => clearBrainSession()).not.toThrow()
  })
})

describe("awaitBrainSession gate", () => {
  test("returns immediately when already set", async () => {
    setBrainSession("opencode-go:glm-5.1")
    // Race against a short timeout — awaitBrainSession() must resolve sync-ish.
    const ref = await Promise.race([
      awaitBrainSession(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timed out")), 50)),
    ])
    expect(ref).toBe("opencode-go:glm-5.1")
  })

  test("blocks when unset and resolves on setBrainSession — the core contract", async () => {
    let resolved = false
    const p = awaitBrainSession().then(ref => {
      resolved = true
      return ref
    })
    // Let the event loop turn so if it were going to resolve synchronously, it would.
    await new Promise(r => setImmediate(r))
    expect(resolved).toBe(false)
    // Now pick — the pending await should resolve.
    setBrainSession("anthropic:claude-sonnet-4-5-20250514")
    const ref = await p
    expect(ref).toBe("anthropic:claude-sonnet-4-5-20250514")
  })

  test("multiple concurrent waiters all resolve to the same ref", async () => {
    const p1 = awaitBrainSession()
    const p2 = awaitBrainSession()
    const p3 = awaitBrainSession()
    setBrainSession("opencode-go:glm-5.1")
    const results = await Promise.all([p1, p2, p3])
    expect(results).toEqual([
      "opencode-go:glm-5.1",
      "opencode-go:glm-5.1",
      "opencode-go:glm-5.1",
    ])
  })

  test("clear() doesn't wake waiters (gate should hold open until a real pick)", async () => {
    let resolved = false
    awaitBrainSession().then(() => { resolved = true })
    clearBrainSession()
    await new Promise(r => setImmediate(r))
    expect(resolved).toBe(false)
  })
})

describe("onBrainSessionChange subscriptions", () => {
  test("fires on set with the new ref", () => {
    const seen: Array<string | null> = []
    onBrainSessionChange(ref => seen.push(ref))
    setBrainSession("x:y")
    expect(seen).toEqual(["x:y"])
  })

  test("fires on clear with null", () => {
    setBrainSession("x:y")
    const seen: Array<string | null> = []
    onBrainSessionChange(ref => seen.push(ref))
    clearBrainSession()
    expect(seen).toEqual([null])
  })

  test("unsubscribe stops delivering events", () => {
    const seen: Array<string | null> = []
    const off = onBrainSessionChange(ref => seen.push(ref))
    off()
    setBrainSession("x:y")
    expect(seen).toEqual([])
  })
})

describe("setBrainSession input validation", () => {
  test("rejects empty string (defensive — would corrupt persisted state)", () => {
    expect(() => setBrainSession("")).toThrow(/non-empty string/)
  })

  test("rejects non-string input (runtime guard against accidental misuse)", () => {
    // @ts-expect-error — intentional bad input
    expect(() => setBrainSession(null)).toThrow(/non-empty string/)
    // @ts-expect-error — intentional bad input
    expect(() => setBrainSession(undefined)).toThrow(/non-empty string/)
  })
})
