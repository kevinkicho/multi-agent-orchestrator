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

type ConfigFile = {
  agents: AgentConfig[]
  autoApprove?: boolean
  pollInterval?: number
  dashboardPort?: number
  brain?: { model?: string; ollamaUrl?: string }
  /** Tunable supervisor limits */
  supervisor?: SupervisorLimits
  /** Phase 3: optional project role mapping { agentName: { coder, reviewer? } } */
  projects?: Record<string, { coder: string; reviewer?: string }>
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
  brain: { model: string; ollamaUrl: string }
  supervisor: SupervisorLimits
  projects?: Record<string, { coder: string; reviewer?: string }>
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
    brain: {
      model: fileConfig?.brain?.model ?? "glm-5.1:cloud",
      ollamaUrl: fileConfig?.brain?.ollamaUrl ?? "http://127.0.0.1:11434",
    },
    supervisor: fileConfig?.supervisor ?? {},
    projects: fileConfig?.projects,
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
  const { agents, autoApprove, verbose, dashboardPort, brain: brainConfig, supervisor: supervisorLimits, projects } = parseArgs()

  // Dashboard event log — shared between orchestrator callbacks and the web UI
  const dashLog = new DashboardLog()

  // Soft-stop flag — set by the "stop" command to finish current cycle then exit
  let activeSoftStop: { requested: boolean } | null = null

  console.log("=== OpenCode Orchestrator ===")
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
      console.log(`${statusIcon(status)} ${agentName} -> ${status}${detail ? ` (${detail})` : ""}`)
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
        console.log(`--- ${agentName} response ---`)
        const maxLen = 2000
        if (response.length > maxLen) {
          console.log(
            response.slice(0, maxLen) +
              `\n... (${response.length - maxLen} more chars, use "messages ${agentName}" to see full)`,
          )
        } else {
          console.log(response)
        }
        console.log(`--- end ${agentName} ---`)
        console.log("")

        // Forward full response to dashboard
        dashLog.push({
          type: "agent-response",
          agent: agentName,
          text: response,
        })
      }
    },

    async onPermissionRequest(agentName, permission) {
      console.log(`\n[PERM] ${agentName} requests permission:`, JSON.stringify(permission, null, 2))
      return "approve"
    },

    onAgentStuck(agentName, busyDurationMs) {
      const mins = Math.round(busyDurationMs / 60_000)
      console.log(`\n[STUCK] ${agentName} has been busy for ${mins}min with no new messages`)
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

  // ProjectManager — handles dynamic agent provisioning from the dashboard
  const projectManager = new ProjectManager(orchestrator, dashLog, brainConfig, supervisorLimits)

  // REPL reader — declared early so handleCommand can re-prompt after background brain tasks
  let reader: any = null

  // Shared command handler for both REPL and dashboard
  let brainRunning = false

  async function handleCommand(command: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    const trimmed = command.trim()
    if (!trimmed) return { ok: false, error: "Empty command" }

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
        parts.push("brain-loop")
      }
      if (hasProjectSupervisors) {
        projectManager.softStopAll()
        parts.push("project supervisors")
      }

      console.log("\n[stop] Soft stop requested.")
      dashLog.push({ type: "brain-thinking", text: "--- Soft stop requested ---" })
      return { ok: true, output: `Soft stop requested for: ${parts.join(", ")}. Will finish current cycles.` }
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
      if (brainRunning) return { ok: false, error: "Brain is already running." }

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
        const stopLoop = () => { hardStopped = true; ac.abort(); activeSoftStop = null; console.log("\nHard stopping all supervisors...") }
        process.once("SIGINT", stopLoop)

        console.log(`\nStarting ${agentCount} parallel supervisors...`)
        console.log(`Directive: "${activeDirective}"`)
        console.log('Type "stop" for soft stop, Ctrl+C for hard stop.\n')

        const { runParallelSupervisors } = await import("./supervisor")
        try {
          await runParallelSupervisors(orchestrator, {
            ollamaUrl: brainConfig.ollamaUrl,
            model: brainConfig.model,
            directive: activeDirective,
            cyclePauseSeconds: supervisorLimits.cyclePauseSeconds ?? 30,
            maxRoundsPerCycle: supervisorLimits.maxRoundsPerCycle ?? 30,
            reviewEnabled: true,
            supervisorLimits,
            projects,
            signal: ac.signal,
            softStop,
            dashboardLog: dashLog,
            onThinking(agentName, thought) {
              console.log(`[${agentName}] ${thought}`)
            },
          })
          console.log("\nAll supervisors finished.")
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
    })
    console.log(`Dashboard: http://127.0.0.1:${dashboardPort}`)
  } catch (err) {
    console.error(`Failed to start dashboard: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // --- Graceful shutdown on signals ---
  let shuttingDown = false
  function gracefulShutdown(signal: string) {
    if (shuttingDown) {
      console.log(`\n[${signal}] Forced exit.`)
      process.exit(1)
    }
    shuttingDown = true
    console.log(`\n[${signal}] Shutting down...`)
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

  console.log("Commands:")
  console.log("  <agent-name> <prompt>    Send prompt to an agent")
  console.log("  all <prompt>             Send prompt to all agents")
  console.log("  brain <objective>        One-shot brain (orchestrator-level)")
  console.log("  brain-loop <directive>   Parallel per-agent supervisors")
  console.log("  brain-queue              Run brain through the task queue")
  console.log("  stop                     Soft stop all supervisors")
  console.log("  projects                 List active projects")
  console.log("  project add <dir> [name] Add a project (spawns agent + supervisor)")
  console.log("  project remove <id>      Remove a project")
  console.log("  tasks                    Show task queue")
  console.log("  task add <title>         Add a task to the queue")
  console.log("  status                   Show agent status")
  console.log("  messages <agent-name>    Show recent messages")
  console.log("  quit                     Exit")
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
