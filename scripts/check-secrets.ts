#!/usr/bin/env bun
/**
 * Pre-commit secret scanner. Runs against files staged for commit (or the
 * whole tree when invoked without `--staged`) and fails if any match a known
 * secret pattern. Purpose: a belt-and-braces guard on top of `.gitignore`, so
 * a `git add -f .env` or a hardcoded token in a new source file is blocked
 * at commit time instead of showing up on github.
 *
 * Usage:
 *   bun run scripts/check-secrets.ts           # scan working tree (tracked files only)
 *   bun run scripts/check-secrets.ts --staged  # scan only files staged for commit (for pre-commit hook)
 */

import { spawnSync } from "child_process"
import { readFileSync, existsSync } from "fs"

// Intentionally narrow: we want true-positives that unambiguously identify a
// secret. Broad patterns (e.g. any 40-char hex) produce false positives on
// commit hashes and test fixtures, training the user to ignore the tool.
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "GitHub classic PAT", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "GitHub OAuth token", re: /gho_[A-Za-z0-9]{20,}/ },
  { name: "GitHub server token", re: /ghs_[A-Za-z0-9]{20,}/ },
  { name: "GitHub fine-grained PAT", re: /github_pat_[A-Za-z0-9_]{30,}/ },
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_\-]{30,}/ },
  { name: "OpenAI API key", re: /sk-(?:proj-)?[A-Za-z0-9_\-]{40,}/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_\-]{30,}/ },
  { name: "AWS access key ID", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Generic 'Bearer ' header with long token", re: /Bearer\s+[A-Za-z0-9_\-]{40,}/ },
]

// Files this scanner must never flag on itself. The patterns list above
// literally contains the strings we're looking for — without an allowlist the
// scanner would self-immolate on first run.
const SELF_EXEMPT = new Set<string>([
  "scripts/check-secrets.ts",
  "scripts\\check-secrets.ts",
])

function isBinary(buf: Buffer): boolean {
  // Cheap heuristic — check for NUL in the first 8KB. Binary files aren't
  // searchable with regex and would blow up the scanner with garbage.
  const slice = buf.slice(0, 8192)
  for (let i = 0; i < slice.length; i++) if (slice[i] === 0) return true
  return false
}

function listStagedFiles(): string[] {
  const out = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf-8" })
  if (out.status !== 0) {
    console.error("[check-secrets] git diff failed:", out.stderr)
    process.exit(2)
  }
  return out.stdout.split("\n").map(s => s.trim()).filter(Boolean)
}

function listTrackedFiles(): string[] {
  const out = spawnSync("git", ["ls-files"], { encoding: "utf-8" })
  if (out.status !== 0) {
    console.error("[check-secrets] git ls-files failed:", out.stderr)
    process.exit(2)
  }
  return out.stdout.split("\n").map(s => s.trim()).filter(Boolean)
}

function main(): void {
  const staged = process.argv.includes("--staged")
  const files = staged ? listStagedFiles() : listTrackedFiles()
  if (files.length === 0) {
    console.log("[check-secrets] no files to scan")
    return
  }

  const findings: Array<{ file: string; line: number; pattern: string; excerpt: string }> = []
  for (const file of files) {
    if (SELF_EXEMPT.has(file.replaceAll("\\", "/"))) continue
    if (!existsSync(file)) continue // deleted in the staged set
    let buf: Buffer
    try {
      buf = readFileSync(file)
    } catch {
      continue
    }
    if (isBinary(buf)) continue
    const text = buf.toString("utf-8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      for (const { name, re } of PATTERNS) {
        const m = line.match(re)
        if (m) {
          findings.push({
            file, line: i + 1, pattern: name,
            excerpt: line.trim().slice(0, 120),
          })
        }
      }
    }
  }

  if (findings.length === 0) {
    console.log(`[check-secrets] OK — scanned ${files.length} file(s), no secret patterns found.`)
    return
  }

  console.error(`[check-secrets] FAIL — ${findings.length} potential secret(s) detected:`)
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.pattern}]  ${f.excerpt}`)
  }
  console.error("\n[check-secrets] Remove the secret, rotate it, and re-stage before committing.")
  console.error("[check-secrets] If this is a false positive, add a SELF_EXEMPT entry in scripts/check-secrets.ts.")
  process.exit(1)
}

main()
