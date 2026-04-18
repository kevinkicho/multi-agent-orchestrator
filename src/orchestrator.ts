import {
  type AgentConfig,
  type AgentState,
  createAgent,
  agentCreateSession,
  agentPrompt,
  agentGetMessages,
  agentGetSessionStatus,
  agentListPermissions,
  agentReplyPermission,
  agentHealthCheck,
  agentAbort,
  agentAnswerQuestion,
  agentRejectQuestion,
} from "./agent"
import { subscribeToAgentEvents, type AgentEvent } from "./events"
import { extractLastAssistantText } from "./message-utils"

/** Events that are too noisy to surface by default */
const FILTERED_EVENTS = new Set([
  "message.part.delta",
  "message.part.updated",
  "message.updated",
  "session.updated",
  "session.diff",
  "server.heartbeat",
  "server.connected",
])

/** Events that indicate meaningful activity */
const NOTABLE_EVENTS = new Set([
  "session.status",
  "session.idle",
  "session.error",
  "permission.request",
  "message.part.updated",
])

export type OrchestratorConfig = {
  agents: AgentConfig[]
  /** How often to poll for permission requests (ms). Default: 2000 */
  pollInterval?: number
  /** Auto-approve all permission requests. Default: false */
  autoApprove?: boolean
  /** Max time (ms) an agent can be busy before it's considered stuck. Default: 300000 (5 min) */
  stuckThresholdMs?: number
  /** Callback when an agent needs a decision from the orchestrator */
  onPermissionRequest?: (agentName: string, permission: unknown) => Promise<"approve" | "deny">
  /** Callback for notable events only (filtered, no spam) */
  onEvent?: (event: AgentEvent) => void
  /** Callback for ALL raw events (including deltas) — use for debugging */
  onRawEvent?: (event: AgentEvent) => void
  /** Callback when agent status changes */
  onStatusChange?: (agentName: string, status: string, detail?: string) => void
  /** Callback when an agent finishes processing and returns to idle */
  onAgentComplete?: (agentName: string, messages: unknown[]) => void
  /** Callback when an agent is detected as stuck (busy too long with no progress) */
  onAgentStuck?: (agentName: string, busyDurationMs: number) => void
}

export type Orchestrator = {
  agents: Map<string, AgentState>
  /** Send a prompt to a specific agent */
  prompt: (agentName: string, text: string) => Promise<void>
  /** Send prompts to all agents simultaneously. Returns partial results so callers can handle failures individually. */
  promptAll: (prompts: { agentName: string; text: string }[]) => Promise<{ succeeded: string[]; failed: Array<{ agent: string; error: string }> }>
  /** Get the latest messages from an agent's session */
  getMessages: (agentName: string) => Promise<unknown[]>
  /** Get status overview of all agents */
  status: () => Promise<Map<string, { status: string; sessionID: string | null; lastActivity: number; lastEventAt: number }>>
  /** Dynamically add a new agent at runtime */
  addAgent: (agentConfig: AgentConfig) => Promise<void>
  /** Remove an agent at runtime */
  removeAgent: (name: string) => void
  /** Abort the current run on an agent (cancel whatever it's doing) */
  abortAgent: (agentName: string) => Promise<void>
  /** Restart an agent's session (abort + create fresh session) */
  restartAgent: (agentName: string) => Promise<string>
  /** Force-reset an agent's status to idle and update activity timestamps. Used when an agent is detected as stale or unresponsive and needs to be unblocked without creating a new session. */
  forceResetAgentStatus: (agentName: string) => void
  /** Gracefully shut down all connections */
  shutdown: () => void
}

