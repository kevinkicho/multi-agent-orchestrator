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
  model?: { providerID: string; modelID: string }
}

export type AgentStatus = "disconnected" | "idle" | "busy" | "error"

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

/** Create a new session on the agent and return its ID */
export async function agentCreateSession(agent: AgentState): Promise<string> {
  const res = await agent.client.session.create({})
  if (res.error) throw new Error(`Failed to create session on ${agent.config.name}: ${JSON.stringify(res.error)}`)
  const session = res.data!
  agent.sessionID = session.id
  agent.status = "idle"
  agent.lastActivity = Date.now()
  return session.id
}

/** Send a prompt to the agent's current session (async — returns immediately) */
export async function agentPrompt(
  agent: AgentState,
  text: string,
  opts?: { model?: { providerID: string; modelID: string }; system?: string },
): Promise<void> {
  if (!agent.sessionID) {
    await agentCreateSession(agent)
  }
  agent.status = "busy"
  agent.lastActivity = Date.now()
  agent.busyStartTime = Date.now()

  const model = opts?.model ?? agent.config.model
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

/** Get messages from the agent's current session */
export async function agentGetMessages(agent: AgentState) {
  if (!agent.sessionID) return []
  const res = await agent.client.session.messages({ sessionID: agent.sessionID })
  if (res.error) throw new Error(`Failed to get messages from ${agent.config.name}`)
  return res.data ?? []
}

/** Get the status of all sessions on the agent */
export async function agentGetSessionStatus(agent: AgentState) {
  const res = await agent.client.session.status({})
  if (res.error) throw new Error(`Failed to get session status from ${agent.config.name}`)
  return res.data
}

/** List pending permission requests on the agent */
export async function agentListPermissions(agent: AgentState) {
  const res = await agent.client.permission.list({})
  if (res.error) throw new Error(`Failed to list permissions from ${agent.config.name}`)
  return res.data ?? []
}

/** Reply to a permission request on the agent */
export async function agentReplyPermission(
  agent: AgentState,
  requestID: string,
  reply: { type: "approve" } | { type: "deny"; reason?: string } | { type: "approveAll" },
) {
  const res = await agent.client.permission.reply({ requestID, reply })
  if (res.error) throw new Error(`Failed to reply to permission on ${agent.config.name}`)
}

/** Auto-answer a question from the agent (select first option or provide text) */
export async function agentAnswerQuestion(
  agent: AgentState,
  requestID: string,
  answers: string[][],
) {
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
