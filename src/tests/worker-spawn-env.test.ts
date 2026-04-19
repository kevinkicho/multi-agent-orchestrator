/**
 * computeWorkerSpawnEnv — blast-radius control for the worker subprocess.
 * These tests pin the policy matrix because the default is "none" — workers
 * do NOT inherit GITHUB_TOKEN. Any change here affects whether a prompt-
 * injected worker can push to arbitrary repos, so the matrix is load-bearing.
 */

import { describe, test, expect } from "bun:test"
import { computeWorkerSpawnEnv } from "../project-manager"

const DIR = "/workspaces/acme"

describe("computeWorkerSpawnEnv", () => {
  test("default (omitted policy) strips GITHUB_TOKEN — safe-by-default", () => {
    // With the default flipped to "none", a worker spawned without an
    // explicit policy must NOT see GITHUB_TOKEN or GH_TOKEN. Any regression
    // here means prompt-injected workers could push to arbitrary repos.
    const env = computeWorkerSpawnEnv({ GITHUB_TOKEN: "ghp_x", PATH: "/usr/bin" }, DIR, {})
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin")
    expect(env.OPENCODE_PROJECT_DIR).toBe(DIR)
  })

  test("'full' (explicit opt-in) exposes GITHUB_TOKEN and mirrors it under GH_TOKEN when absent", () => {
    const env = computeWorkerSpawnEnv(
      { GITHUB_TOKEN: "ghp_x", PATH: "/usr/bin" }, DIR, { workerGithubAccess: "full" },
    )
    expect(env.GITHUB_TOKEN).toBe("ghp_x")
    expect(env.GH_TOKEN).toBe("ghp_x")
  })

  test("'full' mirrors GITHUB_TOKEN under GH_TOKEN only when GH_TOKEN is not already set", () => {
    const env = computeWorkerSpawnEnv(
      { GITHUB_TOKEN: "pat-a", GH_TOKEN: "pat-b" }, DIR, { workerGithubAccess: "full" },
    )
    expect(env.GITHUB_TOKEN).toBe("pat-a")
    expect(env.GH_TOKEN).toBe("pat-b") // don't overwrite caller-provided GH_TOKEN
  })

  test("'none' strips GITHUB_TOKEN and GH_TOKEN from the worker env", () => {
    const env = computeWorkerSpawnEnv(
      { GITHUB_TOKEN: "ghp_x", GH_TOKEN: "ghp_y", OTHER: "keep-me" }, DIR,
      { workerGithubAccess: "none" },
    )
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.OTHER).toBe("keep-me")
    expect(env.OPENCODE_PROJECT_DIR).toBe(DIR)
  })

  test("'none' does not introduce GH_TOKEN even when GITHUB_TOKEN is present in parent env", () => {
    // Regression guard — the mirror branch must not fire under "none".
    const env = computeWorkerSpawnEnv({ GITHUB_TOKEN: "ghp_x" }, DIR, { workerGithubAccess: "none" })
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
  })

  test("'none' leaves non-GitHub secrets alone (narrow scoping, not a env scrub)", () => {
    const env = computeWorkerSpawnEnv(
      { GITHUB_TOKEN: "ghp_x", OPENAI_API_KEY: "sk-xxx", ANTHROPIC_API_KEY: "sk-ant" }, DIR,
      { workerGithubAccess: "none" },
    )
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBe("sk-xxx")
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant")
  })

  test("OPENCODE_PROJECT_DIR always reflects the resolved directory, overriding any inherited value", () => {
    const env = computeWorkerSpawnEnv({ OPENCODE_PROJECT_DIR: "/old/path" }, DIR, {})
    expect(env.OPENCODE_PROJECT_DIR).toBe(DIR)
  })

  test("unset GITHUB_TOKEN in parent env does not synthesize GH_TOKEN", () => {
    const env = computeWorkerSpawnEnv({ PATH: "/usr/bin" }, DIR, { workerGithubAccess: "full" })
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
  })
})
