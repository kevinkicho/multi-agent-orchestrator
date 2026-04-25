/**
 * Orchestrator factory unit tests.
 *
 * `createOrchestrator` reaches out over HTTP at construction time
 * (agentHealthCheck + agentCreateSession) and opens an SSE subscription per
 * agent, so we can't exercise it against real `localhost:NNNN` URLs in a unit
 * test. We use bun's `mock.module()` to stub `../agent`, `../events`, and
 * `../message-utils` before importing the SUT, then drive the public
 * Orchestrator interface (the only surface callers actually depend on).
 *
 * Tests focus on observable behavior — what the public methods return, what
 * the mocked collaborators receive — rather than poking at internal Map
 * mutations.
 */
import { describe, test, expect, beforeAll, afterEach, mock } from "bun:test"
import type { AgentConfig, AgentState } from "../agent"
import type { OrchestratorConfig, Orchestrator } from "../orchestrator"

// ---------------------------------------------------------------------------
// Recorders captured by the module mocks below.
// ---------------------------------------------------------------------------

const promptCalls: Array<{ agent: string; text: string }> = []
const abortCalls: string[] = []
const createSessionCalls: string[] = []
const messagesByAgent = new Map<string, unknown[]>()
const eventSubscriptions: string[] = []
const eventAborts: string[] = []

let healthCheckResult = true
let promptShouldFailFor: Set<string> = new Set()

function resetRecorders() {
  promptCalls.length = 0
  abortCalls.length = 0
  createSessionCalls.length = 0
  messagesByAgent.clear()
  eventSubscriptions.length = 0
  eventAborts.length = 0
  healthCheckResult = true
  promptShouldFailFor = new Set()
}

// ---------------------------------------------------------------------------
// Module mocks — must be installed before importing `../orchestrator`.
// ---------------------------------------------------------------------------

function makeMockAgentState(config: AgentConfig): AgentState {
  return {
    config,
    client: {} as never,
    sessionID: null,
    status: "disconnected",
    lastError: null,
    lastActivity: 0,
    busyStartTime: null,
    lastEventAt: 0,
  }
}

mock.module("../agent", () => ({
  createAgent: (config: AgentConfig) => makeMockAgentState(config),
  agentHealthCheck: async () => healthCheckResult,
  agentCreateSession: async (state: AgentState) => {
    createSessionCalls.push(state.config.name)
    state.sessionID = `sess-${state.config.name}-${createSessionCalls.length}`
    state.status = "idle"
    return state.sessionID
  },
  agentPrompt: async (state: AgentState, text: string) => {
    promptCalls.push({ agent: state.config.name, text })
    if (promptShouldFailFor.has(state.config.name)) {
      throw new Error(`stubbed failure for ${state.config.name}`)
    }
  },
  agentGetMessages: async (state: AgentState) => {
    return messagesByAgent.get(state.config.name) ?? []
  },
  agentGetSessionStatus: async () => null,
  agentListPermissions: async () => [],
  agentReplyPermission: async () => {},
  agentHealthCheck_unused: undefined,
  agentAbort: async (state: AgentState) => {
    abortCalls.push(state.config.name)
  },
  agentAnswerQuestion: async () => {},
  agentRejectQuestion: async () => {},
}))

mock.module("../events", () => ({
  subscribeToAgentEvents: (state: AgentState) => {
    eventSubscriptions.push(state.config.name)
    return {
      abort: () => {
        eventAborts.push(state.config.name)
      },
    }
  },
}))

mock.module("../message-utils", () => ({
  extractLastAssistantText: () => null,
}))

// Import AFTER mocks are installed so the SUT picks up the stubs.
const { createOrchestrator } = await import("../orchestrator")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentConfig(name: string, port = 9000): AgentConfig {
  return { name, url: `http://127.0.0.1:${port}`, directory: `/tmp/${name}` }
}

function baseConfig(agents: AgentConfig[]): OrchestratorConfig {
  // High pollInterval / stuckThreshold so the background timers don't fire
  // during the test window. Tests call shutdown() in afterEach to clear them.
  return {
    agents,
    pollInterval: 60_000,
    autoApprove: false,
    stuckThresholdMs: 60_000,
  }
}

// Track every orchestrator created in a test so afterEach can shut them down,
// otherwise stray setInterval timers keep the bun:test process alive.
const liveOrchestrators: Orchestrator[] = []

