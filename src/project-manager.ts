import { spawn, type Subprocess } from "bun"
import { existsSync, readdirSync, statSync } from "fs"
import { resolve, basename } from "path"
import { homedir, platform } from "os"
import type { Orchestrator } from "./orchestrator"
import type { DashboardLog } from "./dashboard"
import { runAgentSupervisor, type ValidationPreset } from "./supervisor"
import { readJsonFile, writeJsonFile } from "./file-utils"
import { formatThought, C } from "./tui-format"
import { createPauseState, requestPause, requestResume, type PauseState } from "./pause-service"
import { clearAgentKnowledge } from "./shared-knowledge"
import { gitExec, gitCurrentBranch, gitCreateBranch, gitCheckout, gitMerge, gitDeleteBranch, gitForceDeleteBranch } from "./git-utils"
import type { EventBus } from "./event-bus"
import type { ResourceManager } from "./resource-manager"
import { archiveAgentMemory, hasAgentArchive, restoreAgentMemory } from "./brain-memory"

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
}

export type ProjectState = {
  id: string
  name: string
  directory: string
  directive: string
  workerPort: number
  agentName: string
  /** Ollama model for this project's supervisor. Falls back to global config. */
  model?: string
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
  /** Post-cycle validation config */
  postCycleValidation?: { command?: string; preset?: ValidationPreset; timeoutMs?: number; failAction?: "warn" | "inject" | "pause" }
}

