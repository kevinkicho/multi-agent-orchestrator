import { spawn, type Subprocess } from "bun"
import { existsSync, readdirSync, statSync } from "fs"
import { resolve, basename } from "path"
import { platform } from "os"
import type { Orchestrator } from "./orchestrator"
import type { DashboardLog } from "./dashboard"
import { runAgentSupervisor, type ValidationPreset } from "./supervisor"
import { readJsonFile, writeJsonFile } from "./file-utils"
import { formatThought, C } from "./tui-format"
import { createPauseState, requestPause, requestResume, type PauseState } from "./pause-service"
import { clearAgentKnowledge } from "./shared-knowledge"
import {
  gitExec,
  gitCurrentBranch,
  gitCreateBranch,
  gitCheckout,
  gitMerge,
  gitIsClean,
  gitDeleteBranch,
  gitForceDeleteBranch,
  gitRemoteUrl,
  gitBranchExists,
  gitRemoteBranchExists,
  gitCommitsAhead,
  gitCommitsBehind,
  parseGithubRemote,
} from "./git-utils"
import { openOrReusePullRequest, findOpenPullRequest, listPullRequestFeedback, getAuthenticatedUserLogin, updatePullRequestBase, type PullRequestRef, type PullRequestFeedback } from "./github-api"
import { isOrchestratorRepo, canonicalAgentName } from "./repo-identity"
import type { EventBus } from "./event-bus"
import type { ResourceManager } from "./resource-manager"
import { archiveAgentMemory, hasAgentArchive, restoreAgentMemory } from "./brain-memory"
import { resolveDefaultModel, validateModelRoutable, parseModelRef, selectProjectModel, toAgentModelRef } from "./providers"
import {
  type Responsibility,
  buildDefaultResponsibilities,
  reconcileResponsibilities,
  resolveValidationConfig,
  applyValidationConfig,
} from "./responsibilities"

// ---------------------------------------------------------------------------
// Process tree cleanup — kills a process and all its descendants
// ---------------------------------------------------------------------------

async function killProcessTree(pid: number): Promise<void> {
  try {
    if (platform() === "win32") {
      // taskkill /T kills the entire process tree on Windows
      const proc = spawn(["taskkill", "/F", "/T", "/PID", String(pid)], {
        stdout: "ignore", stderr: "ignore",
      })
      await proc.exited
    } else {
      // On Unix, kill the process group (negative PID)
      try { process.kill(-pid, "SIGKILL") } catch {
        // Fallback: just kill the process itself
        try { process.kill(pid, "SIGKILL") } catch {}
      }
    }
  } catch {
    // Process may already be dead — that's fine
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultPullRequestBody(project: { name: string; directive: string; agentBranch?: string; baseBranch?: string }): string {
  const directive = project.directive?.trim() || "(no directive)"
  return [
    `Automated PR opened by the multi-agent-orchestrator.`,
    ``,
    `- **Project:** ${project.name}`,
    `- **Source branch:** \`${project.agentBranch ?? "(unknown)"}\``,
    `- **Target branch:** \`${project.baseBranch ?? "main"}\``,
    ``,
    `**Current directive:**`,
    ``,
    `> ${directive.split("\n").join("\n> ")}`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DirectiveHistoryEntry = {
  timestamp: number
  text: string
  source: "user" | "supervisor"
  /** Optional user comment/feedback for the supervisor to read */
  comment?: string
  /** Whether the supervisor has read this comment */
  commentRead?: boolean
  /** The last completed cycle number when this edit was made. Undefined if no cycle has completed yet. */
  cycleNumber?: number
}

export type ProjectState = {
  id: string
  name: string
  directory: string
  directive: string
  workerPort: number
  agentName: string
  /** Primary model for this project's worker (opencode session). Also used by the
   *  supervisor when `supervisorModel` is unset. Falls back to the first enabled
   *  provider's first model when both are absent. */
  model?: string
  /** Optional override for the supervisor's planning LLM only. When set, the
   *  worker keeps using `model` and the supervisor uses this instead. Typical
   *  use: run a cheap/fast model for planning while keeping a more capable one
   *  for code generation, or isolate a drained per-model quota to one side. */
  supervisorModel?: string
  /** History of directive changes with source tracking and user comments */
  directiveHistory: DirectiveHistoryEntry[]
  /** Fast-access queue for unread comments (avoids iterating full history) */
  pendingComments: string[]
  status: "starting" | "running" | "supervising" | "stopped" | "error"
  addedAt: number
  error?: string
  pauseStatus?: "none" | "requested" | "paused"
  pauseRequestedAt?: number
  pausedAt?: number
  /** Git branch this agent works on (for branch isolation) */
  agentBranch?: string
  /** Base branch the agent branch was cut from — used as merge target and for unmerged-work detection. */
  baseBranch?: string
  /** ISO-8601 timestamp of the last time the supervisor was shown PR feedback.
   *  Drives the `since` filter for listPullRequestFeedback — comments/reviews
   *  newer than this are what the supervisor reads on the next cycle. Absent
   *  means "never checked" → the supervisor sees everything the first time. */
  lastPrFeedbackCheckAt?: string
  /** Post-cycle validation config (legacy; responsibility "supervisor.run-validation" takes precedence) */
  postCycleValidation?: { command?: string; preset?: ValidationPreset; timeoutMs?: number; failAction?: "warn" | "inject" | "pause" }
  /** Per-project responsibilities (toggleable capabilities). Reconciled against the catalog on load. */
  responsibilities?: Responsibility[]
  /** Chronological log of significant git/PR transactions on this project —
   *  clone, push, PR open/merge, base-branch change, local merge, remote delete.
   *  Rendered alongside directive history in the dashboard's History drawer so
   *  the user can see the project's lifecycle as a single timeline. Capped at
   *  200 entries to keep orchestrator.json compact; oldest are dropped first. */
  timeline?: TimelineEvent[]
}

export type TimelineEventKind =
  | "cloned"
  | "branch-pushed"
  | "pull-request-opened"
  | "pull-request-reused"
  | "pull-request-retargeted"
  | "base-branch-changed"
  | "branch-merged"
  | "remote-branch-deleted"

export type TimelineEvent = {
  timestamp: number
  kind: TimelineEventKind
  /** One-line human-readable summary — what shows in the drawer row */
  summary: string
  /** Optional structured payload for kind-specific details (branch names,
   *  PR number/url, etc.). Not surfaced in the UI directly — future UIs
   *  or exports can consume it. */
  details?: Record<string, unknown>
}

/** Snapshot of git/github state for a project — returned by getGitInfo() and
 *  rendered in the "Git/GitHub" drawer tab. */
export type GitInfo = {
  originUrl: string | null
  githubOwner: string | null
  githubRepo: string | null
  agentBranch: string | null
  baseBranch: string | null
  tokenDetected: boolean
  commitsAhead: number
  commitsBehind: number
  openPullRequest: { url: string; number: number } | null
  branchExistsOnRemote: boolean
  /** Unread reviewer feedback on the open PR (comments + reviews + review-comments
   *  newer than lastPrFeedbackCheckAt). The supervisor ingests these at the top
   *  of each cycle; the UI surfaces the count so the user knows the loop is alive. */
  pendingPrFeedbackCount: number
  /** ISO-8601 of the newest feedback item already ingested — tells the user
   *  when the supervisor last caught up. null = never. */
  lastPrFeedbackCheckAt: string | null
}

/** Optional knobs passed to addProject. Any callers that don't set these get
 *  the previous behavior. */
export type AddProjectOptions = {
  /** Branch to cut the agent branch off of. Falls back to current HEAD when absent. */
  baseBranch?: string
  /** Restore a persisted responsibilities list (used by restoreProjects). Reconciled against catalog. */
  responsibilities?: Responsibility[]
  /** Pre-select a `provider:model` (or bare ollama model) for this project's worker
   *  (and, when `supervisorModel` is unset, its supervisor). When absent, the
   *  supervisor falls back to resolveDefaultModel(). */
  model?: string
  /** Optional supervisor-only override — see ProjectState.supervisorModel. */
  supervisorModel?: string
  /** Restore the persisted PR-feedback cursor so we don't re-surface feedback the
   *  supervisor already saw in a previous process. */
  lastPrFeedbackCheckAt?: string
  /** Restore a persisted git/PR transaction timeline from disk (used by
   *  restoreProjects so history survives orchestrator restarts). */
  timeline?: TimelineEvent[]
}

type SavedProjects = {
  projects: Array<{
    name: string
    directory: string
    directive: string
    model?: string
    supervisorModel?: string
    directiveHistory?: DirectiveHistoryEntry[]
    baseBranch?: string
    responsibilities?: Responsibility[]
    lastPrFeedbackCheckAt?: string
    timeline?: TimelineEvent[]
  }>
}

// ---------------------------------------------------------------------------
// Port utilities
// ---------------------------------------------------------------------------

const PORT_MIN = 10000
const PORT_MAX = 60000
const usedPorts = new Set<number>()

function randomPort(): number {
  return PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN))
}

async function findFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = randomPort()
    if (usedPorts.has(port)) continue
    usedPorts.add(port) // reserve before testing
    try {
      const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") })
      server.stop(true) // force-close immediately so port is released
      return port // already in usedPorts
    } catch {
      usedPorts.delete(port) // release failed reservation
    }
  }
  throw new Error("Cannot find free port after 100 attempts")
}

// ---------------------------------------------------------------------------
// Server health check
// ---------------------------------------------------------------------------

