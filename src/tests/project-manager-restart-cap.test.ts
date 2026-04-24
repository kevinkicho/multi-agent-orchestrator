/**
 * ProjectManager.handleSupervisorStop — auto-restart cap (§21).
 *
 * Covers the opt-in `maxSupervisorRestartAttempts` limit:
 *  - default (Infinity) schedules a timer on every failure;
 *  - finite cap schedules timers until the count is exceeded, then emits
 *    `supervisor-given-up` and stops rescheduling;
 *  - clean stop resets the count regardless of cap.
 */
import { describe, test, expect, afterEach } from "bun:test"
import { ProjectManager } from "../project-manager"
import { DashboardLog } from "../dashboard"
import { EventBus, type BusEvent } from "../event-bus"
import type { Orchestrator } from "../orchestrator"

function makeStubOrchestrator(): Orchestrator {
  const stub: unknown = {
    agents: new Map(),
    async prompt() {}, async promptAll() { return { succeeded: [], failed: [] } },
    async getMessages() { return [] }, async status() { return new Map() },
    async addAgent() {}, removeAgent() {}, async abortAgent() {},
    async restartAgent() { return "s" }, forceResetAgentStatus() {}, shutdown() {},
  }
  return stub as Orchestrator
}

/** Seed a fake project row so projectName lookups don't crash if any code
 *  reaches into `this.projects`. The auto-restart timer will check
 *  `this.processes.has(projectId)` before restarting, so without a spawned
 *  process it will no-op — exactly what we want in a unit test. */
function seedProject(pm: ProjectManager, projectId: string, name: string): void {
  const projects = (pm as unknown as { projects: Map<string, { name: string; status: string }> }).projects
  projects.set(projectId, { name, status: "running" })
}

function setupManager(maxAttempts: number | undefined): { pm: ProjectManager; bus: EventBus; events: BusEvent[]; timers: Map<string, ReturnType<typeof setTimeout>> } {
  const bus = new EventBus()
  const events: BusEvent[] = []
  bus.onAny(e => { events.push(e) })

  const limits = maxAttempts === undefined ? undefined : { maxSupervisorRestartAttempts: maxAttempts }
  const pm = new ProjectManager(
    makeStubOrchestrator(),
    new DashboardLog(),
    { ollamaUrl: "http://127.0.0.1:11434" },
    limits,
    bus,
  )

  const timers = (pm as unknown as { autoRestartTimers: Map<string, ReturnType<typeof setTimeout>> }).autoRestartTimers
  return { pm, bus, events, timers }
}

function clearTimers(timers: Map<string, ReturnType<typeof setTimeout>>): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}

describe("handleSupervisorStop — default (no cap)", () => {
  const { pm, events, timers } = setupManager(undefined)
  seedProject(pm, "p1", "proj-1")

  afterEach(() => { clearTimers(timers); events.length = 0 })

  test("schedules an auto-restart timer on each failure, never gives up", () => {
    for (let i = 0; i < 5; i++) {
      pm.handleSupervisorStop("p1", "proj-1", "agent-1", `failure ${i + 1}`, true, undefined)
      expect(timers.has("p1")).toBe(true)
      clearTimeout(timers.get("p1")!)
      timers.delete("p1")
    }
    expect(events.find(e => e.type === "supervisor-given-up")).toBeUndefined()
  })
})

describe("handleSupervisorStop — with cap", () => {
  test("stops rescheduling and emits supervisor-given-up after the cap", () => {
    const { pm, events, timers } = setupManager(2)
    seedProject(pm, "p2", "proj-2")

    // Attempt 1 — scheduled
    pm.handleSupervisorStop("p2", "proj-2", "agent-2", "fail 1", true, undefined)
    expect(timers.has("p2")).toBe(true)
    clearTimeout(timers.get("p2")!); timers.delete("p2")

    // Attempt 2 — scheduled (equal to cap, still within)
    pm.handleSupervisorStop("p2", "proj-2", "agent-2", "fail 2", true, undefined)
    expect(timers.has("p2")).toBe(true)
    clearTimeout(timers.get("p2")!); timers.delete("p2")

    // Attempt 3 — exceeds cap, should emit given-up and NOT schedule a timer
    pm.handleSupervisorStop("p2", "proj-2", "agent-2", "fail 3", true, undefined)
    expect(timers.has("p2")).toBe(false)

    const givenUp = events.find(e => e.type === "supervisor-given-up")
    expect(givenUp).toBeDefined()
    expect(givenUp?.agentName).toBe("agent-2")
    expect(givenUp?.projectId).toBe("p2")
    const data = givenUp?.data as { attempts: number; limit: number; summary: string }
    expect(data.attempts).toBe(3)
    expect(data.limit).toBe(2)
    expect(data.summary).toBe("fail 3")
  })

  test("clean stop resets the counter so the cap starts fresh", () => {
    const { pm, events, timers } = setupManager(2)
    seedProject(pm, "p3", "proj-3")

    pm.handleSupervisorStop("p3", "proj-3", "agent-3", "fail 1", true, undefined)
    pm.handleSupervisorStop("p3", "proj-3", "agent-3", "fail 2", true, undefined)
    clearTimers(timers)

    // Clean stop between failures
    pm.handleSupervisorStop("p3", "proj-3", "agent-3", "clean", false, undefined)

    // Now we should get two more timers before giving up again
    pm.handleSupervisorStop("p3", "proj-3", "agent-3", "fail 3", true, undefined)
    expect(timers.has("p3")).toBe(true)
    clearTimeout(timers.get("p3")!); timers.delete("p3")

    pm.handleSupervisorStop("p3", "proj-3", "agent-3", "fail 4", true, undefined)
    expect(timers.has("p3")).toBe(true)
    clearTimeout(timers.get("p3")!); timers.delete("p3")

    // Third post-reset failure exceeds the cap again
    pm.handleSupervisorStop("p3", "proj-3", "agent-3", "fail 5", true, undefined)
    expect(timers.has("p3")).toBe(false)
    expect(events.filter(e => e.type === "supervisor-given-up").length).toBe(1)
  })
})
