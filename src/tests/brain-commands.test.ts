import { describe, test, expect } from "bun:test"

// parseCommands and parseSupervisorCommands are not exported, so we test them
// by importing the module source and extracting the functions via a workaround.
// Since they're internal, we re-implement the parser logic here for testing.
// This also serves as a specification for the command format.

// --- Brain command parser (mirrors brain.ts parseCommands) ---

type ParsedCommand =
  | { type: "prompt"; agent: string; message: string }
  | { type: "prompt_all"; message: string }
  | { type: "status" }
  | { type: "messages"; agent: string }
  | { type: "wait" }
  | { type: "note"; agent: string; text: string }
  | { type: "done"; summary: string }

function parseCommands(response: string): ParsedCommand[] {
  const commands: ParsedCommand[] = []
  const codeBlockMatch = response.match(/```commands?\n([\s\S]*?)```/)
  const lines = codeBlockMatch ? codeBlockMatch[1]!.split("\n") : response.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("PROMPT_ALL ")) {
      commands.push({ type: "prompt_all", message: trimmed.slice(11) })
    } else if (trimmed.startsWith("PROMPT ")) {
      const rest = trimmed.slice(7)
      const spaceIdx = rest.indexOf(" ")
      if (spaceIdx !== -1) {
        commands.push({ type: "prompt", agent: rest.slice(0, spaceIdx), message: rest.slice(spaceIdx + 1) })
      }
    } else if (trimmed === "STATUS") {
      commands.push({ type: "status" })
    } else if (trimmed.startsWith("MESSAGES ")) {
      commands.push({ type: "messages", agent: trimmed.slice(9).trim() })
    } else if (trimmed.startsWith("NOTE ")) {
      const rest = trimmed.slice(5)
      const spaceIdx = rest.indexOf(" ")
      if (spaceIdx !== -1) {
        commands.push({ type: "note", agent: rest.slice(0, spaceIdx), text: rest.slice(spaceIdx + 1) })
      }
    } else if (trimmed === "WAIT") {
      commands.push({ type: "wait" })
    } else if (trimmed.startsWith("DONE")) {
      commands.push({ type: "done", summary: trimmed.slice(4).trim() || "Objective completed." })
    }
  }
  return commands
}

// --- Supervisor command parser (mirrors supervisor.ts parseSupervisorCommands) ---

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
    } else if (trimmed.startsWith("CYCLE_DONE")) {
      commands.push({ type: "cycle_done", summary: trimmed.slice(10).trim() || "Cycle completed." })
    } else if (trimmed.startsWith("STOP")) {
      commands.push({ type: "stop", summary: trimmed.slice(4).trim() || "Supervisor stopped." })
    }
  }
  return commands
}

// ---------------------------------------------------------------------------
// Brain parseCommands tests
// ---------------------------------------------------------------------------

