import { describe, test, expect } from "bun:test"
import { resolve } from "path"
import {
  normalizeGitUrl,
  repoSlugFromUrl,
  slugifyAgentName,
  isOrchestratorRepo,
  canonicalAgentName,
} from "../repo-identity"

describe("normalizeGitUrl", () => {
  test("https URLs strip scheme, trailing .git, and slashes", () => {
    expect(normalizeGitUrl("https://github.com/kevinkicho/multi-agent-orchestrator.git"))
      .toBe("github.com/kevinkicho/multi-agent-orchestrator")
    expect(normalizeGitUrl("https://GitHub.com/kevinkicho/Repo/"))
      .toBe("github.com/kevinkicho/Repo")
  })

  test("ssh URLs with git@host:owner/repo form", () => {
    expect(normalizeGitUrl("git@github.com:kevinkicho/multi-agent-orchestrator.git"))
      .toBe("github.com/kevinkicho/multi-agent-orchestrator")
  })

  test("ssh:// URLs normalize to same form as https", () => {
    const a = normalizeGitUrl("ssh://git@github.com/kevinkicho/repo.git")
    const b = normalizeGitUrl("https://github.com/kevinkicho/repo.git")
    expect(a).toBe(b)
  })

  test("returns null for empty / whitespace input", () => {
    expect(normalizeGitUrl("")).toBeNull()
    expect(normalizeGitUrl("   ")).toBeNull()
  })
})

describe("repoSlugFromUrl", () => {
  test("extracts last path segment", () => {
    expect(repoSlugFromUrl("https://github.com/foo/my-repo.git")).toBe("my-repo")
    expect(repoSlugFromUrl("git@github.com:foo/my-repo")).toBe("my-repo")
  })

  test("returns null for unparseable URL", () => {
    expect(repoSlugFromUrl("")).toBeNull()
  })
})

describe("slugifyAgentName", () => {
  test("lowercases and strips disallowed characters", () => {
    expect(slugifyAgentName("My_Cool Project!")).toBe("my-cool-project")
  })
  test("collapses runs of dashes and trims", () => {
    expect(slugifyAgentName("---foo--bar--")).toBe("foo-bar")
  })
})

describe("isOrchestratorRepo", () => {
  test("true when target path resolves to orchestrator root", async () => {
    const deps = {
      getOriginUrl: async () => null,
      orchestratorRoot: "/repo",
    }
    expect(await isOrchestratorRepo("/repo", deps)).toBe(true)
    expect(await isOrchestratorRepo(resolve("/repo") + "/", deps)).toBe(true)
  })

  test("false for a sibling clone with matching origin at a different path", async () => {
    // Clones of the same GitHub repo at different paths used to trip this
    // guard; the narrowed guard now allows them since the supervisor operates
    // on the clone directory, not the running tree.
    const deps = {
      getOriginUrl: async (_cwd: string) => "https://github.com/k/repo.git",
      orchestratorRoot: "/running/tree",
    }
    expect(await isOrchestratorRepo("/another/clone/of/repo", deps)).toBe(false)
  })

  test("false when paths differ and no origin info is available", async () => {
    const deps = {
      getOriginUrl: async () => null,
      orchestratorRoot: "/root",
    }
    expect(await isOrchestratorRepo("/elsewhere", deps)).toBe(false)
  })
})

describe("canonicalAgentName", () => {
  test("prefers slug from origin URL over folder name", async () => {
    const deps = {
      getOriginUrl: async () => "https://github.com/k/multi-agent-orchestrator.git",
    }
    const name = await canonicalAgentName("/some/weird/folder-name", "folder-name", deps)
    expect(name).toBe("multi-agent-orchestrator")
  })

  test("falls back to provided name when no remote", async () => {
    const deps = { getOriginUrl: async () => null }
    expect(await canonicalAgentName("/x", "My Repo", deps)).toBe("my-repo")
  })

  test("falls back to basename when name is empty and no remote", async () => {
    const deps = { getOriginUrl: async () => null }
    expect(await canonicalAgentName("/tmp/abc-xyz", undefined, deps)).toBe("abc-xyz")
  })

  test("returns 'project' when nothing produces a valid slug", async () => {
    const deps = { getOriginUrl: async () => null }
    expect(await canonicalAgentName("/tmp/!!!", "!!!", deps)).toBe("project")
  })
})
