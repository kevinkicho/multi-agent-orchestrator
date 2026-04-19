/**
 * github-api — exercises the pull-request helpers with an injected fetch so the
 * tests don't depend on network or a real GITHUB_TOKEN. We assert on the
 * request shape (URL, headers, body) and on response handling (happy path,
 * existing PR reuse, error propagation) since both are load-bearing for the
 * "Push & PR" button in the dashboard.
 */

import { describe, test, expect } from "bun:test"
import { findOpenPullRequest, createPullRequest, openOrReusePullRequest, listPullRequestFeedback, getAuthenticatedUserLogin } from "../github-api"

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (url: unknown, init?: unknown) => handler(String(url), init as RequestInit | undefined)) as unknown as typeof fetch
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

describe("findOpenPullRequest", () => {
  test("returns null when GitHub returns an empty array", async () => {
    const f = mockFetch(() => ok([]))
    const pr = await findOpenPullRequest({
      owner: "o", repo: "r", head: "agent/x", base: "main", token: "t", fetchImpl: f,
    })
    expect(pr).toBeNull()
  })

  test("returns the first PR with isNew=false when one exists", async () => {
    const f = mockFetch(() => ok([
      { html_url: "https://github.com/o/r/pull/42", number: 42 },
      { html_url: "https://github.com/o/r/pull/99", number: 99 },
    ]))
    const pr = await findOpenPullRequest({
      owner: "o", repo: "r", head: "agent/x", base: "main", token: "t", fetchImpl: f,
    })
    expect(pr).toEqual({ url: "https://github.com/o/r/pull/42", number: 42, isNew: false })
  })

  test("sends head=owner:branch, base, state=open, and auth headers", async () => {
    let seenUrl = ""
    let seenHeaders: Record<string, string> = {}
    const f = mockFetch((url, init) => {
      seenUrl = url
      seenHeaders = (init?.headers ?? {}) as Record<string, string>
      return ok([])
    })
    await findOpenPullRequest({ owner: "o", repo: "r", head: "agent/x", base: "main", token: "secret-t", fetchImpl: f })
    expect(seenUrl).toContain("/repos/o/r/pulls?")
    expect(seenUrl).toContain("head=o%3Aagent%2Fx")
    expect(seenUrl).toContain("base=main")
    expect(seenUrl).toContain("state=open")
    expect(seenHeaders["Authorization"]).toBe("Bearer secret-t")
    expect(seenHeaders["Accept"]).toBe("application/vnd.github+json")
  })

  test("throws with status code when GitHub returns non-2xx", async () => {
    const f = mockFetch(() => new Response("Not Found", { status: 404 }))
    await expect(
      findOpenPullRequest({ owner: "o", repo: "r", head: "agent/x", base: "main", token: "t", fetchImpl: f }),
    ).rejects.toThrow(/404/)
  })
})

describe("createPullRequest", () => {
  test("POSTs title/body/head/base and returns isNew=true", async () => {
    let seenBody: Record<string, string> = {}
    let seenMethod = ""
    const f = mockFetch((_url, init) => {
      seenMethod = String(init?.method ?? "GET")
      seenBody = JSON.parse(String(init?.body ?? "{}"))
      return new Response(JSON.stringify({ html_url: "https://github.com/o/r/pull/7", number: 7 }), { status: 201 })
    })
    const pr = await createPullRequest({
      owner: "o", repo: "r", head: "agent/x", base: "main",
      title: "agent PR", body: "did things", token: "t", fetchImpl: f,
    })
    expect(seenMethod).toBe("POST")
    expect(seenBody).toEqual({ title: "agent PR", body: "did things", head: "agent/x", base: "main" })
    expect(pr).toEqual({ url: "https://github.com/o/r/pull/7", number: 7, isNew: true })
  })

  test("surfaces GitHub's error body in the thrown message", async () => {
    const f = mockFetch(() => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }))
    await expect(
      createPullRequest({ owner: "o", repo: "r", head: "agent/x", base: "main", title: "t", token: "tk", fetchImpl: f }),
    ).rejects.toThrow(/422.*Validation Failed/)
  })
})