type SavedProjects = {
  projects: Array<{
    name: string
    directory: string
    directive: string
    model?: string
    directiveHistory?: DirectiveHistoryEntry[]
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

// ---------------------------------------------------------------------------
// ProjectManager
// ---------------------------------------------------------------------------

// Resolve opencode location — override with OPENCODE_DIR env var, or auto-detect from common locations
function findOpencodeDir(): string {
  if (process.env.OPENCODE_DIR) return resolve(process.env.OPENCODE_DIR)
  const candidates = [
    resolve(import.meta.dirname, "..", "..", "opencode"),                          // sibling to orchestrator
    resolve(import.meta.dirname, "..", "..", "opencode", "packages", "opencode"),  // monorepo layout
    resolve(homedir(), "Desktop", "opencode", "packages", "opencode"),            // Desktop monorepo
    resolve(homedir(), "Desktop", "opencode"),                                     // Desktop flat
  ]
  for (const dir of candidates) {
    if (existsSync(resolve(dir, "src", "index.ts"))) return dir
  }
  return candidates[0]! // fall back to sibling (will error with clear message later)
}
const OPENCODE_DIR = findOpencodeDir()
const OPENCODE_ENTRY = resolve(OPENCODE_DIR, "src", "index.ts")
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
  /** Cycle limit callbacks — auto-pause after N cycles (used by A/B test) */
  private cycleLimitCallbacks = new Map<string, { maxCycles: number; count: number }>()
  private addLock: Promise<void> = Promise.resolve()
  private idCounter = 0

  constructor(
    private orchestrator: Orchestrator,
    private dashLog: DashboardLog,
    private brainConfig: { model: string; ollamaUrl: string },
    private supervisorLimits?: import("./supervisor").SupervisorLimits,
    private eventBus?: EventBus,
    private resourceManager?: ResourceManager,
  ) {}

  /** Add a project: spawns a worker agent and starts its supervisor.
   *  Uses a promise-chain mutex so concurrent calls queue up instead of racing. */
  async addProject(directory: string, directive: string, name?: string, restoreHistory?: DirectiveHistoryEntry[]): Promise<ProjectState> {
    let resolve!: () => void
    const nextLock = new Promise<void>(r => { resolve = r })
    const prev = this.addLock
    this.addLock = nextLock

    // Wait for previous add to finish before starting ours
    await prev

    try {
      return await this._addProjectInner(directory, directive, name, restoreHistory)
    } finally {
      resolve()
    }
  }

  private async _addProjectInner(directory: string, directive: string, name?: string, restoreHistory?: DirectiveHistoryEntry[]): Promise<ProjectState> {
    const resolvedDir = resolve(directory)
    if (!existsSync(resolvedDir)) {
      throw new Error(`Directory does not exist: ${resolvedDir}`)
    }

    const projectName = name || basename(resolvedDir)
    const id = `proj-${++this.idCounter}`
    let agentName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")

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
      directiveHistory: restoreHistory ?? [{ timestamp: Date.now(), text: directive, source: "user" as const }],
      pendingComments: [],
      status: "starting",
      addedAt: Date.now(),
    }

    this.projects.set(id, project)
    this.dashLog.push({ type: "brain-thinking", text: `Adding project: ${projectName} at ${resolvedDir} (port ${port})` })

    try {
      // Spawn opencode serve instance
      if (!existsSync(OPENCODE_ENTRY)) {
        throw new Error(`Cannot find opencode at ${OPENCODE_ENTRY}`)
      }

      const proc = spawn({
        cmd: [
          "bun", "run",
          "--cwd", OPENCODE_DIR,
          "--conditions=browser",
          OPENCODE_ENTRY,
          "serve",
          "--port", String(port),
        ],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          // Set the working directory for this agent
          OPENCODE_PROJECT_DIR: resolvedDir,
        },
      })
      this.processes.set(id, proc)

      // Monitor for unexpected process death
      this.monitorProcess(id, proc)

      // Wait for health check
      const url = `http://127.0.0.1:${port}`
      this.dashLog.push({ type: "brain-thinking", text: `Waiting for ${projectName} agent at ${url}...` })
      const healthy = await waitForServer(url)
      if (!healthy) {
        throw new Error(`Agent for ${projectName} failed to start on port ${port}`)
      }

      // Register with orchestrator
      await this.orchestrator.addAgent({
        name: agentName,
        url,
        directory: resolvedDir,
      })

      project.status = "running"

      // Create agent-specific git branch for isolation
      try {
        const currentBranch = await gitCurrentBranch(resolvedDir)
        const branchName = `agent/${agentName}`
        // Delete stale branch if it already exists (from a previous run that wasn't cleaned up)
        const existingBranches = await gitExec(resolvedDir, "branch", "--list", branchName).catch(() => "")
        if (existingBranches.trim()) {
          await gitForceDeleteBranch(resolvedDir, branchName).catch(() => {})
        }
        await gitCreateBranch(resolvedDir, branchName, currentBranch)
        project.agentBranch = branchName
        this.dashLog.push({ type: "brain-thinking", text: `Created branch ${branchName} for ${projectName}` })
        this.eventBus?.emit({
          type: "branch-created",
          source: "project-manager",
          agentName,
          projectId: id,
          data: { branch: branchName, from: currentBranch },
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
      } catch {}

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

    project.status = "supervising"

    ;(async () => {
      try {
        await runAgentSupervisor(this.orchestrator, {
          ollamaUrl: this.brainConfig.ollamaUrl,
          model: project.model || this.brainConfig.model,
          agentName: project.agentName,
          directory: project.directory,
          directive: project.directive,
          cyclePauseSeconds: this.supervisorLimits?.cyclePauseSeconds ?? 30,
          maxRoundsPerCycle: this.supervisorLimits?.maxRoundsPerCycle ?? 30,
          reviewEnabled: true,
          limits: this.supervisorLimits,
          dashboardLog: this.dashLog,
          signal: ac.signal,
          softStop,
          pauseState,
          postCycleValidation: project.postCycleValidation,
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
          onCycleComplete: (cycleNumber) => {
            // Successful cycle — reset auto-restart count and LLM breaker count (failure was transient)
            this.autoRestartCounts.delete(projectId)
            this.llmCircuitBreakerCounts.delete(projectId)
            const limit = this.cycleLimitCallbacks.get(projectId)
            if (limit) {
              limit.count = cycleNumber
              if (cycleNumber >= limit.maxCycles) {
                this.cycleLimitCallbacks.delete(projectId)
                this.pauseProject(projectId)
              }
            }
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
      }
    })()
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

  /** Remove a project: stops supervisor, kills agent process */
  async removeProject(projectId: string): Promise<void> {
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

    // Clean up agent branch (non-fatal)
    if (project.agentBranch) {
      try {
        const currentBranch = await gitCurrentBranch(project.directory)
        if (currentBranch === project.agentBranch) {
          await gitCheckout(project.directory, "main").catch(() =>
            gitCheckout(project.directory, "master")
          )
        }
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

  /** Set a cycle limit — supervisor auto-pauses after N cycles. Used by A/B testing. */
  setCycleLimit(projectId: string, maxCycles: number): void {
    this.cycleLimitCallbacks.set(projectId, { maxCycles, count: 0 })
  }

  /** Clear any active cycle limit */
  clearCycleLimit(projectId: string): void {
    this.cycleLimitCallbacks.delete(projectId)
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

    const target = targetBranch ?? "main"
    await gitCheckout(project.directory, target)
    const result = await gitMerge(project.directory, project.agentBranch)

    if (result.success) {
      this.eventBus?.emit({
        type: "branch-merged",
        source: "project-manager",
        agentName: project.agentName,
        projectId,
        data: { branch: project.agentBranch, into: target },
      })
      this.dashLog.push({ type: "brain-thinking", text: `Merged ${project.agentBranch} into ${target}` })
    }

    // Checkout back to agent branch so work continues
    await gitCheckout(project.directory, project.agentBranch)
    return result
  }

  /** Set post-cycle validation config for a project */
  setValidationConfig(projectId: string, config: { command?: string; preset?: ValidationPreset; timeoutMs?: number; failAction?: "warn" | "inject" | "pause" }): void {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    project.postCycleValidation = config
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

  /** Update a project's directive (from dashboard or supervisor) */
  updateDirective(projectId: string, directive: string, source: "user" | "supervisor" = "user") {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Unknown project: ${projectId}`)
    project.directive = directive
    project.directiveHistory.push({ timestamp: Date.now(), text: directive, source })
    // Keep last 20 entries
    if (project.directiveHistory.length > 20) {
      project.directiveHistory = project.directiveHistory.slice(-20)
    }
    this.saveProjects()
    this.dashLog.push({ type: "brain-thinking", text: `${project.name} directive updated by ${source}.` })
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
    this.saveProjects()
    this.dashLog.push({ type: "brain-thinking", text: `${project.name} model changed to: ${model}` })
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
          ...(p.directiveHistory.length > 1 ? { directiveHistory: p.directiveHistory } : {}),
        })),
    }
    writeJsonFile(resolve(process.cwd(), PROJECTS_FILE), data).catch(err => {
      console.error(`[project-manager] Failed to save projects file: ${err}`)
    })
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
        await this.addProject(p.directory, p.directive, p.name, p.directiveHistory)
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
