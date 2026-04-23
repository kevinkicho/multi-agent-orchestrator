/**
 * Tests for dashboard §13 — graceful shutdown with SSE drain.
 *
 * Verifies:
 *  - gracefulStop broadcasts a `dashboard-shutdown` frame to every active
 *    SSE subscriber before closing the server.
 *  - The server accepts the `drainMs` budget and returns within it.
 *  - After gracefulStop resolves, the port is released (a new server can
 *    bind to it immediately).
 *
 * We don't cover "in-flight HTTP request completes during drain" here — Bun's
 * server.stop(false) already handles that, and asserting it portably is awkward
 * without a long-running endpoint. Integration tests against a real long-poll
 * would be the right place for that.
 */
import { describe, test, expect } from "bun:test"
import { DashboardLog, startDashboard } from "../dashboard"
import { EventBus } from "../event-bus"
import type { Orchestrator } from "../orchestrator"

function makeOrch(): Orchestrator {
  const stub: unknown = {
    agents: new Map(),
    async prompt() {},
    async promptAll() { return { succeeded: [], failed: [] } },
    async getMessages() { return [] },
    async status() { return new Map() },
    async addAgent() {}, removeAgent() {}, async abortAgent() {},
    async restartAgent() { return "s" }, forceResetAgentStatus() {}, shutdown() {},
  }
  return stub as Orchestrator
}

describe("gracefulStop", () => {
  test("broadcasts dashboard-shutdown to SSE subscribers and releases the port", async () => {
    const port = 14589
    const log = new DashboardLog()
    const bus = new EventBus()
    // Pre-seed an event so the SSE handler's initial-batch write flushes the
    // response headers immediately — without this, Bun's fetch may not
    // resolve until the stream produces its first byte.
    bus.emit({ type: "test-warmup", source: "test", data: {} })
    const server = await startDashboard(makeOrch(), log, port, { eventBus: bus })

    // Open one SSE connection and collect frames. We use an AbortController
    // so the client-side fetch can be cancelled after the assertions —
    // Bun's response body reader otherwise stays in a resolved-but-unread
    // state after the server closes its controller, which hangs the test.
    const ac = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/events/stream`, { signal: ac.signal })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    const frames: string[] = []
    const readTask = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) frames.push(decoder.decode(value, { stream: true }))
        }
      } catch {
        // Expected: stream ends when server closes the controller, or the
        // fetch is aborted after the assertions.
      }
    })()

    // Give the subscriber a tick to register with sseSubscribers
    await new Promise(r => setTimeout(r, 100))

    const start = Date.now()
    await server.gracefulStop({ drainMs: 500 })
    const elapsed = Date.now() - start

    // Give the reader one more tick to ingest the final buffered frame.
    await new Promise(r => setTimeout(r, 100))
    ac.abort() // release the body reader if still waiting
    await Promise.race([readTask, new Promise(r => setTimeout(r, 500))])

    // drainMs ceiling honored (allow some slack for flush + stop)
    expect(elapsed).toBeLessThan(2000)

    // Farewell frame should be in the payload
    const joined = frames.join("")
    expect(joined).toContain("dashboard-shutdown")

    // Port should be immediately rebindable — prove by starting a second
    // dashboard on the same port. If gracefulStop didn't fully release,
    // this throws from checkPortAvailable().
    const second = await startDashboard(makeOrch(), new DashboardLog(), port, { eventBus: new EventBus() })
    second.stop()
  })

  test("drainMs=0 still completes without hanging", async () => {
    const port = 14590
    const server = await startDashboard(makeOrch(), new DashboardLog(), port, { eventBus: new EventBus() })
    const start = Date.now()
    await server.gracefulStop({ drainMs: 0 })
    expect(Date.now() - start).toBeLessThan(500)
  })

  test("gracefulStop is safe to call with no active SSE subscribers", async () => {
    const port = 14591
    const server = await startDashboard(makeOrch(), new DashboardLog(), port, { eventBus: new EventBus() })
    await expect(server.gracefulStop({ drainMs: 100 })).resolves.toBeUndefined()
  })
})
