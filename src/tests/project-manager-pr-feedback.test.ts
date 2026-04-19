/**
 * fetchPendingPullRequestFeedback / markPullRequestFeedbackRead — these back
 * the "supervisor reads PR comments" loop. The ProjectManager owns the cursor
 * (lastPrFeedbackCheckAt), so these tests focus on its behavior under the
 * GITHUB_TOKEN / remote-URL / has-PR gates and on cursor advancement.
 *
 * No network: we use a local bare repo (path contains "github.com" so
 * parseGithubRemote matches) and rely on the early-return paths. The happy
 * path that actually talks to GitHub is covered in github-api.test.ts.
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

function seedProject(
  pm: ProjectManager, id: string, directory: string, agentBranch: string, baseBranch: string,
  lastPrFeedbackCheckAt?: string,
): void {
  const map = (pm as unknown as { projects: Map<string, Mutable<{
    id: string; name: string; directory: string; agentName: string; agentBranch: string; baseBranch: string;
    status: string; directive: string; directiveHistory: unknown[]; pendingComments: string[];
    workerPort: number; addedAt: number; lastPrFeedbackCheckAt?: string
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
    ...(lastPrFeedbackCheckAt ? { lastPrFeedbackCheckAt } : {}),
  })
}

let workdir: string
let root: string
const originalToken = process.env.GITHUB_TOKEN

beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(), "pm-prfb-"))
  const baredir = join(root, "github.com-fake.git")
  mkdirSync(baredir, { recursive: true })
  await gitExec(baredir, "init", "--bare", "-b", "main")

  workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  await gitExec(workdir, "init", "-b", "main")
  await gitExec(workdir, "config", "user.email", "test@example.com")
  await gitExec(workdir, "config", "user.name", "Test")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "init-main")
  await gitExec(workdir, "remote", "add", "origin", baredir)
  await gitExec(workdir, "checkout", "-b", "agent/test-agent")
  await gitExec(workdir, "commit", "--allow-empty", "-m", "agent-1")
})

afterAll(() => {
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalToken
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  delete process.env.GITHUB_TOKEN
})

describe("fetchPendingPullRequestFeedback", () => {
  test("returns [] when GITHUB_TOKEN is unset (no network attempted)", async () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    const items = await pm.fetchPendingPullRequestFeedback("p1")
    expect(items).toEqual([])
  })

  test("returns [] when origin is not a github URL", async () => {
    const gitlabRoot = mkdtempSync(resolve(tmpdir(), "pm-prfb-gitlab-"))
    await gitExec(gitlabRoot, "init", "-b", "main")
    await gitExec(gitlabRoot, "config", "user.email", "t@e.com")
    await gitExec(gitlabRoot, "config", "user.name", "T")
    await gitExec(gitlabRoot, "commit", "--allow-empty", "-m", "init")
    await gitExec(gitlabRoot, "remote", "add", "origin", "https://gitlab.example.com/x/y.git")
    try {
      process.env.GITHUB_TOKEN = "ghp_fake"
      const pm = makeProjectManager()
      seedProject(pm, "p1", gitlabRoot, "agent/test-agent", "main")
      const items = await pm.fetchPendingPullRequestFeedback("p1")
      expect(items).toEqual([])
    } finally {
      rmSync(gitlabRoot, { recursive: true, force: true })
    }
  })

  test("returns [] when project has no agent branch set", async () => {
    process.env.GITHUB_TOKEN = "ghp_fake"
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "", "main")
    const items = await pm.fetchPendingPullRequestFeedback("p1")
    expect(items).toEqual([])
  })

  test("throws for unknown project id", async () => {
    const pm = makeProjectManager()
    await expect(pm.fetchPendingPullRequestFeedback("nope")).rejects.toThrow(/Unknown project/)
  })
})

describe("markPullRequestFeedbackRead", () => {
  test("advances cursor when new timestamp is newer", () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main", "2026-04-18T10:00:00Z")
    pm.markPullRequestFeedbackRead("p1", "2026-04-18T11:00:00Z")
    const project = pm.getProject("p1")!
    expect(project.lastPrFeedbackCheckAt).toBe("2026-04-18T11:00:00Z")
  })

  test("does not move cursor backwards when new timestamp is older (clock-skew guard)", () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main", "2026-04-18T10:00:00Z")
    pm.markPullRequestFeedbackRead("p1", "2026-04-17T00:00:00Z")
    const project = pm.getProject("p1")!
    expect(project.lastPrFeedbackCheckAt).toBe("2026-04-18T10:00:00Z")
  })

  test("sets cursor when previously unset", () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main")
    pm.markPullRequestFeedbackRead("p1", "2026-04-18T10:00:00Z")
    const project = pm.getProject("p1")!
    expect(project.lastPrFeedbackCheckAt).toBe("2026-04-18T10:00:00Z")
  })

  test("ignores empty or invalid timestamp strings", () => {
    const pm = makeProjectManager()
    seedProject(pm, "p1", workdir, "agent/test-agent", "main", "2026-04-18T10:00:00Z")
    pm.markPullRequestFeedbackRead("p1", "")
    pm.markPullRequestFeedbackRead("p1", "not-a-date")
    const project = pm.getProject("p1")!
    expect(project.lastPrFeedbackCheckAt).toBe("2026-04-18T10:00:00Z")
  })

  test("throws for unknown project id", () => {
    const pm = makeProjectManager()
    expect(() => pm.markPullRequestFeedbackRead("nope", "2026-04-18T10:00:00Z")).toThrow(/Unknown project/)
  })
})
