import { describe, test, expect } from "bun:test"
import { parseLessons } from "../lesson-extractor"

describe("parseLessons", () => {
  test("returns empty for '(none)'", () => {
    expect(parseLessons("(none)")).toEqual([])
    expect(parseLessons("  (none)  ")).toEqual([])
    expect(parseLessons("(None).")).toEqual([])
  })

  test("returns empty for empty / whitespace input", () => {
    expect(parseLessons("")).toEqual([])
    expect(parseLessons("   ")).toEqual([])
  })

  test("extracts a single LESSON line", () => {
    const out = parseLessons("LESSON: WHEN refactoring auth DO run the full test suite WHY token flow is fragile")
    expect(out).toHaveLength(1)
    expect(out[0]).toBe("WHEN refactoring auth DO run the full test suite WHY token flow is fragile")
  })

  test("extracts multiple LESSON lines and caps at 2", () => {
    const out = parseLessons([
      "LESSON: WHEN X DO A WHY P",
      "LESSON: WHEN Y DO B WHY Q",
      "LESSON: WHEN Z DO C WHY R",
    ].join("\n"))
    expect(out).toHaveLength(2)
    expect(out[0]).toContain("WHEN X")
    expect(out[1]).toContain("WHEN Y")
  })

  test("ignores prose lines around LESSON lines", () => {
    const out = parseLessons([
      "Here is my analysis:",
      "LESSON: WHEN editing providers.ts DO typecheck WHY hyphenated IDs break parseModelRef",
      "That is all.",
    ].join("\n"))
    expect(out).toHaveLength(1)
    expect(out[0]).toBe("WHEN editing providers.ts DO typecheck WHY hyphenated IDs break parseModelRef")
  })

  test("drops lessons over 200 chars", () => {
    const long = "x".repeat(250)
    const out = parseLessons(`LESSON: ${long}`)
    expect(out).toEqual([])
  })

  test("accepts mixed-case LESSON prefix", () => {
    const out = parseLessons("lesson: WHEN a DO b WHY c")
    expect(out).toHaveLength(1)
  })

  test("skips empty LESSON bodies", () => {
    const out = parseLessons("LESSON:   \nLESSON: WHEN a DO b WHY c")
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("WHEN a")
  })
})
