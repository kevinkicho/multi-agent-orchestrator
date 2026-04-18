import { describe, test, expect } from "bun:test"
import { smartTrim } from "../message-utils"

describe("smartTrim", () => {
  test("returns empty string for empty input", () => {
    expect(smartTrim("", 100)).toBe("")
  })

  test("returns text unchanged when shorter than maxChars", () => {
    const text = "hello world"
    expect(smartTrim(text, 100)).toBe(text)
  })

  test("returns text unchanged when exactly maxChars", () => {
    const text = "x".repeat(50)
    expect(smartTrim(text, 50)).toBe(text)
  })

  test("trims and preserves head + tail when text exceeds maxChars", () => {
    const head = "HEAD_MARKER_AAA"
    const tail = "TAIL_MARKER_ZZZ"
    const middle = "x".repeat(10000)
    const text = head + middle + tail
    const result = smartTrim(text, 500)

    expect(result.length).toBeLessThanOrEqual(500)
    expect(result.startsWith(head)).toBe(true)
    expect(result.endsWith(tail)).toBe(true)
    expect(result).toContain("chars trimmed")
  })

  test("falls back to tail-slice when maxChars is too small for marker", () => {
    const text = "a".repeat(1000)
    const result = smartTrim(text, 20)
    expect(result.length).toBe(20)
  })

  test("includes dropped-char count in elision marker", () => {
    const text = "a".repeat(2000)
    const result = smartTrim(text, 500)
    expect(result).toMatch(/\[\.\.\. \d+ chars trimmed/)
  })
})
