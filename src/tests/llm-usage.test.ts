/**
 * Tests for the LLM usage telemetry ledger (separate from prompt-ledger).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync } from "fs"
import { resolve } from "path"
import {
  recordLLMUsage,
  loadLLMUsage,
  bucketUsageByHour,
  summarizeUsage,
  type LLMUsageEntry,
} from "../llm-usage"

let originalCwd: string
let tmpDir: string

beforeEach(() => {
  originalCwd = process.cwd()
  tmpDir = resolve(originalCwd, `.test-tmp-usage-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

function mkEntry(overrides: Partial<LLMUsageEntry> = {}): LLMUsageEntry {
  return {
    ts: Date.now(),
    provider: "ollama",
    model: "qwen2.5",
    role: "supervisor",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    durationMs: 2000,
    ok: true,
    ...overrides,
  }
}

describe("recordLLMUsage", () => {
  test("persists entries atomically and preserves insert order", async () => {
    await recordLLMUsage(mkEntry({ ts: 1000, role: "brain" }))
    await recordLLMUsage(mkEntry({ ts: 2000, role: "supervisor" }))
    await recordLLMUsage(mkEntry({ ts: 3000, role: "observer" }))
    const store = await loadLLMUsage()
    expect(store.entries).toHaveLength(3)
    expect(store.entries.map(e => e.role)).toEqual(["brain", "supervisor", "observer"])
  })

  test("serial recordLLMUsage calls do not interleave via the write-lock", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => recordLLMUsage(mkEntry({ ts: 1000 + i }))),
    )
    const store = await loadLLMUsage()
    expect(store.entries).toHaveLength(20)
    // Every ts is preserved despite concurrent callers.
    const seen = new Set(store.entries.map(e => e.ts))
    expect(seen.size).toBe(20)
  })
})

describe("bucketUsageByHour", () => {
  test("groups entries by ISO hour", async () => {
    const h1 = new Date("2026-04-18T10:12:00Z").getTime()
    const h1b = new Date("2026-04-18T10:48:00Z").getTime()
    const h2 = new Date("2026-04-18T11:05:00Z").getTime()
    await recordLLMUsage(mkEntry({ ts: h1, role: "brain", totalTokens: 100 }))
    await recordLLMUsage(mkEntry({ ts: h1b, role: "supervisor", totalTokens: 200 }))
    await recordLLMUsage(mkEntry({ ts: h2, role: "brain", totalTokens: 300 }))

    const buckets = bucketUsageByHour(await loadLLMUsage())
    expect(buckets).toHaveLength(2)
    expect(buckets[0]!.hour).toBe("2026-04-18T10")
    expect(buckets[0]!.calls).toBe(2)
    expect(buckets[0]!.totalTokens).toBe(300)
    expect(buckets[0]!.byRole.brain).toBe(1)
    expect(buckets[0]!.byRole.supervisor).toBe(1)
    expect(buckets[1]!.hour).toBe("2026-04-18T11")
    expect(buckets[1]!.calls).toBe(1)
  })

  test("since filter excludes older entries", async () => {
    const old = new Date("2026-04-17T10:00:00Z").getTime()
    const recent = new Date("2026-04-18T10:00:00Z").getTime()
    await recordLLMUsage(mkEntry({ ts: old }))
    await recordLLMUsage(mkEntry({ ts: recent }))

    const cutoff = new Date("2026-04-18T00:00:00Z").getTime()
    const buckets = bucketUsageByHour(await loadLLMUsage(), cutoff)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.hour).toBe("2026-04-18T10")
  })
})

describe("summarizeUsage", () => {
  test("aggregates by role/provider/model and counts failure rate", async () => {
    await recordLLMUsage(mkEntry({ role: "brain", provider: "ollama", model: "a", totalTokens: 100 }))
    await recordLLMUsage(mkEntry({ role: "brain", provider: "ollama", model: "a", totalTokens: 200 }))
    await recordLLMUsage(mkEntry({ role: "supervisor", provider: "openai", model: "b", totalTokens: 300 }))
    await recordLLMUsage(mkEntry({ role: "supervisor", provider: "openai", model: "b", totalTokens: 0, ok: false, errorKind: "TimeoutError" }))

    const s = summarizeUsage(await loadLLMUsage())
    expect(s.totalCalls).toBe(4)
    expect(s.totalTokens).toBe(600)
    expect(s.byRole.brain!.calls).toBe(2)
    expect(s.byRole.brain!.totalTokens).toBe(300)
    expect(s.byRole.supervisor!.calls).toBe(2)
    expect(s.byProvider.ollama!.calls).toBe(2)
    expect(s.byProvider.openai!.calls).toBe(2)
    expect(s.byModel.a!.totalTokens).toBe(300)
    expect(s.byModel.b!.totalTokens).toBe(300)
    expect(s.failureRate).toBeCloseTo(0.25, 5)
  })

  test("empty store yields zero summary", async () => {
    const s = summarizeUsage(await loadLLMUsage())
    expect(s.totalCalls).toBe(0)
    expect(s.totalTokens).toBe(0)
    expect(s.failureRate).toBe(0)
  })
})
