/**
 * Periodic meta-reflection.
 *
 * Inspired by the memory consolidation pattern in Hermes Agent by Nous Research
 * (https://github.com/nousresearch/hermes-agent). The supervisor runs this
 * every N successful cycles: it looks at the agent's recent session summaries,
 * existing behavioral notes, and project notes, then distills 0-3 higher-level
 * PRINCIPLEs — patterns that span multiple cycles rather than single events.
 *
 * Output flows back through addBehavioralNote, which dedups by topic, so the
 * "Lessons from Previous Cycles" block in the supervisor prompt evolves into
 * a compact, stable set of operating principles instead of a growing log.
 *
 * Failure is non-fatal: the supervisor loop continues on any error.
 */
import { chatCompletion } from "./brain"
import type { BrainMemoryEntry } from "./brain-memory"
import { parseSessionSummary } from "./brain-memory"

export type MetaReflectionInput = {
  agentName: string
  directory: string
  /** Recent session summaries (BrainMemoryEntry[]); oldest first. */
  recentSummaries: BrainMemoryEntry[]
  /** Existing behavioral notes (lessons) the supervisor already has. */
  behavioralNotes: string[]
  /** Project notes accumulated by the brain for this agent. */
  projectNotes: string[]
  /** LLM routing */
  model: string
  ollamaUrl: string
  timeoutMs?: number
}

const META_REFLECTION_PROMPT = `You consolidate observations from multiple completed cycles of an AI coding agent into durable operating PRINCIPLEs.

You will receive:
- A chronological list of recent session summaries (each with Active Task / Completed Actions / Remaining Work and similar fields, or prose).
- The agent's current behavioral notes (lessons already captured from single cycles).
- Project notes (facts about this codebase).

Your job is to find HIGHER-ORDER patterns that span multiple cycles, NOT to restate any single cycle. Look for:
- Recurring failure modes (same class of problem appears across cycles).
- Techniques that consistently work (an approach used in 2+ cycles with good outcomes).
- Drift between stated goals and actual actions (Remaining Work keeps growing in one area).
- Blind spots (something worth checking that isn't being checked).

Output zero, one, two, or three PRINCIPLEs in this exact format, one per line:

PRINCIPLE: WHEN <situation across cycles> DO <action> BECAUSE <pattern observed>

Rules:
- Each PRINCIPLE must be under 200 characters total.
- PRINCIPLEs must reflect a CROSS-CYCLE pattern — if you can only justify it from one cycle, skip it (that's a LESSON, not a PRINCIPLE).
- Do NOT restate existing behavioral notes verbatim. If an existing note already covers the pattern, skip it unless you can sharpen the situation or reason meaningfully.
- No generic platitudes ("write good code", "test thoroughly"). Skip rather than invent.
- If no durable cross-cycle pattern stands out, output exactly:
  (none)
- Do not output any prose, commentary, or explanation — only PRINCIPLE: lines or (none).`

/**
 * Run meta-reflection. Returns 0-3 principle strings. Returns [] on any
 * failure or when there's insufficient history to reflect on.
 */
