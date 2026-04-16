import { describe, test, expect } from "bun:test"

// Re-implement the supervisor command parser to test it (not exported from supervisor.ts)
// This mirrors the parser in supervisor.ts and serves as a specification for the command format.

type SupervisorCommand =
  | { type: "prompt"; message: string }
  | { type: "wait" }
  | { type: "messages" }
  | { type: "review" }
  | { type: "restart" }
  | { type: "abort" }
  | { type: "note"; text: string }
  | { type: "note_behavior"; text: string }
  | { type: "directive"; text: string }
  | { type: "notify"; message: string }
  | { type: "intent"; description: string; files: string[] }
  | { type: "cycle_done"; summary: string }
  | { type: "stop"; summary: string }

function parseSupervisorCommands(response: string): SupervisorCommand[] {
  const commands: SupervisorCommand[] = []
  const codeBlockMatch = response.match(/```commands?\n([\s\S]*?)```/)
  const lines = codeBlockMatch ? codeBlockMatch[1]!.split("\n") : response.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("PROMPT ")) {
      commands.push({ type: "prompt", message: trimmed.slice(7) })
    } else if (trimmed === "WAIT") {
      commands.push({ type: "wait" })
    } else if (trimmed === "MESSAGES") {
      commands.push({ type: "messages" })
    } else if (trimmed === "REVIEW") {
      commands.push({ type: "review" })
    } else if (trimmed === "RESTART") {
      commands.push({ type: "restart" })
    } else if (trimmed === "ABORT") {
      commands.push({ type: "abort" })
    } else if (trimmed.startsWith("NOTE_BEHAVIOR ")) {
      commands.push({ type: "note_behavior", text: trimmed.slice(14) })
    } else if (trimmed.startsWith("NOTE ")) {
      commands.push({ type: "note", text: trimmed.slice(5) })
    } else if (trimmed.startsWith("DIRECTIVE ")) {
      commands.push({ type: "directive", text: trimmed.slice(10) })
    } else if (trimmed.startsWith("NOTIFY ")) {
      commands.push({ type: "notify", message: trimmed.slice(7) })
    } else if (trimmed.startsWith("INTENT ")) {
      const rest = trimmed.slice(7)
      const filesMatch = rest.match(/\[files?:\s*([^\]]+)\]/)
      const files = filesMatch
        ? filesMatch[1]!.split(",").map(f => f.trim()).filter(Boolean)
        : []
      const description = rest.replace(/\[files?:\s*[^\]]+\]/, "").trim()
      commands.push({ type: "intent", description, files })
    } else if (trimmed.startsWith("CYCLE_DONE")) {
      commands.push({ type: "cycle_done", summary: trimmed.slice(10).trim() || "Cycle completed." })
    } else if (trimmed.startsWith("STOP")) {
      commands.push({ type: "stop", summary: trimmed.slice(4).trim() || "Supervisor stopped." })
    }
  }
  return commands
}

// ---------------------------------------------------------------------------
// NOTIFY command tests
// ---------------------------------------------------------------------------

describe("NOTIFY command", () => {
  test("parses NOTIFY with message", () => {
    const cmds = parseSupervisorCommands("NOTIFY I'm about to refactor the auth module")
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toEqual({ type: "notify", message: "I'm about to refactor the auth module" })
  })

  test("NOTIFY in code block", () => {
    const response = `\`\`\`commands
NOTIFY Starting database migration work
WAIT
\`\`\``
    const cmds = parseSupervisorCommands(response)
    expect(cmds).toHaveLength(2)
    expect(cmds[0]!.type).toBe("notify")
    expect((cmds[0] as { type: "notify"; message: string }).message).toBe("Starting database migration work")
  })
})

// ---------------------------------------------------------------------------
// INTENT command tests
// ---------------------------------------------------------------------------

describe("INTENT command", () => {
  test("parses INTENT with description and files", () => {
    const cmds = parseSupervisorCommands("INTENT Refactor auth module [files: src/auth.ts, src/middleware.ts]")
    expect(cmds).toHaveLength(1)
    const cmd = cmds[0] as { type: "intent"; description: string; files: string[] }
    expect(cmd.type).toBe("intent")
    expect(cmd.description).toBe("Refactor auth module")
    expect(cmd.files).toEqual(["src/auth.ts", "src/middleware.ts"])
  })

  test("parses INTENT with description only (no files)", () => {
    const cmds = parseSupervisorCommands("INTENT Research best practices for error handling")
    expect(cmds).toHaveLength(1)
    const cmd = cmds[0] as { type: "intent"; description: string; files: string[] }
    expect(cmd.type).toBe("intent")
    expect(cmd.description).toBe("Research best practices for error handling")
    expect(cmd.files).toEqual([])
  })

  test("parses INTENT with single file", () => {
    const cmds = parseSupervisorCommands("INTENT Fix bug [file: src/bug.ts]")
    expect(cmds).toHaveLength(1)
    const cmd = cmds[0] as { type: "intent"; description: string; files: string[] }
    expect(cmd.files).toEqual(["src/bug.ts"])
  })

  test("INTENT with files containing spaces in file list", () => {
    const cmds = parseSupervisorCommands("INTENT Update configs [files: src/config.ts, src/settings.ts, src/env.ts]")
    const cmd = cmds[0] as { type: "intent"; description: string; files: string[] }
    expect(cmd.files).toEqual(["src/config.ts", "src/settings.ts", "src/env.ts"])
  })

  test("INTENT in code block with other commands", () => {
    const response = `\`\`\`commands
INTENT Add test coverage [files: src/tests/new.test.ts, src/utils.ts]
PROMPT Write tests for the utils module
WAIT
\`\`\``
    const cmds = parseSupervisorCommands(response)
    expect(cmds).toHaveLength(3)
    expect(cmds[0]!.type).toBe("intent")
    expect(cmds[1]!.type).toBe("prompt")
    expect(cmds[2]!.type).toBe("wait")
  })
})

// ---------------------------------------------------------------------------
// All commands together
// ---------------------------------------------------------------------------

describe("full command set", () => {
  test("parses a realistic multi-command response", () => {
    const response = `Let me check the agent's state and declare my intent.

\`\`\`commands
MESSAGES
INTENT Fix authentication bugs [files: src/auth.ts, src/login.ts]
NOTIFY Starting auth bug fixes - will be touching auth.ts and login.ts
PROMPT Fix the null pointer exception in the login flow at src/login.ts:42
WAIT
\`\`\`

I'll wait for the agent to complete this.`

    const cmds = parseSupervisorCommands(response)
    expect(cmds).toHaveLength(5)
    expect(cmds[0]!.type).toBe("messages")
    expect(cmds[1]!.type).toBe("intent")
    expect(cmds[2]!.type).toBe("notify")
    expect(cmds[3]!.type).toBe("prompt")
    expect(cmds[4]!.type).toBe("wait")
  })

  test("handles all command types in sequence", () => {
    const response = `\`\`\`commands
MESSAGES
PROMPT Do the thing
WAIT
REVIEW
RESTART
ABORT
NOTE Important note
NOTE_BEHAVIOR Keep it short
DIRECTIVE New direction
NOTIFY Heads up everyone
INTENT Working on tests [files: test.ts]
CYCLE_DONE All done with good progress
\`\`\``
    const cmds = parseSupervisorCommands(response)
    expect(cmds).toHaveLength(12)
    expect(cmds.map(c => c.type)).toEqual([
      "messages", "prompt", "wait", "review", "restart", "abort",
      "note", "note_behavior", "directive", "notify", "intent", "cycle_done",
    ])
  })
})
