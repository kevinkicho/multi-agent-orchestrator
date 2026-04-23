/**
 * Smoke tests for the extracted supervisor-parser module. The canonical parser
 * behavior is already covered by brain-commands.test.ts, integration-supervisor.test.ts,
 * and supervisor-commands.test.ts — those tests still pass against the
 * re-implementations living inside each test file. This suite asserts that the
 * *real* extracted module exports the same surface and produces the same
 * commands for a handful of representative inputs, so a future rename or
 * export removal fails a test loudly instead of silently.
 */
import { describe, test, expect } from "bun:test"
import {
  parseSupervisorCommands,
  parseJsonCommands,
  parseSocraticResponse,
  parseLegacyCommands,
  matchMarker,
  SOCRATIC_MARKERS,
  LEGACY_COMMAND_PREFIXES,
  JSON_MODE_INSTRUCTION,
  isCommandLine,
  type SupervisorCommand,
} from "../supervisor-parser"

describe("supervisor-parser exports", () => {
  test("SOCRATIC_MARKERS and LEGACY_COMMAND_PREFIXES are non-empty", () => {
    expect(SOCRATIC_MARKERS.length).toBeGreaterThan(0)
    expect(LEGACY_COMMAND_PREFIXES.length).toBeGreaterThan(0)
  })

  test("JSON_MODE_INSTRUCTION is a non-empty string", () => {
    expect(typeof JSON_MODE_INSTRUCTION).toBe("string")
    expect(JSON_MODE_INSTRUCTION.length).toBeGreaterThan(0)
  })
})

describe("parseSocraticResponse", () => {
  test("Socratic @worker + @check + @done", () => {
    const res = parseSocraticResponse([
      "Let me think about this.",
      "@check",
      "@worker: please look at src/auth.ts",
      "@done: summary of work",
    ].join("\n"))
    const types = res.commands.map(c => c.type)
    expect(types).toContain("messages")
    expect(types).toContain("prompt")
    expect(types).toContain("wait") // implicit after every @worker
    expect(types).toContain("cycle_done")
    expect(res.thinking).toContain("Let me think about this.")
  })

  test("@share with LESSON: prefix is classified as lesson", () => {
    const res = parseSocraticResponse("@share: LESSON: always rate-limit [files: src/api.ts]")
    const share = res.commands.find(c => c.type === "share") as Extract<SupervisorCommand, { type: "share" }> | undefined
    expect(share).toBeTruthy()
    expect(share?.kind).toBe("lesson")
    expect(share?.files).toEqual(["src/api.ts"])
  })

  test("@broadcast maps to notify command", () => {
    const res = parseSocraticResponse("@broadcast: starting auth refactor")
    const cmd = res.commands[0] as Extract<SupervisorCommand, { type: "notify" }>
    expect(cmd.type).toBe("notify")
    expect(cmd.message).toBe("starting auth refactor")
  })
})

describe("parseLegacyCommands", () => {
  test("legacy UPPERCASE commands still parse", () => {
    const cmds = parseLegacyCommands([
      "PROMPT fix the bug",
      "WAIT",
      "CYCLE_DONE wrapped up",
    ].join("\n"))
    expect(cmds.map(c => c.type)).toEqual(["prompt", "wait", "cycle_done"])
  })

  test("legacy multi-line PROMPT accumulates continuation lines", () => {
    const cmds = parseLegacyCommands("PROMPT line one\ncontinuation line")
    const prompt = cmds[0] as Extract<SupervisorCommand, { type: "prompt" }>
    expect(prompt.message).toBe("line one\ncontinuation line")
  })
})

describe("parseSupervisorCommands", () => {
  test("prefers Socratic when @ markers present", () => {
    const cmds = parseSupervisorCommands("@check\n@done: ok")
    expect(cmds.map(c => c.type)).toContain("messages")
    expect(cmds.map(c => c.type)).toContain("cycle_done")
  })

  test("falls back to legacy when no @ markers", () => {
    const cmds = parseSupervisorCommands("MESSAGES\nCYCLE_DONE done")
    expect(cmds.map(c => c.type)).toEqual(["messages", "cycle_done"])
  })
})

describe("parseJsonCommands", () => {
  test("parses a well-formed JSON actions array", () => {
    const cmds = parseJsonCommands(JSON.stringify({ actions: ["@check", "@done: finished"] }))
    const types = cmds.map(c => c.type)
    expect(types).toContain("messages")
    expect(types).toContain("cycle_done")
  })

  test("falls back to text parsing for malformed JSON", () => {
    const cmds = parseJsonCommands("@check\n@done: ok")
    expect(cmds.map(c => c.type)).toContain("messages")
  })
})

describe("matchMarker and isCommandLine", () => {
  test("matchMarker identifies @worker prefix", () => {
    const m = matchMarker("@worker: hello")
    expect(m?.marker.type).toBe("prompt")
    expect(m?.rest).toBe("hello")
  })

  test("matchMarker returns null for unrelated text", () => {
    expect(matchMarker("just plain thinking")).toBeNull()
  })

  test("isCommandLine detects legacy prefixes", () => {
    expect(isCommandLine("PROMPT do X")).toBe(true)
    expect(isCommandLine("CYCLE_DONE")).toBe(true)
    expect(isCommandLine("nothing special")).toBe(false)
  })
})
