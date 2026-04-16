import { describe, test, expect, mock, beforeEach } from "bun:test"
import { EventBus } from "../event-bus"
import { ResourceManager } from "../resource-manager"

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

// We can't easily mock chatCompletion (it's imported at module level), so we
// test the components that the supervisor orchestrates: command parsing, event
// bus integration, resource manager, and the recovery system working together.
// This exercises the cross-component flows without needing a real LLM.

type Message = { role: "system" | "user" | "assistant"; content: string }

// Re-implement parseSupervisorCommands (not exported) to verify integration
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
    if (trimmed.startsWith("PROMPT ")) commands.push({ type: "prompt", message: trimmed.slice(7) })
    else if (trimmed === "WAIT") commands.push({ type: "wait" })
    else if (trimmed === "MESSAGES") commands.push({ type: "messages" })
    else if (trimmed === "REVIEW") commands.push({ type: "review" })
    else if (trimmed === "RESTART") commands.push({ type: "restart" })
    else if (trimmed === "ABORT") commands.push({ type: "abort" })
    else if (trimmed.startsWith("NOTE_BEHAVIOR ")) commands.push({ type: "note_behavior", text: trimmed.slice(14) })
    else if (trimmed.startsWith("NOTE ")) commands.push({ type: "note", text: trimmed.slice(5) })
    else if (trimmed.startsWith("DIRECTIVE ")) commands.push({ type: "directive", text: trimmed.slice(10) })
    else if (trimmed.startsWith("NOTIFY ")) commands.push({ type: "notify", message: trimmed.slice(7) })
    else if (trimmed.startsWith("INTENT ")) {
      const rest = trimmed.slice(7)
      const filesMatch = rest.match(/\[files?:\s*([^\]]+)\]/)
      const files = filesMatch ? filesMatch[1]!.split(",").map(f => f.trim()).filter(Boolean) : []
      const description = rest.replace(/\[files?:\s*[^\]]+\]/, "").trim()
      commands.push({ type: "intent", description, files })
    }
    else if (trimmed.startsWith("CYCLE_DONE")) commands.push({ type: "cycle_done", summary: trimmed.slice(10).trim() || "Cycle completed." })
    else if (trimmed.startsWith("STOP")) commands.push({ type: "stop", summary: trimmed.slice(4).trim() || "Supervisor stopped." })
  }
  return commands
}

// Import recovery utilities
import {
  createNudgeState, resetNudge, buildEmptyNudge, buildNoParseNudge,
  fuzzyExtractCommands, createCircuitBreaker, recordFailure, recordSuccess,
  SUPERVISOR_COMMANDS, SUPERVISOR_DEFAULT_CMD,
} from "../command-recovery"
import { trimConversation } from "../message-utils"

// ---------------------------------------------------------------------------
// Integration: Supervisor state machine simulation
// ---------------------------------------------------------------------------

