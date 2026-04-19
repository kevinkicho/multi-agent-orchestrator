/**
 * Repo identity helpers — used by the project manager to decide:
 *  (a) whether a "project" being added is the orchestrator's own repo (self-ingest guard)
 *  (b) what canonical agent name to use for a project (prefer repo slug over folder basename)
 *
 * Pure functions for URL normalization + name derivation are exported and tested
 * directly. Functions that touch the filesystem accept a git-runner so tests can
 * inject stubs.
 */

import { resolve } from "path"
import { basename } from "path"

export type GitRunner = (cwd: string, ...args: string[]) => Promise<string>

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/** Normalize a git remote URL for equality comparison.
 *  Collapses https/ssh/git forms, strips trailing .git, lowercases host, and
 *  drops leading user segment on ssh URLs. Returns null for unparseable input. */
export function normalizeGitUrl(url: string): string | null {
  if (!url) return null
  let s = url.trim()
  if (!s) return null

  // git@host:owner/repo.git  →  host/owner/repo
  const sshMatch = s.match(/^[^@\s]+@([^:\s]+):(.+)$/)
  if (sshMatch) {
    s = `${sshMatch[1]}/${sshMatch[2]}`
  } else {
    // Strip scheme + optional user@ (https://, ssh://, git://, etc.)
    s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\/(?:[^@/]+@)?/i, "")
  }

  // Lowercase host (first path segment)
  const firstSlash = s.indexOf("/")
  if (firstSlash > 0) {
    s = s.slice(0, firstSlash).toLowerCase() + s.slice(firstSlash)
  } else {
    s = s.toLowerCase()
  }

  // Strip trailing .git and trailing slashes
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "")

  return s || null
}

// ---------------------------------------------------------------------------
// Repo name derivation
// ---------------------------------------------------------------------------

/** Extract the repo slug (last path segment) from a normalized or raw URL.
 *  Returns null if the URL has no recognizable slug. */
export function repoSlugFromUrl(url: string): string | null {
  const normalized = normalizeGitUrl(url)
  if (!normalized) return null
  const parts = normalized.split("/").filter(Boolean)
  const last = parts[parts.length - 1]
  if (!last) return null
  return last
}

/** Slugify an arbitrary project name into an agent-name-safe identifier.
 *  Lowercase, only [a-z0-9-], collapses consecutive dashes, trims leading/trailing dashes. */
export function slugifyAgentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
}

// ---------------------------------------------------------------------------
// Self-ingest detection
// ---------------------------------------------------------------------------

export type RepoIdentityDeps = {
  /** Resolver for `git remote get-url <remote>` — kept for `canonicalAgentName`
   *  which still uses it; `isOrchestratorRepo` itself no longer calls it. */
  getOriginUrl: (cwd: string) => Promise<string | null>
  /** Absolute path of the orchestrator's own repo root (defaults to process.cwd()). */
  orchestratorRoot?: string
}

/** True when `directory` resolves to the exact running orchestrator root.
 *  Guards against a genuine footgun: creating `agent/` branches inside the
 *  working tree currently executing the orchestrator. Sibling clones that
 *  share the same `origin` URL at a different path are allowed — their
 *  supervisor cuts branches inside the clone, not the running tree. */
export async function isOrchestratorRepo(directory: string, deps: RepoIdentityDeps): Promise<boolean> {
  const root = resolve(deps.orchestratorRoot ?? process.cwd())
  const target = resolve(directory)
  return target === root
}

/** Derive the canonical agent name for a project directory.
 *  Prefers the repo slug from the `origin` remote URL so two clones of the same
 *  repo land on the same agent name (and therefore share archived memory).
 *  Falls back to slugifying the provided name (or the directory basename). */
export async function canonicalAgentName(
  directory: string,
  fallbackName: string | undefined,
  deps: RepoIdentityDeps,
): Promise<string> {
  const originUrl = await deps.getOriginUrl(directory).catch(() => null)
  if (originUrl) {
    const slug = repoSlugFromUrl(originUrl)
    if (slug) {
      const sanitized = slugifyAgentName(slug)
      if (sanitized) return sanitized
    }
  }
  const name = fallbackName && fallbackName.trim() ? fallbackName : basename(resolve(directory))
  return slugifyAgentName(name) || "project"
}
