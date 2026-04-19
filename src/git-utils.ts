/**
 * Shared git utilities — used by analytics (A/B testing), project-manager (branch isolation),
 * and supervisor (false progress detection, resource contention).
 */

// ---------------------------------------------------------------------------
// Core exec helper
// ---------------------------------------------------------------------------

export async function gitExec(cwd: string, ...args: string[]): Promise<string> {
  // Flatten so callers can pass "status --porcelain" or "status", "--porcelain"
  const flatArgs = args.flatMap(a => a.split(" ").filter(Boolean))
  const proc = Bun.spawn(["git", ...flatArgs], { cwd, stdout: "pipe", stderr: "pipe" })
  // Read stdout and stderr concurrently before awaiting exit
  const [out, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`git ${flatArgs[0]} failed (code ${code}): ${stderr.trim()}`)
  }
  return out.trim()
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

export type GitDiffStat = {
  filesChanged: string[]
  summary: string
  isEmpty: boolean
}

/** Get diff stat for uncommitted changes (staged + unstaged) */
export async function gitDiffStat(cwd: string): Promise<GitDiffStat> {
  // Check both staged and unstaged changes
  const [unstaged, staged] = await Promise.all([
    gitExec(cwd, "diff", "--stat").catch(() => ""),
    gitExec(cwd, "diff", "--cached", "--stat").catch(() => ""),
  ])
  const summary = [unstaged, staged].filter(Boolean).join("\n")
  const filesChanged: string[] = []

  // Parse file names from --stat output (lines like " src/foo.ts | 5 +++--")
  for (const line of summary.split("\n")) {
    const match = line.match(/^\s*(.+?)\s*\|/)
    if (match && match[1]) filesChanged.push(match[1].trim())
  }

  return { filesChanged, summary, isEmpty: filesChanged.length === 0 }
}

/** Get list of changed file paths (uncommitted: staged + unstaged) */
export async function gitDiffNameOnly(cwd: string, base?: string): Promise<string[]> {
  const args = base ? ["diff", "--name-only", base] : ["diff", "--name-only", "HEAD"]
  let output: string
  try {
    output = await gitExec(cwd, ...args)
  } catch {
    // HEAD may not exist (first commit) — try without it
    output = await gitExec(cwd, "diff", "--name-only")
  }
  // Also include staged changes
  const staged = await gitExec(cwd, "diff", "--cached", "--name-only").catch(() => "")
  const all = [output, staged].filter(Boolean).join("\n")
  return all.split("\n").map(f => f.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Branch helpers
// ---------------------------------------------------------------------------

/** Get current branch name */
export async function gitCurrentBranch(cwd: string): Promise<string> {
  return gitExec(cwd, "rev-parse", "--abbrev-ref", "HEAD")
}

/** Create and checkout a new branch */
export async function gitCreateBranch(cwd: string, branchName: string, from?: string): Promise<void> {
  if (from) {
    await gitExec(cwd, "checkout", "-b", branchName, from)
  } else {
    await gitExec(cwd, "checkout", "-b", branchName)
  }
}

/** Checkout an existing branch */
export async function gitCheckout(cwd: string, branch: string): Promise<void> {
  await gitExec(cwd, "checkout", branch)
}

/** Merge a branch into the current branch. Returns success status and output. */
export async function gitMerge(cwd: string, branch: string): Promise<{ success: boolean; output: string }> {
  try {
    const output = await gitExec(cwd, "merge", branch)
    return { success: true, output }
  } catch (err) {
    // Merge conflicts — abort the merge so the repo isn't left in a dirty state
    await gitExec(cwd, "merge", "--abort").catch(() => {})
    return { success: false, output: String(err) }
  }
}

/** Delete a local branch (non-force — will fail if unmerged) */
export async function gitDeleteBranch(cwd: string, branch: string): Promise<void> {
  await gitExec(cwd, "branch", "-d", branch)
}

/** Force-delete a local branch (for cleanup) */
export async function gitForceDeleteBranch(cwd: string, branch: string): Promise<void> {
  await gitExec(cwd, "branch", "-D", branch)
}

// ---------------------------------------------------------------------------
// Info helpers
// ---------------------------------------------------------------------------

/** Get latest commit as one-line summary */
export async function gitLatestCommit(cwd: string): Promise<string> {
  return gitExec(cwd, "log", "--oneline", "-1")
}

/** Check if working tree is clean (no uncommitted changes) */
export async function gitIsClean(cwd: string): Promise<boolean> {
  const output = await gitExec(cwd, "status", "--porcelain")
  return output === ""
}

/** Get URL for a named remote (default origin), or null if the remote isn't configured. */
export async function gitRemoteUrl(cwd: string, remote = "origin"): Promise<string | null> {
  try {
    const url = await gitExec(cwd, "remote", "get-url", remote)
    return url.trim() || null
  } catch {
    return null
  }
}

/** Check if a local branch with the given name exists. */
export async function gitBranchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await gitExec(cwd, "rev-parse", "--verify", `refs/heads/${branch}`)
    return true
  } catch {
    return false
  }
}

