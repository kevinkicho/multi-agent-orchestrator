/**
 * cloneGithubRepo — the Add Project modal's "GitHub URL" flow. Uses a local
 * bare repo as the source (path contains "github.com" so the URL guard
 * passes) so tests stay offline. Exercises: URL parsing, target-name
 * override, non-empty-target refusal, and missing-parent error.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { resolve, join } from "path"
import { ProjectManager } from "../project-manager"
import { DashboardLog } from "../dashboard"
import { gitExec } from "../git-utils"
import type { Orchestrator } from "../orchestrator"

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

let root: string
let fakeRemote: string  // path that LOOKS like a github.com URL to parseGithubRemote
let parentDir: string
const originalToken = process.env.GITHUB_TOKEN

beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(), "pm-clone-"))
  // The parseGithubRemote regex keys on the substring "github.com/owner/repo"
  // or "github.com:owner/repo", so we build a path that ends with
  // `/github.com/fake/repo.git` — a bare repo git can clone from locally.
  const githubShim = join(root, "github.com")
  const ownerDir = join(githubShim, "fake")
  mkdirSync(ownerDir, { recursive: true })
  // Use forward slashes so parseGithubRemote (which anchors on "github.com/...")
  // matches regardless of host OS — Windows join() would insert backslashes.
  fakeRemote = join(ownerDir, "repo.git").replace(/\\/g, "/")
  await gitExec(root, "init", "--bare", "-b", "main", fakeRemote)

  // Seed the bare repo with one commit via a scratch workdir.
  const seed = mkdtempSync(resolve(tmpdir(), "pm-clone-seed-"))
  await gitExec(seed, "init", "-b", "main")
  await gitExec(seed, "config", "user.email", "t@e.com")
  await gitExec(seed, "config", "user.name", "T")
  writeFileSync(join(seed, "README.md"), "seeded\n")
  await gitExec(seed, "add", "README.md")
  await gitExec(seed, "commit", "-m", "seed")
  await gitExec(seed, "remote", "add", "origin", fakeRemote)
  await gitExec(seed, "push", "origin", "main")
  rmSync(seed, { recursive: true, force: true })

  parentDir = join(root, "workspace")
  mkdirSync(parentDir, { recursive: true })
})

afterAll(() => {
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalToken
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  // Clone tests don't exercise HTTPS auth — drop the token so we take the
  // plain-git branch, which is what public-repo clones use in practice.
  delete process.env.GITHUB_TOKEN
})

describe("cloneGithubRepo", () => {
  test("clones a github-style URL into the parent directory using the repo name", async () => {
    const pm = makeProjectManager()
    const target = await pm.cloneGithubRepo(fakeRemote, parentDir)
    expect(target).toBe(resolve(parentDir, "repo"))
    expect(existsSync(join(target, ".git"))).toBe(true)
    expect(existsSync(join(target, "README.md"))).toBe(true)
    rmSync(target, { recursive: true, force: true })
  })

  test("honors an explicit targetName override", async () => {
    const pm = makeProjectManager()
    const target = await pm.cloneGithubRepo(fakeRemote, parentDir, { targetName: "custom-name" })
    expect(target).toBe(resolve(parentDir, "custom-name"))
    expect(existsSync(join(target, "README.md"))).toBe(true)
    rmSync(target, { recursive: true, force: true })
  })

  test("rejects non-github URLs up front, before touching the filesystem", async () => {
    const pm = makeProjectManager()
    await expect(
      pm.cloneGithubRepo("https://gitlab.com/x/y.git", parentDir),
    ).rejects.toThrow(/Not a GitHub URL/)
  })

  test("rejects empty URL", async () => {
    const pm = makeProjectManager()
    await expect(pm.cloneGithubRepo("   ", parentDir)).rejects.toThrow(/required/)
  })

  test("refuses to clone when the target exists and is non-empty (prevents silent clobber)", async () => {
    const pm = makeProjectManager()
    const existing = join(parentDir, "repo")
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, "precious.txt"), "user data\n")
    try {
      await expect(pm.cloneGithubRepo(fakeRemote, parentDir)).rejects.toThrow(/not empty/i)
      // Precious file must still be there — the refusal came BEFORE any clone.
      expect(existsSync(join(existing, "precious.txt"))).toBe(true)
    } finally {
      rmSync(existing, { recursive: true, force: true })
    }
  })

  test("throws when the parent directory does not exist", async () => {
    const pm = makeProjectManager()
    await expect(
      pm.cloneGithubRepo(fakeRemote, join(root, "does-not-exist")),
    ).rejects.toThrow(/Parent directory does not exist/)
  })
})
