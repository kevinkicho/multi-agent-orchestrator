/**
 * Per-agent chat history persistence.
 *
 * Each agent has its own append-only JSONL file in `.orchestrator-chat-log/`.
 * Entries are one-per-line: `{"t": <epoch-ms>, "e": <DashboardEvent>}`.
 *
 * When a file exceeds `maxBytes` (default 25 MB), it is rotated: we keep the
 * newest ~80% and drop the oldest chunk at a line boundary. This keeps the
 * ledger bounded without unbounded growth.
 *
 * Only "chat-relevant" events are persisted — prompts, responses, status
 * transitions, cycle summaries, permission requests/resolutions, and lifecycle
 * events that have an `agent` field. Brain/supervisor internals are NOT stored
 * here; they live in the prompt-ledger and performance-log.
 */

import { resolve, join } from "path"
import { existsSync, mkdirSync, statSync } from "fs"
import type { DashboardEvent } from "./dashboard"

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024 // 25 MB per agent
const ROTATION_KEEP_FRACTION = 0.8         // keep newest 80% after rotation
const ROTATION_CHECK_EVERY = 64             // check size every N appends per agent

export type ChatLogRecord = {
  /** Epoch milliseconds when the event was persisted. */
  t: number
  /** The original DashboardEvent. */
  e: DashboardEvent
}

/** Events that carry a user-visible agent scope and belong in the chat log. */
const CHAT_EVENT_TYPES = new Set<DashboardEvent["type"]>([
  "agent-event",
  "agent-status",
  "agent-prompt",
  "agent-response",
  "cycle-summary",
  "permission-request",
  "permission-resolved",
])

function getDir(): string {
  return resolve(process.cwd(), ".orchestrator-chat-log")
}

function sanitizeAgent(agent: string): string {
  return agent.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 128) || "unknown"
}

function pathFor(agent: string): string {
  return join(getDir(), sanitizeAgent(agent) + ".jsonl")
}

function eventAgent(event: DashboardEvent): string | null {
  if (CHAT_EVENT_TYPES.has(event.type) && "agent" in event && typeof event.agent === "string") {
    return event.agent
  }
  return null
}

const appendCounts = new Map<string, number>()

// Per-agent write lock. appendChatEvent does a read-modify-write, so without
// serialization two back-to-back emits for the same agent can interleave and
// lose events. Locks are per-agent because writes to different agents target
// different files and never conflict. See review note in chat-log.ts.
const writeLocks = new Map<string, Promise<void>>()
function withAgentLock<T>(agent: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(agent) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  writeLocks.set(agent, next.then(() => {}, () => {}))
  return next
}

/** Append an event to the per-agent chat log. Returns true if persisted. */
export async function appendChatEvent(event: DashboardEvent, maxBytes = DEFAULT_MAX_BYTES): Promise<boolean> {
  const agent = eventAgent(event)
  if (!agent) return false

  const dir = getDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const file = pathFor(agent)
  const record: ChatLogRecord = { t: event.t ?? Date.now(), e: event }
  const line = JSON.stringify(record) + "\n"

  return withAgentLock(agent, async () => {
    try {
      const existing = await readFileOrEmpty(file)
      await Bun.write(file, existing + line)
    } catch (err) {
      console.error(`[chat-log] Failed to append event for ${agent}: ${err}`)
      return false
    }

    // Periodic size check to avoid stat'ing every write
    const n = (appendCounts.get(agent) ?? 0) + 1
    appendCounts.set(agent, n)
    if (n % ROTATION_CHECK_EVERY === 0) {
      try {
        if (statSync(file).size > maxBytes) await rotate(file, maxBytes)
      } catch { /* Intentionally silent: best-effort rotation */ }
    }
    return true
  })
}

async function readFileOrEmpty(file: string): Promise<string> {
  try {
    const f = Bun.file(file)
    if (await f.exists()) return await f.text()
  } catch { /* fallthrough */ }
  return ""
}

async function rotate(file: string, maxBytes: number): Promise<void> {
  const text = await readFileOrEmpty(file)
  if (text.length <= maxBytes) return
  // Drop the oldest (1 - ROTATION_KEEP_FRACTION) slice, aligned to a newline
  const targetStart = Math.floor(text.length * (1 - ROTATION_KEEP_FRACTION))
  const nextNewline = text.indexOf("\n", targetStart)
  if (nextNewline < 0) return // no newline found — pathological single-line file; leave it
  const kept = text.slice(nextNewline + 1)
  await Bun.write(file, kept)
}

/** Read chat events for an agent, oldest-first, up to `limit` entries strictly
 *  older than `beforeTs`. Pass beforeTs = Infinity (or omit) to get the most
 *  recent `limit` events. */
export async function readChatEvents(
  agent: string,
  beforeTs: number | undefined,
  limit: number,
): Promise<ChatLogRecord[]> {
  const file = pathFor(agent)
  const text = await readFileOrEmpty(file)
  if (!text) return []

  const out: ChatLogRecord[] = []
  const before = beforeTs ?? Number.POSITIVE_INFINITY
  // Parse all lines, filter, then take the last `limit`
  const lines = text.split("\n")
  for (const line of lines) {
    if (!line) continue
    try {
      const rec = JSON.parse(line) as ChatLogRecord
      if (typeof rec.t === "number" && rec.e && rec.t < before) out.push(rec)
    } catch { /* Intentionally silent: skip malformed lines (partial writes, corruption) */ }
  }
  if (out.length <= limit) return out
  return out.slice(out.length - limit)
}