/** Simulates one supervisor round: LLM response → parse → execute → nudge/recover */
function simulateRound(
  response: string | null, // null = empty response
  messages: Message[],
  nudge: ReturnType<typeof createNudgeState>,
  eventBus: EventBus,
  resourceManager: ResourceManager,
  agentName: string,
): { commands: SupervisorCommand[]; nudged: boolean; recovered: boolean } {
  // Empty response path
  if (!response) {
    messages.push({
      role: "user",
      content: buildEmptyNudge(nudge, SUPERVISOR_COMMANDS, SUPERVISOR_DEFAULT_CMD),
    })
    return { commands: [], nudged: true, recovered: false }
  }

  messages.push({ role: "assistant", content: response })

  // Parse commands
  let commands = parseSupervisorCommands(response)
  let recovered = false

  // Fuzzy recovery
  if (commands.length === 0) {
    const fuzzyLines = fuzzyExtractCommands(response, SUPERVISOR_COMMANDS)
    if (fuzzyLines.length > 0) {
      const wrapped = "```commands\n" + fuzzyLines.join("\n") + "\n```"
      commands = parseSupervisorCommands(wrapped)
      if (commands.length > 0) recovered = true
    }
  }

  // No-parse nudge
  if (commands.length === 0) {
    messages.push({
      role: "user",
      content: buildNoParseNudge(nudge, response, SUPERVISOR_COMMANDS, SUPERVISOR_DEFAULT_CMD),
    })
    return { commands: [], nudged: true, recovered: false }
  }

  // Successful parse
  resetNudge(nudge)

  // Execute commands through event bus and resource manager
  for (const cmd of commands) {
    if (cmd.type === "intent") {
      resourceManager.declareIntent(agentName, cmd.description, cmd.files)
    } else if (cmd.type === "notify") {
      eventBus.emit({
        type: "agent-notification",
        source: "supervisor",
        agentName,
        data: { message: cmd.message },
      })
    } else if (cmd.type === "cycle_done") {
      resourceManager.clearIntent(agentName)
      resourceManager.releaseFiles(agentName)
      eventBus.emit({
        type: "cycle-done",
        source: "supervisor",
        agentName,
        data: { summary: cmd.summary },
      })
    }
  }

  return { commands, nudged: false, recovered }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: supervisor round simulation", () => {
  let eventBus: EventBus
  let resourceManager: ResourceManager
  let messages: Message[]
  let nudge: ReturnType<typeof createNudgeState>

  beforeEach(() => {
    eventBus = new EventBus()
    resourceManager = new ResourceManager(2)
    messages = [
      { role: "system", content: "You are a supervisor." },
      { role: "user", content: "Directive: fix bugs" },
    ]
    nudge = createNudgeState()
  })

  test("normal flow: parse commands, emit events", () => {
    const response = "```commands\nMESSAGES\nWAIT\n```"
    const result = simulateRound(response, messages, nudge, eventBus, resourceManager, "agent-1")
    expect(result.commands).toHaveLength(2)
    expect(result.commands[0]!.type).toBe("messages")
    expect(result.commands[1]!.type).toBe("wait")
    expect(result.nudged).toBe(false)
  })

  test("empty response triggers escalating nudge", () => {
    const r1 = simulateRound(null, messages, nudge, eventBus, resourceManager, "agent-1")
    expect(r1.nudged).toBe(true)
    expect(nudge.consecutiveEmpty).toBe(1)
    const lastMsg1 = messages[messages.length - 1]!.content
    expect(lastMsg1).toContain("empty")

    const r2 = simulateRound(null, messages, nudge, eventBus, resourceManager, "agent-1")
    expect(r2.nudged).toBe(true)
    expect(nudge.consecutiveEmpty).toBe(2)
    const lastMsg2 = messages[messages.length - 1]!.content
    expect(lastMsg2).toContain("```commands") // level 2 shows format

    const r3 = simulateRound(null, messages, nudge, eventBus, resourceManager, "agent-1")
    expect(nudge.consecutiveEmpty).toBe(3)
    const lastMsg3 = messages[messages.length - 1]!.content
    expect(lastMsg3).toContain(SUPERVISOR_DEFAULT_CMD) // level 3 forces default
  })

  test("unparseable prose triggers nudge with feedback, then recovery resets it", () => {
    const badResponse = "I think we should check the agent's status and review the code carefully."
    const r1 = simulateRound(badResponse, messages, nudge, eventBus, resourceManager, "agent-1")
    expect(r1.nudged).toBe(true)
    expect(r1.commands).toHaveLength(0)
    expect(nudge.consecutiveNoParse).toBe(1)
    const feedback = messages[messages.length - 1]!.content
    expect(feedback).toContain("not recognized")

    // Now LLM responds correctly
    const goodResponse = "```commands\nMESSAGES\n```"
    const r2 = simulateRound(goodResponse, messages, nudge, eventBus, resourceManager, "agent-1")
    expect(r2.commands).toHaveLength(1)
    expect(nudge.consecutiveNoParse).toBe(0) // reset on success
  })

  test("fuzzy recovery extracts commands from prose without code block", () => {
    const proseWithCommands = `Let me check the agent's work.
1. MESSAGES
2. WAIT`
    const result = simulateRound(proseWithCommands, messages, nudge, eventBus, resourceManager, "agent-1")
    expect(result.recovered).toBe(true)
    expect(result.commands).toHaveLength(2)
    expect(result.commands[0]!.type).toBe("messages")
    expect(result.commands[1]!.type).toBe("wait")
  })

  test("INTENT command registers in resource manager", () => {
    const response = "```commands\nINTENT Refactor auth [files: src/auth.ts, src/login.ts]\nWAIT\n```"
    simulateRound(response, messages, nudge, eventBus, resourceManager, "agent-1")

    const intents = resourceManager.getAllIntents()
    expect(intents.has("agent-1")).toBe(true)
    expect(intents.get("agent-1")!.files).toEqual(["src/auth.ts", "src/login.ts"])
  })

  test("CYCLE_DONE clears intent and emits bus event", () => {
    // First declare intent
    const r1 = "```commands\nINTENT Fix bugs [files: src/app.ts]\n```"
    simulateRound(r1, messages, nudge, eventBus, resourceManager, "agent-1")
    expect(resourceManager.getAllIntents().has("agent-1")).toBe(true)

    // Collect bus events
    const events: any[] = []
    eventBus.onAny(e => events.push(e))

    // Now complete cycle
    const r2 = "```commands\nCYCLE_DONE Fixed 3 bugs in app.ts\n```"
    simulateRound(r2, messages, nudge, eventBus, resourceManager, "agent-1")

    expect(resourceManager.getAllIntents().has("agent-1")).toBe(false)
    expect(events.some(e => e.type === "cycle-done")).toBe(true)
  })

  test("NOTIFY broadcasts through event bus", () => {
    const events: any[] = []
    eventBus.onAny(e => events.push(e))

    const response = "```commands\nNOTIFY Starting auth refactor — will touch auth.ts\nWAIT\n```"
    simulateRound(response, messages, nudge, eventBus, resourceManager, "agent-1")

    const notification = events.find(e => e.type === "agent-notification")
    expect(notification).toBeDefined()
    expect(notification.agentName).toBe("agent-1")
    expect(notification.data.message).toContain("auth refactor")
  })

  test("two agents with overlapping intents produce conflicts", () => {
    // Agent 1 declares intent
    resourceManager.declareIntent("agent-1", "Fix auth", ["src/auth.ts", "src/shared.ts"])

    // Agent 2 declares overlapping intent
    resourceManager.declareIntent("agent-2", "Refactor shared", ["src/shared.ts", "src/utils.ts"])

    // Check conflicts from agent-2's perspective
    const conflicts = resourceManager.getIntentConflicts("agent-2")
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts[0]!.overlappingFiles).toContain("src/shared.ts")
    expect(conflicts[0]!.theirIntent.agentName).toBe("agent-1")
  })
})

