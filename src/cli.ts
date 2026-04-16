#!/usr/bin/env bun
import { createOrchestrator, type OrchestratorConfig } from "./orchestrator"
import type { AgentConfig } from "./agent"
import type { AgentEvent } from "./events"
import { DashboardLog, startDashboard } from "./dashboard"
import { ProjectManager } from "./project-manager"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import { loadTaskQueue, addTask, formatQueueForPrompt } from "./task-queue"
import { extractLastAssistantText, formatRecentMessages } from "./message-utils"
import { formatThought, C } from "./tui-format"
import { detectCrash, initSessionState, markCleanShutdown, formatCrashReport } from "./session-state"
import { recordPrompt } from "./prompt-ledger"

/** Tunable supervisor limits — all optional with sensible defaults */
type SupervisorLimits = {
  /** Max agent restarts per supervision cycle. Default: 3 */
  maxRestartsPerCycle?: number
  /** Consecutive failed cycles before circuit breaker triggers. Default: 3 */
  maxConsecutiveFailedCycles?: number
  /** Base backoff delay (ms) for restart exponential backoff. Default: 30000 */
  restartBackoffBaseMs?: number
  /** Max LLM conversation messages before trimming. Default: 60 */
  maxConversationMessages?: number
  /** Seconds between supervision cycles. Default: 30 */
  cyclePauseSeconds?: number
  /** Max LLM rounds per cycle. Default: 30 */
  maxRoundsPerCycle?: number
  /** Time (ms) before an agent is considered stuck. Default: 300000 */
  stuckThresholdMs?: number
}

type TeamMemberConfig = {
  role: string
  agentName: string
  directory: string
  directive: string
}

type TeamConfigFile = {
  goal: string
  members: TeamMemberConfig[]
  managerIntervalSeconds?: number
  managerMaxRounds?: number
}

type ConfigFile = {
  agents: AgentConfig[]
  autoApprove?: boolean
  pollInterval?: number
  dashboardPort?: number
  /** Operating mode: "projects" (isolated per-project supervisors) or "teams" (shared goal with manager) */
  mode?: "projects" | "teams"
  brain?: { model?: string; ollamaUrl?: string }
  /** Tunable supervisor limits */
  supervisor?: SupervisorLimits
  /** Phase 3: optional project role mapping { agentName: { coder, reviewer? } } */
  projects?: Record<string, { coder: string; reviewer?: string }>
  /**
   * Scheduling mode for supervisors:
   * - "parallel": All supervisors run simultaneously (fast, high API usage)
   * - "sequential": Rotate through agents N at a time (slower, low API usage)
   * Default: "parallel"
   */
  scheduling?: "parallel" | "sequential"
  /** For sequential mode: how many agents to supervise concurrently. Default: 1 */
  concurrency?: number
  /** For sequential mode: cycles per agent before rotating. Default: 2 */
  cyclesPerRotation?: number
  /** Teams mode configuration (only used when mode = "teams") */
  team?: TeamConfigFile
}

function loadConfigFile(): ConfigFile | null {
  const paths = [
    resolve(process.cwd(), "orchestrator.json"),
    resolve(import.meta.dirname, "..", "orchestrator.json"),
  ]
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        console.log(`Loading config from ${p}`)
        return JSON.parse(readFileSync(p, "utf-8"))
      } catch (err) {
        console.error(`Failed to parse config ${p}: ${err}`)
        return null
      }
    }
  }
  return null
}

