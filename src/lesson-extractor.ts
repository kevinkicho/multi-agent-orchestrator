/**
 * Post-review lesson extraction.
 *
 * Inspired by the "autonomous skill creation" pattern from Hermes Agent
 * by Nous Research (https://github.com/nousresearch/hermes-agent). After each
 * @review cycle, a small LLM pass distills 0–2 durable lessons from the
 * review outcome. Returned lessons flow through addBehavioralNote, which
 * already dedups by topic and caps per-agent — so repeated observations
 * fold into a stable set of principles rather than ballooning indefinitely.
 *
 * Lessons surface on future cycles via buildSocraticPrompt's
 * "Lessons from Previous Cycles" section.
 */
import { chatCompletion } from "./brain"

export type LessonExtractionInput = {
  agentName: string
  directory: string
  /** Reviewer's full assessment of recent worker output */
  reviewText: string
  /** Optional: recent worker activity context (e.g., last few worker messages) */
  recentWorkerContext?: string
  /** LLM routing */
  model: string
  ollamaUrl: string
  timeoutMs?: number
}

const LESSON_EXTRACTOR_PROMPT = `You distill lessons from a completed code-review cycle.

You will receive:
- A code review (the reviewer's assessment of recent worker output)
- Optional context about what the worker did

Output zero, one, or two LESSONs in this exact format, one per line:

LESSON: WHEN <situation> DO <action> WHY <reason>

Rules:
- Each LESSON must be under 180 characters total.
- Only emit a LESSON if the review reflects a reusable pattern worth remembering — a specific technique that worked, or a specific pitfall hit/avoided.
- Do not emit generic platitudes ("write good code", "test thoroughly"). Skip rather than invent.
- If the review surfaced unresolved issues, you may still emit a "pitfall" lesson capturing what to avoid next time.
- If nothing durable stands out (task was trivial, review was generic, nothing specific to this codebase), output exactly:
  (none)
- Do not output any prose, commentary, or explanation — only LESSON: lines or (none).`

/**
 * Call the brain model with the review + context, parse back 0–2 lessons.
 * Returns [] on any failure — lesson extraction is best-effort and must not
 * block the supervisor loop.
 */
export async function extractLessonsFromReview(
  input: LessonExtractionInput,
): Promise<string[]> {
  const userContent = [
    `Agent: ${input.agentName}`,
    `Project: ${input.directory}`,
    "",
    "## Review",
    input.reviewText.slice(0, 4000),
    input.recentWorkerContext
      ? `\n## Recent worker context\n${input.recentWorkerContext.slice(0, 2000)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n")

  const raw = await chatCompletion(
    input.ollamaUrl,
    input.model,
    [
      { role: "system", content: LESSON_EXTRACTOR_PROMPT },
      { role: "user", content: userContent },
    ],
    { temperature: 0.2, maxTokens: 512, timeoutMs: input.timeoutMs ?? 60_000 },
  )

  return parseLessons(raw)
}

/**
 * Parse an extractor response into lesson strings. Exported for testability.
 * Drops anything over 200 chars (per-lesson hard cap) and trims to at most 2.
 */
export function parseLessons(text: string): string[] {
  if (!text) return []
  const trimmed = text.trim()
  if (/^\(none\)\.?$/i.test(trimmed)) return []
  const lessons: string[] = []
  for (const line of trimmed.split("\n")) {
    const m = line.trim().match(/^LESSON:\s*(.+)$/i)
    if (!m) continue
    const body = m[1]!.trim()
    if (body.length === 0 || body.length > 200) continue
    lessons.push(body)
  }
  return lessons.slice(0, 2)
}
