/**
 * mergeAgentBranch — exercises the safety guards that sit in front of the
 * actual `git merge`. These matter because a mis-fired merge can corrupt the
 * supervisor's working tree or silently drop uncommitted worker edits.
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
  root = mkdtempSync(resolve(tmpdir(), "pm-merge-"))
  workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  await gitExec(workdir, "init", "-b", "main")
  await gitExec(workdir, "config", "user.email", "test@example.com")
  await gitExec(workdir, "config", "user.name", "Test")
  writeFileSync(join(workdir, "file.txt"), "initial\n")
  await gitExec(workdir, "add", "file.txt")
  await gitExec(workdir, "commit", "-m", "init-main")
  await gitExec(workdir, "checkout", "-b", "agent/test-agent")
  writeFileSync(join(workdir, "file.txt"), "agent work\n")
  await gitExec(workdir, "add", "file.txt")
  await gitExec(workdir, "commit", "-m", "agent-1")
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("mergeAgentBranch dirty-tree guard", () => {
  test("refuses when there are unstaged changes and does not touch the working tree", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    // Introduce an unstaged change — simulating the worker mid-edit.
    writeFileSync(join(workdir, "file.txt"), "worker in progress — NOT committed\n")
    try {
      await expect(pm.mergeAgentBranch("p1")).rejects.toThrow(/uncommitted changes/i)
      // The unstaged change must still be present after the guard fires —
      // proves we refused BEFORE any checkout, not after a clobber.
      const status = await gitExec(workdir, "status", "--porcelain")
      expect(status).toContain("file.txt")
    } finally {
      // Clean up so other tests don't see the dirty tree.
      await gitExec(workdir, "checkout", "--", "file.txt")
    }
  })

  test("refuses when there are untracked files (they can collide with checkout)", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const untracked = join(workdir, "scratch.tmp")
    writeFileSync(untracked, "just a scratch file\n")
    try {
      await expect(pm.mergeAgentBranch("p1")).rejects.toThrow(/uncommitted changes/i)
    } finally {
      rmSync(untracked, { force: true })
    }
  })

  test("refuses when supervisor is actively supervising (separate guard)", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const map = (pm as unknown as { projects: Map<string, Mutable<{ status: string }>> }).projects
    map.get("p1")!.status = "supervising"
    await expect(pm.mergeAgentBranch("p1")).rejects.toThrow(/supervisor is actively running/)
  })
})

describe("mergeAgentBranch crash-resilience", () => {
  test("leaves the working tree on the agent branch on the happy path", async () => {
    // This pins the try/finally guarantee: after merge returns, the repo HEAD
    // is back on agent/test-agent — not stuck on the merge target. If this
    // regresses, the worker's next commit would land on main.
    const subRoot = mkdtempSync(resolve(tmpdir(), "pm-merge-ff-"))
    try {
      const wd = join(subRoot, "w")
      mkdirSync(wd, { recursive: true })
      await gitExec(wd, "init", "-b", "main")
      await gitExec(wd, "config", "user.email", "t@e.com")
      await gitExec(wd, "config", "user.name", "T")
      writeFileSync(join(wd, "a.txt"), "a\n")
      await gitExec(wd, "add", "a.txt")
      await gitExec(wd, "commit", "-m", "init")
      await gitExec(wd, "checkout", "-b", "agent/ff-agent")
      writeFileSync(join(wd, "a.txt"), "b\n")
      await gitExec(wd, "add", "a.txt")
      await gitExec(wd, "commit", "-m", "edit")

      const pm = makeProjectManager()
      seedProject(pm, "p1", wd, "agent/ff-agent", "main")
      const res = await pm.mergeAgentBranch("p1", "main")
      expect(res.success).toBe(true)

      const head = (await gitExec(wd, "rev-parse", "--abbrev-ref", "HEAD")).trim()
      expect(head).toBe("agent/ff-agent")
    } finally {
      rmSync(subRoot, { recursive: true, force: true })
    }
  })

  test("returns the working tree to the agent branch after a conflict (finally branch)", async () => {
    // Set up divergent edits on main + agent so `git merge` generates a real
    // conflict. gitMerge aborts the merge internally, and the finally block
    // must still switch HEAD back to agent/c-agent.
    const subRoot = mkdtempSync(resolve(tmpdir(), "pm-merge-conflict-"))
    try {
      const wd = join(subRoot, "w")
      mkdirSync(wd, { recursive: true })
      await gitExec(wd, "init", "-b", "main")
      await gitExec(wd, "config", "user.email", "t@e.com")
      await gitExec(wd, "config", "user.name", "T")
      writeFileSync(join(wd, "a.txt"), "base\n")
      await gitExec(wd, "add", "a.txt")
      await gitExec(wd, "commit", "-m", "init")
      await gitExec(wd, "checkout", "-b", "agent/c-agent")
      writeFileSync(join(wd, "a.txt"), "agent-side\n")
      await gitExec(wd, "add", "a.txt")
      await gitExec(wd, "commit", "-m", "agent-edit")
      await gitExec(wd, "checkout", "main")
      writeFileSync(join(wd, "a.txt"), "main-side\n")
      await gitExec(wd, "add", "a.txt")
      await gitExec(wd, "commit", "-m", "main-edit")
      await gitExec(wd, "checkout", "agent/c-agent")

      const pm = makeProjectManager()
      seedProject(pm, "p1", wd, "agent/c-agent", "main")
      const res = await pm.mergeAgentBranch("p1", "main")
      expect(res.success).toBe(false) // conflict — gitMerge aborts internally
      // Critical invariant: HEAD returned to the agent branch.
      const head = (await gitExec(wd, "rev-parse", "--abbrev-ref", "HEAD")).trim()
      expect(head).toBe("agent/c-agent")
    } finally {
      rmSync(subRoot, { recursive: true, force: true })
    }
  })
})
