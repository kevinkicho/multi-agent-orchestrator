/**
 * Model propagation — the dashboard's per-project model picker must reach the
 * worker's opencode session, not just the supervisor's planning LLM. Without
 * propagation the dropdown silently affects only half the system: supervisor
 * restarts with the new model, but the worker keeps using whatever opencode
 * baked in at serve-spawn time.
 */

import { describe, test, expect } from "bun:test"
import type { AgentState } from "../agent"
import { ProjectManager } from "../project-manager"
import { DashboardLog } from "../dashboard"
import type { Orchestrator } from "../orchestrator"

function makeOrchestrator() {
  const agents = new Map<string, AgentState>()
  return {
    agents,
    async prompt() {}, async promptAll() { return { succeeded: [], failed: [] } },
    async getMessages() { return [] }, async status() { return new Map() },
    async addAgent() {}, removeAgent() {}, async abortAgent() {},
    async restartAgent() { return "s" }, forceResetAgentStatus() {}, shutdown() {},
  } as unknown as Orchestrator
}

function seedAgent(orch: Orchestrator, name: string, initialModel?: { providerID: string; modelID: string }) {
  const agent: AgentState = {
    config: { name, url: "http://127.0.0.1:0", directory: "/tmp", model: initialModel },
    client: {} as AgentState["client"],
    sessionID: null,
    status: "idle",
    lastError: null,
    lastActivity: Date.now(),
    busyStartTime: null,
    lastEventAt: Date.now(),
  }
  orch.agents.set(name, agent)
  return agent
}

function seedProject(pm: ProjectManager, id: string, agentName: string, model?: string, supervisorModel?: string) {
  const map = (pm as unknown as { projects: Map<string, {
    id: string; name: string; directory: string; agentName: string; agentBranch: string; baseBranch: string;
    status: string; directive: string; directiveHistory: unknown[]; pendingComments: string[]; workerPort: number; addedAt: number;
    model?: string;
    supervisorModel?: string;
  }> }).projects
  map.set(id, {
    id, name: "test", directory: "/tmp",
    agentName,
    agentBranch: "agent/test", baseBranch: "main",
    status: "running",
    directive: "",
    directiveHistory: [],
    pendingComments: [],
    workerPort: 0,
    addedAt: Date.now(),
    model,
    supervisorModel,
  })
}

describe("updateModel propagates the new model to the worker", () => {
  test("mutates the live agent's config.model so the next prompt uses the new model", () => {
    const orch = makeOrchestrator()
    const agent = seedAgent(orch, "worker-1", { providerID: "opencode-go", modelID: "qwen3.6-plus" })
    const pm = new ProjectManager(orch, new DashboardLog(), { ollamaUrl: "http://127.0.0.1:11434" })
    seedProject(pm, "p1", "worker-1", "opencode-go:qwen3.6-plus")

    pm.updateModel("p1", "opencode-go:glm-5.1")

    expect(agent.config.model).toEqual({ providerID: "opencode-go", modelID: "glm-5.1" })
  })

  test("no-ops gracefully when the agent hasn't connected yet (project exists, no agent in map)", () => {
    const orch = makeOrchestrator()
    const pm = new ProjectManager(orch, new DashboardLog(), { ollamaUrl: "http://127.0.0.1:11434" })
    seedProject(pm, "p1", "worker-missing", "opencode-go:qwen3.6-plus")

    expect(() => pm.updateModel("p1", "opencode-go:glm-5.1")).not.toThrow()
  })

  test("throws when the project id is unknown — matches other accessors", () => {
    const pm = new ProjectManager(makeOrchestrator(), new DashboardLog(), { ollamaUrl: "http://127.0.0.1:11434" })
    expect(() => pm.updateModel("nope", "opencode-go:glm-5.1")).toThrow(/Unknown project/)
  })
})

describe("updateSupervisorModel — supervisor-only override", () => {
  test("sets project.supervisorModel and does NOT touch the worker agent.config.model", () => {
    const orch = makeOrchestrator()
    const workerModel = { providerID: "opencode-go", modelID: "qwen3.6-plus" }
    const agent = seedAgent(orch, "worker-1", workerModel)
    const pm = new ProjectManager(orch, new DashboardLog(), { ollamaUrl: "http://127.0.0.1:11434" })
    seedProject(pm, "p1", "worker-1", "opencode-go:qwen3.6-plus")

    pm.updateSupervisorModel("p1", "opencode-go:glm-5.1")

    const project = (pm as unknown as { projects: Map<string, { supervisorModel?: string }> }).projects.get("p1")!
    expect(project.supervisorModel).toBe("opencode-go:glm-5.1")
    expect(agent.config.model).toEqual(workerModel)
  })

  test("empty or undefined clears the override", () => {
    const pm = new ProjectManager(makeOrchestrator(), new DashboardLog(), { ollamaUrl: "http://127.0.0.1:11434" })
    seedProject(pm, "p1", "worker-1", "opencode-go:qwen3.6-plus", "opencode-go:glm-5.1")

    pm.updateSupervisorModel("p1", "")

    const project = (pm as unknown as { projects: Map<string, { supervisorModel?: string }> }).projects.get("p1")!
    expect(project.supervisorModel).toBeUndefined()
  })

  test("throws when the project id is unknown", () => {
    const pm = new ProjectManager(makeOrchestrator(), new DashboardLog(), { ollamaUrl: "http://127.0.0.1:11434" })
    expect(() => pm.updateSupervisorModel("nope", "opencode-go:glm-5.1")).toThrow(/Unknown project/)
  })
})
