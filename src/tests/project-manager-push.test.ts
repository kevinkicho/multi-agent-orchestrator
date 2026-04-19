/**
 * pushAgentBranch — verifies the project manager can push a project's agent
 * branch to origin with GITHUB_TOKEN-based auth, and fails loudly when its
 * preconditions aren't met (no token, no origin, non-github origin).
 *
 * We sidestep real GitHub by using a local bare repo whose directory path
 * contains "github.com" as a literal substring — this satisfies the URL guard
 * without making a network call, and exercises the real `git push` codepath.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync } from "fs"
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

/** Directly inject a project into the manager's internal map so we can test
 *  pushAgentBranch without spinning up an opencode subprocess. */
function seedProject(pm: ProjectManager, id: string, directory: string, agentBranch: string): void {
  const map = (pm as unknown as { projects: Map<string, Mutable<{ id: string; name: string; directory: string; agentName: string; agentBranch: string; status: string }>> }).projects
  map.set(id, {
    id,
    name: "test",
    directory,
    agentName: "test-agent",
    agentBranch,
    status: "running",
  })
}

let workdir: string
let baredir: string
let testRoot: string
const originalToken = process.env.GITHUB_TOKEN
const originalCwd = process.cwd()

beforeAll(async () => {
  testRoot = mkdtempSync(resolve(tmpdir(), "pm-push-"))
  // ProjectManager.saveProjects() writes to `process.cwd()/orchestrator-projects.json`,
  // and this test exercises pushAgentBranch which emits a timeline event that
  // triggers that save. Chdir into the tmpdir so the write lands in throwaway
  // scratch space instead of polluting the repo root's real projects file.
  process.chdir(testRoot)
  // Bare repo path intentionally contains "github.com" so the URL guard passes.
  baredir = join(testRoot, "github.com-fake.git")
  mkdirSync(baredir, { recursive: true })
  await gitExec(baredir, "init", "--bare", "-b", "main")

  workdir = join(testRoot, "work")
  mkdirSync(workdir, { recursive: true })
  await gitExec(workdir, "init", "-b", "main")
  await gitExec(workdir, "config", "user.email", "test@example.com")
  await gitExec(workdir, "config", "user.name", "Test")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "init")
  await gitExec(workdir, "remote", "add", "origin", baredir)
  await gitExec(workdir, "checkout", "-b", "agent/test-agent")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "work")
})

afterAll(() => {
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalToken
  // Restore cwd before rmSync so we don't try to delete the directory we're in.
  process.chdir(originalCwd)
  rmSync(testRoot, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.GITHUB_TOKEN = "ghp_fake_for_test"
})

describe("pushAgentBranch", () => {
  test("throws when GITHUB_TOKEN is unset", async () => {
    delete process.env.GITHUB_TOKEN
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent")
    await expect(pm.pushAgentBranch("p1")).rejects.toThrow(/GITHUB_TOKEN/)
  })

  test("throws when the project has no agent branch", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "")
    await expect(pm.pushAgentBranch("p1")).rejects.toThrow(/No agent branch/)
  })

  test("throws when origin is not configured", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "pm-push-noorigin-"))
    await gitExec(root, "init", "-b", "main")
    await gitExec(root, "config", "user.email", "t@e.com")
    await gitExec(root, "config", "user.name", "T")
    await gitExec(root, "commit", "--allow-empty", "-m", "init")
    try {
      const pm = makeProjectManager()
      seedProject(pm, "p1", root, "agent/test-agent")
      await expect(pm.pushAgentBranch("p1")).rejects.toThrow(/No 'origin' remote/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("throws when origin is not a github.com URL", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "pm-push-gitlab-"))
    await gitExec(root, "init", "-b", "main")
    await gitExec(root, "config", "user.email", "t@e.com")
    await gitExec(root, "config", "user.name", "T")
    await gitExec(root, "commit", "--allow-empty", "-m", "init")
    await gitExec(root, "remote", "add", "origin", "https://gitlab.example.com/x/y.git")
    try {
      const pm = makeProjectManager()
      seedProject(pm, "p1", root, "agent/test-agent")
      await expect(pm.pushAgentBranch("p1")).rejects.toThrow(/not a GitHub URL/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("pushes the agent branch to origin on the happy path", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent")
    const result = await pm.pushAgentBranch("p1")
    expect(result.success).toBe(true)
    // Verify the bare now has the branch.
    const refs = await gitExec(baredir, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    expect(refs.split("\n")).toContain("agent/test-agent")
  })
})
