import { describe, test, expect } from "bun:test"

// Test isSimilarNote — re-implemented here since it's not exported
function isSimilarNote(a: string, b: string, threshold = 0.6): boolean {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3))
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3))
  if (wordsA.size === 0 || wordsB.size === 0) return false
  let overlap = 0
  for (const w of wordsA) { if (wordsB.has(w)) overlap++ }
  const similarity = overlap / Math.min(wordsA.size, wordsB.size)
  return similarity >= threshold
}

describe("isSimilarNote", () => {
  test("detects duplicate notes", () => {
    expect(isSimilarNote(
      "Agent non-responsive with empty responses in cycle 3",
      "Agent non-responsive with empty responses in cycle 5",
    )).toBe(true)
  })

  test("does not flag unrelated notes", () => {
    expect(isSimilarNote(
      "Agent non-responsive with empty responses",
      "Fixed authentication bug in login page",
    )).toBe(false)
  })

  test("ignores short words (<=3 chars)", () => {
    // "the" and "a" are filtered out — only longer words count
    expect(isSimilarNote("the a is on", "the a is on")).toBe(false)
  })

  test("handles empty strings", () => {
    expect(isSimilarNote("", "something")).toBe(false)
    expect(isSimilarNote("something", "")).toBe(false)
  })

  test("is case-insensitive", () => {
    expect(isSimilarNote(
      "Agent keeps producing empty responses",
      "AGENT KEEPS PRODUCING EMPTY RESPONSES",
    )).toBe(true)
  })

  test("strips punctuation before comparing", () => {
    expect(isSimilarNote(
      "Agent's session crashed; needs restart!",
      "Agent session crashed, needs restart.",
    )).toBe(true)
  })
})