describe("openOrReusePullRequest", () => {
  test("reuses existing PR without POSTing a new one", async () => {
    let posts = 0
    const f = mockFetch((_url, init) => {
      if (init?.method === "POST") { posts++; return ok({ html_url: "x", number: 1 }) }
      return ok([{ html_url: "https://github.com/o/r/pull/5", number: 5 }])
    })
    const pr = await openOrReusePullRequest({
      owner: "o", repo: "r", head: "agent/x", base: "main", title: "t", token: "tk", fetchImpl: f,
    })
    expect(pr.isNew).toBe(false)
    expect(pr.number).toBe(5)
    expect(posts).toBe(0)
  })

  test("creates a new PR when none exists", async () => {
    let posts = 0
    const f = mockFetch((_url, init) => {
      if (init?.method === "POST") {
        posts++
        return new Response(JSON.stringify({ html_url: "https://github.com/o/r/pull/8", number: 8 }), { status: 201 })
      }
      return ok([])
    })
    const pr = await openOrReusePullRequest({
      owner: "o", repo: "r", head: "agent/x", base: "main", title: "t", token: "tk", fetchImpl: f,
    })
    expect(pr.isNew).toBe(true)
    expect(pr.number).toBe(8)
    expect(posts).toBe(1)
  })
})

describe("listPullRequestFeedback", () => {
  /** Routes the three GitHub endpoints to separate mock responses. */
  function routed(issueComments: unknown[], reviewComments: unknown[], reviews: unknown[]): typeof fetch {
    return mockFetch((url) => {
      if (url.includes("/issues/") && url.includes("/comments")) return ok(issueComments)
      if (url.includes("/pulls/") && url.includes("/comments")) return ok(reviewComments)
      if (url.includes("/pulls/") && url.includes("/reviews")) return ok(reviews)
      return new Response("unexpected", { status: 500 })
    })
  }

  test("merges all three surfaces and sorts by createdAt", async () => {
    const issueComments = [
      { user: { login: "alice" }, body: "top-level thought", created_at: "2026-04-18T10:00:00Z", html_url: "https://x/1" },
    ]
    const reviewComments = [
      { user: { login: "bob" }, body: "nit on line 3", created_at: "2026-04-18T09:00:00Z", html_url: "https://x/2", path: "a.ts", line: 3 },
    ]
    const reviews = [
      { user: { login: "carol" }, body: "looks good", submitted_at: "2026-04-18T11:00:00Z", html_url: "https://x/3", state: "APPROVED" },
    ]
    const f = routed(issueComments, reviewComments, reviews)
    const items = await listPullRequestFeedback({ owner: "o", repo: "r", number: 1, token: "t", fetchImpl: f })
    expect(items).toHaveLength(3)
    expect(items[0]!.kind).toBe("review-comment")
    expect(items[1]!.kind).toBe("issue-comment")
    expect(items[2]!.kind).toBe("review")
    expect(items[2]!.state).toBe("APPROVED")
    expect(items[0]!.path).toBe("a.ts")
    expect(items[0]!.line).toBe(3)
  })

  test("filters out bot authors on all three surfaces", async () => {
    const f = routed(
      [{ user: { login: "dependabot[bot]" }, body: "bump", created_at: "2026-04-18T10:00:00Z", html_url: "x" }],
      [{ user: { login: "ci-bot[bot]" }, body: "fmt", created_at: "2026-04-18T10:00:00Z", html_url: "y", path: "a.ts" }],
      [{ user: { login: "gha[bot]" }, body: "ran", submitted_at: "2026-04-18T11:00:00Z", html_url: "z", state: "COMMENTED" }],
    )
    const items = await listPullRequestFeedback({ owner: "o", repo: "r", number: 1, token: "t", fetchImpl: f })
    expect(items).toEqual([])
  })

  test("passes sinceIso to the issue/review-comments endpoints and client-filters reviews", async () => {
    let issuesUrl = ""
    let reviewsUrl = ""
    const f = mockFetch((url) => {
      if (url.includes("/issues/") && url.includes("/comments")) { issuesUrl = url; return ok([]) }
      if (url.includes("/pulls/") && url.includes("/comments")) return ok([])
      if (url.includes("/pulls/") && url.includes("/reviews")) {
        reviewsUrl = url
        return ok([
          // This one is BEFORE since and must be filtered client-side.
          { user: { login: "alice" }, body: "old", submitted_at: "2026-04-17T00:00:00Z", html_url: "x", state: "COMMENTED" },
          // This one is AFTER since and must pass through.
          { user: { login: "alice" }, body: "new", submitted_at: "2026-04-19T00:00:00Z", html_url: "y", state: "COMMENTED" },
        ])
      }
      return new Response("x", { status: 500 })
    })
    const items = await listPullRequestFeedback({
      owner: "o", repo: "r", number: 1, token: "t", sinceIso: "2026-04-18T00:00:00Z", fetchImpl: f,
    })
    expect(issuesUrl).toContain("since=2026-04-18T00%3A00%3A00Z")
    expect(reviewsUrl).not.toContain("since=") // reviews endpoint doesn't support since — filtered client-side
    expect(items).toHaveLength(1)
    expect(items[0]!.body).toBe("new")
  })

  test("skips empty-body COMMENTED reviews (bare approve-click noise) but keeps CHANGES_REQUESTED", async () => {
    const f = routed(
      [],
      [],
      [
        { user: { login: "alice" }, body: "", submitted_at: "2026-04-18T10:00:00Z", html_url: "x", state: "COMMENTED" },
        { user: { login: "bob" }, body: "", submitted_at: "2026-04-18T11:00:00Z", html_url: "y", state: "CHANGES_REQUESTED" },
      ],
    )
    const items = await listPullRequestFeedback({ owner: "o", repo: "r", number: 1, token: "t", fetchImpl: f })
    expect(items).toHaveLength(1)
    expect(items[0]!.state).toBe("CHANGES_REQUESTED")
  })

  test("excludeAuthors filters self-authored comments case-insensitively", async () => {
    const f = routed(
      [
        { user: { login: "AgentKevin" }, body: "self-post", created_at: "2026-04-18T10:00:00Z", html_url: "x" },
        { user: { login: "reviewer1" }, body: "real feedback", created_at: "2026-04-18T11:00:00Z", html_url: "y" },
      ],
      [
        { user: { login: "agentkevin" }, body: "inline self", created_at: "2026-04-18T10:30:00Z", html_url: "z", path: "a.ts" },
      ],
      [
        { user: { login: "AGENTKEVIN" }, body: "self review", submitted_at: "2026-04-18T12:00:00Z", html_url: "w", state: "COMMENTED" },
      ],
    )
    const items = await listPullRequestFeedback({
      owner: "o", repo: "r", number: 1, token: "t", excludeAuthors: ["agentkevin"], fetchImpl: f,
    })
    expect(items).toHaveLength(1)
    expect(items[0]!.author).toBe("reviewer1")
  })

  test("throws when any of the three endpoints returns non-2xx", async () => {
    const f = mockFetch((url) => {
      if (url.includes("/reviews")) return new Response("forbidden", { status: 403 })
      return ok([])
    })
    await expect(
      listPullRequestFeedback({ owner: "o", repo: "r", number: 1, token: "t", fetchImpl: f }),
    ).rejects.toThrow(/403/)
  })
})