async function waitForServer(url: string, timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/global/health`)
      if (res.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

// ---------------------------------------------------------------------------
// Directory browser (for dashboard folder picker)
// ---------------------------------------------------------------------------

export function listDirectories(dirPath: string): Array<{ name: string; path: string }> {
  try {
    const resolved = resolve(dirPath)
    if (!existsSync(resolved)) return []
    const entries = readdirSync(resolved)
    const dirs: Array<{ name: string; path: string }> = []

    // Add parent directory
    const parent = resolve(resolved, "..")
    if (parent !== resolved) {
      dirs.push({ name: "..", path: parent })
    }

    for (const entry of entries) {
      // Skip hidden/system directories
      if (entry.startsWith(".") || entry === "node_modules" || entry === "$RECYCLE.BIN" || entry === "System Volume Information") continue
      try {
        const fullPath = resolve(resolved, entry)
        if (statSync(fullPath).isDirectory()) {
          dirs.push({ name: entry, path: fullPath })
        }
      } catch {
        // Permission denied or broken symlink — skip
      }
    }
    return dirs
  } catch {
    return []
  }
}

/**
 * Build the environment variables a worker subprocess should run under, given
 * the parent's env and the security policy. Pure function — exported so it
 * can be tested without spawning a real process. The behavior matters for
 * blast-radius reduction: default is "none" (strip GITHUB_TOKEN and GH_TOKEN)
 * so a prompt-injected worker cannot push to arbitrary repos. Operators who
 * want the worker to have GitHub write access must opt in via "full".
 */
export function computeWorkerSpawnEnv(
  parentEnv: Record<string, string | undefined>,
  resolvedDir: string,
  policy: { workerGithubAccess?: "none" | "full" },
): Record<string, string | undefined> {
  const access = policy.workerGithubAccess ?? "none"
  const base: Record<string, string | undefined> = { ...parentEnv }
  if (access === "none") {
    delete base.GITHUB_TOKEN
    delete base.GH_TOKEN
  }
  const env: Record<string, string | undefined> = {
    ...base,
    OPENCODE_PROJECT_DIR: resolvedDir,
  }
  if (access === "full" && parentEnv.GITHUB_TOKEN && !parentEnv.GH_TOKEN) {
    env.GH_TOKEN = parentEnv.GITHUB_TOKEN
  }
  return env
}

// ---------------------------------------------------------------------------
// ProjectManager
// ---------------------------------------------------------------------------

import { getOpencodeLaunch, buildOpencodeSpawnCmd } from "./opencode-runtime"

const PROJECTS_FILE = "orchestrator-projects.json"

export class ProjectManager {
  private projects = new Map<string, ProjectState>()
  private processes = new Map<string, Subprocess>()
  private supervisorAborts = new Map<string, AbortController>()
  private softStops = new Map<string, { requested: boolean }>()
  /** Pending auto-restart timers — tracked so they can be cancelled on remove/restart */
  private autoRestartTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Track auto-restart counts per project — resets on successful cycle completion */
  private autoRestartCounts = new Map<string, number>()
  private static AUTO_RESTART_DELAYS = [10_000, 30_000, 60_000] // escalating: 10s, 30s, 60s for first 3 attempts
  private static BACKOFF_BASE_MS = 30_000 // base delay for exponential backoff after initial attempts
  private static BACKOFF_CAP_MS = 600_000 // cap at 10 minutes
  /** Track consecutive LLM circuit breaker trips per project — resets on successful cycle completion */
  private llmCircuitBreakerCounts = new Map<string, number>()
  private static LLM_CIRCUIT_BREAKER_COOLDOWN_MS = 300_000 // 5-minute cooldown after LLM circuit breaker
  private pauseStates = new Map<string, PauseState>()
  /** Live directive refs per project — supervisor reads .value at each cycle boundary, so updateDirective can hot-swap without restart. */
  private directiveRefs = new Map<string, { value: string }>()
  /** Last completed cycle number per project — stamped on directive history entries for cross-reference. */
  private lastCycleNumbers = new Map<string, number>()
  /** Lock that serializes all project mutations (add/remove/restart) to prevent races */
  private projectLock: Promise<void> = Promise.resolve()
  private idCounter = 0
  /** Cached login of the user that owns GITHUB_TOKEN. Resolved lazily on the
   *  first PR-feedback fetch and cached for the process lifetime. Used to
   *  filter the orchestrator's own PR comments out of reviewer-feedback so
   *  the supervisor doesn't react to its own posts as though they were human
   *  review. `undefined` = not yet resolved; `null` = resolved and absent
   *  (/user call failed — we fall back to no-filter). */
  private githubSelfLogin: string | null | undefined = undefined
  /** Per-project TTL cache for getGitInfo snapshots. Dashboard polls this
   *  endpoint on every drawer open; each call fires `GET /pulls` + `GET /user`
   *  + (when an open PR exists) the feedback-merge triad, so repeated polls
   *  burn GitHub REST rate-limit unnecessarily. 30s TTL collapses idle polling
   *  to one upstream round-trip per project per window while remaining short
   *  enough that post-mutation freshness feels immediate — any write path
   *  (push/PR/delete/merge/setBase) invalidates its project's entry directly. */
  private gitInfoCache = new Map<string, { expiresAt: number; value: GitInfo }>()
  private readonly gitInfoCacheTtlMs = 30_000

  constructor(
    private orchestrator: Orchestrator,
    private dashLog: DashboardLog,
    /** Legacy brain config. `model` is optional — per-project models take precedence,
     *  with resolveDefaultModel() as the primary fallback and brainConfig.model as a
     *  last-resort legacy fallback for configs that still set it in orchestrator.json. */
    private brainConfig: { model?: string; ollamaUrl: string },
    private supervisorLimits?: import("./supervisor").SupervisorLimits,
    private eventBus?: EventBus,
    private resourceManager?: ResourceManager,
    /** Spawn-env security policy. Default is "none" — workers do NOT inherit
     *  GITHUB_TOKEN / GH_TOKEN; all GitHub ops route through the ProjectManager.
     *  Opt into "full" in orchestrator.json if the worker needs direct GitHub
     *  write access (e.g. pushing from within a tool call). */
    private securityConfig: { workerGithubAccess?: "none" | "full" } = {},
  ) {
    // Mirror validation outcomes into the owning project's responsibility so
    // lastStatus/lastRunAt survive restarts and are visible in the checklist UI.
    this.eventBus?.on({ type: "validation-result" }, (event) => {
      const project = Array.from(this.projects.values()).find(p => p.agentName === event.agentName)
      if (!project) return
      const data = event.data as { passed?: boolean; command?: string; exitCode?: number } | undefined
      const detail = data?.command
        ? `${data.command}${data.exitCode != null ? ` (exit ${data.exitCode})` : ""}`
        : undefined
      this.recordResponsibilityOutcome(
        project.id,
        "supervisor.run-validation",
        data?.passed ? "success" : "failure",
        detail,
      )
    })
  }

  /** Clone a GitHub repo into `<parentDirectory>/<repoName>` and return the
   *  resulting absolute path. Uses GITHUB_TOKEN auth (GIT_CONFIG_COUNT pattern)
   *  when set — required for private repos, transparently skipped for public ones.
   *
   *  Refuses to overwrite an existing non-empty target; the caller should pick a
   *  different parent or delete the existing directory first. The clone itself
   *  goes through git's own fetch, so partial failures leave a `.git/` shell that
   *  `existsSync` would see as populated — we detect this by checking for HEAD. */
  async cloneGithubRepo(gitUrl: string, parentDirectory: string, opts?: { targetName?: string }): Promise<string> {
    const url = gitUrl.trim()
    if (!url) throw new Error("GitHub URL is required")
    const parsed = parseGithubRemote(url)
    if (!parsed) {
      throw new Error(`Not a GitHub URL: ${url} — only github.com URLs are supported (HTTPS or SSH).`)
    }
    const parentResolved = resolve(parentDirectory.trim())
    if (!existsSync(parentResolved)) {
      throw new Error(`Parent directory does not exist: ${parentResolved}`)
    }
    const targetName = opts?.targetName?.trim() || parsed.repo
    const targetDir = resolve(parentResolved, targetName)
    if (existsSync(targetDir)) {
      const entries = readdirSync(targetDir)
      if (entries.length > 0) {
        throw new Error(`Target already exists and is not empty: ${targetDir}`)
      }
    }

    const token = process.env.GITHUB_TOKEN
    const args = ["clone", url, targetDir]
    const { success, output } = token
      ? await this.runGithubAuthenticatedGit(parentResolved, args, token)
      : await (async () => {
          const proc = spawn({ cmd: ["git", ...args], cwd: parentResolved, stdout: "pipe", stderr: "pipe" })
          const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
          const code = await proc.exited
          return { success: code === 0, output: [out, err].filter(s => s.trim()).join("\n").trim() }
        })()
    if (!success) {
      throw new Error(`git clone failed: ${output}`)
    }
    this.dashLog.push({ type: "brain-thinking", text: `Cloned ${url} → ${targetDir}` })
    return targetDir
  }

  /** Add a project: spawns a worker agent and starts its supervisor.
   *  Uses a promise-chain mutex so concurrent mutations queue up instead of racing. */
  async addProject(
    directory: string,
    directive: string,
    name?: string,
    restoreHistory?: DirectiveHistoryEntry[],
    opts?: AddProjectOptions,
  ): Promise<ProjectState> {
    let resolve!: () => void
    const nextLock = new Promise<void>(r => { resolve = r })
    const prev = this.projectLock
    this.projectLock = nextLock

    // Wait for previous mutation to finish before starting ours
    await prev

    try {
      return await this._addProjectInner(directory, directive, name, restoreHistory, opts)
    } finally {
      resolve()
    }
  }

  private async _addProjectInner(
    directory: string,
    directive: string,
    name?: string,
    restoreHistory?: DirectiveHistoryEntry[],
    opts?: AddProjectOptions,
  ): Promise<ProjectState> {
    const resolvedDir = resolve(directory)
    if (!existsSync(resolvedDir)) {
      throw new Error(`Directory does not exist: ${resolvedDir}`)
    }

    // Self-ingest guard — refuse to add the exact directory currently running
    // the orchestrator. Prevents the supervisor from cutting `agent/` branches
    // inside its own working tree. Sibling clones at different paths (even
    // with matching `origin`) are allowed — their supervisor operates on the
    // clone, not the running tree.
    const isSelf = await isOrchestratorRepo(resolvedDir, {
      getOriginUrl: (cwd) => gitRemoteUrl(cwd),
    })
    if (isSelf) {
      throw new Error(
        `Refusing to add ${resolvedDir}: this is the directory currently running the orchestrator. ` +
        `Clone the repo to a different path and add that instead.`,
      )
    }

    const projectName = name || basename(resolvedDir)
    const id = `proj-${++this.idCounter}`
    let agentName = await canonicalAgentName(resolvedDir, projectName, {
      getOriginUrl: (cwd) => gitRemoteUrl(cwd),
    })

    // Check for duplicate directory — clean up dead entries, block truly active ones
    for (const [existingId, p] of this.projects.entries()) {
      if (p.directory === resolvedDir) {
        if (p.status === "stopped" || p.status === "error") {
          // Remove stale entry so re-add works cleanly
          this.projects.delete(existingId)
        } else {
          throw new Error(`Project at ${resolvedDir} is already active`)
        }
      }
    }

    // Ensure agent name is unique — append suffix if a different project already uses this name
    const baseAgentName = agentName
    let suffix = 1
    while (this.orchestrator.agents.has(agentName) ||
           Array.from(this.projects.values()).some(p => p.agentName === agentName && p.status !== "stopped" && p.status !== "error")) {
      agentName = `${baseAgentName}-${++suffix}`
    }

    const port = await findFreePort()

    const project: ProjectState = {
      id,
      name: projectName,
      directory: resolvedDir,
      directive,
      workerPort: port,
      agentName,
      model: opts?.model || undefined,
      supervisorModel: opts?.supervisorModel || undefined,
      directiveHistory: restoreHistory ?? [{ timestamp: Date.now(), text: directive, source: "user" as const }],
      pendingComments: [],
      status: "starting",
      addedAt: Date.now(),
      responsibilities: opts?.responsibilities
        ? reconcileResponsibilities(opts.responsibilities)
        : buildDefaultResponsibilities(),
      ...(opts?.lastPrFeedbackCheckAt ? { lastPrFeedbackCheckAt: opts.lastPrFeedbackCheckAt } : {}),
      ...(opts?.timeline && opts.timeline.length > 0 ? { timeline: opts.timeline } : {}),
    }

    this.projects.set(id, project)
    this.dashLog.push({ type: "brain-thinking", text: `Adding project: ${projectName} at ${resolvedDir} (port ${port})` })

    try {
      // Spawn opencode serve instance. We generate an opencode.json from our
      // own provider registry and point OPENCODE_CONFIG at it — without this,
      // opencode reads only its global config (~/.config/opencode/opencode.json)
      // and silently falls back to whatever default model that file has,
      // making our provider picker a no-op. (Cwd is NOT the right lever:
      // opencode resolves project config from the session's `directory` SDK
      // param, not from the serve process's cwd.)
      const launch = getOpencodeLaunch()
      const { prepareWorkerScratch } = await import("./opencode-config")
      const { loadProviders } = await import("./providers")
      const providers = await loadProviders()
      const scratchConfigPath = await prepareWorkerScratch(id, providers).catch((err) => {
        // Non-fatal: if we can't write the scratch config, fall through to
        // opencode's global config. Surface the reason so the user sees why
        // the worker is going to misroute.
        this.dashLog.push({ type: "brain-thinking", text: `[worker-spawn] Could not prepare opencode scratch config: ${err instanceof Error ? err.message : String(err)}` })
        return null
      })
      const spawnEnv = computeWorkerSpawnEnv(process.env, resolvedDir, this.securityConfig)
      if (scratchConfigPath) spawnEnv.OPENCODE_CONFIG = scratchConfigPath
      const proc = spawn({
        cmd: buildOpencodeSpawnCmd(launch, port),
        stdout: "pipe",
        stderr: "pipe",
        env: spawnEnv,
      })
      this.processes.set(id, proc)

      // Drain opencode's stdout/stderr into the dashboard log. Previously these
      // pipes were created and never read, so provider-load errors, missing-key
      // errors, and SDK loading failures disappeared — which is exactly how the
      // "Round N → no commands" stall hid the real failure for so long.
      this.streamOpencodeOutput(id, projectName, proc)

      // Monitor for unexpected process death
      this.monitorProcess(id, proc)

      // Wait for health check
      const url = `http://127.0.0.1:${port}`
      this.dashLog.push({ type: "brain-thinking", text: `Waiting for ${projectName} agent at ${url}...` })
      const healthy = await waitForServer(url)
      if (!healthy) {
        throw new Error(`Agent for ${projectName} failed to start on port ${port}`)
      }

      // Register with orchestrator. Include the project's model so the worker's
      // opencode session uses it (without a model field, opencode falls back to
      // its own default, making the dashboard's per-project model picker a no-op
      // for worker prompts).
      const workerModel = toAgentModelRef(project.model)
      await this.orchestrator.addAgent({
        name: agentName,
        url,
        directory: resolvedDir,
        ...(workerModel ? { model: workerModel } : {}),
      })

      project.status = "running"

      // Create agent-specific git branch for isolation
      try {
        const currentBranch = await gitCurrentBranch(resolvedDir)
        const branchName = `agent/${agentName}`

        // Resolve the base branch: explicit option wins; otherwise fall back to current HEAD.
        // If the requested base isn't present locally, try to materialize it from origin.
        let fromBranch = currentBranch
        const requestedBase = opts?.baseBranch?.trim()
        if (requestedBase) {
          if (await gitBranchExists(resolvedDir, requestedBase)) {
            fromBranch = requestedBase
          } else if (await gitRemoteBranchExists(resolvedDir, requestedBase)) {
            await gitExec(resolvedDir, "fetch", "origin", `${requestedBase}:${requestedBase}`).catch(() => {})
            if (await gitBranchExists(resolvedDir, requestedBase)) {
              fromBranch = requestedBase
              this.dashLog.push({ type: "brain-thinking", text: `Fetched ${requestedBase} from origin for ${projectName}` })
            } else {
              this.dashLog.push({
                type: "brain-thinking",
                text: `Requested base branch ${requestedBase} not available — branching from ${currentBranch} instead`,
              })
            }
          } else {
            this.dashLog.push({
              type: "brain-thinking",
              text: `Requested base branch ${requestedBase} not found locally or on origin — branching from ${currentBranch} instead`,
            })
          }
        }

        // Delete stale branch if it already exists (from a previous run that wasn't cleaned up)
        const existingBranches = await gitExec(resolvedDir, "branch", "--list", branchName).catch(() => "")
        if (existingBranches.trim()) {
          await gitForceDeleteBranch(resolvedDir, branchName).catch(() => {})
        }
        await gitCreateBranch(resolvedDir, branchName, fromBranch)
        project.agentBranch = branchName
        project.baseBranch = fromBranch
        this.dashLog.push({ type: "brain-thinking", text: `Created branch ${branchName} from ${fromBranch} for ${projectName}` })
        this.eventBus?.emit({
          type: "branch-created",
          source: "project-manager",
          agentName,
          projectId: id,
          data: { branch: branchName, from: fromBranch },
        })
      } catch (err) {
        // Non-fatal — branch isolation is optional (may not be a git repo)
        this.dashLog.push({ type: "brain-thinking", text: `Branch isolation skipped for ${projectName}: ${err}` })
      }

      // Restore archived memory if available (matched by agent name + directory hash)
      try {
        if (await hasAgentArchive(agentName, resolvedDir)) {
          await restoreAgentMemory(agentName, resolvedDir)
          this.dashLog.push({ type: "brain-thinking", text: `Restored archived memory for ${agentName}` })
        }
      } catch (err) {
        console.error(`[project-manager] Failed to restore archived memory for ${agentName}:`, err)
        this.dashLog.push({ type: "brain-thinking", text: `WARNING: Failed to restore archived memory for ${agentName}: ${err}` })
      }

      this.dashLog.push({ type: "brain-thinking", text: `${projectName} agent ready. Starting supervisor...` })

      // Save projects
      this.saveProjects()

      // Start supervisor in background
      this.startSupervisor(id)

      this.eventBus?.emit({
        type: "project-added",
        source: "project-manager",
        agentName,
        projectId: id,
        data: { name: projectName, directory: resolvedDir, branch: project.agentBranch },
      })

      return project
    } catch (err) {
      this.dashLog.push({ type: "brain-thinking", text: `Error adding ${projectName}: ${err}` })
      // Clean up — remove from map so re-add isn't blocked
      const proc = this.processes.get(id)
      if (proc) { killProcessTree(proc.pid).catch(() => {}); this.processes.delete(id) }
      this.projects.delete(id)
      usedPorts.delete(port)
      throw err
    }
  }

  /** Resolve the model a project should use. Delegates the tiered fallback to
   *  `selectProjectModel` (pure decision) and layers on contextual dashboard
   *  logging when a non-explicit tier is used. Throws when no route exists. */
  private async resolveProjectModel(project: ProjectState): Promise<string> {
    const defaultModel = await resolveDefaultModel()
    try {
      // Supervisor-only override wins when set; otherwise fall back to the
      // primary model (which the worker also uses). Keeps old projects working
      // without migration — supervisorModel defaults to undefined.
      const effective = project.supervisorModel ?? project.model
      const resolved = selectProjectModel(effective, defaultModel, this.brainConfig.model)
      if (resolved.source === "default") {
        this.dashLog.push({
          type: "brain-thinking",
          text: `${project.name}: no per-project model set — falling back to "${resolved.model}" (first enabled provider). Set a model on the project to pin this.`,
        })
      } else if (resolved.source === "legacy") {
        this.dashLog.push({
          type: "brain-thinking",
          text: `${project.name}: no enabled provider has a model configured — using legacy brain.model "${resolved.model}" from orchestrator.json.`,
        })
      }
      return resolved.model
    } catch {
      throw new Error(
        `Cannot start supervisor for "${project.name}": no model configured on the project and no enabled provider has a model available. Enable a provider with at least one model in the LLM Providers tab.`,
      )
    }
  }

  /** Start the supervisor brain for a project */
  private startSupervisor(projectId: string) {
    const project = this.projects.get(projectId)
    if (!project) return

    const ac = new AbortController()
    this.supervisorAborts.set(projectId, ac)
    const softStop = { requested: false }
    this.softStops.set(projectId, softStop)
    const pauseState = createPauseState()
    this.pauseStates.set(projectId, pauseState)
    const directiveRef = { value: project.directive }
    this.directiveRefs.set(projectId, directiveRef)

    project.status = "supervising"

    ;(async () => {
      try {
        const resolvedModel = await this.resolveProjectModel(project)
        const routable = await validateModelRoutable(resolvedModel)
        if (!routable.ok) {
          this.dashLog.push({
            type: "supervisor-alert",
            agent: project.agentName,
            text: `Model routing check failed for ${project.name}: ${routable.reason}. Enable the target provider or pick a different model.`,
          })
          project.status = "error"
          project.error = routable.reason
          return
        }
        await runAgentSupervisor(this.orchestrator, {
          ollamaUrl: this.brainConfig.ollamaUrl,
          model: resolvedModel,
          agentName: project.agentName,
          directory: project.directory,
          directive: project.directive,
          directiveRef,
          cyclePauseSeconds: this.supervisorLimits?.cyclePauseSeconds ?? 30,
          maxRoundsPerCycle: this.supervisorLimits?.maxRoundsPerCycle ?? 30,
          reviewEnabled: true,
          limits: this.supervisorLimits,
          dashboardLog: this.dashLog,
          signal: ac.signal,
          softStop,
          pauseState,
          postCycleValidation: resolveValidationConfig(project.responsibilities, project.postCycleValidation) as typeof project.postCycleValidation,
          eventBus: this.eventBus,
          resourceManager: this.resourceManager,
          // Fast coordination: listen for notifications from other agents
          urgentEventPatterns: this.eventBus ? [
            { type: "agent-notification" },
            { type: "resource-contention" },
            { type: "intent-conflict" },
          ] : undefined,
          onUrgentEvent: (event) => {
            if (event.agentName === project.agentName) return null
            if (event.type === "agent-notification") {
              return `Agent ${event.agentName} says: ${(event.data as Record<string, unknown>).message}`
            }
            if (event.type === "resource-contention") {
              const data = event.data as { conflicts?: Array<{ file: string; heldBy: string }> }
              const files = data.conflicts?.map(c => c.file).join(", ") ?? "unknown"
              return `[REDIRECT] Agent ${event.agentName} has file contention on: ${files}. Check if your work overlaps.`
            }
            if (event.type === "intent-conflict") {
              const data = event.data as { conflicts?: Array<{ agent: string; files: string[] }> }
              const details = data.conflicts?.map(c => `${c.agent}: ${c.files.join(", ")}`).join("; ") ?? "unknown"
              return `Agent ${event.agentName} declared work that overlaps with: ${details}. Coordinate to avoid conflicts.`
            }
            return null
          },
          onThinking: (thought) => {
            console.log(formatThought(project.agentName, thought))
          },
          onDirectiveUpdate: (newDirective) => {
            this.updateDirective(project.id, newDirective, "supervisor")
          },
          getUnreadComments: () => {
            return this.getUnreadComments(project.agentName)
          },
          getPendingPrFeedback: async () => {
            const items = await this.fetchPendingPullRequestFeedback(project.id)
            return items.map(f => ({
              kind: f.kind, author: f.author, createdAt: f.createdAt,
              body: f.body, url: f.url,
              ...(f.path ? { path: f.path } : {}),
              ...(f.line !== undefined ? { line: f.line } : {}),
              ...(f.state ? { state: f.state } : {}),
            }))
          },
          onPrFeedbackConsumed: (latestIso) => {
            this.markPullRequestFeedbackRead(project.id, latestIso)
          },
          onCycleComplete: (cycleNumber) => {
            // Successful cycle — reset auto-restart count and LLM breaker count (failure was transient)
            this.autoRestartCounts.delete(projectId)
            this.llmCircuitBreakerCounts.delete(projectId)
            this.lastCycleNumbers.set(projectId, cycleNumber)
          },
          onSupervisorStop: (agentName, summary, isFailure, reason) => {
            if (isFailure) {
              const prevCount = this.autoRestartCounts.get(projectId) ?? 0
              const nextCount = prevCount + 1
              this.autoRestartCounts.set(projectId, nextCount)

              // Track LLM circuit breaker trips — each trip adds escalation
              const isLlmBreaker = reason === "llm-unreachable"
              const prevBreakerCount = this.llmCircuitBreakerCounts.get(projectId) ?? 0
              const currentBreakerCount = isLlmBreaker ? prevBreakerCount + 1 : prevBreakerCount
              if (isLlmBreaker) this.llmCircuitBreakerCounts.set(projectId, currentBreakerCount)

              // Escalating delay: first 3 use fixed schedule, then exponential backoff
              let delay = nextCount <= ProjectManager.AUTO_RESTART_DELAYS.length
                ? ProjectManager.AUTO_RESTART_DELAYS[nextCount - 1]!
                : Math.min(
                    ProjectManager.BACKOFF_BASE_MS * Math.pow(2, nextCount - ProjectManager.AUTO_RESTART_DELAYS.length),
                    ProjectManager.BACKOFF_CAP_MS,
                  )

              // LLM circuit breaker: enforce minimum cooldown and add per-trip escalation
              if (isLlmBreaker) {
                const breakerBackoff = ProjectManager.LLM_CIRCUIT_BREAKER_COOLDOWN_MS * Math.pow(2, currentBreakerCount - 1)
                delay = Math.max(delay, breakerBackoff)
                delay = Math.min(delay, ProjectManager.BACKOFF_CAP_MS)
              }

              const breakerInfo = isLlmBreaker
                ? ` [LLM breaker trip #${currentBreakerCount}]`
                : ""
              console.error(`${C.brightRed}${C.bold}[${agentName}] SUPERVISOR STOPPED (failure, attempt ${nextCount})${breakerInfo}:${C.reset} ${C.red}${summary}${C.reset}`)
              this.dashLog.push({
                type: "brain-thinking",
                text: `ALERT: ${project.name} supervisor stopped (attempt ${nextCount}, next restart in ${Math.round(delay / 1000)}s)${breakerInfo}: ${summary}`,
              })

              // Auto-restart with escalating backoff — never fully gives up
              const timer = setTimeout(() => {
                this.autoRestartTimers.delete(projectId)
                const p = this.projects.get(projectId)
                if (p && p.status !== "stopped" && this.processes.has(projectId)) {
                  console.log(`${C.brightYellow}[${agentName}] Auto-restarting supervisor (attempt ${nextCount}) after ${Math.round(delay / 1000)}s backoff...${C.reset}`)
                  this.dashLog.push({ type: "brain-thinking", text: `Auto-restarting ${project.name} supervisor (attempt ${nextCount})...` })
                  this.restartSupervisor(projectId)
                }
              }, delay)
              this.autoRestartTimers.set(projectId, timer)
            } else {
              // Clean stop — reset auto-restart count and breaker count
              this.autoRestartCounts.delete(projectId)
              this.llmCircuitBreakerCounts.delete(projectId)
            }
          },
        })
      } catch (err) {
        if (!ac.signal.aborted) {
          console.error(`${C.red}[${project.agentName}] Supervisor error:${C.reset}`, err)
          this.dashLog.push({ type: "brain-thinking", text: `${project.name} supervisor error: ${err}` })
        }
      } finally {
        if (project.status === "supervising") {
          project.status = "running"
        }
        // Only delete our own refs — a restart may have already replaced them
        if (this.supervisorAborts.get(projectId) === ac) this.supervisorAborts.delete(projectId)
        if (this.softStops.get(projectId) === softStop) this.softStops.delete(projectId)
        if (this.pauseStates.get(projectId) === pauseState) this.pauseStates.delete(projectId)
        if (this.directiveRefs.get(projectId) === directiveRef) this.directiveRefs.delete(projectId)
      }
    })()
  }

  /** Drain an opencode serve subprocess's stdout/stderr into the dashboard
   *  log. The pipes MUST be read or the child's buffer fills and it blocks —
   *  but more importantly, when the pipes are ignored, opencode's own
   *  provider-load / API-key / model-resolution errors are never surfaced.
   *  That's the failure mode that made the silent-fallback-to-ollama bug
   *  invisible for so long. Anything on stderr is tagged as an error; stdout
   *  is surfaced as plain brain-thinking so it doesn't dominate the log. */
  private streamOpencodeOutput(projectId: string, projectName: string, proc: Subprocess): void {
    const log = this.dashLog
    const drain = async (stream: ReadableStream<Uint8Array> | null, kind: "stdout" | "stderr") => {
      if (!stream) return
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, "")
            buffer = buffer.slice(idx + 1)
            if (line.trim()) {
              log.push({
                type: "brain-thinking",
                text: `[opencode:${kind}] ${projectName}: ${line.slice(0, 500)}`,
              })
              // Also mirror to the parent console so the terminal shows it too —
              // operators most often look there first when a worker hangs.
              if (kind === "stderr") console.error(`[opencode:${projectName}] ${line}`)
              else console.log(`[opencode:${projectName}] ${line}`)
            }
          }
        }
      } catch { /* stream ended / process died — monitorProcess handles it */ }
    }
    void drain(proc.stdout as unknown as ReadableStream<Uint8Array> | null, "stdout")
    void drain(proc.stderr as unknown as ReadableStream<Uint8Array> | null, "stderr")
  }

  /** Watch a spawned process for unexpected crashes */
  private monitorProcess(projectId: string, proc: Subprocess) {
    proc.exited.then((exitCode) => {
      const project = this.projects.get(projectId)
      if (!project || project.status === "stopped") return // intentional shutdown

      // Process died unexpectedly
      project.status = "error"
      project.error = `Agent process exited unexpectedly (code ${exitCode})`
      this.dashLog.push({
        type: "brain-thinking",
        text: `${project.name} agent process crashed (exit code ${exitCode}). Use dashboard to remove and re-add.`,
      })

      // Stop the supervisor since the agent is gone
      const ac = this.supervisorAborts.get(projectId)
      if (ac) ac.abort()

      // Clean up
      this.processes.delete(projectId)
      usedPorts.delete(project.workerPort)
      this.orchestrator.removeAgent(project.agentName)
    }).catch(() => {})
  }

  /** Remove a project: stops supervisor, kills agent process.
   *  Serialized with addProject to prevent concurrent add/remove races. */
  async removeProject(projectId: string): Promise<void> {
    let resolve!: () => void
    const nextLock = new Promise<void>(r => { resolve = r })
    const prev = this.projectLock
    this.projectLock = nextLock
    await prev

    try {
      return await this._removeProjectInner(projectId)
    } finally {
      resolve()
    }
  }

  private async _removeProjectInner(projectId: string): Promise<void> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)

    // Archive agent memory before removing (non-fatal)
    await archiveAgentMemory(project.agentName, project.directive, project.directory).catch(err => {
      console.error(`[project-manager] Failed to archive memory for ${project.agentName}: ${err}`)
    })

    // Cancel any pending auto-restart timer to prevent a zombie supervisor from starting
    const pendingTimer = this.autoRestartTimers.get(projectId)
    if (pendingTimer) { clearTimeout(pendingTimer); this.autoRestartTimers.delete(projectId) }
    this.autoRestartCounts.delete(projectId)
    this.llmCircuitBreakerCounts.delete(projectId)

    // Resume paused supervisor so it unblocks before abort
    const ps = this.pauseStates.get(projectId)
    if (ps) requestResume(ps)

    // Stop supervisor
    const ac = this.supervisorAborts.get(projectId)
    if (ac) ac.abort()

    // Clean up agent branch (non-fatal). Before deleting, check whether the agent
    // branch has commits that never landed on the base branch — `git branch -d`
    // already refuses to delete unmerged work, but the failure was silent.
    // We emit a structured event and a dashboard warning so the user knows
    // work is being preserved rather than lost.
    if (project.agentBranch) {
      try {
        const base = project.baseBranch || "main"
        const ahead = await gitCommitsAhead(project.directory, base, project.agentBranch).catch(() => 0)
        if (ahead > 0) {
          const msg = `WARNING: ${project.agentBranch} has ${ahead} commit(s) not on ${base} — branch is being preserved. Review or merge before deleting.`
          this.dashLog.push({ type: "brain-thinking", text: msg })
          this.eventBus?.emit({
            type: "unmerged-agent-branch",
            source: "project-manager",
            agentName: project.agentName,
            projectId,
            data: { branch: project.agentBranch, baseBranch: base, commitsAhead: ahead },
          })
        }
        const currentBranch = await gitCurrentBranch(project.directory)
        if (currentBranch === project.agentBranch) {
          await gitCheckout(project.directory, base).catch(() =>
            gitCheckout(project.directory, "main").catch(() =>
              gitCheckout(project.directory, "master"),
            ),
          )
        }
        // Non-force delete: succeeds only when the branch is fully merged.
        // Unmerged branches stay in place (preserving work) — the warning above tells the user.
        await gitDeleteBranch(project.directory, project.agentBranch).catch(() => {})
      } catch { /* non-fatal */ }
    }

    // Release file locks
    this.resourceManager?.releaseFiles(project.agentName)

    // Clear shared knowledge entries for this agent
    await clearAgentKnowledge(project.agentName).catch((err: unknown) => {
      console.error(`[project-manager] Failed to clear shared knowledge for ${project.agentName}: ${err}`)
    })

    // Mark as stopped BEFORE killing process to prevent monitorProcess
    // from detecting the intentional kill as an unexpected crash
    project.status = "stopped"

    // Remove from orchestrator
    this.orchestrator.removeAgent(project.agentName)

    // Kill process tree (agent + any child processes it spawned, e.g. dev servers)
    const proc = this.processes.get(projectId)
    if (proc) {
      await killProcessTree(proc.pid)
      // Give the process up to 5s to exit and release its port
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 5_000))])
      this.processes.delete(projectId)
    }

    usedPorts.delete(project.workerPort)

    // Clean up the opencode scratch workspace so dead projects don't leave
    // stale provider configs lying around. Non-fatal — missing/already-gone is fine.
    try {
      const { rm } = await import("fs/promises")
      const { scratchDirFor } = await import("./opencode-config")
      await rm(scratchDirFor(projectId), { recursive: true, force: true }).catch(() => {})
    } catch { /* best-effort cleanup */ }

    // Remove from the projects map so it doesn't leak memory over many add/remove cycles
    this.projects.delete(projectId)
    this.supervisorAborts.delete(projectId)
    this.softStops.delete(projectId)
    this.pauseStates.delete(projectId)

    this.dashLog.push({ type: "brain-thinking", text: `Removed project: ${project.name}` })
    this.eventBus?.emit({
      type: "project-removed",
      source: "project-manager",
      agentName: project.agentName,
      projectId,
      data: { name: project.name },
    })
    this.saveProjects()
  }

  // ---- Pause / Resume ----

  pauseProject(projectId: string): void {
    const ps = this.pauseStates.get(projectId)
    if (!ps) throw new Error(`No pause state for project: ${projectId}`)
    requestPause(ps)
    const project = this.projects.get(projectId)
    if (project) {
      project.pauseStatus = ps.status
      project.pauseRequestedAt = ps.requestedAt ?? undefined
    }
    this.dashLog.push({ type: "brain-thinking", text: `Pause requested for ${project?.name ?? projectId}` })
  }

  resumeProject(projectId: string): void {
    const ps = this.pauseStates.get(projectId)
    if (!ps) throw new Error(`No pause state for project: ${projectId}`)
    requestResume(ps)
    const project = this.projects.get(projectId)
    if (project) {
      project.pauseStatus = "none"
      project.pauseRequestedAt = undefined
      project.pausedAt = undefined
    }
    this.dashLog.push({ type: "brain-thinking", text: `Resume requested for ${project?.name ?? projectId}` })
  }

  pauseAll(): void {
    for (const id of this.pauseStates.keys()) {
      const project = this.projects.get(id)
      if (project && (project.status === "supervising" || project.status === "running")) {
        this.pauseProject(id)
      }
    }
  }

  resumeAll(): void {
    for (const id of this.pauseStates.keys()) {
      const ps = this.pauseStates.get(id)
      if (ps && ps.status !== "none") {
        this.resumeProject(id)
      }
    }
  }

  getPauseState(projectId: string): PauseState | undefined {
    return this.pauseStates.get(projectId)
  }

  // ---- Branch Isolation ----

  /** Get the git branch name for a project's agent */
  getAgentBranch(projectId: string): string | undefined {
    return this.projects.get(projectId)?.agentBranch
  }

  /** Merge an agent's branch into a target branch (default: main).
   *  Agent must be paused or not supervising — merging while actively running risks conflicts. */
  async mergeAgentBranch(projectId: string, targetBranch?: string): Promise<{ success: boolean; output: string }> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    if (!project.agentBranch) throw new Error(`No agent branch for project: ${projectId}`)

    // Safety: don't merge while agent is actively running — could corrupt its working tree
    const ps = this.pauseStates.get(projectId)
    if (project.status === "supervising" && (!ps || ps.status !== "paused")) {
      throw new Error(`Cannot merge while supervisor is actively running. Pause the project first.`)
    }

    // Dirty-tree guard: if the working tree has uncommitted changes, `git
    // checkout <target>` will either fail noisily or silently clobber those
    // changes (depending on what they touch). Either outcome is unacceptable —
    // the user asked to merge, not to throw away in-progress worker edits.
    const clean = await gitIsClean(project.directory)
    if (!clean) {
      throw new Error(
        `Working tree has uncommitted changes in ${project.directory}. ` +
        `Commit or stash them before merging — proceeding would risk losing the worker's in-progress edits.`,
      )
    }

    // Default merge target to the base branch the project was cloned from, not
    // a hardcoded "main" — otherwise repos whose default is master/develop/trunk
    // get silently merged into the wrong place.
    const target = targetBranch ?? project.baseBranch ?? "main"
    await gitCheckout(project.directory, target)
    // Crash-resilience: once we've checked out `target`, the working tree is on
    // the wrong branch until we switch back. If `gitMerge` throws (conflict,
    // process signal, etc.) the worker's next tool-call would commit to
    // `target` instead of its agent branch. A try/finally keeps the switch-back
    // on the happy AND failure paths.
    let result: { success: boolean; output: string }
    try {
      result = await gitMerge(project.directory, project.agentBranch)
      if (result.success) {
        this.eventBus?.emit({
          type: "branch-merged",
          source: "project-manager",
          agentName: project.agentName,
          projectId,
          data: { branch: project.agentBranch, into: target },
        })
        this.dashLog.push({ type: "brain-thinking", text: `Merged ${project.agentBranch} into ${target}` })
        this.recordTimelineEvent(projectId, "branch-merged", `Merged ${project.agentBranch} → ${target} locally`, {
          branch: project.agentBranch, into: target,
        })
      }
    } finally {
      await gitCheckout(project.directory, project.agentBranch).catch(err => {
        // Loudest signal available: the worker's directory is now parked on
        // `target`. Surface this so the user sees it before the worker makes
        // a commit on the wrong branch.
        this.dashLog.push({
          type: "brain-thinking",
          text: `WARNING: Failed to switch ${project.directory} back to ${project.agentBranch} after merge — ` +
                `working tree is still on ${target}. Manual checkout required before the worker resumes: ${err}`,
        })
      })
    }
    this.invalidateGitInfoCache(projectId)
    return result
  }

  /** Push the project's agent branch to origin on GitHub using GITHUB_TOKEN.
   *
   *  Auth is injected via GIT_CONFIG env vars (not argv), so the token never
   *  appears in process listings or on-disk config. This is the same pattern
   *  GitHub Actions uses for its checkout step. Works without `gh` installed.
   *
   *  Throws if GITHUB_TOKEN is unset, origin is missing, or origin isn't github.com. */
  async pushAgentBranch(
    projectId: string,
    opts?: { setUpstream?: boolean },
  ): Promise<{ success: boolean; output: string }> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    if (!project.agentBranch) throw new Error(`No agent branch for project: ${projectId}`)
    const token = process.env.GITHUB_TOKEN
    if (!token) {
      throw new Error("GITHUB_TOKEN is not set — paste a classic PAT into .env to enable pushing.")
    }
    const remoteUrl = await gitRemoteUrl(project.directory)
    if (!remoteUrl) throw new Error(`No 'origin' remote configured in ${project.directory}`)
    if (!/github\.com/i.test(remoteUrl)) {
      throw new Error(`'origin' is not a GitHub URL (${remoteUrl}) — GITHUB_TOKEN auth only covers github.com`)
    }

    const args = ["push"]
    if (opts?.setUpstream) args.push("--set-upstream")
    args.push("origin", project.agentBranch)

    const { success, output } = await this.runGithubAuthenticatedGit(project.directory, args, token)

    if (success) {
      this.eventBus?.emit({
        type: "branch-pushed",
        source: "project-manager",
        agentName: project.agentName,
        projectId,
        data: { branch: project.agentBranch, remote: "origin" },
      })
      this.dashLog.push({ type: "brain-thinking", text: `Pushed ${project.agentBranch} to origin` })
      this.invalidateGitInfoCache(projectId)
      this.recordTimelineEvent(projectId, "branch-pushed", `Pushed ${project.agentBranch} → origin`, {
        branch: project.agentBranch, remote: "origin",
      })
    } else {
      this.dashLog.push({ type: "brain-thinking", text: `Push failed for ${project.agentBranch}: ${output.split("\n")[0] ?? ""}` })
    }
    return { success, output }
  }

  /** Run a git command with a GitHub PAT injected as an HTTP Basic auth
   *  extraheader. Same pattern GitHub Actions uses for its checkout step.
   *  Shared by clone / push / delete-remote.
   *
   *  Design notes:
   *   - Uses `-c` command-line form rather than GIT_CONFIG_* env vars. The
   *     env-var mechanism fails on git 2.53.0.windows.1 + Bun spawn — the
   *     extraheader never gets applied, git falls through to credential
   *     helpers, and we hang on a hidden prompt. The -c form is what GitHub
   *     Actions uses and works reliably across platforms.
   *   - Uses `Basic base64(x-access-token:PAT)` rather than `token PAT`.
   *     GitHub has effectively deprecated the `token` scheme for extraheader
   *     auth — only `Basic` is accepted now.
   *   - Passes `credential.helper=` (empty) to suppress Git Credential Manager
   *     on Windows, which otherwise runs in parallel with our extraheader and
   *     opens a hidden browser OAuth flow that blocks forever.
   *   - Sets `GIT_TERMINAL_PROMPT=0` so any remaining auth failure surfaces as
   *     an error rather than blocking on stdin.
   *   - Redacts the token from stdout/stderr before returning `output`, so
   *     it can't leak into dashboard logs or timeline entries.
   *
   *  Tradeoff: the token appears in argv for the lifetime of the git process
   *  (seconds). On a single-user dev box this is fine — same blast radius as
   *  `actions/checkout` on GitHub-hosted runners. If multi-user isolation
   *  becomes a requirement, revisit via a short-lived credential helper. */
  private async runGithubAuthenticatedGit(
    cwd: string,
    args: string[],
    token: string,
  ): Promise<{ success: boolean; output: string }> {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64")
    const proc = spawn({
      cmd: [
        "git",
        "-c", "credential.helper=",
        "-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
        ...args,
      ],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    const raw = [out, err].filter(s => s.trim()).join("\n").trim()
    // Belt-and-braces redaction: the token SHOULDN'T appear in git's output,
    // but if a malformed URL or config error echoes the argv, we scrub it so
    // dashboard logs and timeline entries never carry a live credential.
    const output = raw.replaceAll(token, "[REDACTED-GITHUB-TOKEN]").replaceAll(basic, "[REDACTED]")
    return { success: code === 0, output }
  }

  /** Push the agent branch and open (or reuse) a PR into the project's base branch.
   *
   *  Idempotent: clicking repeatedly keeps updating the same remote branch and
   *  either surfaces the existing open PR or creates one if none exists. The
   *  result object's `pr.isNew` distinguishes the two so the UI can phrase the
   *  toast appropriately. */
  async pushAndOpenPullRequest(
    projectId: string,
    opts?: { title?: string; body?: string },
  ): Promise<{ pushed: boolean; pushOutput: string; pr: PullRequestRef }> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    if (!project.agentBranch) throw new Error(`No agent branch for project: ${projectId}`)
    const token = process.env.GITHUB_TOKEN
    if (!token) {
      throw new Error("GITHUB_TOKEN is not set — paste a classic PAT into .env to enable Push & PR.")
    }

    // Push first so the branch exists on the remote before we ask GitHub to open a PR.
    // --set-upstream is harmless if upstream already exists (git just re-sets it).
    const push = await this.pushAgentBranch(projectId, { setUpstream: true })
    if (!push.success) {
      throw new Error(`Push failed: ${push.output}`)
    }

    const remoteUrl = await gitRemoteUrl(project.directory)
    if (!remoteUrl) throw new Error(`No 'origin' remote configured in ${project.directory}`)
    const parsed = parseGithubRemote(remoteUrl)
    if (!parsed) {
      throw new Error(`Could not parse GitHub owner/repo from origin URL: ${remoteUrl}`)
    }

    // Resolve base: explicit project.baseBranch, else best-effort fallback. If
    // the user added the project before we persisted baseBranch (or without
    // supplying one), default to "main" — a noisy wrong answer is more useful
    // than silently picking a branch that might not exist on the remote.
    const base = project.baseBranch?.trim() || "main"
    const title = opts?.title?.trim() || `[agent] ${project.name}: ${project.agentBranch}`
    const body = opts?.body ?? defaultPullRequestBody(project)

    const pr = await openOrReusePullRequest({
      owner: parsed.owner,
      repo: parsed.repo,
      head: project.agentBranch,
      base,
      title,
      body,
      token,
    })

    this.eventBus?.emit({
      type: pr.isNew ? "pull-request-opened" : "pull-request-reused",
      source: "project-manager",
      agentName: project.agentName,
      projectId,
      data: { url: pr.url, number: pr.number, head: project.agentBranch, base },
    })
    this.dashLog.push({
      type: "brain-thinking",
      text: `${pr.isNew ? "Opened" : "Updated"} PR #${pr.number} (${project.agentBranch} → ${base}) — ${pr.url}`,
    })
    this.invalidateGitInfoCache(projectId)
    this.recordTimelineEvent(
      projectId,
      pr.isNew ? "pull-request-opened" : "pull-request-reused",
      `${pr.isNew ? "Opened" : "Reused"} PR #${pr.number} (${project.agentBranch} → ${base})`,
      { number: pr.number, url: pr.url, head: project.agentBranch, base, isNew: pr.isNew },
    )

    return { pushed: true, pushOutput: push.output, pr }
  }

  /** Read-only snapshot of the project's git/github state — powers the
   *  "Git/GitHub" drawer tab. Swallows PR-lookup errors so a transient GitHub
   *  outage doesn't blank the whole tab; everything else is load-bearing. */
  async getGitInfo(projectId: string): Promise<GitInfo> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    const cached = this.gitInfoCache.get(projectId)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const originUrl = await gitRemoteUrl(project.directory)
    const parsed = originUrl ? parseGithubRemote(originUrl) : null
    const token = process.env.GITHUB_TOKEN
    const tokenDetected = !!token
    const base = project.baseBranch ?? null
    const agent = project.agentBranch ?? null

    let commitsAhead = 0
    let commitsBehind = 0
    if (base && agent) {
      commitsAhead = await gitCommitsAhead(project.directory, base, agent).catch(() => 0)
      commitsBehind = await gitCommitsBehind(project.directory, base, agent).catch(() => 0)
    }

    let openPullRequest: { url: string; number: number } | null = null
    let branchExistsOnRemote = false
    let pendingPrFeedbackCount = 0
    if (parsed && agent && base) {
      branchExistsOnRemote = await gitRemoteBranchExists(project.directory, agent).catch(() => false)
      if (token) {
        try {
          const pr = await findOpenPullRequest({
            owner: parsed.owner, repo: parsed.repo, head: agent, base, token,
          })
          if (pr) {
            openPullRequest = { url: pr.url, number: pr.number }
            try {
              const selfLogin = await this.resolveGithubSelfLogin(token)
              const feedback = await listPullRequestFeedback({
                owner: parsed.owner, repo: parsed.repo, number: pr.number,
                token, sinceIso: project.lastPrFeedbackCheckAt,
                excludeAuthors: selfLogin ? [selfLogin] : undefined,
              })
              pendingPrFeedbackCount = feedback.length
            } catch {
              // Feedback is a nice-to-have in the tab — a flake shouldn't blank the panel.
            }
          }
        } catch {
          // A 404/403/5xx from GitHub shouldn't blank the tab — the user can still
          // see their local facts and retry. The absent-PR state is the same shape.
        }
      }
    }

    const snapshot: GitInfo = {
      originUrl,
      githubOwner: parsed?.owner ?? null,
      githubRepo: parsed?.repo ?? null,
      agentBranch: agent,
      baseBranch: base,
      tokenDetected,
      commitsAhead,
      commitsBehind,
      openPullRequest,
      branchExistsOnRemote,
      pendingPrFeedbackCount,
      lastPrFeedbackCheckAt: project.lastPrFeedbackCheckAt ?? null,
    }
    this.gitInfoCache.set(projectId, { expiresAt: Date.now() + this.gitInfoCacheTtlMs, value: snapshot })
    return snapshot
  }

  /** Drop the cached getGitInfo snapshot for a project so the next read
   *  recomputes from disk + GitHub. Called by every write path — push, PR,
   *  merge, delete-remote, setBaseBranch, markPullRequestFeedbackRead. */
  private invalidateGitInfoCache(projectId: string): void {
    this.gitInfoCache.delete(projectId)
  }

  /** Mutate the project's base branch (the PR/merge target). If an open PR
   *  exists on the agent branch targeting the OLD base, retarget it to the
   *  NEW base via the GitHub API — otherwise the next "Push & PR" click
   *  creates a duplicate PR and orphans the first. Retarget is best-effort:
   *  local state change stands even if the API call fails, and the failure
   *  is surfaced in the dashboard log so the user can resolve it manually. */
  async setBaseBranch(projectId: string, baseBranch: string): Promise<GitInfo> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    const trimmed = baseBranch.trim()
    if (!trimmed) throw new Error("Base branch cannot be empty")
    const previous = project.baseBranch
    if (previous === trimmed) return this.getGitInfo(projectId)

    // Retarget any open PR BEFORE flipping local state — if retarget fails,
    // we still update state (the user asked for it) but we log clearly that
    // the old PR is now orphaned on its old base.
    let retargetMessage = ""
    if (previous) {
      const token = process.env.GITHUB_TOKEN
      const remoteUrl = await gitRemoteUrl(project.directory).catch(() => null)
      const parsed = remoteUrl ? parseGithubRemote(remoteUrl) : null
      const agent = project.agentBranch
      if (token && parsed && agent) {
        try {
          const pr = await findOpenPullRequest({
            owner: parsed.owner, repo: parsed.repo, head: agent, base: previous, token,
          })
          if (pr) {
            await updatePullRequestBase({
              owner: parsed.owner, repo: parsed.repo, number: pr.number, base: trimmed, token,
            })
            retargetMessage = ` (retargeted PR #${pr.number} from ${previous} to ${trimmed})`
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          retargetMessage = ` (WARNING: could not retarget existing PR — ${msg})`
        }
      }
    }

    project.baseBranch = trimmed
    this.saveProjects()
    this.invalidateGitInfoCache(projectId)
    this.recordTimelineEvent(projectId, "base-branch-changed", `Base branch: ${previous ?? "(unset)"} → ${trimmed}`, {
      previous, next: trimmed, retargetMessage: retargetMessage.trim() || undefined,
    })
    this.dashLog.push({
      type: "brain-thinking",
      text: `Base branch for ${project.name} changed: ${previous ?? "(unset)"} → ${trimmed}${retargetMessage}`,
    })
    return this.getGitInfo(projectId)
  }

  /** Delete the agent branch on origin. Local branch is left intact — the
   *  agent may still be using it. Typical use: cleanup after a PR was merged. */
  async deleteRemoteBranch(projectId: string): Promise<{ success: boolean; output: string }> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    if (!project.agentBranch) throw new Error(`No agent branch for project: ${projectId}`)
    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error("GITHUB_TOKEN is not set — cannot delete remote branch.")
    const remoteUrl = await gitRemoteUrl(project.directory)
    if (!remoteUrl) throw new Error(`No 'origin' remote configured in ${project.directory}`)
    if (!/github\.com/i.test(remoteUrl)) {
      throw new Error(`'origin' is not a GitHub URL (${remoteUrl}) — token auth only covers github.com`)
    }

    const { success, output } = await this.runGithubAuthenticatedGit(
      project.directory,
      ["push", "origin", "--delete", project.agentBranch],
      token,
    )
    if (success) {
      this.dashLog.push({ type: "brain-thinking", text: `Deleted origin/${project.agentBranch}` })
      this.invalidateGitInfoCache(projectId)
      this.recordTimelineEvent(projectId, "remote-branch-deleted", `Deleted origin/${project.agentBranch}`, {
        branch: project.agentBranch,
      })
    } else {
      this.dashLog.push({ type: "brain-thinking", text: `Delete remote branch failed: ${output.split("\n")[0] ?? ""}` })
    }
    return { success, output }
  }

  /** Fetch any unread PR feedback (issue comments / review comments / reviews)
   *  newer than `project.lastPrFeedbackCheckAt`. Returns [] when:
   *   - no GITHUB_TOKEN
   *   - no github origin
   *   - no open PR for the agent branch
   *   - the REST call fails (failure is logged, not thrown, so a flaky network
   *     doesn't crash a supervisor cycle)
   *
   *  NOTE: the cursor is NOT advanced here — callers must call
   *  `markPullRequestFeedbackRead(projectId, latestIso)` once the feedback has
   *  been handed to the supervisor. Splitting fetch/mark keeps the operation
   *  exactly-once-visible even if the caller crashes between the two steps. */
  async fetchPendingPullRequestFeedback(projectId: string): Promise<PullRequestFeedback[]> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    const token = process.env.GITHUB_TOKEN
    if (!token) return []
    const remoteUrl = await gitRemoteUrl(project.directory).catch(() => null)
    const parsed = remoteUrl ? parseGithubRemote(remoteUrl) : null
    if (!parsed) return []
    const agent = project.agentBranch
    const base = project.baseBranch
    if (!agent || !base) return []
    try {
      const pr = await findOpenPullRequest({
        owner: parsed.owner, repo: parsed.repo, head: agent, base, token,
      })
      if (!pr) return []
      const selfLogin = await this.resolveGithubSelfLogin(token)
      return await listPullRequestFeedback({
        owner: parsed.owner, repo: parsed.repo, number: pr.number,
        token, sinceIso: project.lastPrFeedbackCheckAt,
        excludeAuthors: selfLogin ? [selfLogin] : undefined,
      })
    } catch (err) {
      this.dashLog.push({
        type: "brain-thinking",
        text: `PR feedback fetch failed for ${project.name}: ${err instanceof Error ? err.message : String(err)}`,
      })
      return []
    }
  }

  /** Lazily resolve the login attached to GITHUB_TOKEN. Cached for the process
   *  lifetime — tokens don't change identity. If the /user call fails, cache
   *  null so we don't hammer GitHub on every cycle. */
  private async resolveGithubSelfLogin(token: string): Promise<string | null> {
    if (this.githubSelfLogin !== undefined) return this.githubSelfLogin
    const login = await getAuthenticatedUserLogin({ token })
    this.githubSelfLogin = login
    if (login) {
      this.dashLog.push({
        type: "brain-thinking",
        text: `GitHub token identity: @${login} (this account's comments will be excluded from reviewer-feedback injection)`,
      })
    }
    return login
  }

  /** Advance the project's PR-feedback cursor so the next fetch only returns
   *  items newer than `latestIso`. Pass the createdAt of the newest item the
   *  supervisor just consumed. No-op if the new timestamp is older than the
   *  existing cursor (guards against clock skew or out-of-order delivery). */
  markPullRequestFeedbackRead(projectId: string, latestIso: string): void {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    if (!latestIso) return
    const newMs = Date.parse(latestIso)
    if (!Number.isFinite(newMs)) return
    const prevMs = project.lastPrFeedbackCheckAt ? Date.parse(project.lastPrFeedbackCheckAt) : 0
    if (newMs <= prevMs) return
    project.lastPrFeedbackCheckAt = latestIso
    this.invalidateGitInfoCache(projectId)
    this.saveProjects()
  }

  /** Append a git/PR transaction to the project's timeline and persist.
   *  Capped at 200 entries (oldest dropped first) — the History drawer shows
   *  the recent tail, and orchestrator.json stays compact across long sessions. */
  private recordTimelineEvent(projectId: string, kind: TimelineEventKind, summary: string, details?: Record<string, unknown>): void {
    const project = this.projects.get(projectId)
    if (!project) return
    if (!project.timeline) project.timeline = []
    project.timeline.push({ timestamp: Date.now(), kind, summary, ...(details ? { details } : {}) })
    if (project.timeline.length > 200) {
      project.timeline = project.timeline.slice(-200)
    }
    this.saveProjects()
  }

  /** Read-only accessor for the project's git/PR transaction timeline.
   *  Returns a defensive copy so callers can't mutate our persisted state. */
  getTimeline(projectId: string): TimelineEvent[] {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    return (project.timeline ?? []).slice()
  }

  /** Set post-cycle validation config for a project */
  setValidationConfig(projectId: string, config: { command?: string; preset?: ValidationPreset; timeoutMs?: number; failAction?: "warn" | "inject" | "pause" }): void {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    project.postCycleValidation = config
    // Mirror into the responsibility so both sources of truth agree.
    project.responsibilities = applyValidationConfig(project.responsibilities, config)
    this.saveProjects()
  }

  /** List a project's responsibilities, reconciled against the current catalog. */
  listResponsibilities(projectId: string): Responsibility[] {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    project.responsibilities = reconcileResponsibilities(project.responsibilities)
    return project.responsibilities
  }

  /** Toggle a responsibility on or off. */
  setResponsibilityEnabled(projectId: string, responsibilityId: string, enabled: boolean): Responsibility {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    const list = reconcileResponsibilities(project.responsibilities)
    const target = list.find(r => r.id === responsibilityId)
    if (!target) throw new Error(`Unknown responsibility: ${responsibilityId}`)
    target.enabled = enabled
    project.responsibilities = list
    // Keep legacy validation field in sync so the supervisor pipeline sees the change immediately.
    if (responsibilityId === "supervisor.run-validation") {
      project.postCycleValidation = enabled && target.config ? (target.config as typeof project.postCycleValidation) : undefined
    }
    this.saveProjects()
    return target
  }

  /** Update a responsibility's config. Does not change its enabled state. */
  setResponsibilityConfig(projectId: string, responsibilityId: string, config: Record<string, unknown>): Responsibility {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    const list = reconcileResponsibilities(project.responsibilities)
    const target = list.find(r => r.id === responsibilityId)
    if (!target) throw new Error(`Unknown responsibility: ${responsibilityId}`)
    target.config = { ...config }
    project.responsibilities = list
    if (responsibilityId === "supervisor.run-validation" && target.enabled) {
      project.postCycleValidation = target.config as typeof project.postCycleValidation
    }
    this.saveProjects()
    return target
  }

  /** Record the outcome of a responsibility run (called by event subscribers). */
  recordResponsibilityOutcome(
    projectId: string,
    responsibilityId: string,
    status: "success" | "failure" | "skipped" | "unknown",
    detail?: string,
  ): void {
    const project = this.projects.get(projectId)
    if (!project) return
    const list = reconcileResponsibilities(project.responsibilities)
    const target = list.find(r => r.id === responsibilityId)
    if (!target) return
    target.lastStatus = status
    target.lastRunAt = Date.now()
    if (detail !== undefined) target.lastDetail = detail
    project.responsibilities = list
    this.saveProjects()
  }

  /** Soft stop all supervisors */
  softStopAll() {
    for (const ss of this.softStops.values()) {
      ss.requested = true
    }
    this.dashLog.push({ type: "brain-thinking", text: "Soft stop requested for all supervisors." })
  }

  /** Hard stop all supervisors */
  hardStopAll() {
    for (const ac of this.supervisorAborts.values()) {
      ac.abort()
    }
  }

  /** Restart supervisor for a project */
  restartSupervisor(projectId: string, directive?: string, model?: string) {
    const project = this.projects.get(projectId)
    if (!project) return

    // Cancel any pending auto-restart timer to prevent double-start
    const pendingTimer = this.autoRestartTimers.get(projectId)
    if (pendingTimer) { clearTimeout(pendingTimer); this.autoRestartTimers.delete(projectId) }
    // Manual restart resets the auto-restart escalation count and LLM breaker count
    this.autoRestartCounts.delete(projectId)
    this.llmCircuitBreakerCounts.delete(projectId)

    // Stop existing supervisor
    const ac = this.supervisorAborts.get(projectId)
    if (ac) ac.abort()

    if (directive) project.directive = directive
    if (model) project.model = model

    // Start new one after a brief delay — verify project still exists and isn't stopped
    setTimeout(() => {
      const p = this.projects.get(projectId)
      if (p && p.status !== "stopped") {
        this.startSupervisor(projectId)
      }
    }, 500)
  }

  /** Update a project's directive (from dashboard or supervisor).
   *  Hot-swaps the live supervisor's directive ref when a supervisor is running, so the change
   *  takes effect at the next cycle boundary without restarting. Cycle count is preserved. */
  updateDirective(projectId: string, directive: string, source: "user" | "supervisor" = "user") {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    project.directive = directive
    const ref = this.directiveRefs.get(projectId)
    if (ref) ref.value = directive
    const cycleNumber = this.lastCycleNumbers.get(projectId)
    const entry: DirectiveHistoryEntry = { timestamp: Date.now(), text: directive, source }
    if (cycleNumber !== undefined) entry.cycleNumber = cycleNumber
    project.directiveHistory.push(entry)
    // Keep last 20 entries
    if (project.directiveHistory.length > 20) {
      project.directiveHistory = project.directiveHistory.slice(-20)
    }
    this.saveProjects()
    const liveNote = ref ? " (applies next cycle)" : ""
    this.dashLog.push({ type: "brain-thinking", text: `${project.name} directive updated by ${source}${liveNote}.` })
  }

  /** Add a user comment on a directive entry for the supervisor to read.
   *  If historyIndex is provided, comments on that specific entry; otherwise on the latest. */
  addDirectiveComment(projectId: string, comment: string, historyIndex?: number) {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    const target = historyIndex !== undefined
      ? project.directiveHistory[historyIndex]
      : project.directiveHistory[project.directiveHistory.length - 1]
    if (target) {
      if (target.comment && !target.commentRead) {
        target.comment = target.comment + "\n" + comment
      } else {
        target.comment = comment
      }
      target.commentRead = false
    }
    // Push to fast-access queue so supervisor doesn't iterate full history
    // Cap at 50 to prevent unbounded growth if supervisor is slow to read
    project.pendingComments.push(comment)
    if (project.pendingComments.length > 50) {
      project.pendingComments = project.pendingComments.slice(-50)
    }
    this.saveProjects()
    this.dashLog.push({ type: "brain-thinking", text: `${project.name}: user commented on directive — "${comment.slice(0, 80)}..."` })
  }

  /** Get unread directive comments for a project's agent, marking them as read */
  getUnreadComments(agentName: string): string[] {
    for (const project of this.projects.values()) {
      if (project.agentName !== agentName) continue
      // Use the fast queue
      if (project.pendingComments.length === 0) return []
      const comments = [...project.pendingComments]
      project.pendingComments = []
      // Also mark history entries as read
      for (const entry of project.directiveHistory) {
        if (entry.comment && !entry.commentRead) {
          entry.commentRead = true
        }
      }
      this.saveProjects()
      return comments
    }
    return []
  }

  /** Get directive history for a project */
  getDirectiveHistory(projectId: string): DirectiveHistoryEntry[] {
    const project = this.projects.get(projectId)
    if (!project) return []
    return project.directiveHistory
  }

  /** Update a project's supervisor model */
  updateModel(projectId: string, model: string) {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    project.model = model
    // Propagate the new model to the live worker so the next prompt uses it.
    // Without this, the supervisor restart picks up the new model for its own
    // LLM calls but the worker's opencode session keeps using whatever model
    // was baked in when its serve process was spawned.
    const agent = this.orchestrator.agents.get(project.agentName)
    if (agent) agent.config.model = toAgentModelRef(model)
    this.saveProjects()
    this.dashLog.push({ type: "brain-thinking", text: `${project.name} model changed to: ${model}` })
  }

  /** Set or clear the supervisor-only model override. Pass an empty string (or
   *  undefined) to clear the override and let the supervisor fall back to the
   *  worker's model. Does NOT touch the worker's agent.config.model — that's
   *  the whole point of the split. Caller should restartSupervisor() afterwards
   *  because the supervisor reads its model once at startSupervisor time. */
  updateSupervisorModel(projectId: string, model: string | undefined) {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    const trimmed = model?.trim() || undefined
    project.supervisorModel = trimmed
    this.saveProjects()
    const label = trimmed ?? "(cleared — will use worker model)"
    this.dashLog.push({ type: "brain-thinking", text: `${project.name} supervisor model changed to: ${label}` })
  }

  /** Get the Ollama URL for fetching available models */
  getOllamaUrl(): string {
    return this.brainConfig.ollamaUrl
  }

  listProjects(): ProjectState[] {
    // Enrich with live pause state
    for (const [id, project] of this.projects) {
      const ps = this.pauseStates.get(id)
      if (ps) {
        project.pauseStatus = ps.status
        project.pauseRequestedAt = ps.requestedAt ?? undefined
        project.pausedAt = ps.pausedAt ?? undefined
      }
    }
    return Array.from(this.projects.values())
  }

  getProject(id: string): ProjectState | undefined {
    return this.projects.get(id)
  }

  /** Persist project configs (directory + directive) for quick re-add */
  private saveProjects() {
    const data: SavedProjects = {
      projects: this.listProjects()
        .filter(p => p.status !== "stopped")
        .map(p => ({
          name: p.name, directory: p.directory, directive: p.directive,
          ...(p.model ? { model: p.model } : {}),
          ...(p.supervisorModel ? { supervisorModel: p.supervisorModel } : {}),
          ...(p.directiveHistory && p.directiveHistory.length > 1 ? { directiveHistory: p.directiveHistory } : {}),
          ...(p.baseBranch ? { baseBranch: p.baseBranch } : {}),
          ...(p.responsibilities ? { responsibilities: p.responsibilities } : {}),
          ...(p.lastPrFeedbackCheckAt ? { lastPrFeedbackCheckAt: p.lastPrFeedbackCheckAt } : {}),
          ...(p.timeline && p.timeline.length > 0 ? { timeline: p.timeline } : {}),
        })),
    }
    writeJsonFile(resolve(process.cwd(), PROJECTS_FILE), data).catch(err => {
      console.error(`[project-manager] Failed to save projects file: ${err}`)
      this.dashLog.push({ type: "brain-thinking", text: `WARNING: Failed to persist project state to disk. In-memory state may diverge from saved state on restart: ${err}` })
    })
  }

  /** Audit saved project configs against the provider registry. Warns for any
   *  persisted `model` that targets a missing or disabled provider — surfaced to
   *  the dashboard log so the user sees the problem at startup instead of the
   *  first time a supervisor tries to spin up. */
  async auditSavedProjectModels(): Promise<Array<{ project: string; model: string; reason: string }>> {
    const saved = await this.getSavedProjects()
    if (saved.length === 0) return []
    const issues: Array<{ project: string; model: string; reason: string }> = []
    for (const p of saved) {
      if (p.model) {
        const check = await validateModelRoutable(p.model)
        if (!check.ok) {
          issues.push({ project: p.name, model: p.model, reason: check.reason })
          this.dashLog.push({
            type: "brain-thinking",
            text: `Startup audit: ${p.name} worker is pinned to "${p.model}" but ${check.reason}. Pick a different model on the project row, or enable the target provider.`,
          })
        }
      }
      if (p.supervisorModel) {
        const check = await validateModelRoutable(p.supervisorModel)
        if (!check.ok) {
          issues.push({ project: p.name, model: p.supervisorModel, reason: check.reason })
          this.dashLog.push({
            type: "brain-thinking",
            text: `Startup audit: ${p.name} supervisor is pinned to "${p.supervisorModel}" but ${check.reason}. Pick a different supervisor model, or enable the target provider.`,
          })
        }
      }
    }
    return issues
  }

  /** Load previously saved projects list (does not restore them — caller decides) */
  async getSavedProjects(): Promise<SavedProjects["projects"]> {
    try {
      const data = await readJsonFile<SavedProjects>(resolve(process.cwd(), PROJECTS_FILE), { projects: [] })
      return data?.projects ?? []
    } catch {
      return []
    }
  }

  /** Restore previously saved projects (re-adds them) */
  async restoreProjects(): Promise<{ restored: string[]; failed: string[] }> {
    const saved = await this.getSavedProjects()
    if (saved.length === 0) return { restored: [], failed: [] }

    const restored: string[] = []
    const failed: string[] = []

    for (const p of saved) {
      try {
        await this.addProject(p.directory, p.directive, p.name, p.directiveHistory, {
          baseBranch: p.baseBranch,
          responsibilities: p.responsibilities,
          model: p.model,
          supervisorModel: p.supervisorModel,
          lastPrFeedbackCheckAt: p.lastPrFeedbackCheckAt,
          timeline: p.timeline,
        })
        restored.push(p.name)
      } catch (err) {
        failed.push(`${p.name}: ${err}`)
        this.dashLog.push({ type: "brain-thinking", text: `Failed to restore ${p.name}: ${err}` })
      }
    }

    return { restored, failed }
  }

  /** Shut down everything — kills all child processes and waits for port release */
  shutdown() {
    // Cancel all pending auto-restart timers and reset counts
    for (const timer of this.autoRestartTimers.values()) clearTimeout(timer)
    this.autoRestartTimers.clear()
    this.autoRestartCounts.clear()
    this.llmCircuitBreakerCounts.clear()
    this.hardStopAll()
    for (const proc of this.processes.values()) {
      killProcessTree(proc.pid).catch(() => {})
    }
    this.processes.clear()
    usedPorts.clear()
  }
}