async function spawn(config: OrchestratorConfig): Promise<Orchestrator> {
  const o = await createOrchestrator(config)
  liveOrchestrators.push(o)
  return o
}

afterEach(() => {
  while (liveOrchestrators.length) {
    const o = liveOrchestrators.pop()!
    try { o.shutdown() } catch {}
  }
  resetRecorders()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOrchestrator — initialization", () => {
  test("connects to all configured agents and creates sessions", async () => {
    const o = await spawn(baseConfig([
      agentConfig("a-1", 9001),
      agentConfig("a-2", 9002),
    ]))

    expect(o.agents.size).toBe(2)
    expect(o.agents.has("a-1")).toBe(true)
    expect(o.agents.has("a-2")).toBe(true)
    expect(createSessionCalls.sort()).toEqual(["a-1", "a-2"])
    expect(eventSubscriptions.sort()).toEqual(["a-1", "a-2"])
  })

  test("supports an empty agent list", async () => {
    const o = await spawn(baseConfig([]))
    expect(o.agents.size).toBe(0)
    expect(createSessionCalls).toEqual([])
  })

  test("marks unreachable agents as disconnected and skips session creation", async () => {
    healthCheckResult = false
    const o = await spawn(baseConfig([agentConfig("dead", 9003)]))
    expect(o.agents.size).toBe(1)
    expect(o.agents.get("dead")!.status).toBe("disconnected")
    expect(createSessionCalls).toEqual([])
    expect(eventSubscriptions).toEqual([])
  })
})

describe("createOrchestrator — addAgent / removeAgent", () => {
  test("addAgent registers a new agent and subscribes to its events", async () => {
    const o = await spawn(baseConfig([]))
    await o.addAgent(agentConfig("dynamic", 9100))

    expect(o.agents.has("dynamic")).toBe(true)
    expect(createSessionCalls).toContain("dynamic")
    expect(eventSubscriptions).toContain("dynamic")
  })

  test("addAgent rejects when the new agent fails its health check", async () => {
    const o = await spawn(baseConfig([]))
    healthCheckResult = false
    await expect(o.addAgent(agentConfig("nope", 9101)))
      .rejects.toThrow(/not reachable/)
    expect(o.agents.has("nope")).toBe(false)
  })

  test("removeAgent drops the agent and aborts its event subscription", async () => {
    const o = await spawn(baseConfig([agentConfig("temp", 9102)]))
    expect(eventSubscriptions).toContain("temp")

    o.removeAgent("temp")
    expect(o.agents.has("temp")).toBe(false)
    expect(eventAborts).toContain("temp")
  })

  test("removeAgent on an unknown name is a no-op", async () => {
    const o = await spawn(baseConfig([]))
    expect(() => o.removeAgent("ghost")).not.toThrow()
  })
})

describe("createOrchestrator — prompt / promptAll", () => {
  test("prompt forwards the text to the named agent", async () => {
    const o = await spawn(baseConfig([agentConfig("a-1", 9200)]))
    await o.prompt("a-1", "hello")
    expect(promptCalls).toEqual([{ agent: "a-1", text: "hello" }])
  })

  test("prompt rejects for an unknown agent", async () => {
    const o = await spawn(baseConfig([]))
    await expect(o.prompt("missing", "hi"))
      .rejects.toThrow(/Unknown agent: missing/)
  })

  test("promptAll fans out to every named agent and reports succeeded list", async () => {
    const o = await spawn(baseConfig([
      agentConfig("a-1", 9201),
      agentConfig("a-2", 9202),
    ]))
    const result = await o.promptAll([
      { agentName: "a-1", text: "p1" },
      { agentName: "a-2", text: "p2" },
    ])
    expect(result.succeeded.sort()).toEqual(["a-1", "a-2"])
    expect(result.failed).toHaveLength(0)
    expect(promptCalls).toHaveLength(2)
  })

  test("promptAll surfaces partial failures without aborting siblings", async () => {
    const o = await spawn(baseConfig([
      agentConfig("good", 9203),
      agentConfig("bad", 9204),
    ]))
    promptShouldFailFor = new Set(["bad"])

    const result = await o.promptAll([
      { agentName: "good", text: "ok" },
      { agentName: "bad", text: "boom" },
    ])
    expect(result.succeeded).toEqual(["good"])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.agent).toBe("bad")
    expect(result.failed[0]!.error).toMatch(/stubbed failure for bad/)
  })
})

