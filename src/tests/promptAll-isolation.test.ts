import { describe, test, expect } from "bun:test"

describe("promptAll result type", () => {
  test("promptAll returns { succeeded, failed } with all successes", async () => {
    const calls: string[] = []
    const orchestrator = {
      agents: new Map([
        ["alpha", { status: "idle", config: { name: "alpha" } }],
        ["beta", { status: "idle", config: { name: "beta" } }],
      ]),
      prompt: async (name: string, _text: string) => { calls.push(name) },
      promptAll: async (prompts: { agentName: string; text: string }[]) => {
        const succeeded: string[] = []
        const failed: Array<{ agent: string; error: string }> = []
        for (const p of prompts) {
          calls.push(p.agentName)
          succeeded.push(p.agentName)
        }
        return { succeeded, failed }
      },
      getMessages: async () => [{ role: "assistant", content: "done" }],
      status: async () => new Map(),
      addAgent: async () => {},
      removeAgent: () => {},
      abortAgent: async () => {},
      restartAgent: async () => "sess",
      forceResetAgentStatus: () => {},
      shutdown: () => {},
    }

    const result = await orchestrator.promptAll([
      { agentName: "alpha", text: "hello" },
      { agentName: "beta", text: "hello" },
    ])

    expect(result.succeeded).toEqual(["alpha", "beta"])
    expect(result.failed).toEqual([])
    expect(calls).toEqual(["alpha", "beta"])
  })

  test("promptAll returns partial failures", async () => {
    const orchestrator = {
      promptAll: async (prompts: { agentName: string; text: string }[]) => {
        const succeeded: string[] = []
        const failed: Array<{ agent: string; error: string }> = []
        for (const p of prompts) {
          if (p.agentName === "broken") {
            failed.push({ agent: p.agentName, error: "Unknown agent: broken" })
          } else {
            succeeded.push(p.agentName)
          }
        }
        return { succeeded, failed }
      },
    }

    const result = await orchestrator.promptAll([
      { agentName: "alpha", text: "hello" },
      { agentName: "broken", text: "hello" },
      { agentName: "gamma", text: "hello" },
    ])

    expect(result.succeeded).toEqual(["alpha", "gamma"])
    expect(result.failed).toEqual([{ agent: "broken", error: "Unknown agent: broken" }])
  })

  test("promptAll returns all failures", async () => {
    const orchestrator = {
      promptAll: async (prompts: { agentName: string; text: string }[]) => {
        const failed = prompts.map(p => ({ agent: p.agentName, error: "disconnected" }))
        return { succeeded: [] as string[], failed }
      },
    }

    const result = await orchestrator.promptAll([
      { agentName: "a", text: "hello" },
      { agentName: "b", text: "hello" },
    ])

    expect(result.succeeded).toEqual([])
    expect(result.failed.length).toBe(2)
    expect(result.failed[0]!.agent).toBe("a")
    expect(result.failed[1]!.agent).toBe("b")
  })

  test("brain prompt_all formats partial failures for LLM", () => {
    const succeeded = ["alpha", "gamma"]
    const failed = [{ agent: "broken", error: "Unknown agent: broken" }]
    const total = 3

    const result = failed.length > 0
      ? `Sent to ${succeeded.length}/${total} agents. Failed: ${failed.map(f => `${f.agent}: ${f.error}`).join("; ")}. Consider retrying failed agents individually with PROMPT.`
      : `Sent to all ${succeeded.length} agents: "hello..."`

    expect(result).toBe("Sent to 2/3 agents. Failed: broken: Unknown agent: broken. Consider retrying failed agents individually with PROMPT.")
  })

  test("brain prompt_all formats full success for LLM", () => {
    const succeeded = ["alpha", "beta", "gamma"]
    const failed: Array<{ agent: string; error: string }> = []
    const total = 3

    const result = failed.length > 0
      ? `Sent to ${succeeded.length}/${total} agents. Failed: ${failed.map(f => `${f.agent}: ${f.error}`).join("; ")}. Consider retrying failed agents individually with PROMPT.`
      : `Sent to all ${succeeded.length} agents: "hello..."`

    expect(result).toBe('Sent to all 3 agents: "hello..."')
  })
})