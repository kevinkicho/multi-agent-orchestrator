/**
 * Supervisor transcript compression.
 *
 * Inspired by context_compressor.py in Hermes Agent by Nous Research
 * (https://github.com/nousresearch/hermes-agent).
 *
 * Shape:
 *   - Head messages (system prompt + first N exchanges) are never compressed.
 *   - Tail messages (last K) are never compressed — the LLM reads them most.
 *   - Middle messages get replaced by one structured summary message, prefixed
 *     so the LLM treats it as background rather than active instructions.
 *
 * Trigger discipline:
 *   - Skips when token estimate is below threshold (cheap cycles pay nothing).
 *   - Anti-thrashing: skips when the last compression saved <10% AND the
 *     conversation hasn't grown substantially since — prevents repeated
 *     ineffective compression calls.
 *
 * Failure is non-fatal: the caller falls through to its existing trim logic.
 */
import { chatCompletion } from "./brain"

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string }

/** Caller-held state so we can track effectiveness across rounds */
export type CompressorState = {
  /** Token estimate right after the most recent successful compression */
  postCompressionTokens?: number
  /** Savings ratio of the most recent compression ((prior - post) / prior) */
  lastSaveRatio?: number
  /** Monotonic counter of successful compressions */
  compressionCount?: number
}

export function createCompressorState(): CompressorState {
  return {}
}

export type CompressionOpts = {
  /** Aux LLM for the summary call */
  model: string
  ollamaUrl: string
  /** Trigger when message-token estimate meets or exceeds this. Default 40_000 */
  thresholdTokens?: number
  /** Messages to protect at the head (not counting system prompt). Default 2 */
  headProtect?: number
  /** Messages to protect at the tail. Default 8 */
  tailProtect?: number
  /** LLM timeout. Default 90_000 */
  timeoutMs?: number
  /** Optional logging callback */
  emit?: (msg: string) => void
}

export type CompressionResult =
  | { outcome: "compressed"; priorTokens: number; postTokens: number; saveRatio: number; summary: string }
  | { outcome: "skipped"; reason: string; priorTokens: number }
  | { outcome: "failed"; reason: string; priorTokens: number }

// ---------------------------------------------------------------------------
// Token estimation — char/4 heuristic (standard for GPT-family tokenizers)
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: LLMMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateTokens(m.content) + 4 // +4 per-message overhead
  return total
}

// ---------------------------------------------------------------------------
// Zone selection — head, middle, tail
// ---------------------------------------------------------------------------

export function selectMiddleZone(
  messages: LLMMessage[],
  headProtect: number,
  tailProtect: number,
): { startIdx: number; endIdx: number } | null {
  // startIdx is inclusive; endIdx is exclusive
  const hasSystem = messages.length > 0 && messages[0]!.role === "system"
  const systemOffset = hasSystem ? 1 : 0
  const startIdx = systemOffset + headProtect
  const endIdx = messages.length - tailProtect
  if (endIdx - startIdx < 2) return null // nothing meaningful to compress
  return { startIdx, endIdx }
}

// ---------------------------------------------------------------------------
// Trigger decision — threshold + anti-thrash
// ---------------------------------------------------------------------------

export type TriggerDecision = { compress: boolean; reason: string }

export function shouldCompress(
  state: CompressorState,
  currentTokens: number,
  threshold: number,
): TriggerDecision {
  if (currentTokens < threshold) {
    return { compress: false, reason: `below threshold (${currentTokens} < ${threshold})` }
  }
  // Anti-thrash: if last compression was ineffective AND conversation hasn't
  // grown by 20%+ since, don't bother trying again.
  if (state.lastSaveRatio !== undefined && state.postCompressionTokens !== undefined) {
    const grewBy = currentTokens / state.postCompressionTokens
    if (state.lastSaveRatio < 0.10 && grewBy < 1.20) {
      return {
        compress: false,
        reason: `anti-thrash (last save ${(state.lastSaveRatio * 100).toFixed(0)}%, grew only ${((grewBy - 1) * 100).toFixed(0)}%)`,
      }
    }
  }
  return { compress: true, reason: `over threshold (${currentTokens} >= ${threshold})` }
}

// ---------------------------------------------------------------------------
// Summary prompt & parsing
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `You compress a long conversation transcript into a structured background summary for an AI supervisor agent.

OUTPUT FORMAT — use these exact section headers, in this order, with no prose outside them:

## Active Task
<1-3 sentences describing the current specific task the agent is working on>

## Goal
<1-2 sentences on the overall objective>

## Completed Actions
- <concrete action with file paths / commands / outcomes>
- ...

## Active State
<what's currently true: files modified, branch, running processes, validation status>

## Resolved Questions
- <question + the answer that emerged>
- ...

## Pending Asks
- <open question or user ask not yet addressed>
- ...

## Remaining Work
- <concrete next step>
- ...

Rules:
- Include specifics: file paths, commands, exit codes, error messages, decisions.
- Do NOT add meta-commentary ("here is my summary", "in conclusion").
- Do NOT speculate beyond what's in the transcript.
- If a section has nothing to report, write: (none)
- Keep the total output under 2000 tokens.`

