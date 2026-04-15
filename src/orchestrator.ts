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
} from "./agent"
import { subscribeToAgentEvents, type AgentEvent } from "./events"

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
}

export type Orchestrator = {
  agents: Map<string, AgentState>
  /** Send a prompt to a specific agent */
  prompt: (agentName: string, text: string) => Promise<void>
  /** Send prompts to all agents simultaneously */
  promptAll: (prompts: { agentName: string; text: string }[]) => Promise<void>
  /** Get the latest messages from an agent's session */
  getMessages: (agentName: string) => Promise<unknown[]>
  /** Get status overview of all agents */
  status: () => Promise<Map<string, { status: string; sessionID: string | null; lastActivity: number }>>
  /** Dynamically add a new agent at runtime */
  addAgent: (agentConfig: AgentConfig) => Promise<void>
  /** Remove an agent at runtime */
  removeAgent: (name: string) => void
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

  // Create sessions on all connected agents
  for (const { name, healthy } of results) {
    if (!healthy) continue
    const agent = agents.get(name)!
    try {
      const sessionID = await agentCreateSession(agent)
      config.onStatusChange?.(name, "idle", `Session: ${sessionID}`)
    } catch (err) {
      config.onStatusChange?.(name, "error", `Failed to create session: ${err}`)
    }
  }

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
    }
  }

  async function handlePermission(name: string, agent: AgentState, properties: Record<string, unknown>) {
    const requestID = properties.requestID as string
    if (!requestID) return

    if (config.autoApprove) {
      try {
        await agentReplyPermission(agent, requestID, { type: "approve" })
        config.onStatusChange?.(name, "permission-approved", `Auto-approved: ${requestID}`)
      } catch (err) {
        console.error(`[${name}] Failed to auto-approve permission:`, err)
      }
      return
    }

    if (config.onPermissionRequest) {
      try {
        const decision = await config.onPermissionRequest(name, properties)
        await agentReplyPermission(agent, requestID, { type: decision })
        config.onStatusChange?.(name, `permission-${decision}d`, requestID)
      } catch (err) {
        console.error(`[${name}] Failed to handle permission:`, err)
      }
    }
  }

  // Health monitoring — periodically check agents and auto-reconnect
  let healthTimer: ReturnType<typeof setInterval> | null = null
  const healthInterval = 15_000 // check every 15 seconds

  healthTimer = setInterval(async () => {
    for (const [name, agent] of agents) {
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

  // Poll for pending permissions (backup for any missed SSE events)
  const pollInterval = config.pollInterval ?? 2000
  pollTimer = setInterval(async () => {
    for (const [name, agent] of agents) {
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
      // Report any failures but don't throw — partial success is better than total failure
      const failures = results
        .map((r, i) => r.status === "rejected" ? `${prompts[i]!.agentName}: ${r.reason}` : null)
        .filter(Boolean)
      if (failures.length > 0) {
        const err = new Error(`Some prompts failed: ${failures.join("; ")}`)
        console.error(`[orchestrator] promptAll partial failure: ${err.message}`)
        if (failures.length === prompts.length) throw err // all failed
      }
    },

    async getMessages(agentName) {
      const agent = agents.get(agentName)
      if (!agent) throw new Error(`Unknown agent: ${agentName}`)
      return agentGetMessages(agent)
    },

    async status() {
      const result = new Map<string, { status: string; sessionID: string | null; lastActivity: number }>()
      for (const [name, agent] of agents) {
        result.set(name, {
          status: agent.status,
          sessionID: agent.sessionID,
          lastActivity: agent.lastActivity,
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
      // Clean up prompt queue
      promptQueues.delete(name)
      config.onStatusChange?.(name, "disconnected", "Removed")
    },

    shutdown() {
      if (pollTimer) clearInterval(pollTimer)
      if (healthTimer) clearInterval(healthTimer)
      for (const sub of eventAborts.values()) sub.abort()
      eventAborts.clear()
      console.log("[orchestrator] Shut down")
    },
  }
}