describe("createOrchestrator — abortAgent / restartAgent", () => {
  test("abortAgent calls agentAbort and clears busyStartTime", async () => {
    const o = await spawn(baseConfig([agentConfig("a-1", 9300)]))
    const agent = o.agents.get("a-1")!
    agent.busyStartTime = Date.now() - 1_000

    await o.abortAgent("a-1")
    expect(abortCalls).toEqual(["a-1"])
    expect(agent.busyStartTime).toBeNull()
  })

  test("abortAgent throws on unknown agent", async () => {
    const o = await spawn(baseConfig([]))
    await expect(o.abortAgent("ghost"))
      .rejects.toThrow(/Unknown agent: ghost/)
  })

  test("restartAgent aborts then opens a fresh session and returns its id", async () => {
    const o = await spawn(baseConfig([agentConfig("a-1", 9301)]))
    // Reset recorder so we can assert just the restart-time calls.
    abortCalls.length = 0
    createSessionCalls.length = 0

    const sessionID = await o.restartAgent("a-1")
    expect(abortCalls).toEqual(["a-1"])
    expect(createSessionCalls).toEqual(["a-1"])
    expect(sessionID).toMatch(/^sess-a-1-/)
  })

  test("restartAgent throws on unknown agent", async () => {
    const o = await spawn(baseConfig([]))
    await expect(o.restartAgent("ghost"))
      .rejects.toThrow(/Unknown agent: ghost/)
  })
})

describe("createOrchestrator — status / getMessages", () => {
  test("getMessages returns the mocked transcript for the agent", async () => {
    const o = await spawn(baseConfig([agentConfig("a-1", 9400)]))
    const transcript = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]
    messagesByAgent.set("a-1", transcript)

    const msgs = await o.getMessages("a-1")
    expect(msgs).toEqual(transcript)
  })

  test("getMessages throws on unknown agent", async () => {
    const o = await spawn(baseConfig([]))
    await expect(o.getMessages("ghost"))
      .rejects.toThrow(/Unknown agent: ghost/)
  })

  test("status returns one entry per registered agent", async () => {
    const o = await spawn(baseConfig([
      agentConfig("a-1", 9401),
      agentConfig("a-2", 9402),
    ]))

    const snapshot = await o.status()
    expect(snapshot.size).toBe(2)
    const a1 = snapshot.get("a-1")!
    expect(a1.status).toBe("idle")
    expect(a1.sessionID).toMatch(/^sess-a-1-/)
    expect(typeof a1.lastActivity).toBe("number")
    expect(typeof a1.lastEventAt).toBe("number")
  })
})

describe("createOrchestrator — forceResetAgentStatus / shutdown", () => {
  test("forceResetAgentStatus moves the agent back to idle", async () => {
    const o = await spawn(baseConfig([agentConfig("a-1", 9500)]))
    const agent = o.agents.get("a-1")!
    agent.status = "busy"
    agent.busyStartTime = Date.now() - 10_000
    agent.lastActivity = 0
    agent.lastEventAt = 0

    o.forceResetAgentStatus("a-1")
    // Re-read through the public agents map so TS doesn't narrow `status` to
    // the pre-reset literal type.
    const after = o.agents.get("a-1")!
    expect(after.status).toBe("idle")
    expect(after.busyStartTime).toBeNull()
    expect(after.lastActivity).toBeGreaterThan(0)
    expect(after.lastEventAt).toBeGreaterThan(0)
  })

  test("forceResetAgentStatus on unknown agent is a no-op", async () => {
    const o = await spawn(baseConfig([]))
    expect(() => o.forceResetAgentStatus("ghost")).not.toThrow()
  })

  test("shutdown aborts every event subscription", async () => {
    const o = await spawn(baseConfig([
      agentConfig("a-1", 9600),
      agentConfig("a-2", 9601),
    ]))
    expect(eventSubscriptions.sort()).toEqual(["a-1", "a-2"])

    o.shutdown()
    // Pop from liveOrchestrators so afterEach doesn't double-shutdown.
    liveOrchestrators.pop()
    expect(eventAborts.sort()).toEqual(["a-1", "a-2"])
  })
})
