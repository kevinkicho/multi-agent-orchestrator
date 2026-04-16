import { describe, test, expect } from "bun:test"
import { formatCrashReport, type SessionState, type SupervisorCheckpoint } from "../session-state"

// We test the pure functions from session-state.
// detectCrash, initSessionState, etc. require file I/O and process checks,
// so we test formatCrashReport which is the pure formatting function.

describe("formatCrashReport", () => {
  test("formats basic crash state", () => {
    const state: SessionState = {
      pid: 12345,
      startedAt: Date.now() - 3600_000, // 1 hour ago
      lastHeartbeat: Date.now() - 300_000, // 5 min ago
      dashboardPort: 4000,
      mode: "projects",
      supervisors: {},
      cleanShutdown: false,
    }
    const report = formatCrashReport(state)
    expect(report).toContain("PID 12345")
    expect(report).toContain("did not shut down cleanly")
    expect(report).toContain("projects")
    expect(report).toContain("4000")
  })

  test("includes supervisor details", () => {
    const state: SessionState = {
      pid: 99999,
      startedAt: Date.now() - 60_000,
      lastHeartbeat: Date.now() - 10_000,
      dashboardPort: 4000,
      mode: "teams",
      supervisors: {
        "agent-1": {
          agentName: "agent-1",
          cycleNumber: 3,
          lastSummary: "Fixed 2 bugs in auth module",
          directive: "Fix authentication",
          status: "running",
          updatedAt: Date.now() - 15_000,
        },
        "agent-2": {
          agentName: "agent-2",
          cycleNumber: 1,
          lastSummary: "",
          directive: "Write tests",
          status: "idle",
          updatedAt: Date.now() - 60_000,
        },
      },
      cleanShutdown: false,
    }
    const report = formatCrashReport(state)
    expect(report).toContain("agent-1")
    expect(report).toContain("cycle #3")
    expect(report).toContain("running")
    expect(report).toContain("Fixed 2 bugs")
    expect(report).toContain("agent-2")
    expect(report).toContain("idle")
  })

  test("truncates long summaries", () => {
    const longSummary = "A".repeat(200)
    const state: SessionState = {
      pid: 1,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      dashboardPort: 4000,
      mode: "projects",
      supervisors: {
        "agent-1": {
          agentName: "agent-1",
          cycleNumber: 1,
          lastSummary: longSummary,
          directive: "test",
          status: "running",
          updatedAt: Date.now(),
        },
      },
      cleanShutdown: false,
    }
    const report = formatCrashReport(state)
    expect(report).toContain("...")
    // Should not contain the full 200 chars
    expect(report.length).toBeLessThan(longSummary.length + 200)
  })

  test("handles state with no supervisors", () => {
    const state: SessionState = {
      pid: 1,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      dashboardPort: 4000,
      mode: "projects",
      supervisors: {},
      cleanShutdown: false,
    }
    const report = formatCrashReport(state)
    expect(report).not.toContain("Supervisors at time of crash")
  })
})
