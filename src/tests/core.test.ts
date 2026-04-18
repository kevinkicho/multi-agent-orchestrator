import { describe, test, expect } from "bun:test"
import { trimConversation, extractLastAssistantText, summarizeLastAssistantTurn, formatRecentMessages } from "../message-utils"

// ---------------------------------------------------------------------------
// trimConversation
// ---------------------------------------------------------------------------

describe("trimConversation", () => {
  test("does nothing when under maxMessages", () => {
    const msgs = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ]
    trimConversation(msgs, 10)
    expect(msgs.length).toBe(3)
  })

  test("trims to maxMessages, keeping system prompt", () => {
    const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: "sys" },
    ]
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: "user", content: `u${i}` })
      msgs.push({ role: "assistant", content: `a${i}` })
    }
    // 41 total (1 system + 40 conversation)
    expect(msgs.length).toBe(41)

    trimConversation(msgs, 10)
    // Should be capped at 10
    expect(msgs.length).toBe(10)
    // First message is still the system prompt
    expect(msgs[0]!.role).toBe("system")
    expect(msgs[0]!.content).toBe("sys")
    // Second message is the trim marker
    expect(msgs[1]!.content).toContain("Context trimmed")
    // Last messages are the most recent
    expect(msgs[msgs.length - 1]!.content).toBe("a19")
  })

  test("keeps exactly maxMessages when equal", () => {
    const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ]
    trimConversation(msgs, 3)
    expect(msgs.length).toBe(3) // no change
  })
})

// ---------------------------------------------------------------------------
// extractLastAssistantText
// ---------------------------------------------------------------------------

describe("extractLastAssistantText", () => {
  test("returns null for empty array", () => {
    expect(extractLastAssistantText([])).toBeNull()
  })

  test("extracts text from the last assistant message", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "first reply" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "follow up" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "second reply" }] },
    ]
    expect(extractLastAssistantText(msgs)).toBe("second reply")
  })

  test("returns null when no assistant messages", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ]
    expect(extractLastAssistantText(msgs)).toBeNull()
  })

  test("joins multiple text parts", () => {
    const msgs = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "part 1" },
          { type: "tool-use", tool: "grep" },
          { type: "text", text: "part 2" },
        ],
      },
    ]
    expect(extractLastAssistantText(msgs)).toBe("part 1\npart 2")
  })

  test("skips assistant messages with only tool-use parts", () => {
    const msgs = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "real answer" }] },
      { info: { role: "assistant" }, parts: [{ type: "tool-use", tool: "edit" }] },
    ]
    expect(extractLastAssistantText(msgs)).toBe("real answer")
  })
})

// ---------------------------------------------------------------------------
// summarizeLastAssistantTurn
// ---------------------------------------------------------------------------

describe("summarizeLastAssistantTurn", () => {
  test("prefers text when present", () => {
    const msgs = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }, { type: "tool", tool: "Read" }] },
    ]
    expect(summarizeLastAssistantTurn(msgs)).toBe("hello")
  })

  test("falls back to reasoning when no text", () => {
    const msgs = [
      { info: { role: "assistant" }, parts: [{ type: "reasoning", text: "thinking..." }] },
    ]
    expect(summarizeLastAssistantTurn(msgs)).toContain("reasoning only")
    expect(summarizeLastAssistantTurn(msgs)).toContain("thinking...")
  })

  test("falls back to tool-call summary when only tool parts (type=tool)", () => {
    const msgs = [
      { info: { role: "assistant" }, parts: [{ type: "tool", tool: "Read" }, { type: "tool", tool: "Edit" }] },
    ]
    expect(summarizeLastAssistantTurn(msgs)).toBe("(tool calls only: Read, Edit)")
  })

  test("falls back to tool-call summary when only tool parts (type=tool-use)", () => {
    const msgs = [
      { info: { role: "assistant" }, parts: [{ type: "tool-use", tool: "Bash" }] },
    ]
    expect(summarizeLastAssistantTurn(msgs)).toBe("(tool calls only: Bash)")
  })

  test("summarizes the LAST assistant turn, not a prior one", () => {
    const msgs = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "old text" }] },
      { info: { role: "assistant" }, parts: [{ type: "tool", tool: "Grep" }] },
    ]
    expect(summarizeLastAssistantTurn(msgs)).toBe("(tool calls only: Grep)")
  })

  test("returns null for empty array", () => {
    expect(summarizeLastAssistantTurn([])).toBeNull()
  })

  test("returns null when no assistant messages", () => {
    const msgs = [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }]
    expect(summarizeLastAssistantTurn(msgs)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// formatRecentMessages
// ---------------------------------------------------------------------------

describe("formatRecentMessages", () => {
  test("formats recent messages with roles", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hi there" }] },
    ]
    const result = formatRecentMessages(msgs, 2, 1000)
    expect(result.length).toBe(2)
    expect(result[0]).toContain("[user]")
    expect(result[0]).toContain("hello")
    expect(result[1]).toContain("[assistant]")
    expect(result[1]).toContain("hi there")
  })

  test("truncates long messages", () => {
    const longText = "x".repeat(500)
    const msgs = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: longText }] },
    ]
    const result = formatRecentMessages(msgs, 1, 100)
    expect(result[0]!.length).toBeLessThanOrEqual(120) // [assistant] prefix + 100 chars
  })

  test("shows tool-use parts", () => {
    const msgs = [
      { info: { role: "assistant" }, parts: [{ type: "tool-use", tool: "grep", name: "Grep" }] },
    ]
    const result = formatRecentMessages(msgs, 1, 1000)
    expect(result[0]).toContain("[tool:")
  })

  test("only takes the last N messages", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      info: { role: "user" },
      parts: [{ type: "text", text: `msg${i}` }],
    }))
    const result = formatRecentMessages(msgs, 3, 1000)
    expect(result.length).toBe(3)
    expect(result[0]).toContain("msg7")
  })
})
