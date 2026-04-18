import { describe, test, expect } from "bun:test"
import { parsePrinciples } from "../meta-reflection"

describe("parsePrinciples", () => {
  test("returns empty for '(none)'", () => {
    expect(parsePrinciples("(none)")).toEqual([])
    expect(parsePrinciples("  (none)  ")).toEqual([])
    expect(parsePrinciples("(None).")).toEqual([])
  })

  test("returns empty for empty / whitespace input", () => {
    expect(parsePrinciples("")).toEqual([])
    expect(parsePrinciples("   ")).toEqual([])
  })

  test("extracts a single PRINCIPLE line", () => {
    const out = parsePrinciples(
      "PRINCIPLE: WHEN a review surfaces the same test file 3+ cycles DO run typecheck before dispatch BECAUSE regressions keep landing in the same module",
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("WHEN a review surfaces")
  })

  test("extracts multiple PRINCIPLEs and caps at 3", () => {
    const out = parsePrinciples([
      "PRINCIPLE: WHEN X DO A BECAUSE P",
      "PRINCIPLE: WHEN Y DO B BECAUSE Q",
      "PRINCIPLE: WHEN Z DO C BECAUSE R",
      "PRINCIPLE: WHEN W DO D BECAUSE S",
    ].join("\n"))
    expect(out).toHaveLength(3)
    expect(out[0]).toContain("WHEN X")
    expect(out[2]).toContain("WHEN Z")
  })

  test("ignores prose lines around PRINCIPLE lines", () => {
    const out = parsePrinciples([
      "After reviewing:",
      "PRINCIPLE: WHEN auth migrations run DO checkpoint first BECAUSE rollbacks are expensive",
      "That's my analysis.",
    ].join("\n"))
    expect(out).toHaveLength(1)
    expect(out[0]).toBe("WHEN auth migrations run DO checkpoint first BECAUSE rollbacks are expensive")
  })

  test("drops principles over 200 chars", () => {
    const long = "x".repeat(250)
    const out = parsePrinciples(`PRINCIPLE: ${long}`)
    expect(out).toEqual([])
  })

  test("accepts mixed-case PRINCIPLE prefix", () => {
    const out = parsePrinciples("principle: WHEN a DO b BECAUSE c")
    expect(out).toHaveLength(1)
  })

  test("skips empty PRINCIPLE bodies", () => {
    const out = parsePrinciples("PRINCIPLE:   \nPRINCIPLE: WHEN a DO b BECAUSE c")
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("WHEN a")
  })
})
