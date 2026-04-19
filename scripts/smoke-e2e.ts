#!/usr/bin/env bun
/**
 * End-to-end smoke for the git lane that touches origin:
 *   cloneGithubRepo -> commit -> pushAgentBranch -> mergeAgentBranch -> deleteRemoteBranch.
 *
 * Uses a local bare repo whose path contains "github.com/<owner>/<repo>" so
 * `parseGithubRemote` + the origin-URL guards pass without any network call.
 * Exit code 0 means the full lane works against the currently checked-out
 * source; non-zero means a regression — run this before every manual QA pass.
 *
 * Not covered here:
 *   - pushAndOpenPullRequest / listOpenPullRequests (hit api.github.com)
 *   - fetchPendingPullRequestFeedback (hits api.github.com)
 * Those still need a real repo + token in the manual pass.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve, join } from "path"
import { ProjectManager } from "../src/project-manager"
import { DashboardLog } from "../src/dashboard"
import { gitExec } from "../src/git-utils"
import type { Orchestrator } from "../src/orchestrator"

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const SMOKE_TOKEN = "ghp_smoke_fake_token_not_a_real_credential"

function makeProjectManager(): ProjectManager {
  const stub: unknown = {
    agents: new Map(),
    async prompt() {}, async promptAll() { return { succeeded: [], failed: [] } },
    async getMessages() { return [] }, async status() { return new Map() },
    async addAgent() {}, removeAgent() {}, async abortAgent() {},
    async restartAgent() { return "s" }, forceResetAgentStatus() {}, shutdown() {},
  }
  return new ProjectManager(stub as Orchestrator, new DashboardLog(), { ollamaUrl: "http://127.0.0.1:11434" })
}

function seedProject(
  pm: ProjectManager, id: string, directory: string, agentBranch: string, baseBranch: string,
): void {
  const map = (pm as unknown as { projects: Map<string, Mutable<{
    id: string; name: string; directory: string; agentName: string; agentBranch: string; baseBranch: string;
    status: string; directive: string; directiveHistory: unknown[]; pendingComments: string[]; workerPort: number; addedAt: number
  }>> }).projects
  map.set(id, {
    id, name: "smoke", directory,
    agentName: "smoke-agent",
    agentBranch, baseBranch,
    status: "running",
    directive: "",
    directiveHistory: [],
    pendingComments: [],
    workerPort: 0,
    addedAt: Date.now(),
  })
}

function log(step: string, msg: string): void {
  console.log(`[smoke] ${step}: ${msg}`)
}

async function main(): Promise<void> {
  const root = mkdtempSync(resolve(tmpdir(), "orc-smoke-"))
  // Forward-slash path so parseGithubRemote's regex matches on Windows too.
  // Git accepts forward slashes in path arguments on all platforms.
  const bareDir = join(root, "github.com", "smoke", "bare.git").replaceAll("\\", "/")
  const parentDir = join(root, "clones").replaceAll("\\", "/")
  const originalToken = process.env.GITHUB_TOKEN
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalToken
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
  process.on("SIGINT", () => { cleanup(); process.exit(130) })

  try {
    log("setup", `workspace at ${root}`)
    mkdirSync(bareDir, { recursive: true })
    await gitExec(bareDir, "init", "--bare", "-b", "main")

    // Seed the bare with one commit so cloning produces a usable main.
    const seedDir = join(root, "seed").replaceAll("\\", "/")
    mkdirSync(seedDir, { recursive: true })
    await gitExec(seedDir, "init", "-b", "main")
    await gitExec(seedDir, "config", "user.email", "smoke@example.com")
    await gitExec(seedDir, "config", "user.name", "Smoke")
    writeFileSync(join(seedDir, "README.md"), "# smoke\n")
    await gitExec(seedDir, "add", "README.md")
    await gitExec(seedDir, "commit", "-m", "init")
    await gitExec(seedDir, "remote", "add", "origin", bareDir)
    await gitExec(seedDir, "push", "origin", "main")
    log("setup", "bare seeded with main@init")

    process.env.GITHUB_TOKEN = SMOKE_TOKEN
    const pm = makeProjectManager()

    mkdirSync(parentDir, { recursive: true })
    log("clone", `cloneGithubRepo(${bareDir} → ${parentDir})`)
    const cloneDir = await pm.cloneGithubRepo(bareDir, parentDir)
    log("clone", `ok → ${cloneDir}`)

    // Configure identity on the clone (user.email/name are not inherited on CI-like envs).
    await gitExec(cloneDir, "config", "user.email", "smoke@example.com")
    await gitExec(cloneDir, "config", "user.name", "Smoke")

    const agentBranch = "agent/smoke-agent"
    await gitExec(cloneDir, "checkout", "-b", agentBranch)
    writeFileSync(join(cloneDir, "work.txt"), "worker edit\n")
    await gitExec(cloneDir, "add", "work.txt")
    await gitExec(cloneDir, "commit", "-m", "worker-edit")
    log("branch", `created + committed on ${agentBranch}`)

    const projectId = "smoke-project"
    seedProject(pm, projectId, cloneDir, agentBranch, "main")

    log("push", "pushAgentBranch …")
    const pushRes = await pm.pushAgentBranch(projectId, { setUpstream: true })
    if (!pushRes.success) throw new Error(`push failed: ${pushRes.output}`)
    const refs = (await gitExec(bareDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/")).split("\n").map(s => s.trim())
    if (!refs.includes(agentBranch)) throw new Error(`bare missing ${agentBranch}, saw: ${refs.join(",")}`)
    log("push", `ok — bare has ${agentBranch}`)

    log("merge", "mergeAgentBranch into main …")
    const mergeRes = await pm.mergeAgentBranch(projectId, "main")
    if (!mergeRes.success) throw new Error(`merge failed: ${mergeRes.output}`)
    log("merge", "ok — local main fast-forwarded")

    // Push merged main so the bare mirrors the merge — mergeAgentBranch is local only.
    await gitExec(cloneDir, "checkout", "main")
    const pushMain = await gitExec(cloneDir, "push", "origin", "main")
    log("merge", `pushed main → bare: ${pushMain.split("\n").pop()?.trim() ?? "ok"}`)
    await gitExec(cloneDir, "checkout", agentBranch)

    log("delete", "deleteRemoteBranch …")
    const delRes = await pm.deleteRemoteBranch(projectId)
    if (!delRes.success) throw new Error(`delete failed: ${delRes.output}`)
    const refsAfter = (await gitExec(bareDir, "for-each-ref", "--format=%(refname:short)", "refs/heads/")).split("\n").map(s => s.trim())
    if (refsAfter.includes(agentBranch)) throw new Error(`bare still has ${agentBranch} after delete: ${refsAfter.join(",")}`)
    log("delete", `ok — bare refs: ${refsAfter.filter(Boolean).join(",")}`)

    console.log("\n[smoke] SMOKE OK — clone → commit → push → merge → delete-remote all green.")
    console.log("[smoke] Still UNCOVERED (need real github.com): pushAndOpenPullRequest, listOpenPullRequests, fetchPendingPullRequestFeedback.")
  } catch (err) {
    console.error("\n[smoke] FAILED:", err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    cleanup()
  }
}

main().catch((err) => {
  console.error("[smoke] fatal:", err)
  process.exit(1)
})
