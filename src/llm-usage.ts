import { resolve } from "path"
import { readJsonFile, writeJsonFile } from "./file-utils"

// Lightweight per-call telemetry, separate from prompt-ledger. prompt-ledger
// stores content (bounded to ~2000 entries); this stores counts only and can
// retain much longer history for usage graphs.

export type LLMUsageRole =
  | "brain"          // runBrain commands to worker-agents
  | "supervisor"     // per-project supervisor loop
  | "observer"       // Phase 3 episodic observer
  | "manager"        // Phase 5 persistent overseer
  | "team-manager"   // team-mode manager
  | "other"

export type LLMUsageEntry = {
  ts: number
  provider: string
  model: string
  role: LLMUsageRole
  agentName?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  durationMs: number
  ok: boolean
  /** Only set when ok=false */
  errorKind?: string
}

export type LLMUsageStore = {
  entries: LLMUsageEntry[]
}

const MAX_ENTRIES = 20_000

function getUsagePath(): string {
  return resolve(process.cwd(), ".orchestrator-llm-usage.json")
}

let writeLock: Promise<void> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn)
  writeLock = next.then(() => {}, () => {})
  return next
}

export async function loadLLMUsage(): Promise<LLMUsageStore> {
  return readJsonFile<LLMUsageStore>(getUsagePath(), { entries: [] })
}

export async function recordLLMUsage(entry: LLMUsageEntry): Promise<void> {
  await withWriteLock(async () => {
    const store = await loadLLMUsage()
    store.entries.push(entry)
    if (store.entries.length > MAX_ENTRIES) {
      store.entries = store.entries.slice(store.entries.length - MAX_ENTRIES)
    }
    await writeJsonFile(getUsagePath(), store)
  })
}

export type UsageBucket = {
  /** ISO hour bucket, e.g. "2026-04-18T14" */
  hour: string
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  byRole: Record<string, number>
  byProvider: Record<string, number>
}

/** Bucket entries by hour, oldest → newest. */
export function bucketUsageByHour(store: LLMUsageStore, sinceMs?: number): UsageBucket[] {
  const cutoff = sinceMs ?? 0
  const byHour = new Map<string, UsageBucket>()
  for (const e of store.entries) {
    if (e.ts < cutoff) continue
    const hour = new Date(e.ts).toISOString().slice(0, 13)
    let bucket = byHour.get(hour)
    if (!bucket) {
      bucket = {
        hour,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        byRole: {},
        byProvider: {},
      }
      byHour.set(hour, bucket)
    }
    bucket.calls++
    bucket.promptTokens += e.promptTokens ?? 0
    bucket.completionTokens += e.completionTokens ?? 0
    bucket.totalTokens += e.totalTokens ?? 0
    bucket.byRole[e.role] = (bucket.byRole[e.role] ?? 0) + 1
    bucket.byProvider[e.provider] = (bucket.byProvider[e.provider] ?? 0) + 1
  }
  return Array.from(byHour.values()).sort((a, b) => a.hour.localeCompare(b.hour))
}

export type UsageSummary = {
  totalCalls: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  byRole: Record<string, { calls: number; totalTokens: number }>
  byProvider: Record<string, { calls: number; totalTokens: number }>
  byModel: Record<string, { calls: number; totalTokens: number }>
  failureRate: number
}

export function summarizeUsage(store: LLMUsageStore, sinceMs?: number): UsageSummary {
  const cutoff = sinceMs ?? 0
  const summary: UsageSummary = {
    totalCalls: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    byRole: {},
    byProvider: {},
    byModel: {},
    failureRate: 0,
  }
  let failures = 0
  for (const e of store.entries) {
    if (e.ts < cutoff) continue
    summary.totalCalls++
    summary.totalPromptTokens += e.promptTokens ?? 0
    summary.totalCompletionTokens += e.completionTokens ?? 0
    summary.totalTokens += e.totalTokens ?? 0
    if (!e.ok) failures++
    const roleRow = summary.byRole[e.role] ?? { calls: 0, totalTokens: 0 }
    roleRow.calls++; roleRow.totalTokens += e.totalTokens ?? 0
    summary.byRole[e.role] = roleRow
    const provRow = summary.byProvider[e.provider] ?? { calls: 0, totalTokens: 0 }
    provRow.calls++; provRow.totalTokens += e.totalTokens ?? 0
    summary.byProvider[e.provider] = provRow
    const modelRow = summary.byModel[e.model] ?? { calls: 0, totalTokens: 0 }
    modelRow.calls++; modelRow.totalTokens += e.totalTokens ?? 0
    summary.byModel[e.model] = modelRow
  }
  summary.failureRate = summary.totalCalls > 0 ? failures / summary.totalCalls : 0
  return summary
}
