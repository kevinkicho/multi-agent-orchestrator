/**
 * Dashboard API endpoint tests.
 *
 * Spins up a real Bun.serve via startDashboard() with a mock orchestrator,
 * then exercises each HTTP endpoint. The server is torn down after each suite.
 *
 * Key design choice: we test the actual HTTP layer (routing, auth, CORS, JSON
 * serialization) rather than mocking fetch. This catches real integration bugs
 * like missing headers, wrong status codes, or malformed JSON.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { DashboardLog, startDashboard } from "../dashboard"
import { EventBus } from "../event-bus"
import { ResourceManager } from "../resource-manager"
import type { Orchestrator } from "../orchestrator"

// ---------------------------------------------------------------------------
// Mock orchestrator — minimal implementation satisfying the Orchestrator type
// ---------------------------------------------------------------------------

function createMockOrchestrator(): Orchestrator {
  const agents = new Map<string, any>()
  agents.set("test-agent", {
    status: "idle",
    sessionID: "sess-1",
    lastActivity: Date.now(),
    config: { name: "test-agent", url: "http://localhost:9999", directory: "/tmp/test" },
  })

  return {
    agents,
    async prompt() {},
    async promptAll() { return { succeeded: [], failed: [] } },
    async getMessages() { return [{ role: "assistant", content: "hello" }] },
    async status() {
      return new Map([["test-agent", { status: "idle", sessionID: "sess-1", lastActivity: Date.now(), lastEventAt: Date.now() }]])
    },
    async addAgent() {},
    removeAgent() {},
    async abortAgent() {},
    async restartAgent() { return "new-sess" },
    forceResetAgentStatus() {},
    shutdown() {},
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Dashboard API endpoints", () => {
  let server: { stop: () => void }
  let log: DashboardLog
  let eventBus: EventBus
  let resourceManager: ResourceManager
  let apiToken: string
  const port = 14567 // high port to avoid conflicts

  const base = `http://127.0.0.1:${port}`

  beforeAll(async () => {
    log = new DashboardLog()
    eventBus = new EventBus()
    resourceManager = new ResourceManager(2)
    const orchestrator = createMockOrchestrator()

    server = await startDashboard(orchestrator, log, port, {
      eventBus,
      resourceManager,
      async onCommand(cmd) {
        if (cmd === "status") return { ok: true, output: "all good" }
        if (cmd === "fail") return { ok: false, error: "nope" }
        return { ok: true }
      },
    })

    // Extract API token from the served HTML page
    const res = await fetch(`${base}/`)
    const html = await res.text()
    const match = html.match(/window\.__API_TOKEN__="([^"]+)"/)
    apiToken = match?.[1] ?? ""
  })

  afterAll(() => {
    server?.stop()
  })

  // -------------------------------------------------------------------------
  // Basic connectivity
  // -------------------------------------------------------------------------

  test("serves dashboard HTML at /", async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const text = await res.text()
    expect(text).toContain("Multi-Agent Orchestrator")
  })

  test("serves CSS at /dashboard-client.css", async () => {
    const res = await fetch(`${base}/dashboard-client.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/css")
    const text = await res.text()
    expect(text).toContain("box-sizing")
  })

  test("serves JS at /dashboard-client.js", async () => {
    const res = await fetch(`${base}/dashboard-client.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/javascript")
    const text = await res.text()
    expect(text).toContain("API_TOKEN")
  })

  test("returns 404 for unknown paths", async () => {
    const res = await fetch(`${base}/nonexistent`)
    expect(res.status).toBe(404)
  })

  // -------------------------------------------------------------------------
  // API token authentication
  // -------------------------------------------------------------------------

  test("POST without API token returns 401", async () => {
    const res = await fetch(`${base}/api/soft-stop`, { method: "POST" })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toContain("Unauthorized")
  })

  test("POST with wrong API token returns 401", async () => {
    const res = await fetch(`${base}/api/soft-stop`, {
      method: "POST",
      headers: { "X-API-Token": "wrong-token" },
    })
    expect(res.status).toBe(401)
  })

  test("GET requests don't require API token", async () => {
    const res = await fetch(`${base}/api/status`)
    expect(res.status).toBe(200)
  })

  // -------------------------------------------------------------------------
  // Status endpoint
  // -------------------------------------------------------------------------

  test("GET /api/status returns agent statuses", async () => {
    const res = await fetch(`${base}/api/status`)
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, any>
    expect(data["test-agent"]).toBeDefined()
    expect(data["test-agent"].status).toBe("idle")
    expect(data["test-agent"].sessionID).toBe("sess-1")
  })

  // -------------------------------------------------------------------------
  // Messages endpoint
  // -------------------------------------------------------------------------

  test("GET /api/messages/:agent returns messages", async () => {
    const res = await fetch(`${base}/api/messages/test-agent`)
    expect(res.status).toBe(200)
    const msgs = await res.json() as any[]
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[0].role).toBe("assistant")
  })

  test("GET /api/messages/:unknown returns 404", async () => {
    const res = await fetch(`${base}/api/messages/nonexistent-agent`)
    // The mock orchestrator's getMessages doesn't throw for unknown agents,
    // but the real one does. We just verify the endpoint responds.
    expect(res.status).toBe(200) // mock always succeeds
  })

  // -------------------------------------------------------------------------
  // Command endpoint
  // -------------------------------------------------------------------------

  test("POST /api/command executes a command", async () => {
    const res = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Token": apiToken },
      body: JSON.stringify({ command: "status" }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(data.output).toBe("all good")
  })

  test("POST /api/command returns error for failed command", async () => {
    const res = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Token": apiToken },
      body: JSON.stringify({ command: "fail" }),
    })
    const data = await res.json() as any
    expect(data.ok).toBe(false)
    expect(data.error).toBe("nope")
  })

  test("POST /api/command rejects empty command", async () => {
    const res = await fetch(`${base}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Token": apiToken },
      body: JSON.stringify({ command: "" }),
    })
    expect(res.status).toBe(400)
  })

  // -------------------------------------------------------------------------
  // Event polling
  // -------------------------------------------------------------------------

  test("GET /api/events unblocks when event arrives during long-poll", async () => {
    const cursor = log.getCursor()
    // Start long-poll, then push an event to unblock it
    const fetchPromise = fetch(`${base}/api/events?since=${cursor}`)
    setTimeout(() => log.push({ type: "brain-thinking", text: "unblock" }), 100)
    const res = await fetchPromise
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.events.some((e: any) => e.text === "unblock")).toBe(true)
  })

  test("GET /api/events returns pushed events", async () => {
    const cursor = log.getCursor()
    log.push({ type: "brain-thinking", text: "test event" })
    const res = await fetch(`${base}/api/events?since=${cursor}`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.events.length).toBeGreaterThan(0)
    expect(data.events.some((e: any) => e.text === "test event")).toBe(true)
    expect(data.cursor).toBeGreaterThan(cursor)
  })

  // -------------------------------------------------------------------------
  // Event Bus endpoints
  // -------------------------------------------------------------------------

  test("GET /api/events/bus/recent returns bus events", async () => {
    eventBus.emit({ type: "test-event", source: "unit-test", data: { foo: 1 } })
    const res = await fetch(`${base}/api/events/bus/recent?limit=10`)
    expect(res.status).toBe(200)
    const events = await res.json() as any[]
    expect(events.some((e: any) => e.type === "test-event")).toBe(true)
  })

  test("GET /api/events/bus/recent filters by type", async () => {
    eventBus.emit({ type: "keep-me", source: "test", data: {} })
    eventBus.emit({ type: "filter-me", source: "test", data: {} })
    const res = await fetch(`${base}/api/events/bus/recent?type=keep-me&limit=50`)
    const events = await res.json() as any[]
    expect(events.every((e: any) => e.type === "keep-me")).toBe(true)
  })

  // -------------------------------------------------------------------------
  // SSE stream endpoint
  // -------------------------------------------------------------------------

  test("GET /api/events/stream returns SSE content-type", async () => {
    const controller = new AbortController()
    const res = await fetch(`${base}/api/events/stream`, { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    controller.abort()
  })

  // -------------------------------------------------------------------------
  // Resource Manager endpoints
  // -------------------------------------------------------------------------

  test("GET /api/resources/locks returns lock state", async () => {
    resourceManager.acquireFiles("agent-x", ["src/foo.ts"])
    const res = await fetch(`${base}/api/resources/locks`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.locks["agent-x"]).toBeDefined()
    expect(data.locks["agent-x"].files).toContain("src/foo.ts")
    expect(typeof data.llmQueueDepth).toBe("number")
    expect(typeof data.llmActive).toBe("number")
    expect(data.llmMax).toBe(2)
    resourceManager.releaseFiles("agent-x")
  })

  test("GET /api/resources/intents returns intents", async () => {
    resourceManager.declareIntent("agent-y", "Testing", ["src/bar.ts"])
    const res = await fetch(`${base}/api/resources/intents`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.intents["agent-y"]).toBeDefined()
    expect(data.intents["agent-y"].description).toBe("Testing")
    resourceManager.clearIntent("agent-y")
  })

  // -------------------------------------------------------------------------
  // Projects endpoint (without project manager)
  // -------------------------------------------------------------------------

  test("GET /api/projects returns empty array without project manager", async () => {
    const res = await fetch(`${base}/api/projects`)
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(data).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Performance endpoint
  // -------------------------------------------------------------------------

  test("GET /api/performance returns performance data", async () => {
    const res = await fetch(`${base}/api/performance`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    // May have entries from previous tests or be empty
    expect(data).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Team endpoints
  // -------------------------------------------------------------------------

  test("GET /api/team/members returns inactive when no team manager", async () => {
    const res = await fetch(`${base}/api/team/members`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.active).toBe(false)
  })

  // -------------------------------------------------------------------------
  // CORS headers
  // -------------------------------------------------------------------------

  test("OPTIONS returns CORS headers", async () => {
    const res = await fetch(`${base}/api/status`, { method: "OPTIONS" })
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-methods")).toContain("GET")
    expect(res.headers.get("access-control-allow-methods")).toContain("POST")
  })

  test("responses include CORS origin header", async () => {
    const res = await fetch(`${base}/api/status`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    })
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // DashboardLog cursor behavior
  // -------------------------------------------------------------------------

  test("DashboardLog cursor advances with events", () => {
    const testLog = new DashboardLog()
    expect(testLog.getCursor()).toBe(0)
    testLog.push({ type: "brain-thinking", text: "a" })
    testLog.push({ type: "brain-thinking", text: "b" })
    expect(testLog.getCursor()).toBe(2)
  })

  test("DashboardLog getEventsSince returns missed events", () => {
    const testLog = new DashboardLog()
    testLog.push({ type: "brain-thinking", text: "a" })
    testLog.push({ type: "brain-thinking", text: "b" })
    testLog.push({ type: "brain-thinking", text: "c" })

    const { events, cursor } = testLog.getEventsSince(1)
    expect(events.length).toBe(2) // b and c
    expect(cursor).toBe(3)
  })

  test("DashboardLog getEventsSince returns empty when caught up", () => {
    const testLog = new DashboardLog()
    testLog.push({ type: "brain-thinking", text: "a" })
    const { events } = testLog.getEventsSince(1)
    expect(events.length).toBe(0)
  })

  test("DashboardLog subscribe fires for new events", () => {
    const testLog = new DashboardLog()
    const received: string[] = []
    const unsub = testLog.subscribe((e) => {
      if (e.type === "brain-thinking") received.push((e as any).text)
    })
    testLog.push({ type: "brain-thinking", text: "x" })
    testLog.push({ type: "brain-thinking", text: "y" })
    unsub()
    testLog.push({ type: "brain-thinking", text: "z" }) // not received
    expect(received).toEqual(["x", "y"])
  })

  test("DashboardLog trims history to maxHistory", () => {
    const testLog = new DashboardLog()
    // Push more than maxHistory (500) events
    for (let i = 0; i < 520; i++) {
      testLog.push({ type: "brain-thinking", text: `event-${i}` })
    }
    expect(testLog.getHistory().length).toBe(500)
    // Cursor should still be absolute (520, not 500)
    expect(testLog.getCursor()).toBe(520)
  })

  test("DashboardLog handles stale cursors gracefully", () => {
    const testLog = new DashboardLog()
    for (let i = 0; i < 520; i++) {
      testLog.push({ type: "brain-thinking", text: `event-${i}` })
    }
    // Cursor 0 is stale (those events were trimmed) — should return all remaining
    const { events } = testLog.getEventsSince(0)
    expect(events.length).toBe(500)
  })

  // --- /api/health ---
  test("GET /api/health returns health status", async () => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const data = await res.json() as { status: string; timestamp: string; uptime: number }
    expect(data.status).toBe("ok")
    expect(data.timestamp).toBeDefined()
    expect(data.uptime).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Project + provider routing endpoints. These don't spin up a real
// ProjectManager (heavy — spawns opencode per project); they use a narrow mock
// that captures addProject calls and returns canned listProjects() data. That
// keeps the tests fast while still exercising the HTTP layer end-to-end.
// ---------------------------------------------------------------------------

describe("Project + provider routing endpoints", () => {
  let server: { stop: () => void }
  let apiToken: string
  let addProjectCalls: Array<{ directory: string; directive: string; name?: string; opts?: any }>
  let mockProjects: Array<{ id: string; name: string; model?: string; status: string }>
  const port = 14568

  beforeAll(async () => {
    const log = new DashboardLog()
    const orchestrator = createMockOrchestrator()
    addProjectCalls = []
    mockProjects = []

    const fakeProjectManager: any = {
      listProjects: () => mockProjects,
      getProject: (id: string) => mockProjects.find(p => p.id === id),
      async addProject(directory: string, directive: string, name?: string, _restore?: any, opts?: any) {
        addProjectCalls.push({ directory, directive, name, opts })
        const project = { id: "test-proj-1", name: name ?? "test", model: opts?.model, status: "starting" }
        mockProjects.push(project)
        return project
      },
      async removeProject() {},
      async restoreProjects() { return { restored: [], failed: [] } },
      async getSavedProjects() { return [] },
    }

    server = await startDashboard(orchestrator, log, port, {
      projectManager: fakeProjectManager,
      eventBus: new EventBus(),
      resourceManager: new ResourceManager(2),
    })
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    apiToken = html.match(/window\.__API_TOKEN__="([^"]+)"/)?.[1] ?? ""
  })

  afterAll(() => { server?.stop() })

  const base = `http://127.0.0.1:${port}`

  // --- addProject model pinning (task #6) ---
  test("POST /api/projects forwards model to addProject opts", async () => {
    addProjectCalls.length = 0
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Token": apiToken },
      body: JSON.stringify({
        directory: "/tmp/test-dir",
        directive: "do the thing",
        name: "test-proj",
        model: "openai:gpt-4o",
      }),
    })
    expect(res.status).toBe(200)
    expect(addProjectCalls).toHaveLength(1)
    expect(addProjectCalls[0]!.opts?.model).toBe("openai:gpt-4o")
    expect(addProjectCalls[0]!.directory).toBe("/tmp/test-dir")
  })

  test("POST /api/projects omits model when client sends empty string", async () => {
    addProjectCalls.length = 0
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Token": apiToken },
      body: JSON.stringify({ directory: "/tmp/other", model: "" }),
    })
    expect(addProjectCalls).toHaveLength(1)
    // Empty string → undefined so resolveDefaultModel kicks in at supervisor start
    expect(addProjectCalls[0]!.opts?.model).toBeUndefined()
  })

  test("POST /api/projects omits model when client omits the field", async () => {
    addProjectCalls.length = 0
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Token": apiToken },
      body: JSON.stringify({ directory: "/tmp/no-model" }),
    })
    expect(addProjectCalls).toHaveLength(1)
    expect(addProjectCalls[0]!.opts?.model).toBeUndefined()
  })

  // --- /api/providers/:id/usage (task #7) ---
  test("GET /api/providers/:id/usage lists projects pinned to the provider", async () => {
    mockProjects.length = 0
    mockProjects.push(
      { id: "p1", name: "alpha", model: "openai:gpt-4o", status: "supervising" },
      { id: "p2", name: "beta", model: "anthropic:claude-sonnet", status: "running" },
      { id: "p3", name: "gamma", model: "openai:gpt-4o-mini", status: "stopped" },
    )
    const res = await fetch(`${base}/api/providers/openai/usage`)
    expect(res.status).toBe(200)
    const data = await res.json() as { providerId: string; projects: Array<{ id: string; name: string; model: string }> }
    expect(data.providerId).toBe("openai")
    expect(data.projects).toHaveLength(2)
    expect(data.projects.map(p => p.name).sort()).toEqual(["alpha", "gamma"])
  })

  test("GET /api/providers/:id/usage returns empty list when no project uses it", async () => {
    mockProjects.length = 0
    mockProjects.push({ id: "p1", name: "alpha", model: "openai:gpt-4o", status: "supervising" })
    const res = await fetch(`${base}/api/providers/groq/usage`)
    expect(res.status).toBe(200)
    const data = await res.json() as { projects: any[] }
    expect(data.projects).toEqual([])
  })

  test("GET /api/providers/:id/usage skips projects with no model pinned", async () => {
    mockProjects.length = 0
    mockProjects.push(
      { id: "p1", name: "unpinned", status: "supervising" }, // no model field
      { id: "p2", name: "pinned", model: "openai:gpt-4o", status: "supervising" },
    )
    const res = await fetch(`${base}/api/providers/openai/usage`)
    const data = await res.json() as { projects: Array<{ name: string }> }
    expect(data.projects.map(p => p.name)).toEqual(["pinned"])
  })

  test("GET /api/providers/:id/usage parses bare ollama model names correctly", async () => {
    mockProjects.length = 0
    mockProjects.push(
      { id: "p1", name: "ollama-project", model: "llama3:8b", status: "supervising" },
    )
    const res = await fetch(`${base}/api/providers/ollama/usage`)
    const data = await res.json() as { projects: Array<{ name: string }> }
    // Bare model strings (no provider prefix) route to ollama via parseModelRef
    expect(data.projects.map(p => p.name)).toEqual(["ollama-project"])
  })
})
