/**
 * getGitInfo / setBaseBranch / deleteRemoteBranch — these back the new
 * "Git/GitHub" drawer tab. Tests use a local bare repo (path contains
 * "github.com" so the URL guard passes) and clear GITHUB_TOKEN so the
 * PR-lookup path short-circuits without hitting api.github.com.
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

function seedProject(pm: ProjectManager, id: string, directory: string, agentBranch: string, baseBranch: string): void {
  const map = (pm as unknown as { projects: Map<string, Mutable<{ id: string; name: string; directory: string; agentName: string; agentBranch: string; baseBranch: string; status: string; directive: string; directiveHistory: unknown[]; pendingComments: string[]; workerPort: number; addedAt: number }>> }).projects
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
let baredir: string
let root: string
const originalToken = process.env.GITHUB_TOKEN
const originalCwd = process.cwd()

beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(), "pm-gitinfo-"))
  // Isolate cwd so ProjectManager.saveProjects() writes into the tmpdir
  // instead of polluting the repo root's orchestrator-projects.json.
  process.chdir(root)
  baredir = join(root, "github.com-fake.git")
  mkdirSync(baredir, { recursive: true })
  await gitExec(baredir, "init", "--bare", "-b", "main")

  workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  await gitExec(workdir, "init", "-b", "main")
  await gitExec(workdir, "config", "user.email", "test@example.com")
  await gitExec(workdir, "config", "user.name", "Test")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "init-main")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "main-2")
  await gitExec(workdir, "remote", "add", "origin", baredir)
  await gitExec(workdir, "checkout", "-b", "agent/test-agent")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "agent-1")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "agent-2")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "agent-3")
  // Advance main by 2 commits so "behind" > 0
  await gitExec(workdir, "checkout", "main")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "main-3")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "main-4")
  await gitExec(workdir, "checkout", "agent/test-agent")
})

afterAll(() => {
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalToken
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  // Clear token so getGitInfo doesn't try to reach api.github.com from tests.
  delete process.env.GITHUB_TOKEN
})

describe("getGitInfo", () => {
  test("returns fully populated snapshot for a repo with origin and agent branch", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const info = await pm.getGitInfo("p1")
    expect(info.originUrl).toBe(baredir)
    // Local bare path with "github.com" in it still parses — we test the pattern, not the host.
    expect(info.agentBranch).toBe("agent/test-agent")
    expect(info.baseBranch).toBe("main")
    expect(info.tokenDetected).toBe(false)
    expect(info.openPullRequest).toBeNull()
    // agent branched off main@commit-2, then advanced 3 commits; main then advanced 2 past the split point.
    expect(info.commitsAhead).toBe(3)
    expect(info.commitsBehind).toBe(2)
  })

  test("handles repos with no origin configured", async () => {
    const noOrigin = mkdtempSync(resolve(tmpdir(), "pm-gitinfo-noorigin-"))
    await gitExec(noOrigin, "init", "-b", "main")
    await gitExec(noOrigin, "config", "user.email", "t@e.com")
    await gitExec(noOrigin, "config", "user.name", "T")
    await gitExec(noOrigin, "commit", "--allow-empty", "-m", "init")
    try {
      const pm = makeProjectManager()
      seedProject(pm, "p1", noOrigin, "agent/test-agent", "main")
      const info = await pm.getGitInfo("p1")
      expect(info.originUrl).toBeNull()
      expect(info.githubOwner).toBeNull()
      expect(info.githubRepo).toBeNull()
    } finally {
      rmSync(noOrigin, { recursive: true, force: true })
    }
  })

  test("reports tokenDetected=true when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_fake"
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const info = await pm.getGitInfo("p1")
    expect(info.tokenDetected).toBe(true)
  })

  test("throws for unknown project id", async () => {
    const pm = makeProjectManager()
    await expect(pm.getGitInfo("nope")).rejects.toThrow(/Unknown project/)
  })
})

describe("setBaseBranch", () => {
  test("updates the project's base branch and returns a fresh snapshot", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const info = await pm.setBaseBranch("p1", "develop")
    expect(info.baseBranch).toBe("develop")
  })

  test("trims whitespace and rejects empty input", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    await expect(pm.setBaseBranch("p1", "   ")).rejects.toThrow(/cannot be empty/)
  })

  test("throws for unknown project id", async () => {
    const pm = makeProjectManager()
    await expect(pm.setBaseBranch("nope", "main")).rejects.toThrow(/Unknown project/)
  })

  test("no-ops when new base equals previous (avoids a pointless GitHub retarget call)", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    // Second call with the same value should return the same snapshot without error.
    const info = await pm.setBaseBranch("p1", "main")
    expect(info.baseBranch).toBe("main")
  })

  test("persists base change even when retarget path short-circuits on missing token", async () => {
    // With no GITHUB_TOKEN, setBaseBranch cannot retarget any open PR — but the
    // local state change must still land so the user's next action uses the new base.
    delete process.env.GITHUB_TOKEN
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const info = await pm.setBaseBranch("p1", "develop")
    expect(info.baseBranch).toBe("develop")
  })
})

describe("getGitInfo TTL cache", () => {
  test("returns a byte-identical snapshot on a second call within the TTL window", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const first = await pm.getGitInfo("p1")
    const second = await pm.getGitInfo("p1")
    // Object identity proves we served the cache rather than recomputing —
    // the recomputed snapshot would be structurally equal but a new object.
    expect(second).toBe(first)
  })

  test("setBaseBranch invalidates the cache so the next read reflects the new base", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const before = await pm.getGitInfo("p1")
    expect(before.baseBranch).toBe("main")
    await pm.setBaseBranch("p1", "develop")
    const after = await pm.getGitInfo("p1")
    expect(after.baseBranch).toBe("develop")
    // And it's a freshly-computed object, not the pre-invalidation hit.
    expect(after).not.toBe(before)
  })

  test("markPullRequestFeedbackRead invalidates the cache so lastPrFeedbackCheckAt updates on next read", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const before = await pm.getGitInfo("p1")
    expect(before.lastPrFeedbackCheckAt).toBeNull()
    pm.markPullRequestFeedbackRead("p1", "2030-01-01T00:00:00Z")
    const after = await pm.getGitInfo("p1")
    expect(after.lastPrFeedbackCheckAt).toBe("2030-01-01T00:00:00Z")
  })
})

describe("deleteRemoteBranch", () => {
  test("throws when GITHUB_TOKEN is unset", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    await expect(pm.deleteRemoteBranch("p1")).rejects.toThrow(/GITHUB_TOKEN/)
  })

  test("throws when project has no agent branch", async () => {
    process.env.GITHUB_TOKEN = "ghp_fake"
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "", "main")
    await expect(pm.deleteRemoteBranch("p1")).rejects.toThrow(/No agent branch/)
  })

  test("throws when origin is not a github URL", async () => {
    const gitlabRoot = mkdtempSync(resolve(tmpdir(), "pm-gitinfo-gitlab-"))
    await gitExec(gitlabRoot, "init", "-b", "main")
    await gitExec(gitlabRoot, "config", "user.email", "t@e.com")
    await gitExec(gitlabRoot, "config", "user.name", "T")
    await gitExec(gitlabRoot, "commit", "--allow-empty", "-m", "init")
    await gitExec(gitlabRoot, "remote", "add", "origin", "https://gitlab.example.com/x/y.git")
    try {
      process.env.GITHUB_TOKEN = "ghp_fake"
      const pm = makeProjectManager()
      seedProject(pm, "p1", gitlabRoot, "agent/test-agent", "main")
      await expect(pm.deleteRemoteBranch("p1")).rejects.toThrow(/not a GitHub URL/)
    } finally {
      rmSync(gitlabRoot, { recursive: true, force: true })
    }
  })
})