describe("updatePullRequestBase", () => {
  test("PATCHes /pulls/:num with {base} and auth", async () => {
    let seenMethod = ""
    let seenUrl = ""
    let seenBody: Record<string, string> = {}
    const { updatePullRequestBase } = await import("../github-api")
    const f = mockFetch((url, init) => {
      seenUrl = url
      seenMethod = String(init?.method ?? "GET")
      seenBody = JSON.parse(String(init?.body ?? "{}"))
      return ok({})
    })
    await updatePullRequestBase({ owner: "o", repo: "r", number: 42, base: "develop", token: "tk", fetchImpl: f })
    expect(seenMethod).toBe("PATCH")
    expect(seenUrl).toContain("/repos/o/r/pulls/42")
    expect(seenBody).toEqual({ base: "develop" })
  })

  test("throws with GitHub's error body on non-2xx", async () => {
    const { updatePullRequestBase } = await import("../github-api")
    const f = mockFetch(() => new Response(JSON.stringify({ message: "Base branch not found" }), { status: 422 }))
    await expect(
      updatePullRequestBase({ owner: "o", repo: "r", number: 1, base: "nope", token: "tk", fetchImpl: f }),
    ).rejects.toThrow(/422.*Base branch not found/)
  })
})

describe("getAuthenticatedUserLogin", () => {
  test("returns the login from /user on success", async () => {
    const f = mockFetch(() => ok({ login: "kevinkicho", id: 42 }))
    const login = await getAuthenticatedUserLogin({ token: "t", fetchImpl: f })
    expect(login).toBe("kevinkicho")
  })

  test("returns null on 401 / token revoked", async () => {
    const f = mockFetch(() => new Response("bad creds", { status: 401 }))
    const login = await getAuthenticatedUserLogin({ token: "t", fetchImpl: f })
    expect(login).toBeNull()
  })

  test("returns null when /user returns a body without login field", async () => {
    const f = mockFetch(() => ok({ id: 42 }))
    const login = await getAuthenticatedUserLogin({ token: "t", fetchImpl: f })
    expect(login).toBeNull()
  })

  test("swallows network errors and returns null (defense in depth)", async () => {
    const f = (async () => { throw new Error("network down") }) as unknown as typeof fetch
    const login = await getAuthenticatedUserLogin({ token: "t", fetchImpl: f })
    expect(login).toBeNull()
  })
})
