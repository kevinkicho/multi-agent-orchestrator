import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import {
  gitExec,
  gitRemoteUrl,
  gitBranchExists,
  gitRemoteBranchExists,
  gitListBranches,
  gitCommitsAhead,
} from "../git-utils"

let tmp: string

beforeAll(async () => {
  tmp = mkdtempSync(resolve(tmpdir(), "git-utils-branches-"))
  await gitExec(tmp, "init", "-b", "main")
  await gitExec(tmp, "config", "user.email", "test@example.com")
  await gitExec(tmp, "config", "user.name", "Test")
  await gitExec(tmp, "commit", "--allow-empty", "-m", "init")
  await gitExec(tmp, "checkout", "-b", "feature/alpha")
  await gitExec(tmp, "commit", "--allow-empty", "-m", "alpha-1")
  await gitExec(tmp, "commit", "--allow-empty", "-m", "alpha-2")
  await gitExec(tmp, "checkout", "main")
  await gitExec(tmp, "checkout", "-b", "agent/foo-archive-1")
  await gitExec(tmp, "checkout", "main")
  await gitExec(tmp, "checkout", "-b", "agent/foo-archive-2")
  await gitExec(tmp, "checkout", "main")
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("gitBranchExists", () => {
  test("true for existing branch, false for missing", async () => {
    expect(await gitBranchExists(tmp, "main")).toBe(true)
    expect(await gitBranchExists(tmp, "feature/alpha")).toBe(true)
    expect(await gitBranchExists(tmp, "nope")).toBe(false)
  })
})

describe("gitRemoteUrl", () => {
  test("returns null when no origin configured", async () => {
    expect(await gitRemoteUrl(tmp)).toBeNull()
  })
  test("returns url after remote add", async () => {
    await gitExec(tmp, "remote", "add", "origin", "https://github.com/x/y.git")
    expect(await gitRemoteUrl(tmp)).toBe("https://github.com/x/y.git")
    await gitExec(tmp, "remote", "remove", "origin")
  })
})

describe("gitRemoteBranchExists", () => {
  test("false when remote is unreachable or missing", async () => {
    expect(await gitRemoteBranchExists(tmp, "main")).toBe(false)
  })
})

describe("gitListBranches", () => {
  test("returns all branches when no pattern", async () => {
    const branches = await gitListBranches(tmp)
    expect(branches).toContain("main")
    expect(branches).toContain("feature/alpha")
    expect(branches).toContain("agent/foo-archive-1")
  })
  test("filters by glob pattern", async () => {
    const matches = await gitListBranches(tmp, "agent/foo-*")
    expect(matches.sort()).toEqual(["agent/foo-archive-1", "agent/foo-archive-2"])
  })
  test("empty array for no matches", async () => {
    expect(await gitListBranches(tmp, "nonexistent/*")).toEqual([])
  })
})

describe("gitCommitsAhead", () => {
  test("counts commits on head not on base", async () => {
    expect(await gitCommitsAhead(tmp, "main", "feature/alpha")).toBe(2)
    expect(await gitCommitsAhead(tmp, "feature/alpha", "main")).toBe(0)
  })
  test("returns 0 for missing refs", async () => {
    expect(await gitCommitsAhead(tmp, "main", "does-not-exist")).toBe(0)
  })
})
