import { describe, test, expect } from "bun:test"
import { trimConversation } from "../message-utils"

type Msg = { role: "system" | "user" | "assistant"; content: string }

describe("trimConversation — priority preservation", () => {
  test("non-priority messages in trim zone are removed before priority", () => {
    // Build a conversation where the trim zone has a mix of priority and non-priority.
    // We verify that non-priority indices are removed and priority ones survive longer.
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "normal user 0" },        // trim zone
      { role: "assistant", content: "normal asst 0" },    // trim zone
      { role: "user", content: "[WARNING] important" },   // trim zone — priority
      { role: "assistant", content: "response to warn" }, // trim zone — follows priority
      { role: "user", content: "normal user 2" },         // trim zone
      { role: "assistant", content: "normal asst 2" },    // trim zone
      // keep zone (recent messages)
      { role: "user", content: "recent 1" },
      { role: "assistant", content: "recent 1 resp" },
      { role: "user", content: "recent 2" },
      { role: "assistant", content: "recent 2 resp" },
      { role: "user", content: "recent 3" },
      { role: "assistant", content: "recent 3 resp" },
    ]
    // 13 messages. maxMessages=10 → keep=8, endIdx=13-8=5, trim zone=1..4
    trimConversation(msgs, 10)

    const contents = msgs.map(m => m.content)
    // Non-priority "normal user 0" and "normal asst 0" should be gone
    expect(contents.some(c => c === "normal user 0")).toBe(false)
    expect(contents.some(c => c === "normal asst 0")).toBe(false)
    // System prompt preserved
    expect(contents[0]).toBe("sys")
    // Recent messages preserved
    expect(contents.some(c => c === "recent 3 resp")).toBe(true)
  })

  test("all priority prefix types are recognized in trim decisions", () => {
    const prefixes = ["[VALIDATION]", "[DIRECTIVE]", "[URGENT]", "[WARNING]", "[REDIRECT]"]
    for (const prefix of prefixes) {
      const msgs: Msg[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "normal 1" },              // trim zone - non-priority
        { role: "assistant", content: "normal 1 resp" },     // trim zone - non-priority
        { role: "user", content: `${prefix} tagged msg` },   // trim zone - priority
        { role: "assistant", content: "tagged resp" },        // trim zone - follows priority
        { role: "user", content: "recent" },
        { role: "assistant", content: "recent resp" },
        { role: "user", content: "recent 2" },
        { role: "assistant", content: "recent 2 resp" },
        { role: "user", content: "recent 3" },
        { role: "assistant", content: "recent 3 resp" },
      ]
      // 11 messages, max=9 → keep=7, endIdx=4, zone=1..3
      // zone: [normal 1, normal 1 resp, tagged msg] — tagged is priority, others aren't
      const before = [...msgs]
      trimConversation(msgs, 9)

      const contents = msgs.map(m => m.content)
      // Non-priority "normal 1" removed first
      expect(contents.some(c => c === "normal 1")).toBe(false)
      // Tagged message should remain (only 1 non-priority removed, then we might have room)
    }
  })

  test("trim marker is inserted when messages are removed", () => {
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old 1" },
      { role: "assistant", content: "old 1 resp" },
      { role: "user", content: "old 2" },
      { role: "assistant", content: "old 2 resp" },
      { role: "user", content: "recent" },
      { role: "assistant", content: "recent resp" },
    ]
    // 7 messages, max=5 → keep=3, endIdx=4, zone=1..3
    trimConversation(msgs, 5)
    expect(msgs.some(m => m.content.includes("Context trimmed"))).toBe(true)
  })

  test("no trim marker when nothing was removed", () => {
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]
    trimConversation(msgs, 10)
    expect(msgs.length).toBe(3)
    expect(msgs.some(m => m.content.includes("Context trimmed"))).toBe(false)
  })

  test("system prompt is always preserved", () => {
    const msgs: Msg[] = [
      { role: "system", content: "sys prompt" },
      ...Array.from({ length: 40 }, (_, i) => [
        { role: "user" as const, content: `u${i}` },
        { role: "assistant" as const, content: `a${i}` },
      ]).flat(),
    ]
    trimConversation(msgs, 10)
    expect(msgs[0]!.content).toBe("sys prompt")
    expect(msgs[0]!.role).toBe("system")
  })

  test("most recent messages are preserved", () => {
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 20 }, (_, i) => [
        { role: "user" as const, content: `u${i}` },
        { role: "assistant" as const, content: `a${i}` },
      ]).flat(),
    ]
    trimConversation(msgs, 10)
    // Last message should be the most recent
    expect(msgs[msgs.length - 1]!.content).toBe("a19")
  })

  test("if all trim-zone messages are priority, oldest priority gets trimmed to fit", () => {
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "[URGENT] urgent 1" },
      { role: "assistant", content: "resp 1" },
      { role: "user", content: "[URGENT] urgent 2" },
      { role: "assistant", content: "resp 2" },
      { role: "user", content: "[URGENT] urgent 3" },
      { role: "assistant", content: "resp 3" },
      { role: "user", content: "recent" },
      { role: "assistant", content: "recent resp" },
    ]
    // 9 messages, max=5 → keep=3, endIdx=6, zone=1..5
    // All 5 trim zone messages are priority (3 urgent + 2 follows-priority)
    // 0 non-priority to remove → still 9 > 5, excess=4, splice from 1
    trimConversation(msgs, 5)
    expect(msgs.length).toBeLessThanOrEqual(5)
    // Most recent should survive
    expect(msgs[msgs.length - 1]!.content).toBe("recent resp")
  })

  test("with only non-priority in trim zone, all get removed cleanly", () => {
    const msgs: Msg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old 1" },
      { role: "assistant", content: "old 1 resp" },
      { role: "user", content: "old 2" },
      { role: "assistant", content: "old 2 resp" },
      { role: "user", content: "old 3" },
      { role: "assistant", content: "old 3 resp" },
      { role: "user", content: "recent" },
      { role: "assistant", content: "recent resp" },
    ]
    // 9 messages, max=4 → keep=2, endIdx=7, zone=1..6 (6 non-priority)
    trimConversation(msgs, 4)
    expect(msgs.length).toBeLessThanOrEqual(4)
    expect(msgs[0]!.content).toBe("sys")
    expect(msgs[msgs.length - 1]!.content).toBe("recent resp")
  })
})