export async function createOrchestrator(config: OrchestratorConfig): Promise<Orchestrator> {
  const agents = new Map<string, AgentState>()
  const eventAborts = new Map<string, { abort: () => void }>()
  let pollTimer: ReturnType<typeof setInterval> | null = null

  // Per-agent prompt queue — ensures only one prompt runs at a time per agent.
  // If the agent is busy, the prompt waits in line instead of throwing BusyError.
  const promptQueues = new Map<string, Promise<void>>()

  async function enqueuePrompt(agentName: string, text: string): Promise<void> {
    const agent = agents.get(agentName)
    if (!agent) throw new Error(`Unknown agent: ${agentName}`)
    if (agent.status === "disconnected") throw new Error(`Agent ${agentName} is disconnected`)

    // Chain onto existing queue for this agent
    const prev = promptQueues.get(agentName) ?? Promise.resolve()
    const next = prev.then(async () => {
      // Wait for agent to be idle before sending
      const maxWait = 300_000 // 5 minutes
      const start = Date.now()
      while (agent.status === "busy" && Date.now() - start < maxWait) {
        // Bail out early if the agent was removed while we were waiting
        if (!agents.has(agentName)) {
          throw new Error(`Agent ${agentName} was removed while waiting to send prompt`)
        }
        await new Promise(r => setTimeout(r, 2000))
      }
      if (!agents.has(agentName)) {
        throw new Error(`Agent ${agentName} was removed`)
      }
      if (agent.status === "busy") {
        throw new Error(`Agent ${agentName} still busy after 5 minutes — prompt not sent`)
      }

      try {
        await agentPrompt(agent, text)
      } catch (err) {
        // Retry once after 2s for transient failures
        config.onStatusChange?.(agentName, "error", "Prompt failed, retrying...")
        await new Promise(r => setTimeout(r, 2000))
        const healthy = await agentHealthCheck(agent)
        if (!healthy) throw err
        if (!agent.sessionID) await agentCreateSession(agent)
        await agentPrompt(agent, text)
        config.onStatusChange?.(agentName, "busy", "Retry succeeded")
      }
    })

    // Store the chained promise (strip error so the chain never breaks)
    promptQueues.set(agentName, next.catch(() => {}))

    // But propagate the error to the caller
    return next
  }

  // Initialize all agent connections
  for (const agentConfig of config.agents) {
    const agent = createAgent(agentConfig)
    agents.set(agentConfig.name, agent)
  }

  // Health check all agents
  const healthChecks = Array.from(agents.entries()).map(async ([name, agent]) => {
    const healthy = await agentHealthCheck(agent)
    if (healthy) {
      config.onStatusChange?.(name, "connected")
    } else {
      config.onStatusChange?.(name, "disconnected", `Cannot reach ${agent.config.url}`)
    }
    return { name, healthy }
  })

  const results = await Promise.all(healthChecks)
  const connectedCount = results.filter((r) => r.healthy).length
  if (config.agents.length > 0) {
    console.log(`[orchestrator] ${connectedCount}/${config.agents.length} agents connected`)
  }

  // Create sessions on all connected agents (in parallel)
  await Promise.all(results.filter(r => r.healthy).map(async ({ name }) => {
    const agent = agents.get(name)!
    try {
      const sessionID = await agentCreateSession(agent)
      config.onStatusChange?.(name, "idle", `Session: ${sessionID}`)
    } catch (err) {
      config.onStatusChange?.(name, "error", `Failed to create session: ${err}`)
    }
  }))

  // Subscribe to SSE events from all agents
  for (const [name, agent] of agents) {
    if (agent.status === "disconnected") continue
    const sub = subscribeToAgentEvents(agent, (event) => {
      handleEvent(name, agent, event)
    })
    eventAborts.set(name, sub)
  }

  function completeAgent(name: string, agent: AgentState) {
    agent.status = "idle"
    agent.lastActivity = Date.now()
    const elapsed = agent.busyStartTime
      ? ((Date.now() - agent.busyStartTime) / 1000).toFixed(1)
      : "?"
    agent.busyStartTime = null
    config.onStatusChange?.(name, "completed", `${elapsed}s`)

    if (config.onAgentComplete) {
      agentGetMessages(agent)
        .then((msgs) => config.onAgentComplete!(name, msgs))
        .catch(() => {})
    }
  }

  function handleEvent(name: string, agent: AgentState, event: AgentEvent) {
    config.onRawEvent?.(event)

    // Every SSE event — even noisy deltas — proves the agent process is alive.
    // This powers stale-busy detection in waitForAgent.
    agent.lastEventAt = Date.now()

    const type = event.event.type

    // Only forward notable events to onEvent
    if (!FILTERED_EVENTS.has(type)) {
      config.onEvent?.(event)
    }

    // Track agent busy/idle state from events
    if (type === "session.status") {
      const status = event.event.properties.status as string | undefined
      if (status === "busy" || status === "running") {
        if (agent.status !== "busy") {
          agent.status = "busy"
          agent.lastActivity = Date.now()
          if (!agent.busyStartTime) agent.busyStartTime = Date.now()
          config.onStatusChange?.(name, "busy")
        }
      } else if (status === "idle" || status === "complete") {
        if (agent.status === "busy") {
          completeAgent(name, agent)
        }
      }
    } else if (type === "session.idle") {
      if (agent.status === "busy") {
        completeAgent(name, agent)
      }
    } else if (type === "permission.request") {
      handlePermission(name, agent, event.event.properties)
    } else if (type === "question.asked") {
      handleQuestion(name, agent, event.event.properties)
    }
  }

  async function handlePermission(name: string, agent: AgentState, properties: Record<string, unknown>) {
    const requestID = properties.requestID as string
    if (!requestID) return

    if (config.autoApprove) {
      try {
        await agentReplyPermission(agent, requestID, "once")
        config.onStatusChange?.(name, "permission-approved", `Auto-approved: ${requestID}`)
      } catch (err) {
        console.error(`[${name}] Failed to auto-approve permission:`, err)
      }
      return
    }

    if (config.onPermissionRequest) {
      try {
        const decision = await config.onPermissionRequest(name, properties)
        await agentReplyPermission(agent, requestID, decision === "approve" ? "once" : "reject")
        config.onStatusChange?.(name, `permission-${decision}d`, requestID)
      } catch (err) {
        console.error(`[${name}] Failed to handle permission:`, err)
      }
    }
  }

  async function handleQuestion(name: string, agent: AgentState, properties: Record<string, unknown>) {
    const requestID = properties.id as string
    if (!requestID) return
    const questions = properties.questions as Array<{ question: string; options?: Array<{ label: string }> }> | undefined

    // Auto-answer: pick the first option for each question, or provide "yes" as fallback
    try {
      const answers: string[][] = (questions ?? []).map(q => {
        if (q.options && q.options.length > 0) return [q.options[0]!.label]
        return ["yes"]
      })
      if (answers.length === 0) answers.push(["yes"])
      await agentAnswerQuestion(agent, requestID, answers)
      config.onStatusChange?.(name, "question-answered", `Auto-answered: ${questions?.[0]?.question?.slice(0, 80) ?? requestID}`)
    } catch (err) {
      // If answering fails, try rejecting so the agent unblocks
      try {
        await agentRejectQuestion(agent, requestID)
        config.onStatusChange?.(name, "question-rejected", requestID)
      } catch {
        console.error(`[${name}] Failed to handle question:`, err)
      }
    }
  }

  // Health monitoring — periodically check agents and auto-reconnect
  let healthTimer: ReturnType<typeof setInterval> | null = null
  const healthInterval = 15_000 // check every 15 seconds

  healthTimer = setInterval(async () => {
    for (const [name, agent] of Array.from(agents.entries())) {
      if (agent.status !== "disconnected") continue
      // Attempt reconnection
      try {
        const healthy = await agentHealthCheck(agent)
        if (healthy) {
          config.onStatusChange?.(name, "connected", "Reconnected")
          // Re-create session
          try {
            const sessionID = await agentCreateSession(agent)
            config.onStatusChange?.(name, "idle", `Reconnected, session: ${sessionID}`)
          } catch (err) {
            config.onStatusChange?.(name, "error", `Reconnected but failed to create session: ${err}`)
          }
          // Abort old subscription if it exists, then re-subscribe
          const oldSub = eventAborts.get(name)
          if (oldSub) oldSub.abort()
          const sub = subscribeToAgentEvents(agent, (event) => {
            handleEvent(name, agent, event)
          })
          eventAborts.set(name, sub)
        }
      } catch {
        // still unreachable, will retry next interval
      }
    }
  }, healthInterval)

  // Stuck agent detection — check every 30s for agents that have been busy too long
  const stuckThreshold = config.stuckThresholdMs ?? 300_000 // 5 minutes default
  let stuckTimer: ReturnType<typeof setInterval> | null = null
  // Track last known message count per agent to detect "busy but no progress"
  const lastMessageCounts = new Map<string, number>()
  // Track consecutive empty responses per agent
  const emptyResponseCounts = new Map<string, number>()

  stuckTimer = setInterval(async () => {
    for (const [name, agent] of Array.from(agents.entries())) {
      if (agent.status !== "busy" || !agent.busyStartTime) continue
      const elapsed = Date.now() - agent.busyStartTime
      if (elapsed < stuckThreshold) continue

      // Check if agent has produced any new messages since last check
      try {
        const msgs = await agentGetMessages(agent)
        const currentCount = msgs.length
        const lastCount = lastMessageCounts.get(name) ?? currentCount
        lastMessageCounts.set(name, currentCount)

        if (currentCount === lastCount) {
          // No new messages at all — classic stuck
          config.onStatusChange?.(name, "stuck", `Busy for ${Math.round(elapsed / 1000)}s with no new messages`)
          config.onAgentStuck?.(name, elapsed)
        } else {
          // Messages increased — but check if they're empty (agent responding with no content)
          const lastText = extractLastAssistantText(msgs)
          if (!lastText || lastText.trim().length === 0) {
            const emptyCount = (emptyResponseCounts.get(name) ?? 0) + 1
            emptyResponseCounts.set(name, emptyCount)
            if (emptyCount >= 2) {
              config.onStatusChange?.(name, "stuck", `Agent producing empty responses (${emptyCount} consecutive)`)
              config.onAgentStuck?.(name, elapsed)
            }
          } else {
            emptyResponseCounts.set(name, 0)
          }
        }
      } catch {
        // agent might be unreachable
      }
    }
  }, 30_000)

  // Poll for pending permissions (backup for any missed SSE events)
  const pollInterval = config.pollInterval ?? 2000
  pollTimer = setInterval(async () => {
    for (const [name, agent] of Array.from(agents.entries())) {
      if (agent.status === "disconnected") continue
      try {
        const permissions = await agentListPermissions(agent)
        for (const perm of permissions) {
          await handlePermission(name, agent, perm as Record<string, unknown>)
        }
      } catch {
        // agent might be temporarily unreachable
      }
    }
  }, pollInterval)

  // Public API
  return {
    agents,

    async prompt(agentName, text) {
      await enqueuePrompt(agentName, text)
    },

    async promptAll(prompts) {
      const results = await Promise.allSettled(prompts.map(({ agentName, text }) => enqueuePrompt(agentName, text)))
      const succeeded: string[] = []
      const failed: Array<{ agent: string; error: string }> = []
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!
        const name = prompts[i]!.agentName
        if (r.status === "fulfilled") {
          succeeded.push(name)
        } else {
          const error = r.reason instanceof Error ? r.reason.message : String(r.reason)
          failed.push({ agent: name, error })
          console.error(`[orchestrator] promptAll failed for ${name}: ${error}`)
        }
      }
      return { succeeded, failed }
    },

    async getMessages(agentName) {
      const agent = agents.get(agentName)
      if (!agent) throw new Error(`Unknown agent: ${agentName}`)
      return agentGetMessages(agent)
    },

    async status() {
      const result = new Map<string, { status: string; sessionID: string | null; lastActivity: number; lastEventAt: number }>()
      for (const [name, agent] of agents) {
        result.set(name, {
          status: agent.status,
          sessionID: agent.sessionID,
          lastActivity: agent.lastActivity,
          lastEventAt: agent.lastEventAt,
        })
      }
      return result
    },

    async addAgent(agentConfig) {
      const agent = createAgent(agentConfig)
      agents.set(agentConfig.name, agent)

      const healthy = await agentHealthCheck(agent)
      if (!healthy) {
        agents.delete(agentConfig.name)
        throw new Error(`Agent ${agentConfig.name} not reachable at ${agentConfig.url}`)
      }
      config.onStatusChange?.(agentConfig.name, "connected")

      try {
        const sessionID = await agentCreateSession(agent)
        config.onStatusChange?.(agentConfig.name, "idle", `Session: ${sessionID}`)
      } catch (err) {
        config.onStatusChange?.(agentConfig.name, "error", `Failed to create session: ${err}`)
      }

      const sub = subscribeToAgentEvents(agent, (event) => {
        handleEvent(agentConfig.name, agent, event)
      })
      eventAborts.set(agentConfig.name, sub)
    },

    removeAgent(name) {
      const agent = agents.get(name)
      if (!agent) return
      agent.status = "disconnected"
      agents.delete(name)
      // Abort SSE subscription for this agent
      const sub = eventAborts.get(name)
      if (sub) { sub.abort(); eventAborts.delete(name) }
      // Clean up prompt queue and stuck tracking
      promptQueues.delete(name)
      lastMessageCounts.delete(name)
      emptyResponseCounts.delete(name)
      config.onStatusChange?.(name, "disconnected", "Removed")
    },

    async abortAgent(agentName) {
      const agent = agents.get(agentName)
      if (!agent) throw new Error(`Unknown agent: ${agentName}`)
      await agentAbort(agent)
      agent.busyStartTime = null
      lastMessageCounts.delete(agentName)
      emptyResponseCounts.delete(agentName)
      config.onStatusChange?.(agentName, "idle", "Aborted")
    },

    async restartAgent(agentName) {
      const agent = agents.get(agentName)
      if (!agent) throw new Error(`Unknown agent: ${agentName}`)
      // Abort current work
      try { await agentAbort(agent) } catch {} // Intentionally silent: best-effort abort before restart
      agent.busyStartTime = null
      lastMessageCounts.delete(agentName)
      emptyResponseCounts.delete(agentName)
      // Create fresh session
      const sessionID = await agentCreateSession(agent)
      config.onStatusChange?.(agentName, "idle", `Restarted, new session: ${sessionID}`)
      return sessionID
    },

    forceResetAgentStatus(agentName) {
      const agent = agents.get(agentName)
      if (!agent) return
      agent.status = "idle"
      agent.lastActivity = Date.now()
      agent.lastEventAt = Date.now()
      agent.busyStartTime = null
    },

    shutdown() {
      if (pollTimer) clearInterval(pollTimer)
      if (healthTimer) clearInterval(healthTimer)
      if (stuckTimer) clearInterval(stuckTimer)
      for (const sub of eventAborts.values()) sub.abort()
      eventAborts.clear()
      console.log("[orchestrator] Shut down")
    },
  }
}
