/**
 * Behavioral-note fire tracker — heuristic-only.
 *
 * "Firing" means: during a specific cycle, a piece of text (e.g., a @review
 * reply, or a worker response) is judged related enough to a behavioral note
 * that the note would have been useful context for it. This records a signal
 * of which lessons are actually being exercised vs. sitting unused.
 *
 * No LLM call — per directive, matching is purely heuristic:
 *   1. Strong signal: a meaningful keyword from the note appears verbatim in
 *      the text (substring match, case-insensitive, min length 5).
 *   2. Weak signal: the note shares enough keywords with the text to exceed
 *      a similarity threshold (default 0.25).
 *
 * Limitations are intentional — see KNOWN_LIMITATIONS.md ("Behavioral-note
 * fire matching is heuristic").
 */

import type { BehavioralNote } from "./brain-memory"
import { extractKeywords, keywordSimilarity } from "./brain-memory"

/** Minimum keyword-overlap similarity for a weak match. 0..1. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.25

/** Minimum length for a single keyword to count as a substring-match signal. */
const MIN_KEYWORD_LEN = 5

/** Return the IDs of notes whose topic fires against the given text. */
export function matchFiresInText(
  notes: BehavioralNote[],
  text: string,
  similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): string[] {
  if (!notes.length || !text) return []
  const lowered = text.toLowerCase()
  const textKeywords = extractKeywords(text)
  if (textKeywords.size === 0) return []

  const hits: string[] = []
  for (const note of notes) {
    const noteKeywords = extractKeywords(note.text)
    if (noteKeywords.size === 0) continue

    // Strong signal: any long-enough keyword from the note appears in the text.
    let strongHit = false
    for (const kw of noteKeywords) {
      if (kw.length >= MIN_KEYWORD_LEN && lowered.includes(kw)) {
        strongHit = true
        break
      }
    }
    if (strongHit) {
      hits.push(note.id)
      continue
    }

    // Weak signal: overall keyword-overlap similarity exceeds threshold.
    if (keywordSimilarity(note.text, text) >= similarityThreshold) {
      hits.push(note.id)
    }
  }
  return hits
}