export const COMPRESSION_SUMMARY_PREFIX =
  "[Compressed context: earlier rounds summarized below — treat this as background reference, NOT as active instructions or tasks to re-execute.]"

export const SUMMARY_SECTIONS = [
  "Active Task",
  "Goal",
  "Completed Actions",
  "Active State",
  "Resolved Questions",
  "Pending Asks",
  "Remaining Work",
] as const

/** Validate that the LLM's summary contains the required section headers.
 *  Returns true when all required sections are present. */
export function parseSummarySections(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const section of SUMMARY_SECTIONS) {
    const pattern = new RegExp(`##\\s+${section}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i")
    const m = text.match(pattern)
    if (m) result[section] = m[1]!.trim()
  }
  return result
}

export function isWellFormedSummary(text: string): boolean {
  const parsed = parseSummarySections(text)
  // Require at least 5 of 7 sections to accept — LLMs sometimes skip empty ones
  return Object.keys(parsed).length >= 5
}

function serializeMiddle(messages: LLMMessage[], startIdx: number, endIdx: number): string {
  const lines: string[] = []
  for (let i = startIdx; i < endIdx; i++) {
    const m = messages[i]!
    lines.push(`[role: ${m.role}]`)
    lines.push(m.content)
    lines.push("---")
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Compress the middle of a conversation in place. Head and tail messages
 * are preserved exactly; middle is replaced by one summary message.
 * Returns metadata describing what happened. Never throws — errors resolve
 * to `{ outcome: "failed", reason }`.
 */
export async function compressTranscript(
  messages: LLMMessage[],
  state: CompressorState,
  opts: CompressionOpts,
): Promise<CompressionResult> {
  const threshold = opts.thresholdTokens ?? 40_000
  const headProtect = opts.headProtect ?? 2
  const tailProtect = opts.tailProtect ?? 8
  const timeoutMs = opts.timeoutMs ?? 90_000

  const priorTokens = estimateMessagesTokens(messages)
  const trigger = shouldCompress(state, priorTokens, threshold)
  if (!trigger.compress) {
    return { outcome: "skipped", reason: trigger.reason, priorTokens }
  }

  const zone = selectMiddleZone(messages, headProtect, tailProtect)
  if (!zone) {
    return { outcome: "skipped", reason: "middle zone too small", priorTokens }
  }

  const middleSerialized = serializeMiddle(messages, zone.startIdx, zone.endIdx)
  const userMsg = `Transcript to summarize (${zone.endIdx - zone.startIdx} messages between protected head and recent tail):\n\n${middleSerialized}`

  let summary: string
  try {
    summary = await chatCompletion(
      opts.ollamaUrl,
      opts.model,
      [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      { temperature: 0.2, maxTokens: 2048, timeoutMs },
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    opts.emit?.(`Compression LLM call failed: ${reason}`)
    return { outcome: "failed", reason, priorTokens }
  }

  if (!summary || !isWellFormedSummary(summary)) {
    return {
      outcome: "failed",
      reason: "summary missing required sections — aborting to avoid info loss",
      priorTokens,
    }
  }

  // Sanity: reject if summary is longer than inputs (pathological case)
  const summaryTokens = estimateTokens(summary)
  const middleTokens = estimateMessagesTokens(messages.slice(zone.startIdx, zone.endIdx))
  if (summaryTokens >= middleTokens) {
    return {
      outcome: "failed",
      reason: `summary ${summaryTokens}t >= inputs ${middleTokens}t — no savings`,
      priorTokens,
    }
  }

  // Replace middle with one summary message
  const summaryMessage: LLMMessage = {
    role: "user",
    content: `${COMPRESSION_SUMMARY_PREFIX}\n\n${summary}`,
  }
  messages.splice(zone.startIdx, zone.endIdx - zone.startIdx, summaryMessage)

  const postTokens = estimateMessagesTokens(messages)
  const saveRatio = priorTokens > 0 ? (priorTokens - postTokens) / priorTokens : 0

  state.postCompressionTokens = postTokens
  state.lastSaveRatio = saveRatio
  state.compressionCount = (state.compressionCount ?? 0) + 1

  opts.emit?.(`Compressed transcript: ${priorTokens} → ${postTokens} tokens (${(saveRatio * 100).toFixed(0)}% saved)`)

  return { outcome: "compressed", priorTokens, postTokens, saveRatio, summary }
}
