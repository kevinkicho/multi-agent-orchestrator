import { spawn, type Subprocess } from "bun"
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs"
import { resolve, basename } from "path"
import type { Orchestrator } from "./orchestrator"
import type { DashboardLog } from "./dashboard"
import { runAgentSupervisor } from "./supervisor"

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

const BASE_PORT = 3001
const usedPorts = new Set<number>()

async function findFreePort(startFrom: number): Promise<number> {
  let port = startFrom
  while (usedPorts.has(port)) port++
  // Reserve immediately to prevent concurrent addProject calls from grabbing the same port
  for (let attempt = 0; attempt < 50; attempt++) {
    while (usedPorts.has(port)) port++
    usedPorts.add(port) // reserve before testing
    try {
      const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") })
      server.stop()
      return port // already in usedPorts
    } catch {
      usedPorts.delete(port) // release failed reservation
      port++
    }
  }
  throw new Error(`Cannot find free port starting from ${startFrom}`)
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

// Resolve opencode location — override with OPENCODE_DIR env var if the monorepo layout differs
const OPENCODE_DIR = process.env.OPENCODE_DIR
  ? resolve(process.env.OPENCODE_DIR)
  : resolve(import.meta.dirname, "..", "..", "opencode")
const OPENCODE_ENTRY = resolve(OPENCODE_DIR, "src", "index.ts")
const PROJECTS_FILE = "orchestrator-projects.json"

export class ProjectManager {
  private projects = new Map<string, ProjectState>()
  private processes = new Map<string, Subprocess>()
  private supervisorAborts = new Map<string, AbortController>()
  private softStops = new Map<string, { requested: boolean }>()
  private addLock: Promise<void> = Promise.resolve()
  private idCounter = 0

  constructor(
    private orchestrator: Orchestrator,
    private dashLog: DashboardLog,
    private brainConfig: { model: string; ollamaUrl: string },
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

    // Check for duplicate directory
    for (const p of this.projects.values()) {
      if (p.directory === resolvedDir && p.status !== "stopped") {
        throw new Error(`Project at ${resolvedDir} is already active`)
      }
    }

    // Ensure agent name is unique — append suffix if a different project already uses this name
    const baseAgentName = agentName
    let suffix = 1
    while (this.orchestrator.agents.has(agentName) ||
           Array.from(this.projects.values()).some(p => p.agentName === agentName && p.status !== "stopped")) {
      agentName = `${baseAgentName}-${++suffix}`
    }

    const port = await findFreePort(BASE_PORT)

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
      this.dashLog.push({ type: "brain-thinking", text: `${projectName} agent ready. Starting supervisor...` })

      // Save projects
      this.saveProjects()

      // Start supervisor in background
      this.startSupervisor(id)

      return project
    } catch (err) {
      project.status = "error"
      project.error = String(err)
      this.dashLog.push({ type: "brain-thinking", text: `Error adding ${projectName}: ${err}` })
      // Clean up
      const proc = this.processes.get(id)
      if (proc) { proc.kill(); this.processes.delete(id) }
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

    project.status = "supervising"

    ;(async () => {
      try {
        await runAgentSupervisor(this.orchestrator, {
          ollamaUrl: this.brainConfig.ollamaUrl,
          model: project.model || this.brainConfig.model,
          agentName: project.agentName,
          directory: project.directory,
          directive: project.directive,
          cyclePauseSeconds: 30,
          maxRoundsPerCycle: 30,
          reviewEnabled: true,
          dashboardLog: this.dashLog,
          signal: ac.signal,
          softStop,
          onThinking: (thought) => {
            console.log(`[${project.agentName}] ${thought}`)
          },
          onDirectiveUpdate: (newDirective) => {
            this.updateDirective(project.id, newDirective, "supervisor")
          },
          getUnreadComments: () => {
            return this.getUnreadComments(project.agentName)
          },
          onSupervisorStop: (agentName, summary, isFailure) => {
            if (isFailure) {
              console.error(`[${agentName}] SUPERVISOR STOPPED (failure): ${summary}`)
              this.dashLog.push({
                type: "brain-thinking",
                text: `ALERT: ${project.name} supervisor stopped due to failure: ${summary}. Consider restarting the project.`,
              })
              // Auto-restart supervisor after a delay if the agent process is still alive
              setTimeout(() => {
                const p = this.projects.get(projectId)
                if (p && p.status !== "stopped" && this.processes.has(projectId)) {
                  console.log(`[${agentName}] Auto-restarting supervisor after failure...`)
                  this.dashLog.push({ type: "brain-thinking", text: `Auto-restarting ${project.name} supervisor after failure...` })
                  this.restartSupervisor(projectId)
                }
              }, 10_000) // 10s delay before auto-restart
            }
          },
        })
      } catch (err) {
        if (!ac.signal.aborted) {
          console.error(`[${project.agentName}] Supervisor error:`, err)
          this.dashLog.push({ type: "brain-thinking", text: `${project.name} supervisor error: ${err}` })
        }
      } finally {
        if (project.status === "supervising") {
          project.status = "running"
        }
        this.supervisorAborts.delete(projectId)
        this.softStops.delete(projectId)
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

    // Stop supervisor
    const ac = this.supervisorAborts.get(projectId)
    if (ac) ac.abort()

    // Remove from orchestrator
    this.orchestrator.removeAgent(project.agentName)

    // Kill process
    const proc = this.processes.get(projectId)
    if (proc) {
      proc.kill()
      this.processes.delete(projectId)
    }

    usedPorts.delete(project.workerPort)
    project.status = "stopped"

    this.dashLog.push({ type: "brain-thinking", text: `Removed project: ${project.name}` })
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
  restartSupervisor(projectId: string, directive?: string) {
    const project = this.projects.get(projectId)
    if (!project) return

    // Stop existing supervisor
    const ac = this.supervisorAborts.get(projectId)
    if (ac) ac.abort()

    if (directive) project.directive = directive

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
    project.pendingComments.push(comment)
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
    try {
      writeFileSync(resolve(process.cwd(), PROJECTS_FILE), JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(`[project-manager] Failed to save projects file: ${err}`)
    }
  }

  /** Load previously saved projects (for restore on startup) */
  loadSavedProjects(): Array<{ name: string; directory: string; directive: string; model?: string; directiveHistory?: DirectiveHistoryEntry[] }> {
    const paths = [
      resolve(process.cwd(), PROJECTS_FILE),
      resolve(import.meta.dirname, "..", PROJECTS_FILE),
    ]
    for (const p of paths) {
      if (existsSync(p)) {
        try {
          const data = JSON.parse(readFileSync(p, "utf-8")) as SavedProjects
          return data.projects ?? []
        } catch {}
      }
    }
    return []
  }

  /** Shut down everything */
  shutdown() {
    this.hardStopAll()
    for (const proc of this.processes.values()) {
      proc.kill()
    }
    this.processes.clear()
    usedPorts.clear()
  }
}
