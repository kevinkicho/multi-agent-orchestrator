import { describe, test, expect } from "bun:test"
import { parseSessionSummary } from "../brain-memory"

describe("parseSessionSummary", () => {
  test("returns raw-only for empty input", () => {
    const parsed = parseSessionSummary("")
    expect(parsed.raw).toBe("")
    expect(parsed.sections).toBeUndefined()
  })

  test("returns raw-only for plain prose", () => {
    const prose = "Fixed auth bypass in /api/login. Worker implementing rate limiting. 12/15 tests passing."
    const parsed = parseSessionSummary(prose)
    expect(parsed.raw).toBe(prose)
    expect(parsed.sections).toBeUndefined()
  })

  test("detects structured summary with all seven sections", () => {
    const structured = [
      "## Active Task",
      "Migrating auth middleware",
      "## Goal",
      "Meet legal session-token requirements",
      "## Completed Actions",
      "- Updated src/auth.ts",
      "## Active State",
      "Branch auth-migration, tests passing",
      "## Resolved Questions",
      "- Q: persist tokens? A: session-only",
      "## Pending Asks",
      "(none)",
      "## Remaining Work",
      "- Remove legacy storage",
    ].join("\n")
    const parsed = parseSessionSummary(structured)
    expect(parsed.sections).toBeDefined()
    expect(parsed.sections!["Active Task"]).toContain("Migrating auth")
    expect(parsed.sections!["Remaining Work"]).toContain("legacy storage")
    expect(parsed.sections!["Pending Asks"]).toBe("(none)")
  })

  test("accepts partial structured summary (>=2 sections)", () => {
    const partial = [
      "## Active Task",
      "A",
      "## Completed Actions",
      "- x",
    ].join("\n")
    const parsed = parseSessionSummary(partial)
    expect(parsed.sections).toBeDefined()
    expect(Object.keys(parsed.sections!)).toHaveLength(2)
  })

  test("falls back to raw when only one section is present", () => {
    const oneSection = "## Active Task\nOnly this section"
    const parsed = parseSessionSummary(oneSection)
    expect(parsed.sections).toBeUndefined()
    expect(parsed.raw).toBe(oneSection)
  })
})