/** Check if a branch exists on the named remote. */
export async function gitRemoteBranchExists(cwd: string, branch: string, remote = "origin"): Promise<boolean> {
  try {
    const output = await gitExec(cwd, "ls-remote", "--heads", remote, branch)
    return output.trim().length > 0
  } catch {
    return false
  }
}

/** Check if a branch exists on an arbitrary remote URL, without a local clone.
 *  Used by the Add Project modal to validate baseBranch before cloning. */
export async function gitLsRemoteUrlHasBranch(url: string, branch: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "ls-remote", "--heads", url, branch], {
      stdout: "pipe", stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) return false
    return out.trim().length > 0
  } catch {
    return false
  }
}

/** Resolve the remote's default branch (what `HEAD` points at).
 *  Works for both a local repo (`cwd` of a clone) and an arbitrary remote URL.
 *  Returns null if detection fails — caller should fall back to "main". */
export async function gitRemoteDefaultBranch(
  target: string,
  kind: "dir" | "url",
): Promise<string | null> {
  try {
    const args = kind === "url"
      ? ["ls-remote", "--symref", target, "HEAD"]
      : ["ls-remote", "--symref", "origin", "HEAD"]
    const proc = Bun.spawn(kind === "url" ? ["git", ...args] : ["git", ...args], {
      cwd: kind === "dir" ? target : undefined,
      stdout: "pipe", stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) return null
    // Format: "ref: refs/heads/main\tHEAD\n<sha>\tHEAD"
    const match = out.match(/ref:\s*refs\/heads\/([^\s]+)\s+HEAD/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** List local branches matching an optional glob pattern (e.g. `agent/foo-*`).
 *  Returns an empty array if the pattern matches nothing or git is unavailable. */
export async function gitListBranches(cwd: string, pattern?: string): Promise<string[]> {
  try {
    const args = ["branch", "--list", "--format=%(refname:short)"]
    if (pattern) args.push(pattern)
    const output = await gitExec(cwd, ...args)
    return output.split("\n").map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** Extract `{ owner, repo }` from a GitHub remote URL. Returns `null` for
 *  non-GitHub URLs or unparseable input. Accepts both HTTPS and SSH forms:
 *    - https://github.com/owner/repo(.git)?
 *    - http(s)://github.com/owner/repo(.git)?
 *    - git@github.com:owner/repo(.git)?
 *    - ssh://git@github.com/owner/repo(.git)? */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  // Matches both `github.com/owner/repo` (https/ssh-URL forms) and
  // `github.com:owner/repo` (scp-style git@github.com:owner/repo).
  const match = url.match(/github\.com[/:]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (!match) return null
  const owner = match[1]!.trim()
  const repo = match[2]!.trim()
  if (!owner || !repo) return null
  return { owner, repo }
}

/** Count commits on `head` that are not on `base` (i.e. how far `head` is ahead of `base`).
 *  Returns 0 if either ref is missing or the comparison fails. */
export async function gitCommitsAhead(cwd: string, base: string, head: string): Promise<number> {
  try {
    const output = await gitExec(cwd, "rev-list", "--count", `${base}..${head}`)
    const n = parseInt(output.trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** Count commits on `base` that aren't on `head` — i.e. how far `head` is behind `base`.
 *  Mirror of gitCommitsAhead; useful when asking "is the agent branch stale vs base?" */
export async function gitCommitsBehind(cwd: string, base: string, head: string): Promise<number> {
  return gitCommitsAhead(cwd, head, base)
}