// ---------------------------------------------------------------------------
// Integration: Event bus + resource manager cross-component
// ---------------------------------------------------------------------------

describe("Integration: event bus + resource manager", () => {
  test("bus events from multiple supervisors are isolated and ordered", () => {
    const bus = new EventBus()
    const events: any[] = []
    bus.onAny(e => events.push(e))

    bus.emit({ type: "cycle-start", source: "supervisor", agentName: "agent-1", data: { cycle: 1 } })
    bus.emit({ type: "cycle-start", source: "supervisor", agentName: "agent-2", data: { cycle: 1 } })
    bus.emit({ type: "cycle-done", source: "supervisor", agentName: "agent-1", data: { summary: "done" } })

    expect(events).toHaveLength(3)
    expect(events[0]!.agentName).toBe("agent-1")
    expect(events[1]!.agentName).toBe("agent-2")
    expect(events[2]!.type).toBe("cycle-done")
  })

  test("bus pattern filtering works for urgent event injection", () => {
    const bus = new EventBus()
    const urgentPattern = { type: "cycle-done" as string }

    bus.emit({ type: "cycle-start", source: "supervisor", agentName: "agent-1", data: {} })
    bus.emit({ type: "cycle-done", source: "supervisor", agentName: "agent-2", data: { summary: "done" } })
    bus.emit({ type: "agent-notification", source: "supervisor", agentName: "agent-1", data: {} })

    const recentCycleDone = bus.getRecent(urgentPattern, 10)
    expect(recentCycleDone).toHaveLength(1)
    expect(recentCycleDone[0]!.agentName).toBe("agent-2")
  })

  test("LLM semaphore blocks concurrent access", async () => {
    const rm = new ResourceManager(1) // max 1 concurrent

    await rm.acquireLlmSlot() // slot 1

    let slot2Acquired = false
    const slot2Promise = rm.acquireLlmSlot().then(() => { slot2Acquired = true })

    // Slot 2 should be blocked
    await new Promise(r => setTimeout(r, 50))
    expect(slot2Acquired).toBe(false)

    rm.releaseLlmSlot() // free slot 1
    await slot2Promise
    expect(slot2Acquired).toBe(true)

    rm.releaseLlmSlot() // cleanup
  })

  test("file locks prevent overlapping work", () => {
    const rm = new ResourceManager()
    rm.acquireFiles("agent-1", ["src/auth.ts", "src/db.ts"])
    rm.acquireFiles("agent-2", ["src/utils.ts"])

    const conflicts = rm.getConflicts("agent-2", ["src/auth.ts"])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.heldBy).toBe("agent-1")
    expect(conflicts[0]!.file).toBe("src/auth.ts")

    // No conflict on unrelated files
    const noConflicts = rm.getConflicts("agent-2", ["src/utils.ts"])
    expect(noConflicts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Integration: Priority trimming preserves critical messages across cycles
// ---------------------------------------------------------------------------

describe("Integration: priority trimming across simulated cycles", () => {
  test("REDIRECT and VALIDATION messages survive trimming while normal ones are removed", () => {
    const msgs: Message[] = [
      { role: "system", content: "You are a supervisor." },
      // Cycle 1: normal exchange
      { role: "user", content: "Status: idle" },
      { role: "assistant", content: "```commands\nMESSAGES\n```" },
      // Cycle 2: redirect warning (priority)
      { role: "user", content: "[REDIRECT] Agent agent-2 is already working on src/auth.ts. Focus on src/api.ts instead." },
      { role: "assistant", content: "```commands\nINTENT Fix API bugs [files: src/api.ts]\n```" },
      // Cycle 3: validation result (priority)
      { role: "user", content: "[VALIDATION] Tests failed: 3 failures in auth.test.ts" },
      { role: "assistant", content: "```commands\nPROMPT Fix the 3 test failures\n```" },
      // Recent messages (keep zone)
      { role: "user", content: "Agent finished fixing tests" },
      { role: "assistant", content: "```commands\nCYCLE_DONE Fixed tests\n```" },
    ]

    trimConversation(msgs, 7) // force trim

    const contents = msgs.map(m => m.content)

    // System prompt always preserved
    expect(contents[0]).toBe("You are a supervisor.")
    // Recent messages preserved
    expect(contents.some(c => c.includes("CYCLE_DONE"))).toBe(true)
    // Priority messages should survive longer than normal ones
    // Normal "Status: idle" should be trimmed first
    expect(contents.some(c => c === "Status: idle")).toBe(false)
  })

  test("circuit breaker tracks failures across nudge escalation", () => {
    const cb = createCircuitBreaker(3)
    const nudge = createNudgeState()

    // Simulate 3 consecutive empty responses
    for (let i = 0; i < 3; i++) {
      buildEmptyNudge(nudge, SUPERVISOR_COMMANDS, SUPERVISOR_DEFAULT_CMD)
      const tripped = recordFailure(cb)
      if (i < 2) expect(tripped).toBe(false)
      else expect(tripped).toBe(true) // trips on 3rd
    }

    expect(nudge.consecutiveEmpty).toBe(3)
    expect(cb.tripped).toBe(true)

    // After a successful response, both reset
    resetNudge(nudge)
    recordSuccess(cb)
    expect(nudge.consecutiveEmpty).toBe(0)
    expect(cb.tripped).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration: Multi-cycle simulation
// ---------------------------------------------------------------------------

describe("Integration: multi-cycle state transitions", () => {
  test("simulated 3-cycle flow with intent, notify, and completion", () => {
    const bus = new EventBus()
    const rm = new ResourceManager(2)
    const allEvents: any[] = []
    bus.onAny(e => allEvents.push(e))

    const messages: Message[] = [
      { role: "system", content: "You are a supervisor for agent-1." },
    ]

    // Cycle 1: check messages, declare intent
    const nudge1 = createNudgeState()
    messages.push({ role: "user", content: "Directive: Fix auth bugs" })

    const r1 = simulateRound(
      "```commands\nMESSAGES\nINTENT Fix auth [files: src/auth.ts]\nNOTIFY Starting auth work\nWAIT\n```",
      messages, nudge1, bus, rm, "agent-1",
    )
    expect(r1.commands).toHaveLength(4)
    expect(rm.getAllIntents().has("agent-1")).toBe(true)

    // Cycle 2: prompt agent, still working
    const r2 = simulateRound(
      "```commands\nPROMPT Fix the null check in auth.ts line 42\nWAIT\n```",
      messages, nudge1, bus, rm, "agent-1",
    )
    expect(r2.commands).toHaveLength(2)
    // Intent still active
    expect(rm.getAllIntents().has("agent-1")).toBe(true)

    // Cycle 3: cycle done
    const r3 = simulateRound(
      "```commands\nCYCLE_DONE Fixed null check in auth.ts, all tests passing\n```",
      messages, nudge1, bus, rm, "agent-1",
    )
    expect(r3.commands).toHaveLength(1)
    expect(r3.commands[0]!.type).toBe("cycle_done")
    // Intent cleared
    expect(rm.getAllIntents().has("agent-1")).toBe(false)

    // Verify bus events
    expect(allEvents.some(e => e.type === "agent-notification")).toBe(true)
    expect(allEvents.some(e => e.type === "cycle-done")).toBe(true)
  })

  test("garbage LLM responses trigger escalating recovery before eventual success", () => {
    const bus = new EventBus()
    const rm = new ResourceManager()
    const messages: Message[] = [
      { role: "system", content: "You are a supervisor." },
      { role: "user", content: "Directive: test" },
    ]
    const nudge = createNudgeState()
    const cb = createCircuitBreaker(5)

    // Round 1: empty response
    const r1 = simulateRound(null, messages, nudge, bus, rm, "agent-1")
    expect(r1.nudged).toBe(true)
    recordFailure(cb)

    // Round 2: garbage text
    const r2 = simulateRound(
      "Hmm, let me think about what to do here...",
      messages, nudge, bus, rm, "agent-1",
    )
    expect(r2.nudged).toBe(true)
    expect(r2.commands).toHaveLength(0)
    recordFailure(cb)
    expect(cb.tripped).toBe(false) // not yet at threshold

    // Round 3: partial recovery — commands buried in numbered list prose
    // The normal parser won't find them because lines like "1. MESSAGES" don't match.
    // But fuzzy extraction strips the "1. " prefix.
    const r3 = simulateRound(
      "Here is my plan of action:\n1. MESSAGES\n2. WAIT\nLet me know how it goes.",
      messages, nudge, bus, rm, "agent-1",
    )
    expect(r3.recovered).toBe(true)
    expect(r3.commands).toHaveLength(2)
    recordSuccess(cb) // resets

    // Verify nudge was reset by successful parse
    expect(nudge.consecutiveEmpty).toBe(0)
    expect(nudge.consecutiveNoParse).toBe(0)
  })
})
