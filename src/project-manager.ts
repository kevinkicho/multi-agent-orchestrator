import { spawn, type Subprocess } from "bun"
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs"
import { resolve, basename } from "path"
import type { Orchestrator } from "./orchestrator"
import type { DashboardLog } from "./dashboard"
import { runAgentSupervisor } from "./supervisor"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectState = {
  id: string
  name: string
  directory: string
  directive: string
  workerPort: number
  agentName: string
  status: "starting" | "running" | "supervising" | "stopped" | "error"
  addedAt: number
  error?: string
}

type SavedProjects = {
  projects: Array<{ name: string; directory: string; directive: string }>
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
  async addProject(directory: string, directive: string, name?: string): Promise<ProjectState> {
    let resolve!: () => void
    const nextLock = new Promise<void>(r => { resolve = r })
    const prev = this.addLock
    this.addLock = nextLock

    // Wait for previous add to finish before starting ours
    await prev

    try {
      return await this._addProjectInner(directory, directive, name)
    } finally {
      resolve()
    }
  }

  private async _addProjectInner(directory: string, directive: string, name?: string): Promise<ProjectState> {
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
          model: this.brainConfig.model,
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
        .map(p => ({ name: p.name, directory: p.directory, directive: p.directive })),
    }
    try {
      writeFileSync(resolve(process.cwd(), PROJECTS_FILE), JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(`[project-manager] Failed to save projects file: ${err}`)
    }
  }

  /** Load previously saved projects (for restore on startup) */
  loadSavedProjects(): Array<{ name: string; directory: string; directive: string }> {
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