export async function reflectOnAgentHistory(
  input: MetaReflectionInput,
): Promise<string[]> {
  // Need at least 2 summaries for cross-cycle patterns to be meaningful.
  if (input.recentSummaries.length < 2) return []

  const summariesBlock = input.recentSummaries
    .map((entry, idx) => {
      const date = new Date(entry.timestamp).toISOString()
      const parsed = parseSessionSummary(entry.summary)
      if (parsed.sections) {
        const compact: string[] = []
        for (const [section, body] of Object.entries(parsed.sections)) {
          const trimmed = body.trim()
          if (!trimmed || trimmed.toLowerCase() === "(none)") continue
          compact.push(`  ${section}: ${trimmed.replace(/\n+/g, " ")}`)
        }
        return `### Cycle ${idx + 1} (${date}) — ${entry.objective}\n${compact.join("\n")}`
      }
      return `### Cycle ${idx + 1} (${date}) — ${entry.objective}\n  ${entry.summary.replace(/\n+/g, " ")}`
    })
    .join("\n\n")
    .slice(0, 6000)

  const behavioralBlock = input.behavioralNotes.length
    ? input.behavioralNotes.map(n => `- ${n}`).join("\n").slice(0, 2000)
    : "(none)"

  const projectBlock = input.projectNotes.length
    ? input.projectNotes.map(n => `- ${n}`).join("\n").slice(0, 2000)
    : "(none)"

  const userContent = [
    `Agent: ${input.agentName}`,
    `Project: ${input.directory}`,
    "",
    "## Recent Session Summaries (oldest first)",
    summariesBlock,
    "",
    "## Existing Behavioral Notes",
    behavioralBlock,
    "",
    "## Project Notes",
    projectBlock,
  ].join("\n")

  let raw: string
  try {
    raw = await chatCompletion(
      input.ollamaUrl,
      input.model,
      [
        { role: "system", content: META_REFLECTION_PROMPT },
        { role: "user", content: userContent },
      ],
      { temperature: 0.2, maxTokens: 512, timeoutMs: input.timeoutMs ?? 90_000 },
    )
  } catch {
    return []
  }

  return parsePrinciples(raw)
}

// ---------------------------------------------------------------------------
// Evidence-driven principle clarification
//
// Phase 2 rewires meta-reflection so promotion is driven by fire evidence
// (counted by fire-tracker and gated by brain-memory.shouldPromote). The LLM
// pass below is scoped: it does not INVENT principles, it only rewrites one
// already-earned note at a time for concision and clarity. Failures return
// null so the caller keeps the original wording.
// ---------------------------------------------------------------------------

export type ClarifyInput = {
  noteText: string
  agentName: string
  directory: string
  model: string
  ollamaUrl: string
  timeoutMs?: number
}

const CLARIFY_PROMPT = `You rewrite a single behavioral note as a concise operating PRINCIPLE.

Rules:
- Preserve the meaning exactly — do not add caveats, generalize beyond the note, or invent new rules.
- Prefer the form: WHEN <situation> DO <action> BECAUSE <reason>. Short variations are fine if the original doesn't have all three.
- Under 180 characters. No list prefixes, no quotes, no commentary.
- Output the rewritten principle only, one line. If you cannot compress without losing meaning, output the original text verbatim.`

/**
 * Rewrite a single promoted note for clarity. Returns the rewrite (may equal
 * the input) or null on any LLM failure. Callers should substitute only when
 * the result is non-null and materially different from the input.
 */
export async function clarifyPromotedPrinciple(input: ClarifyInput): Promise<string | null> {
  if (!input.noteText.trim()) return null
  try {
    const raw = await chatCompletion(
      input.ollamaUrl,
      input.model,
      [
        { role: "system", content: CLARIFY_PROMPT },
        { role: "user", content: `Agent: ${input.agentName}\nProject: ${input.directory}\n\nNote:\n${input.noteText.trim()}` },
      ],
      { temperature: 0.1, maxTokens: 200, timeoutMs: input.timeoutMs ?? 45_000 },
    )
    const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, "").split("\n")[0]?.trim()
    if (!trimmed) return null
    if (trimmed.length > 220) return null
    return trimmed
  } catch {
    return null
  }
}

/**
 * Parse a meta-reflection response into principle strings. Exported for
 * testability. Drops >200 chars, trims to at most 3.
 */
export function parsePrinciples(text: string): string[] {
  if (!text) return []
  const trimmed = text.trim()
  if (/^\(none\)\.?$/i.test(trimmed)) return []
  const principles: string[] = []
  for (const line of trimmed.split("\n")) {
    const m = line.trim().match(/^PRINCIPLE:\s*(.+)$/i)
    if (!m) continue
    const body = m[1]!.trim()
    if (body.length === 0 || body.length > 200) continue
    principles.push(body)
  }
  return principles.slice(0, 3)
}
