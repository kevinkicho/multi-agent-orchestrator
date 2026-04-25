import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"

export type AgentConfig = {
  /** Human-readable name for this agent, e.g. "my-project" */
  name: string
  /** Base URL of the opencode serve instance, e.g. "http://127.0.0.1:3010" */
  url: string
  /** Working directory the agent operates in */
  directory: string
  /** Optional server password (OPENCODE_SERVER_PASSWORD) */
  password?: string
  /** Optional model override for this agent */
  model?: { providerID: string; modelID: string } | null
}

export type AgentStatus = "disconnected" | "idle" | "busy" | "error"

/** State of an agent instance */
export type AgentState = {
  config: AgentConfig
  client: OpencodeClient
  sessionID: string | null
  status: AgentStatus
  lastError: string | null
  lastActivity: number
  /** Timestamp when the agent started its current busy period */
  busyStartTime: number | null
  /** Timestamp of the last SSE event received — any event, including streaming deltas.
   *  Used to detect stale-busy agents (status stuck on "busy" but no events flowing). */
  lastEventAt: number
}

export function createAgent(config: AgentConfig): AgentState {
  /**
   * Create a new agent state with the given configuration.
   * @param config - The agent configuration
   * @returns The initialized agent state
   */
  const headers: Record<string, string> = {}
  if (config.password) {
    headers["authorization"] = `Bearer ${config.password}`
  }

  const client = createOpencodeClient({
    baseUrl: config.url,
    directory: config.directory,
    headers,
  })

  return {
    config,
    client,
    sessionID: null,
    status: "disconnected",
    lastError: null,
    lastActivity: Date.now(),
    lastEventAt: Date.now(),
    busyStartTime: null,
  }
}

export async function agentCreateSession(agent: AgentState): Promise<string> {
  /**
   * Create a new session on the agent and return its ID.
   * @param agent - The agent state
   * @returns The session ID
   * @throws Error if session creation fails
   */
  const res = await agent.client.session.create({})
  if (res.error) throw new Error(`Failed to create session on ${agent.config.name}: ${JSON.stringify(res.error)}`)
  const session = res.data!
  agent.sessionID = session.id
  agent.status = "idle"
  agent.lastActivity = Date.now()
  return session.id
}

export async function agentPrompt(
  agent: AgentState,
  text: string,
  opts?: { model?: { providerID: string; modelID: string }; system?: string },
): Promise<void> {
  /**
   * Send a prompt to the agent's current session (async — returns immediately).
   * @param agent - The agent state
   * @param text - The prompt text to send
   * @param opts - Optional model or system parameters
   * @throws Error if the prompt fails
   */
  if (!agent.sessionID) {
    await agentCreateSession(agent)
  }
  agent.status = "busy"
  agent.lastActivity = Date.now()
  agent.busyStartTime = Date.now()

  const model = opts?.model ?? agent.config.model ?? null
  const res = await agent.client.session.promptAsync({
    sessionID: agent.sessionID!,
    parts: [{ type: "text", text }],
    ...opts,
    ...(model ? { model } : {}),
  })
  if (res.error) {
    agent.status = "error"
    agent.lastError = JSON.stringify(res.error)
    throw new Error(`Prompt failed on ${agent.config.name}: ${agent.lastError}`)
  }
}

export async function agentGetMessages(agent: AgentState): Promise<any[]> {
  /**
   * Get messages from the agent's current session.
   * @param agent - The agent state
   * @returns Array of messages from the agent's session
   * @throws Error if fetching messages fails
   */
  if (!agent.sessionID) return []
  const res = await agent.client.session.messages({ sessionID: agent.sessionID })
  if (res.error) throw new Error(`Failed to get messages from ${agent.config.name}`)
  return res.data ?? []
}

export async function agentGetSessionStatus(agent: AgentState): Promise<any> {
  /**
   * Get the status of all sessions on the agent.
   * @param agent - The agent state
   * @returns Session status data
   * @throws Error if fetching session status fails
   */
  const res = await agent.client.session.status({})
  if (res.error) throw new Error(`Failed to get session status from ${agent.config.name}`)
  return res.data
}

export async function agentListPermissions(agent: AgentState): Promise<any[]> {
  /**
   * List pending permission requests on the agent.
   * @param agent - The agent state
   * @returns Array of pending permission requests
   * @throws Error if listing permissions fails
   */
  const res = await agent.client.permission.list({})
  if (res.error) throw new Error(`Failed to list permissions from ${agent.config.name}`)
  return res.data ?? []
}

export async function agentReplyPermission(
  agent: AgentState,
  requestID: string,
  reply: "once" | "always" | "reject",
  message?: string,
): Promise<void> {
  /**
   * Reply to a permission request on the agent.
   * @param agent - The agent state
   * @param requestID - The ID of the permission request
   * @param reply - The reply value ("once", "always", or "reject")
   * @param message - Optional message explaining the reply
   * @throws Error if replying to permission fails
   */
  const res = await agent.client.permission.reply({ requestID, reply, message })
  if (res.error) throw new Error(`Failed to reply to permission on ${agent.config.name}`)
}

export async function agentAnswerQuestion(
  agent: AgentState,
  requestID: string,
  answers: string[][],
): Promise<void> {
  /**
   * Auto-answer a question from the agent (select first option or provide text).
   * @param agent - The agent state
   * @param requestID - The ID of the question
   * @param answers - Array of answer options
   * @throws Error if answering the question fails
   */
  const res = await agent.client.question.reply({ requestID, answers })
  if (res.error) throw new Error(`Failed to answer question on ${agent.config.name}`)
}

/** Reject a question from the agent (dismiss it so it stops blocking) */
export async function agentRejectQuestion(
  agent: AgentState,
  requestID: string,
) {
  const res = await agent.client.question.reject({ requestID })
  if (res.error) throw new Error(`Failed to reject question on ${agent.config.name}`)
}

/** Abort the current session run on the agent */
export async function agentAbort(agent: AgentState): Promise<void> {
  if (!agent.sessionID) return
  await agent.client.session.abort({ sessionID: agent.sessionID })
  agent.status = "idle"
}

/** Check if the agent's opencode server is reachable */
export async function agentHealthCheck(agent: AgentState): Promise<boolean> {
  try {
    const res = await agent.client.global.health({})
    if (res.data) {
      agent.status = agent.status === "disconnected" ? "idle" : agent.status
      return true
    }
    return false
  } catch {
    agent.status = "disconnected"
    return false
  }
}
