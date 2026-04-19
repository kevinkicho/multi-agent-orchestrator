/**
 * Minimal GitHub REST client for the orchestrator. Scope is intentionally narrow:
 * we only need the operations the dashboard surfaces (open or reuse a PR from the
 * agent branch). Anything richer (comments, reviews, issues) belongs in its own
 * caller — keeping this file small keeps the blast radius of a bad token small.
 *
 * All calls take a `fetch` function so tests can inject a mock without a network.
 */

export type GithubFetch = typeof fetch

export type PullRequestRef = {
  url: string     // html_url — what we surface to users
  number: number
  isNew: boolean  // true if we just created it, false if we reused an existing open PR
}

export type OpenPullRequestInput = {
  owner: string
  repo: string
  head: string           // branch name on `owner`'s fork/repo (same-repo PRs only here)
  base: string           // target branch on the repo
  title: string
  body?: string
  token: string
  fetchImpl?: GithubFetch
}

const API_BASE = "https://api.github.com"

function authHeaders(token: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "multi-agent-orchestrator",
  }
}

/** Find an open PR matching head:base. Returns null if none exists. */
export async function findOpenPullRequest(input: {
  owner: string; repo: string; head: string; base: string; token: string; fetchImpl?: GithubFetch
}): Promise<PullRequestRef | null> {
  const f = input.fetchImpl ?? fetch
  const qs = new URLSearchParams({
    head: `${input.owner}:${input.head}`,
    base: input.base,
    state: "open",
  })
  const res = await f(`${API_BASE}/repos/${input.owner}/${input.repo}/pulls?${qs}`, {
    headers: authHeaders(input.token),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`GitHub PR lookup failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const prs = (await res.json()) as Array<{ html_url: string; number: number }>
  if (!Array.isArray(prs) || prs.length === 0) return null
  const pr = prs[0]!
  return { url: pr.html_url, number: pr.number, isNew: false }
}

/**
 * Retarget an existing PR to a new base branch. Thin wrapper around
 * PATCH /pulls/:num with {base}. Used when the user changes baseBranch on a
 * project that already has an open PR — keeps the single-PR-per-branch
 * invariant instead of orphaning the old one.
 */
export async function updatePullRequestBase(input: {
  owner: string
  repo: string
  number: number
  base: string
  token: string
  fetchImpl?: GithubFetch
}): Promise<void> {
  const f = input.fetchImpl ?? fetch
  const res = await f(`${API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.number}`, {
    method: "PATCH",
    headers: { ...authHeaders(input.token), "Content-Type": "application/json" },
    body: JSON.stringify({ base: input.base }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`GitHub PR retarget failed (${res.status}): ${text.slice(0, 300)}`)
  }
}

/** Create a new PR. Caller is responsible for ensuring none already exists. */
export async function createPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef> {
  const f = input.fetchImpl ?? fetch
  const res = await f(`${API_BASE}/repos/${input.owner}/${input.repo}/pulls`, {
    method: "POST",
    headers: { ...authHeaders(input.token), "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      body: input.body ?? "",
      head: input.head,
      base: input.base,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`GitHub PR create failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const pr = (await res.json()) as { html_url: string; number: number }
  return { url: pr.html_url, number: pr.number, isNew: true }
}

/** Open a new PR from head → base, OR return the existing open one if any. This
 *  is the button-grade operation: the user can click "Push & PR" repeatedly and
 *  it stays idempotent — one PR per agent branch until it's merged or closed. */
export async function openOrReusePullRequest(input: OpenPullRequestInput): Promise<PullRequestRef> {
  const existing = await findOpenPullRequest({
    owner: input.owner, repo: input.repo, head: input.head, base: input.base,
    token: input.token, fetchImpl: input.fetchImpl,
  })
  if (existing) return existing
  return createPullRequest(input)
}

/**
 * A single piece of human feedback on a PR. Three GitHub surfaces are merged
 * into one stream so the supervisor doesn't have to understand GitHub's review
 * taxonomy:
 *  - "issue-comment": top-level comments on the PR conversation tab
 *  - "review": a review submission (approve/request-changes/comment) — body
 *    is the overall summary the reviewer wrote
 *  - "review-comment": an inline comment attached to a specific line of a diff
 */
export type PullRequestFeedbackKind = "issue-comment" | "review" | "review-comment"

export type PullRequestFeedback = {
  kind: PullRequestFeedbackKind
  author: string
  /** ISO-8601 timestamp from GitHub (created_at for comments, submitted_at for reviews) */
  createdAt: string
  body: string
  /** html_url pointing at the specific comment/review — useful for the UI and the LLM */
  url: string
  /** Only present for review-comment: the file path and line the reviewer pointed at */
  path?: string
  line?: number
  /** Only present for review: state = APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED */
  state?: string
}

type IssueCommentApi = { user: { login: string } | null; body: string; created_at: string; html_url: string }
type ReviewApi = { user: { login: string } | null; body: string | null; submitted_at: string | null; html_url: string; state: string }
type ReviewCommentApi = { user: { login: string } | null; body: string; created_at: string; html_url: string; path: string; line?: number | null; original_line?: number | null }

/**
 * Fetch all human feedback on a PR since `sinceIso` (ISO-8601). Pass an empty
 * string or omit to get everything. Results are sorted by createdAt ascending
 * so the supervisor reads them in the order a human wrote them.
 *
 * Bot authors (logins ending in "[bot]") are filtered out — we don't want the
 * supervisor to react to CI/Dependabot chatter as though it were human review.
 */
/**
 * Resolve the login attached to a token. Used to filter the orchestrator's own
 * PR comments out of "reviewer feedback" — otherwise every @<user> comment
 * that the agent posts (via `gh pr comment` or API) comes back as input on the
 * next cycle, creating a self-referential loop.
 *
 * Returns null on any failure — callers should treat that as "don't filter"
 * rather than bubbling the error, since this is a defense-in-depth check.
 */
export async function getAuthenticatedUserLogin(input: {
  token: string
  fetchImpl?: GithubFetch
}): Promise<string | null> {
  const f = input.fetchImpl ?? fetch
  try {
    const res = await f(`${API_BASE}/user`, { headers: authHeaders(input.token) })
    if (!res.ok) return null
    const body = (await res.json()) as { login?: string }
    return typeof body.login === "string" && body.login ? body.login : null
  } catch {
    return null
  }
}

export async function listPullRequestFeedback(input: {
  owner: string
  repo: string
  number: number
  token: string
  sinceIso?: string
  /** Case-insensitive list of author logins to exclude. Primary use: filter
   *  the token-owner's own comments so the supervisor doesn't react to its
   *  own PR comments as though they were reviewer input. */
  excludeAuthors?: string[]
  fetchImpl?: GithubFetch
}): Promise<PullRequestFeedback[]> {
  const f = input.fetchImpl ?? fetch
  const headers = authHeaders(input.token)
  const since = input.sinceIso ?? ""
  const sinceParam = since ? `?since=${encodeURIComponent(since)}` : ""

  const issueCommentsUrl = `${API_BASE}/repos/${input.owner}/${input.repo}/issues/${input.number}/comments${sinceParam}`
  const reviewCommentsUrl = `${API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.number}/comments${sinceParam}`
  const reviewsUrl = `${API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.number}/reviews`

  const [issueRes, reviewCommentRes, reviewsRes] = await Promise.all([
    f(issueCommentsUrl, { headers }),
    f(reviewCommentsUrl, { headers }),
    f(reviewsUrl, { headers }),
  ])

  for (const [name, res] of [["issues", issueRes], ["pr-comments", reviewCommentRes], ["reviews", reviewsRes]] as const) {
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`GitHub PR feedback fetch (${name}) failed (${res.status}): ${text.slice(0, 200)}`)
    }
  }

  const issueComments = (await issueRes.json()) as IssueCommentApi[]
  const reviewComments = (await reviewCommentRes.json()) as ReviewCommentApi[]
  const reviews = (await reviewsRes.json()) as ReviewApi[]

  const sinceMs = since ? Date.parse(since) : 0

  const excluded = new Set((input.excludeAuthors ?? []).map(s => s.toLowerCase()))
  const isHuman = (login: string | undefined | null): boolean => {
    if (!login) return false
    if (login.endsWith("[bot]")) return false
    if (excluded.has(login.toLowerCase())) return false
    return true
  }

  const merged: PullRequestFeedback[] = []

  for (const c of issueComments) {
    if (!isHuman(c.user?.login)) continue
    merged.push({
      kind: "issue-comment",
      author: c.user!.login,
      createdAt: c.created_at,
      body: c.body ?? "",
      url: c.html_url,
    })
  }

  for (const c of reviewComments) {
    if (!isHuman(c.user?.login)) continue
    merged.push({
      kind: "review-comment",
      author: c.user!.login,
      createdAt: c.created_at,
      body: c.body ?? "",
      url: c.html_url,
      path: c.path,
      line: c.line ?? c.original_line ?? undefined,
    })
  }

  // /reviews doesn't support ?since — filter client-side.
  for (const r of reviews) {
    if (!isHuman(r.user?.login)) continue
    if (!r.submitted_at) continue
    if (sinceMs && Date.parse(r.submitted_at) <= sinceMs) continue
    // Skip reviews with no body AND neutral state — they're just an approve click with nothing to say
    const hasBody = (r.body ?? "").trim().length > 0
    if (!hasBody && r.state !== "CHANGES_REQUESTED" && r.state !== "APPROVED") continue
    merged.push({
      kind: "review",
      author: r.user!.login,
      createdAt: r.submitted_at,
      body: r.body ?? "",
      url: r.html_url,
      state: r.state,
    })
  }

  merged.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  return merged
}
