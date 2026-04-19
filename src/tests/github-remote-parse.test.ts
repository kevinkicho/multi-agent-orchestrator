import { describe, test, expect } from "bun:test"
import { parseGithubRemote } from "../git-utils"

describe("parseGithubRemote", () => {
  test("parses https URL with .git suffix", () => {
    expect(parseGithubRemote("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" })
  })
  test("parses https URL without .git suffix", () => {
    expect(parseGithubRemote("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" })
  })
  test("parses https URL with trailing slash", () => {
    expect(parseGithubRemote("https://github.com/owner/repo/")).toEqual({ owner: "owner", repo: "repo" })
  })
  test("parses scp-style SSH URL", () => {
    expect(parseGithubRemote("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" })
  })
  test("parses ssh:// URL", () => {
    expect(parseGithubRemote("ssh://git@github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" })
  })
  test("handles hyphenated owner and repo", () => {
    expect(parseGithubRemote("https://github.com/my-org/my-repo.git")).toEqual({ owner: "my-org", repo: "my-repo" })
  })
  test("handles dotted repo names", () => {
    expect(parseGithubRemote("https://github.com/owner/repo.io.git")).toEqual({ owner: "owner", repo: "repo.io" })
  })
  test("returns null for non-github URLs", () => {
    expect(parseGithubRemote("https://gitlab.com/owner/repo.git")).toBeNull()
    expect(parseGithubRemote("https://bitbucket.org/owner/repo.git")).toBeNull()
  })
  test("returns null for garbage input", () => {
    expect(parseGithubRemote("")).toBeNull()
    expect(parseGithubRemote("not a url")).toBeNull()
    expect(parseGithubRemote("https://github.com/")).toBeNull()
    expect(parseGithubRemote("https://github.com/onlyowner")).toBeNull()
  })
  test("is case-insensitive on hostname", () => {
    expect(parseGithubRemote("https://GitHub.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" })
  })
})