describe("parseCommands (brain)", () => {
  test("parses commands from code block", () => {
    const response = `Let me check the status first.

\`\`\`commands
STATUS
PROMPT agent-1 Fix the login bug in src/auth.ts
WAIT
\`\`\`

I'll wait for the results.`

    const cmds = parseCommands(response)
    expect(cmds).toHaveLength(3)
    expect(cmds[0]).toEqual({ type: "status" })
    expect(cmds[1]).toEqual({ type: "prompt", agent: "agent-1", message: "Fix the login bug in src/auth.ts" })
    expect(cmds[2]).toEqual({ type: "wait" })
  })

  test("parses PROMPT_ALL", () => {
    const cmds = parseCommands("PROMPT_ALL Run tests and report results")
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toEqual({ type: "prompt_all", message: "Run tests and report results" })
  })

  test("parses DONE with summary", () => {
    const cmds = parseCommands("DONE All tasks completed successfully.")
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toEqual({ type: "done", summary: "All tasks completed successfully." })
  })

  test("parses DONE without summary", () => {
    const cmds = parseCommands("DONE")
    expect(cmds[0]).toEqual({ type: "done", summary: "Objective completed." })
  })

  test("parses NOTE with agent and text", () => {
    const cmds = parseCommands("NOTE my-project Auth module uses JWT tokens")
    expect(cmds[0]).toEqual({ type: "note", agent: "my-project", text: "Auth module uses JWT tokens" })
  })

  test("parses MESSAGES with agent name", () => {
    const cmds = parseCommands("MESSAGES agent-1")
    expect(cmds[0]).toEqual({ type: "messages", agent: "agent-1" })
  })

  test("returns empty for no commands", () => {
    const cmds = parseCommands("I'm thinking about what to do next...")
    expect(cmds).toHaveLength(0)
  })

  test("skips PROMPT without message", () => {
    const cmds = parseCommands("PROMPT agent-1")
    expect(cmds).toHaveLength(0) // no space after agent name = no message
  })

  test("handles multiple commands", () => {
    const response = `\`\`\`commands
PROMPT agent-1 Fix bug A
PROMPT agent-2 Fix bug B
WAIT
MESSAGES agent-1
MESSAGES agent-2
DONE Both bugs fixed.
\`\`\``
    const cmds = parseCommands(response)
    expect(cmds).toHaveLength(6)
  })
})

// ---------------------------------------------------------------------------
// Supervisor parseSupervisorCommands tests
// ---------------------------------------------------------------------------

describe("parseSupervisorCommands", () => {
  test("parses basic supervisor commands", () => {
    const response = `\`\`\`commands
MESSAGES
PROMPT Check the test output in src/tests/
WAIT
\`\`\``
    const cmds = parseSupervisorCommands(response)
    expect(cmds).toHaveLength(3)
    expect(cmds[0]).toEqual({ type: "messages" })
    expect(cmds[1]).toEqual({ type: "prompt", message: "Check the test output in src/tests/" })
    expect(cmds[2]).toEqual({ type: "wait" })
  })

  test("parses REVIEW, RESTART, ABORT", () => {
    const cmds = parseSupervisorCommands("REVIEW\nRESTART\nABORT")
    expect(cmds).toHaveLength(3)
    expect(cmds[0]).toEqual({ type: "review" })
    expect(cmds[1]).toEqual({ type: "restart" })
    expect(cmds[2]).toEqual({ type: "abort" })
  })

  test("parses NOTE vs NOTE_BEHAVIOR (order matters)", () => {
    const cmds = parseSupervisorCommands("NOTE Important project info\nNOTE_BEHAVIOR Keep prompts short")
    expect(cmds).toHaveLength(2)
    expect(cmds[0]).toEqual({ type: "note", text: "Important project info" })
    expect(cmds[1]).toEqual({ type: "note_behavior", text: "Keep prompts short" })
  })

  test("parses DIRECTIVE", () => {
    const cmds = parseSupervisorCommands("DIRECTIVE Focus on fixing tests now")
    expect(cmds[0]).toEqual({ type: "directive", text: "Focus on fixing tests now" })
  })

  test("parses CYCLE_DONE with summary", () => {
    const cmds = parseSupervisorCommands("CYCLE_DONE Fixed 3 bugs, agent working on test coverage")
    expect(cmds[0]).toEqual({ type: "cycle_done", summary: "Fixed 3 bugs, agent working on test coverage" })
  })

  test("parses CYCLE_DONE without summary", () => {
    const cmds = parseSupervisorCommands("CYCLE_DONE")
    expect(cmds[0]).toEqual({ type: "cycle_done", summary: "Cycle completed." })
  })

  test("parses STOP with summary", () => {
    const cmds = parseSupervisorCommands("STOP Agent is non-responsive after multiple restarts")
    expect(cmds[0]).toEqual({ type: "stop", summary: "Agent is non-responsive after multiple restarts" })
  })

  test("parses STOP without summary", () => {
    const cmds = parseSupervisorCommands("STOP")
    expect(cmds[0]).toEqual({ type: "stop", summary: "Supervisor stopped." })
  })
})