function parseArgs(): {
  agents: AgentConfig[]
  autoApprove: boolean
  verbose: boolean
  dashboardPort: number
  mode: "projects" | "teams"
  brain: { model: string; ollamaUrl: string }
  supervisor: SupervisorLimits
  projects?: Record<string, { coder: string; reviewer?: string }>
  scheduling: "parallel" | "sequential"
  concurrency: number
  cyclesPerRotation: number
  team?: TeamConfigFile
} {
  const args = process.argv.slice(2)
  let autoApprove = false
  let verbose = false
  let dashboardPort = 4000
  let dashboardPortExplicit = false
  let configPath: string | undefined
  const agents: AgentConfig[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--auto-approve") {
      autoApprove = true
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true
    } else if ((arg === "--config" || arg === "-c") && args[i + 1]) {
      configPath = args[++i]!
    } else if (arg === "--dashboard-port" && args[i + 1]) {
      dashboardPort = parseInt(args[++i]!, 10)
      dashboardPortExplicit = true
    } else if (arg === "--agent" && args[i + 1]) {
      const parts = args[++i]!.split("=")
      if (parts.length >= 2) {
        agents.push({
          name: parts[0]!,
          url: parts[1]!,
          directory: parts[2] ?? "",
        })
      }
    }
  }

  let fileConfig: ConfigFile | null = null
  if (configPath) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"))
      console.log(`Loading config from ${configPath}`)
    } catch (err) {
      console.error(`Failed to parse config file ${configPath}: ${err}`)
      process.exit(1)
    }
  } else if (agents.length === 0) {
    fileConfig = loadConfigFile()
  }

  return {
    agents: agents.length > 0 ? agents : fileConfig?.agents ?? [],
    autoApprove: autoApprove || fileConfig?.autoApprove || false,
    verbose,
    dashboardPort: dashboardPortExplicit ? dashboardPort : (fileConfig?.dashboardPort ?? dashboardPort),
    mode: fileConfig?.mode ?? "projects",
    brain: {
      model: fileConfig?.brain?.model ?? "glm-5.1:cloud",
      ollamaUrl: fileConfig?.brain?.ollamaUrl ?? "http://127.0.0.1:11434",
    },
    supervisor: fileConfig?.supervisor ?? {},
    projects: fileConfig?.projects,
    scheduling: fileConfig?.scheduling ?? "parallel",
    concurrency: fileConfig?.concurrency ?? 1,
    cyclesPerRotation: fileConfig?.cyclesPerRotation ?? 2,
    team: fileConfig?.team,
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

function statusIcon(status: string): string {
  switch (status) {
    case "idle":
      return "[IDLE]"
    case "busy":
      return "[BUSY]"
    case "completed":
      return "[DONE]"
    case "connected":
      return "[ OK ]"
    case "disconnected":
      return "[DOWN]"
    case "error":
      return "[ERR!]"
    default:
      return `[${status.toUpperCase().slice(0, 4)}]`
  }
}

async function main() {
  const { agents, autoApprove, verbose, dashboardPort, mode, brain: brainConfig, supervisor: supervisorLimits, projects, scheduling, concurrency, cyclesPerRotation, team: teamConfig } = parseArgs()

  // Dashboard event log — shared between orchestrator callbacks and the web UI
  const dashLog = new DashboardLog()

  // Soft-stop flag — set by the "stop" command to finish current cycle then exit
  let activeSoftStop: { requested: boolean } | null = null

  console.log(`${C.brightMagenta}${C.bold}=== OpenCode Orchestrator ===${C.reset}`)

  // --- Crash detection: check if previous session exited uncleanly ---
  const { crashed, state: prevState } = await detectCrash()
  if (crashed && prevState) {
    console.log(`\n${C.brightYellow}${C.bold}⚠ Crash Recovery Available${C.reset}`)
    console.log(C.yellow + formatCrashReport(prevState) + C.reset)
    console.log(`\n${C.dim}Projects from the previous session will be available to restore via the dashboard.${C.reset}`)
    console.log(`${C.dim}Use "Restore Saved" to pick up where you left off.${C.reset}\n`)
    dashLog.push({
      type: "brain-thinking",
      text: `⚠ Previous session (PID ${prevState.pid}) crashed. ${Object.keys(prevState.supervisors).length} supervisor(s) were active. Use "Restore Saved" to resume.`,
    })
  }

  // Write session state for this run (enables crash detection on next startup)
  await initSessionState({ dashboardPort, mode })

  if (agents.length > 0) {
    console.log(`Pre-configured agents: ${agents.map((a) => `${a.name} @ ${a.url}`).join(", ")}`)
  } else {
    console.log("No pre-configured agents. Use the dashboard to add projects,")
    console.log("or configure agents in orchestrator.json.")
  }
  if (autoApprove) console.log("Auto-approve: enabled")
  console.log("")

  const config: OrchestratorConfig = {
    agents,
    autoApprove,
    stuckThresholdMs: supervisorLimits.stuckThresholdMs,

    onEvent(event: AgentEvent) {
      const { type } = event.event
      if (type === "session.status") {
        const status = event.event.properties.status as string | undefined
        if (status === "busy" || status === "running") return
      }
      if (verbose) {
        console.log(`  [${event.agentName}] ${type}`)
      }
      // Forward permission requests to dashboard
      if (type === "permission.request") {
        const props = event.event.properties as Record<string, unknown>
        const requestID = (props.id ?? props.requestID ?? "") as string
        const tool = (props.tool ?? props.name ?? "") as string
        const input = props.input ? JSON.stringify(props.input, null, 2) : ""
        dashLog.push({
          type: "permission-request",
          agent: event.agentName,
          requestID,
          description: `Tool: ${tool}\n${input}`.trim(),
          properties: props,
        })
      }
      // Forward to dashboard
      dashLog.push({
        type: "agent-event",
        agent: event.agentName,
        event: event.event,
      })
    },

    onRawEvent: verbose
      ? (event: AgentEvent) => {
          console.log(`  [${event.agentName}] ${event.event.type}`)
        }
      : undefined,

    onStatusChange(agentName, status, detail) {
      const statusColor = status === "error" || status === "disconnected" ? C.brightRed
        : status === "busy" ? C.yellow
        : status === "completed" ? C.green
        : C.blue
      console.log(`${statusColor}${statusIcon(status)}${C.reset} ${C.cyan}${agentName}${C.reset} ${C.gray}->${C.reset} ${statusColor}${status}${C.reset}${detail ? ` ${C.dim}(${detail})${C.reset}` : ""}`)
      dashLog.push({
        type: "agent-status",
        agent: agentName,
        status,
        detail,
      })
    },

    onAgentComplete(agentName, messages) {
      const response = extractLastAssistantText(messages)
      if (response) {
        console.log("")
        console.log(`${C.green}${C.bold}--- ${agentName} response ---${C.reset}`)
        const maxLen = 2000
        if (response.length > maxLen) {
          console.log(
            response.slice(0, maxLen) +
              `\n${C.dim}... (${response.length - maxLen} more chars, use "messages ${agentName}" to see full)${C.reset}`,
          )
        } else {
          console.log(response)
        }
        console.log(`${C.green}--- end ${agentName} ---${C.reset}`)
        console.log("")
        // Note: NOT pushing agent-response here — the supervisor's WAIT handler
        // already pushes it to dashboardLog, so pushing here would cause duplicates.
      }
    },

    async onPermissionRequest(agentName, permission) {
      console.log(`\n${C.brightYellow}[PERM]${C.reset} ${C.cyan}${agentName}${C.reset} ${C.yellow}requests permission:${C.reset}`, JSON.stringify(permission, null, 2))
      return "approve"
    },

    onAgentStuck(agentName, busyDurationMs) {
      const mins = Math.round(busyDurationMs / 60_000)
      console.log(`\n${C.brightRed}[STUCK]${C.reset} ${C.cyan}${agentName}${C.reset} ${C.red}has been busy for ${mins}min with no new messages${C.reset}`)
      dashLog.push({
        type: "agent-status",
        agent: agentName,
        status: "stuck",
        detail: `Busy for ${mins}min with no progress`,
      })
      // Auto-fetch latest messages for debugging (orchestrator is available via closure after init)
      if (lazyOrchestrator) {
        ;(async () => {
          try {
            const msgs = await lazyOrchestrator!.getMessages(agentName)
            const lastText = extractLastAssistantText(msgs)
            if (lastText) {
              dashLog.push({
                type: "agent-response",
                agent: agentName,
                text: `[AUTO-CAPTURED — agent stuck] ${lastText.slice(0, 2000)}`,
              })
            }
          } catch {}
        })()
      }
    },
  }

  // Lazy ref so onAgentStuck can access the orchestrator after initialization
  let lazyOrchestrator: Awaited<ReturnType<typeof createOrchestrator>> | null = null

  const orchestrator = await createOrchestrator(config)
  lazyOrchestrator = orchestrator

  // Event bus and resource manager — shared across all agents
  const { EventBus } = await import("./event-bus")
  const { ResourceManager } = await import("./resource-manager")
  const eventBus = new EventBus()
  const resourceManager = new ResourceManager(2) // max 2 concurrent LLM calls

  // ProjectManager — handles dynamic agent provisioning from the dashboard
  const projectManager = new ProjectManager(orchestrator, dashLog, brainConfig, supervisorLimits, eventBus, resourceManager)

  // REPL reader — declared early so handleCommand can re-prompt after background brain tasks
  let reader: any = null

  // Team manager instance — lives across commands, set when team-loop starts
  let activeTeamManager: import("./team-manager").TeamManager | null = null

  // Shared command handler for both REPL and dashboard
  let brainRunning = false

  function findProject(idOrName: string) {
    return projectManager.listProjects().find(p => p.id === idOrName || p.name === idOrName || p.agentName === idOrName)
  }

  async function handleCommand(command: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const trimmed = command.trim()
    if (!trimmed) return { ok: false, error: "Empty command" }

    // Record user command to prompt ledger
    recordPrompt({
      source: "user", target: "system", direction: "outbound",
      content: trimmed,
    }).catch(() => {})

    if (trimmed === "status") {
      const statuses = await orchestrator.status()
      const lines: string[] = []
      for (const [name, s] of statuses) {
        lines.push(`${statusIcon(s.status)} ${name} | session: ${s.sessionID ?? "none"} | last: ${formatTime(s.lastActivity)}`)
      }
      return { ok: true, output: lines.join("\n") }
    }

    if (trimmed === "stop") {
      const hasActiveBrain = !!activeSoftStop
      const hasProjectSupervisors = projectManager.listProjects().some(p => p.status === "supervising")

      if (!hasActiveBrain && !hasProjectSupervisors) {
        return { ok: false, error: "Nothing to stop — no brain-loop or project supervisors running." }
      }

      const parts: string[] = []
      if (activeSoftStop) {
        activeSoftStop.requested = true
        parts.push(activeTeamManager ? "team-loop" : "brain-loop")
      }
      if (hasProjectSupervisors) {
        projectManager.softStopAll()
        parts.push("project supervisors")
      }

      console.log("\n[stop] Soft stop requested.")
      dashLog.push({ type: "brain-thinking", text: "--- Soft stop requested ---" })
      return { ok: true, output: `Soft stop requested for: ${parts.join(", ")}. Will finish current cycles.` }
    }

    if (trimmed.startsWith("pause ")) {
      const idOrName = trimmed.slice(6).trim()
      if (!idOrName) return { ok: false, error: "Usage: pause <project-id-or-name>" }
      const project = projectManager.listProjects().find(p => p.id === idOrName || p.name === idOrName || p.agentName === idOrName)
      if (!project) return { ok: false, error: `Unknown project: ${idOrName}` }
      try {
        projectManager.pauseProject(project.id)
        return { ok: true, output: `Pause requested for ${project.name}. Supervisor will finish current plan and hold.` }
      } catch (err) { return { ok: false, error: String(err) } }
    }

    if (trimmed.startsWith("resume ")) {
      const idOrName = trimmed.slice(7).trim()
      if (!idOrName) return { ok: false, error: "Usage: resume <project-id-or-name>" }
      const project = projectManager.listProjects().find(p => p.id === idOrName || p.name === idOrName || p.agentName === idOrName)
      if (!project) return { ok: false, error: `Unknown project: ${idOrName}` }
      try {
        projectManager.resumeProject(project.id)
        return { ok: true, output: `Resume requested for ${project.name}.` }
      } catch (err) { return { ok: false, error: String(err) } }
    }

    if (trimmed === "pause-all") {
      projectManager.pauseAll()
      return { ok: true, output: "Pause requested for all supervising projects." }
    }

    if (trimmed === "resume-all") {
      projectManager.resumeAll()
      return { ok: true, output: "Resume requested for all paused projects." }
    }

    // ---- Branch & Validation commands ----
    if (trimmed.startsWith("branch ")) {
      const idOrName = trimmed.slice(7).trim()
      const project = findProject(idOrName)
      if (!project) return { ok: false, error: `Unknown project: ${idOrName}` }
      const branch = projectManager.getAgentBranch(project.id)
      return { ok: true, output: branch ? `Agent branch: ${branch}` : "No agent branch (branch isolation not active)" }
    }

    if (trimmed.startsWith("merge ")) {
      const parts = trimmed.slice(6).trim().split(" ")
      const idOrName = parts[0]!
      const target = parts[1] || "main"
      const project = findProject(idOrName)
      if (!project) return { ok: false, error: `Unknown project: ${idOrName}` }
      try {
        const result = await projectManager.mergeAgentBranch(project.id, target)
        return { ok: result.success, output: result.success ? `Merged into ${target}` : `Merge failed: ${result.output}` }
      } catch (err) { return { ok: false, error: String(err) } }
    }

    if (trimmed.startsWith("validate ")) {
      const rest = trimmed.slice(9).trim()
      const spaceIdx = rest.indexOf(" ")
      if (spaceIdx === -1) return { ok: false, error: "Usage: validate <project-id> <command|preset>\nPresets: test, typecheck, lint, build, test+typecheck" }
      const idOrName = rest.slice(0, spaceIdx)
      const commandOrPreset = rest.slice(spaceIdx + 1)
      const project = findProject(idOrName)
      if (!project) return { ok: false, error: `Unknown project: ${idOrName}` }
      const presets = ["test", "typecheck", "lint", "build", "test+typecheck"]
      const isPreset = presets.includes(commandOrPreset.trim().toLowerCase())
      try {
        const config = isPreset
          ? { preset: commandOrPreset.trim().toLowerCase() as any, failAction: "inject" as const }
          : { command: commandOrPreset, failAction: "inject" as const }
        projectManager.setValidationConfig(project.id, config)
        return { ok: true, output: `Validation set for ${project.name}: ${isPreset ? `preset "${commandOrPreset}"` : commandOrPreset}` }
      } catch (err) { return { ok: false, error: String(err) } }
    }

    if (trimmed === "locks") {
      if (!resourceManager) return { ok: true, output: "Resource manager not available" }
      const locks = resourceManager.getActiveLocks()
      if (locks.size === 0) return { ok: true, output: "No active file locks" }
      const lines = Array.from(locks.entries()).map(([agent, lock]) =>
        `  ${agent}: ${lock.files.slice(0, 5).join(", ")}${lock.files.length > 5 ? "..." : ""}`
      )
      return { ok: true, output: `Active file locks:\n${lines.join("\n")}\nLLM queue: ${resourceManager.getLlmQueueDepth()} waiting` }
    }

    if (trimmed === "providers") {
      const { loadProviders, resolveApiKey } = await import("./providers")
      const providers = await loadProviders()
      if (providers.length === 0) return { ok: true, output: "No providers configured" }
      const lines = providers.map(p => {
        const status = p.enabled ? "[ON]" : "[OFF]"
        const hasKey = resolveApiKey(p) ? "key:yes" : (p.id === "ollama" ? "key:n/a" : "key:NO")
        const models = p.models.length > 0 ? p.models.slice(0, 3).join(", ") + (p.models.length > 3 ? "..." : "") : "(no models)"
        return `  ${status} ${p.id} (${p.name}) — ${hasKey} — ${models}`
      })
      return { ok: true, output: `LLM Providers:\n${lines.join("\n")}` }
    }

    if (trimmed.startsWith("provider enable ") || trimmed.startsWith("provider disable ")) {
      const parts = trimmed.split(" ")
      const action = parts[1]
      const id = parts[2]
      if (!id) return { ok: false, output: "Usage: provider enable|disable <id>" }
      const { enableProvider } = await import("./providers")
      const ok = await enableProvider(id, action === "enable")
      return { ok, output: ok ? `Provider ${id} ${action}d` : `Provider "${id}" not found` }
    }

    if (trimmed.startsWith("provider key ")) {
      const parts = trimmed.split(" ")
      const id = parts[2]
      const key = parts.slice(3).join(" ")
      if (!id || !key) return { ok: false, output: "Usage: provider key <id> <api-key>" }
      const { setProviderApiKey } = await import("./providers")
      const ok = await setProviderApiKey(id, key)
      return { ok, output: ok ? `API key set for ${id}` : `Provider "${id}" not found` }
    }

    if (trimmed === "models") {
      const { listAllModels } = await import("./providers")
      const models = await listAllModels()
      if (models.length === 0) return { ok: true, output: "No models available. Enable providers and add API keys." }
      let lastProvider = ""
      const lines: string[] = []
      for (const m of models) {
        if (m.provider !== lastProvider) {
          lines.push(`  -- ${m.providerName} --`)
          lastProvider = m.provider
        }
        const ref = m.provider === "ollama" ? m.model : `${m.provider}:${m.model}`
        lines.push(`    ${ref}`)
      }
      return { ok: true, output: `Available models:\n${lines.join("\n")}\n\nUse provider:model format when setting model (e.g., openai:gpt-4o)` }
    }

    if (trimmed === "intents") {
      if (!resourceManager) return { ok: true, output: "Resource manager not available" }
      const intents = resourceManager.getAllIntents()
      if (intents.size === 0) return { ok: true, output: "No declared work intents" }
      const lines = Array.from(intents.entries()).map(([agent, intent]) => {
        const files = intent.files.length > 0
          ? intent.files.slice(0, 5).join(", ") + (intent.files.length > 5 ? "..." : "")
          : "(no files)"
        const ago = Math.round((Date.now() - intent.declaredAt) / 1000)
        return `  ${agent}: ${intent.description} [${files}] (${ago}s ago)`
      })
      return { ok: true, output: `Declared work intents:\n${lines.join("\n")}` }
    }

    if (trimmed.startsWith("events")) {
      if (!eventBus) return { ok: true, output: "Event bus not available" }
      const limit = parseInt(trimmed.slice(6).trim()) || 20
      const events = eventBus.getRecent(undefined, limit)
      if (events.length === 0) return { ok: true, output: "No recent bus events" }
      const lines = events.map(e => {
        const time = new Date(e.timestamp).toLocaleTimeString()
        return `  ${time} [${e.type}] ${e.agentName ?? e.source} ${JSON.stringify(e.data).slice(0, 80)}`
      })
      return { ok: true, output: `Recent events (${events.length}):\n${lines.join("\n")}` }
    }

    if (trimmed === "projects") {
      const list = projectManager.listProjects()
      if (list.length === 0) return { ok: true, output: "No projects. Add projects from the dashboard or use: project add <directory>" }
      const lines = list.map(p => `  ${p.id} | ${p.name} | ${p.status} | port ${p.workerPort} | ${p.directory}`)
      return { ok: true, output: lines.join("\n") }
    }

    if (trimmed.startsWith("project add ")) {
      const rest = trimmed.slice(12).trim()
      if (!rest) return { ok: false, error: "Usage: project add <directory> [name]" }
      const parts = rest.split(" ")
      const directory = parts[0]!
      const name = parts.slice(1).join(" ") || undefined
      try {
        const project = await projectManager.addProject(directory, "Continuously develop and improve the project. Fix bugs, add features, review code quality.", name)
        return { ok: true, output: `Added project: ${project.name} (${project.id}) on port ${project.workerPort}` }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }

    if (trimmed.startsWith("project remove ")) {
      const id = trimmed.slice(15).trim()
      if (!id) return { ok: false, error: "Usage: project remove <project-id>" }
      try {
        await projectManager.removeProject(id)
        return { ok: true, output: `Removed project: ${id}` }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }

    if (trimmed === "tasks") {
      const queue = await loadTaskQueue()
      return { ok: true, output: formatQueueForPrompt(queue) }
    }

    if (trimmed.startsWith("task add ")) {
      const title = trimmed.slice(9).trim()
      if (!title) return { ok: false, error: "Usage: task add <title>" }
      let queue = await loadTaskQueue()
      queue = await addTask(queue, { title, description: "" })
      return { ok: true, output: `Added task: ${title}` }
    }

    if (trimmed.startsWith("messages ")) {
      const agentName = trimmed.slice(9).trim()
      try {
        const messages = await orchestrator.getMessages(agentName)
        const lines = formatRecentMessages(messages, 4, 500)
        return { ok: true, output: lines.join("\n\n") }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }

    if (trimmed.startsWith("brain-loop")) {
      if (brainRunning) return { ok: false, error: "Brain/team is already running." }

      // Guard: don't run parallel supervisors if ProjectManager already has supervisors on these agents
      const supervisedProjects = projectManager.listProjects().filter(p => p.status === "supervising")
      if (supervisedProjects.length > 0) {
        const names = supervisedProjects.map(p => p.name).join(", ")
        return { ok: false, error: `Project supervisors already running for: ${names}. Use "stop" first to avoid duplicate supervision.` }
      }

      const directive = trimmed.slice(10).trim()
      const activeDirective = directive || "Continuously supervise your agent. Review their work, give feedback, assign new tasks, fix bugs, and improve code quality. Keep the agent productive."

      const agentCount = orchestrator.agents.size

      // Fire-and-forget — parallel supervisors run in background
      ;(async () => {
        brainRunning = true

        const ac = new AbortController()
        const softStop = { requested: false }
        activeSoftStop = softStop

        let hardStopped = false
        const stopLoop = () => { hardStopped = true; ac.abort(); activeSoftStop = null; console.log(`\n${C.brightRed}Hard stopping all supervisors...${C.reset}`) }
        process.once("SIGINT", stopLoop)

        console.log(`\n${C.brightMagenta}${C.bold}Starting ${agentCount} supervisors in ${scheduling} mode...${C.reset}`)
        if (scheduling === "sequential") {
          console.log(`  ${C.dim}Concurrency: ${concurrency} agent(s) at a time, ${cyclesPerRotation} cycles each${C.reset}`)
        }
        console.log(`${C.dim}Directive:${C.reset} ${C.white}"${activeDirective}"${C.reset}`)
        console.log(`${C.dim}Type "stop" for soft stop, Ctrl+C for hard stop.${C.reset}\n`)

        const { runParallelSupervisors } = await import("./supervisor")
        try {
          await runParallelSupervisors(orchestrator, {
            ollamaUrl: brainConfig.ollamaUrl,
            model: brainConfig.model,
            directive: activeDirective,
            cyclePauseSeconds: supervisorLimits.cyclePauseSeconds ?? 30,
            maxRoundsPerCycle: supervisorLimits.maxRoundsPerCycle ?? 12,
            reviewEnabled: true,
            supervisorLimits,
            projects,
            scheduling,
            concurrency,
            cyclesPerRotation,
            signal: ac.signal,
            softStop,
            dashboardLog: dashLog,
            onThinking(agentName, thought) {
              console.log(formatThought(agentName, thought))
            },
          })
          console.log(`\n${C.brightMagenta}${C.bold}All supervisors finished.${C.reset}`)
        } catch (err) {
          console.error(`Supervisor error: ${err}`)
        } finally {
          const finalStatus = hardStopped ? "idle" : "done"
          dashLog.push({ type: "brain-status", status: finalStatus })
          if (hardStopped) dashLog.push({ type: "brain-thinking", text: "--- Hard stopped by user ---" })
          activeSoftStop = null
          brainRunning = false
          process.removeListener("SIGINT", stopLoop)
        }
        try { reader?.prompt() } catch {}
      })()
      return { ok: true, output: `${agentCount} parallel supervisors started: ${activeDirective}` }
    }

    // --- Team mode commands ---

    if (trimmed === "team-loop" || trimmed.startsWith("team-loop ")) {
      if (brainRunning) return { ok: false, error: "Brain/team is already running." }
      if (!teamConfig || !teamConfig.goal) {
        return { ok: false, error: 'No team config found. Add a "team" section with "goal" and "members" to orchestrator.json and set "mode": "teams".' }
      }
      if (teamConfig.members.length === 0) {
        return { ok: false, error: 'Team has no members. Add members to "team.members" in orchestrator.json.' }
      }

      // Pre-flight: check that all team member agents are registered in the orchestrator
      const registeredAgents = new Set(orchestrator.agents.keys())
      const missingAgents = teamConfig.members.filter(m => !registeredAgents.has(m.agentName))
      if (missingAgents.length > 0) {
        const names = missingAgents.map(m => `"${m.agentName}"`).join(", ")
        return { ok: false, error: `Team members reference unregistered agents: ${names}. Add them to "agents" in orchestrator.json first.` }
      }

      const goalOverride = trimmed.slice(9).trim()

      ;(async () => {
        brainRunning = true

        const ac = new AbortController()
        const softStop = { requested: false }
        activeSoftStop = softStop

        let hardStopped = false
        const stopLoop = () => { hardStopped = true; ac.abort(); activeSoftStop = null; console.log(`\n${C.brightRed}Hard stopping team manager...${C.reset}`) }
        process.once("SIGINT", stopLoop)

        console.log(`\n${C.brightMagenta}${C.bold}Starting team mode with ${teamConfig!.members.length} members...${C.reset}`)
        console.log(`${C.dim}Goal:${C.reset} ${C.white}"${goalOverride || teamConfig!.goal}"${C.reset}`)
        console.log(`${C.dim}Manager check-in interval: ${teamConfig!.managerIntervalSeconds ?? 120}s${C.reset}`)
        console.log(`${C.dim}Type "stop" for soft stop, Ctrl+C for hard stop.${C.reset}\n`)

        const { TeamManager } = await import("./team-manager")
        const tm = new TeamManager(orchestrator, {
          ollamaUrl: brainConfig.ollamaUrl,
          model: brainConfig.model,
          goal: goalOverride || teamConfig!.goal,
          members: teamConfig!.members,
          managerIntervalSeconds: teamConfig!.managerIntervalSeconds,
          managerMaxRounds: teamConfig!.managerMaxRounds,
          supervisorLimits,
          scheduling,
          concurrency,
          cyclesPerRotation,
          signal: ac.signal,
          softStop,
          dashboardLog: dashLog,
          onThinking(source, thought) {
            console.log(formatThought(source, thought))
          },
        })
        activeTeamManager = tm

        try {
          await tm.run()
          console.log(`\n${C.brightMagenta}${C.bold}Team manager finished.${C.reset}`)
        } catch (err) {
          console.error(`${C.brightRed}Team manager error:${C.reset} ${err}`)
        } finally {
          const finalStatus = hardStopped ? "idle" : "done"
          dashLog.push({ type: "brain-status", status: finalStatus })
          if (hardStopped) dashLog.push({ type: "brain-thinking", text: "--- Team hard stopped by user ---" })
          activeSoftStop = null
          activeTeamManager = null
          brainRunning = false
          process.removeListener("SIGINT", stopLoop)
        }
        try { reader?.prompt() } catch {}
      })()
      return { ok: true, output: `Team started with ${teamConfig.members.length} members. Goal: "${goalOverride || teamConfig.goal}"` }
    }

    if (trimmed === "team") {
      if (!activeTeamManager) return { ok: false, error: "No team running. Use 'team-loop' to start." }
      const members = activeTeamManager.listMembers()
      if (members.length === 0) return { ok: true, output: "No team members." }
      const lines = members.map(m =>
        `  ${m.role} (${m.agentName}) | ${m.status} | directive: ${m.directive.slice(0, 80)}...\n    last: ${m.recentSummary.slice(0, 120)}`
      )
      return { ok: true, output: `Team members:\n${lines.join("\n")}` }
    }

    if (trimmed === "team hire-requests") {
      if (!activeTeamManager) return { ok: false, error: "No team running." }
      const reqs = activeTeamManager.getHireRequests()
      if (reqs.length === 0) return { ok: true, output: "No pending hire requests." }
      const lines = reqs.map((r, i) => `  [${i}] ${r.role} at ${r.directory}`)
      return { ok: true, output: `Pending hire requests:\n${lines.join("\n")}\nUse 'team approve-hire <index> <agent-name>' to approve.` }
    }

    if (trimmed.startsWith("team approve-hire ")) {
      if (!activeTeamManager) return { ok: false, error: "No team running." }
      const parts = trimmed.slice(18).trim().split(" ")
      const idx = parseInt(parts[0] ?? "", 10)
      const agentName = parts[1]
      if (isNaN(idx) || !agentName) return { ok: false, error: "Usage: team approve-hire <index> <agent-name>" }
      const reqs = activeTeamManager.getHireRequests()
      if (idx < 0 || idx >= reqs.length) return { ok: false, error: `Invalid index. ${reqs.length} pending requests.` }
      const req = reqs[idx]!
      activeTeamManager.addMember({ role: req.role, agentName, directory: req.directory, directive: `Work on ${req.role} tasks for the team goal.` })
      activeTeamManager.removeHireRequest(idx)
      return { ok: true, output: `Hired ${agentName} as ${req.role} at ${req.directory}` }
    }

    if (trimmed === "team dissolve-requests") {
      if (!activeTeamManager) return { ok: false, error: "No team running." }
      const reqs = activeTeamManager.getDissolveRequests()
      if (reqs.length === 0) return { ok: true, output: "No pending dissolve requests." }
      const lines = reqs.map((r, i) => `  [${i}] ${r}`)
      return { ok: true, output: `Pending dissolve requests:\n${lines.join("\n")}\nUse 'team approve-dissolve <agent-name>' to approve.` }
    }

    if (trimmed.startsWith("team approve-dissolve ")) {
      if (!activeTeamManager) return { ok: false, error: "No team running." }
      const agentName = trimmed.slice(21).trim()
      if (!agentName) return { ok: false, error: "Usage: team approve-dissolve <agent-name>" }
      activeTeamManager.removeMember(agentName)
      activeTeamManager.removeDissolveRequest(agentName)
      return { ok: true, output: `Dissolved team member: ${agentName}` }
    }

    if (trimmed === "brain-queue") {
      if (brainRunning) return { ok: false, error: "Brain is already running." }
      const queue = await loadTaskQueue()
      const pending = queue.tasks.filter(t => t.status === "pending")
      if (pending.length === 0) return { ok: false, error: "No pending tasks. Use 'task add <title>' first." }

      ;(async () => {
        brainRunning = true
        dashLog.push({ type: "brain-status", status: "running" })
        console.log(`\nStarting brain with ${pending.length} pending tasks...`)

        const { runBrain } = await import("./brain")
        const queueSummary = formatQueueForPrompt(queue)
        let queueError: unknown = null
        try {
          await runBrain(orchestrator, {
            ollamaUrl: brainConfig.ollamaUrl,
            model: brainConfig.model,
            objective: `Work through the following task queue in order. Mark each task as done when completed.\n\n${queueSummary}`,
            maxRounds: 50,
            dashboardLog: dashLog,
            onThinking(thought) {
              console.log(thought)
              dashLog.push({ type: "brain-thinking", text: thought })
            },
          })
          console.log("\nBrain finished processing queue.")
        } catch (err) {
          queueError = err
          console.error(`Brain error: ${err}`)
        } finally {
          dashLog.push({ type: "brain-status", status: queueError ? "idle" : "done" })
          brainRunning = false
        }
        try { reader?.prompt() } catch {}
      })()
      return { ok: true, output: `Brain started with ${pending.length} tasks.` }
    }

    if (trimmed.startsWith("brain ")) {
      if (brainRunning) return { ok: false, error: "Brain is already running." }
      const objective = trimmed.slice(6).trim()
      if (!objective) return { ok: false, error: "Usage: brain <objective>" }

      ;(async () => {
        brainRunning = true
        dashLog.push({ type: "brain-status", status: "running" })
        dashLog.push({ type: "brain-thinking", text: `Objective: ${objective}` })
        console.log(`\nStarting LLM brain with objective: "${objective}"`)

        const { runBrain } = await import("./brain")
        let brainError: unknown = null
        try {
          await runBrain(orchestrator, {
            ollamaUrl: brainConfig.ollamaUrl,
            model: brainConfig.model,
            objective,
            maxRounds: 50,
            dashboardLog: dashLog,
            onThinking(thought) {
              console.log(thought)
              dashLog.push({ type: "brain-thinking", text: thought })
            },
          })
          console.log("\nBrain finished.")
        } catch (err) {
          brainError = err
          console.error(`Brain error: ${err}`)
        } finally {
          if (brainError) {
            dashLog.push({ type: "brain-status", status: "idle" })
            dashLog.push({ type: "brain-thinking", text: `Error: ${brainError}` })
          } else {
            dashLog.push({ type: "brain-status", status: "done" })
            dashLog.push({ type: "brain-thinking", text: "--- Brain finished ---" })
          }
          brainRunning = false
        }
        try { reader?.prompt() } catch {}
      })()
      return { ok: true, output: `Brain started: ${objective}` }
    }

    // Agent prompt: <agent-name> <prompt> or all <prompt>
    const spaceIdx = trimmed.indexOf(" ")
    if (spaceIdx === -1) return { ok: false, error: "Unknown command. Press ? for help." }

    const target = trimmed.slice(0, spaceIdx)
    const prompt = trimmed.slice(spaceIdx + 1)

    try {
      if (target === "all") {
        const agentNames = Array.from(orchestrator.agents.keys())
        for (const name of agentNames) {
          dashLog.push({ type: "agent-prompt", agent: name, text: prompt })
        }
        await orchestrator.promptAll(agentNames.map(name => ({ agentName: name, text: prompt })))
        return { ok: true, output: `Sent to all ${agentNames.length} agents.` }
      } else {
        if (!orchestrator.agents.has(target)) {
          return { ok: false, error: `Unknown agent: ${target}` }
        }
        dashLog.push({ type: "agent-prompt", agent: target, text: prompt })
        await orchestrator.prompt(target, prompt)
        return { ok: true, output: `Sent to ${target}.` }
      }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  // Start the dashboard web server
  let dashboard: { stop: () => void }
  try {
    dashboard = await startDashboard(orchestrator, dashLog, dashboardPort, {
      onSoftStop() {
        if (activeSoftStop) {
          activeSoftStop.requested = true
          console.log("\n[dashboard] Soft stop requested from web UI.")
          dashLog.push({ type: "brain-thinking", text: "--- Soft stop requested from dashboard ---" })
        }
        // Also soft-stop all project supervisors
        projectManager.softStopAll()
      },
      onCommand: handleCommand,
      projectManager,
      getTeamManager: () => activeTeamManager,
      eventBus,
      resourceManager,
    })
    console.log(`Dashboard: http://127.0.0.1:${dashboardPort}`)
  } catch (err) {
    console.error(`Failed to start dashboard: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // --- Session heartbeat — updates PID file every 30s so crash detection has fresh timestamps ---
  const { updateSessionHeartbeat } = await import("./session-state")
  const heartbeatTimer = setInterval(() => {
    updateSessionHeartbeat().catch(() => {})
  }, 30_000)

  // --- Graceful shutdown on signals ---
  let shuttingDown = false
  function gracefulShutdown(signal: string) {
    if (shuttingDown) {
      console.log(`\n[${signal}] Forced exit.`)
      process.exit(1)
    }
    shuttingDown = true
    console.log(`\n[${signal}] Shutting down...`)
    clearInterval(heartbeatTimer)
    // Mark session as cleanly shut down before stopping components
    markCleanShutdown().catch(() => {})
    projectManager.shutdown()
    dashboard.stop()
    orchestrator.shutdown()
    process.exit(0)
  }
  process.on("SIGINT", () => gracefulShutdown("SIGINT"))
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
  process.on("SIGHUP", () => gracefulShutdown("SIGHUP"))
  // Catch unhandled errors so the dashboard port is released even on crashes
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err)
    gracefulShutdown("uncaughtException")
  })
  process.on("unhandledRejection", (err) => {
    console.error("[unhandledRejection]", err)
    gracefulShutdown("unhandledRejection")
  })

  // --- Interactive REPL ---
  reader = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "orchestrator> ",
  })

  const helpCmd = (cmd: string, desc: string) => console.log(`  ${C.brightCyan}${cmd.padEnd(27)}${C.reset}${C.dim}${desc}${C.reset}`)
  console.log(`${C.bold}Commands:${C.reset}`)
  helpCmd("<agent-name> <prompt>", "Send prompt to an agent")
  helpCmd("all <prompt>", "Send prompt to all agents")
  helpCmd("brain <objective>", "One-shot brain (orchestrator-level)")
  helpCmd("brain-loop <directive>", "Start per-agent supervisors (projects mode)")
  helpCmd("team-loop [goal]", "Start team mode with manager coordination")
  helpCmd("brain-queue", "Run brain through the task queue")
  helpCmd("stop", "Soft stop all supervisors/team")
  helpCmd("team", "List team members and status")
  helpCmd("team hire-requests", "View pending hire requests from manager")
  helpCmd("team dissolve-requests", "View pending dissolve requests from manager")
  helpCmd("projects", "List active projects")
  helpCmd("project add <dir> [name]", "Add a project (spawns agent + supervisor)")
  helpCmd("project remove <id>", "Remove a project")
  helpCmd("tasks", "Show task queue")
  helpCmd("task add <title>", "Add a task to the queue")
  helpCmd("status", "Show agent status")
  helpCmd("messages <agent-name>", "Show recent messages")
  helpCmd("quit", "Exit")
  console.log("")
  console.log(`${C.dim}Mode: ${C.reset}${C.brightMagenta}${mode}${C.reset} ${C.dim}| Scheduling: ${C.reset}${C.brightCyan}${scheduling}${C.reset} ${C.dim}(concurrency=${concurrency}, cyclesPerRotation=${cyclesPerRotation})${C.reset}`)
  console.log("")

  reader.prompt()

  reader.on("line", async (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) {
      reader.prompt()
      return
    }

    if (trimmed === "quit" || trimmed === "exit") {
      gracefulShutdown("quit")
      return
    }

    const result = await handleCommand(trimmed)
    if (result.output) console.log(result.output)
    if (result.error) console.error(result.error)

    reader.prompt()
  })

  reader.on("close", () => {
    gracefulShutdown("close")
  })
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
