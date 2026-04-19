/**
 * Timeline — exercises the persistent log of git/PR transactions that powers
 * the History drawer. Each write path (setBaseBranch, merge, etc.) must stamp
 * exactly one event so the user sees the project's git lifecycle chronologically
 * without duplicates.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve, join } from "path"
import { ProjectManager } from "../project-manager"
import { DashboardLog } from "../dashboard"
import { gitExec } from "../git-utils"
import type { Orchestrator } from "../orchestrator"

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function makeProjectManager(): ProjectManager {
  const orchestrator: unknown = {
    agents: new Map(),
    async prompt() {}, async promptAll() { return { succeeded: [], failed: [] } },
    async getMessages() { return [] }, async status() { return new Map() },
    async addAgent() {}, removeAgent() {}, async abortAgent() {},
    async restartAgent() { return "s" }, forceResetAgentStatus() {}, shutdown() {},
  }
  const log = new DashboardLog()
  return new ProjectManager(orchestrator as Orchestrator, log, { ollamaUrl: "http://127.0.0.1:11434" })
}

function seedProject(pm: ProjectManager, id: string, directory: string, agentBranch: string, baseBranch: string): void {
  const map = (pm as unknown as { projects: Map<string, Mutable<{
    id: string; name: string; directory: string; agentName: string; agentBranch: string; baseBranch: string;
    status: string; directive: string; directiveHistory: unknown[]; pendingComments: string[]; workerPort: number; addedAt: number
  }>> }).projects
  map.set(id, {
    id, name: "test", directory,
    agentName: "test-agent",
    agentBranch, baseBranch,
    status: "running",
    directive: "",
    directiveHistory: [],
    pendingComments: [],
    workerPort: 0,
    addedAt: Date.now(),
  })
}

let workdir: string
let root: string

beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(), "pm-timeline-"))
  workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  await gitExec(workdir, "init", "-b", "main")
  await gitExec(workdir, "config", "user.email", "t@e.com")
  await gitExec(workdir, "config", "user.name", "T")
  writeFileSync(join(workdir, "a.txt"), "1\n")
  await gitExec(workdir, "add", "a.txt")
  await gitExec(workdir, "commit", "-m", "init")
  await gitExec(workdir, "checkout", "-b", "agent/test-agent")
  writeFileSync(join(workdir, "a.txt"), "2\n")
  await gitExec(workdir, "add", "a.txt")
  await gitExec(workdir, "commit", "-m", "agent-1")
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("project timeline", () => {
  test("starts empty for a fresh project", () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    expect(pm.getTimeline("p1")).toEqual([])
  })

  test("throws for unknown project id (matches other accessors)", () => {
    const pm = makeProjectManager()
    expect(() => pm.getTimeline("nope")).toThrow(/Unknown project/)
  })

  test("setBaseBranch stamps exactly one 'base-branch-changed' event per change", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    await pm.setBaseBranch("p1", "develop")
    const events = pm.getTimeline("p1")
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe("base-branch-changed")
    expect(events[0]!.summary).toContain("main")
    expect(events[0]!.summary).toContain("develop")
  })

  test("setBaseBranch no-op (same base) does NOT stamp an event — avoids timeline spam", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    await pm.setBaseBranch("p1", "main") // unchanged
    expect(pm.getTimeline("p1")).toEqual([])
  })

  test("mergeAgentBranch stamps 'branch-merged' on success", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const result = await pm.mergeAgentBranch("p1")
    expect(result.success).toBe(true)
    const events = pm.getTimeline("p1")
    const kinds = events.map(e => e.kind)
    expect(kinds).toContain("branch-merged")
  })

  test("getTimeline returns a defensive copy — mutating it doesn't corrupt internal state", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    await pm.setBaseBranch("p1", "develop")
    const snapshot = pm.getTimeline("p1")
    snapshot.length = 0
    expect(pm.getTimeline("p1")).toHaveLength(1)
  })

  test("timeline accepts a restored seed via AddProjectOptions.timeline (restoreProjects path)", () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    // Directly inject a seeded timeline the way restoreProjects would.
    const map = (pm as unknown as { projects: Map<string, { timeline?: unknown[] }> }).projects
    const p = map.get("p1")!
    p.timeline = [{ timestamp: 1, kind: "cloned", summary: "seed" }]
    expect(pm.getTimeline("p1")).toEqual([{ timestamp: 1, kind: "cloned", summary: "seed" }])
  })
})
