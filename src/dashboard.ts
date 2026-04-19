import { readFileSync } from "fs"
import { resolve } from "path"
import type { Orchestrator } from "./orchestrator"
import type { AgentState } from "./agent"
import { agentListPermissions, agentReplyPermission } from "./agent"
import type { ProjectManager } from "./project-manager"
import { listDirectories } from "./project-manager"
import type { TeamManager } from "./team-manager"
import { loadBrainMemory, addBehavioralNote, addProjectNote, listArchives, loadAgentArchive, restoreAgentMemory } from "./brain-memory"
import { detectCrash, formatCrashReport } from "./session-state"
import { appendChatEvent, readChatEvents } from "./chat-log"

/** Decode and sanitize a URL path segment — strips path traversal and control characters */
function sanitizeParam(raw: string): string {
  return decodeURIComponent(raw).replace(/[\/\\\.]{2,}/g, "").replace(/[\x00-\x1f]/g, "")
}

/** Base shape shared by every dashboard event. `t` is stamped server-side by
 *  DashboardLog.push so clients can dedupe between live SSE and replayed history. */
type DashboardEventBase = { t?: number }

export type DashboardEvent = DashboardEventBase & (
  | { type: "agent-event"; agent: string; event: { type: string; properties: Record<string, unknown> } }
  | { type: "agent-status"; agent: string; status: string; detail?: string }
  | { type: "agent-prompt"; agent: string; text: string }
  | { type: "agent-response"; agent: string; text: string; elapsed?: string }
  | { type: "brain-thinking"; text: string }
  | { type: "brain-status"; status: "running" | "idle" | "done" }
  | { type: "permission-request"; agent: string; requestID: string; description: string; properties: Record<string, unknown> }
  | { type: "permission-resolved"; agent: string; requestID: string; decision: string }
  | { type: "cycle-summary"; cycle: number; agent: string; summary: string }
  | { type: "supervisor-thinking"; agent: string; text: string }
  | { type: "supervisor-status"; agent: string; status: "running" | "idle" | "done" | "reviewing" | "paused" }
  | { type: "supervisor-alert"; agent: string; text: string }
)

/** Shared event log that the dashboard reads from.
 *  Cursors are absolute indices (baseOffset + position in the current array).
 *  When the array is trimmed, baseOffset advances so existing cursors remain valid. */
export class DashboardLog {
  private listeners = new Set<(event: DashboardEvent) => void>()
  private history: DashboardEvent[] = []
  private maxHistory = 500
  /** Absolute index of history[0]. Advances when old events are trimmed. */
  private baseOffset = 0

  push(event: DashboardEvent) {
    // Stamp with a server-side timestamp so the client can dedupe between
    // the live SSE stream and replayed chat history.
    if (event.t == null) event.t = Date.now()
    this.history.push(event)
    if (this.history.length > this.maxHistory) {
      const trimCount = this.history.length - this.maxHistory
      this.history = this.history.slice(trimCount)
      this.baseOffset += trimCount
    }
    for (const listener of this.listeners) {
      try { listener(event) } catch (err) { console.error('[dashboard] Event listener error:', err) }
    }
  }

  /** Returns the absolute cursor pointing past the last event */
  getCursor(): number {
    return this.baseOffset + this.history.length
  }

  /** Get events starting from an absolute cursor. Returns events + new cursor. */
  getEventsSince(since: number): { events: DashboardEvent[]; cursor: number } {
    const relativeIdx = since - this.baseOffset
    if (relativeIdx < 0) {
      // Client is so far behind that some events were trimmed — send everything we have
      return { events: [...this.history], cursor: this.getCursor() }
    }
    if (relativeIdx >= this.history.length) {
      // Client is up to date
      return { events: [], cursor: this.getCursor() }
    }
    return { events: this.history.slice(relativeIdx), cursor: this.getCursor() }
  }

  getHistory(): DashboardEvent[] {
    return this.history
  }

  subscribe(fn: (event: DashboardEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export async function startDashboard(
  orchestrator: Orchestrator,
  log: DashboardLog,
  port: number,
  opts?: {
    onSoftStop?: () => void;
    onCommand?: (command: string) => Promise<{ ok: boolean; output?: string; error?: string }>;
    projectManager?: ProjectManager;
    getTeamManager?: () => TeamManager | null;
    eventBus?: import("./event-bus").EventBus;
    resourceManager?: import("./resource-manager").ResourceManager;
    tokenTracker?: import("./token-tracker").TokenTracker;
  },
): Promise<{ stop: () => void }> {
  // Generate a session token for API authentication.
  // This prevents other local processes from executing arbitrary commands
  // via the dashboard API. The token is injected into the HTML page and
  // required on all mutating (POST/PUT/DELETE) API endpoints.
  const apiToken = crypto.randomUUID()

  // Pre-check port availability — Bun.serve() crashes at a low level on EADDRINUSE
  // before a JS catch block can intercept it, so we detect conflicts early.
  checkPortAvailable(port)

  // Pre-build the HTML with token injected — avoids string replacement on every request
  const injectedHtml = DASHBOARD_HTML.replace(
    "</head>",
    `<script>window.__API_TOKEN__="${apiToken}";</script></head>`,
  )

  // Persist chat-relevant events to a per-agent JSONL so refreshes can replay history.
  // Fire-and-forget — the in-memory broadcast is authoritative; disk is a durable mirror.
  const persistUnsub = log.subscribe((event) => {
    appendChatEvent(event).catch((err) => console.error("[chat-log] persist failed:", err))
  })

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    reusePort: true,
    idleTimeout: 255, // max allowed by Bun (seconds)

    async fetch(req) {
      const url = new URL(req.url)

      // CORS headers — restricted to localhost origins since this runs locally
      const origin = req.headers.get("origin") ?? ""
      const allowedOrigin = origin.startsWith("http://127.0.0.1") || origin.startsWith("http://localhost")
        ? origin
        : `http://127.0.0.1:${port}`
      const corsHeaders = {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-API-Token",
      }

      // Require API token on all mutating requests
      if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
        // Reject oversized or un-sized request bodies (1MB limit)
        const contentLengthHeader = req.headers.get("content-length")
        if (!contentLengthHeader) {
          return Response.json(
            { error: "Content-Length header required for mutating requests" },
            { status: 411, headers: corsHeaders },
          )
        }
        const contentLength = parseInt(contentLengthHeader, 10)
        if (contentLength > 1_048_576) {
          return Response.json(
            { error: `Request body too large (${Math.round(contentLength / 1024 / 1024 * 10) / 10}MB). Maximum is 1MB.` },
            { status: 413, headers: corsHeaders },
          )
        }

        const token = req.headers.get("x-api-token")
        if (token !== apiToken) {
          return Response.json(
            { error: "Unauthorized — invalid or missing API token" },
            { status: 401, headers: corsHeaders },
          )
        }
      }

      if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders })
      }

      try {

      // SSE endpoint — long-poll style to avoid Bun chunked encoding issues
      if (url.pathname === "/api/events") {
        // Get cursor from query param (absolute index, survives history trimming)
        const sinceRaw = parseInt(url.searchParams.get("since") ?? "0", 10)
        const since = Number.isNaN(sinceRaw) ? 0 : sinceRaw
        const { events: missed, cursor: newCursor } = log.getEventsSince(since)

        // If client is behind, send all missed events immediately
        if (missed.length > 0) {
          return Response.json(
            { events: missed, cursor: newCursor },
            { headers: corsHeaders },
          )
        }

        // Otherwise wait up to 30s for new events
        const events = await new Promise<DashboardEvent[]>((resolve) => {
          const collected: DashboardEvent[] = []
          let resolved = false

          const done = () => {
            if (resolved) return
            resolved = true
            unsub()
            clearTimeout(timer)
            resolve(collected)
          }

          const unsub = log.subscribe((event) => {
            collected.push(event)
            // Batch: wait 100ms for more events before responding
            setTimeout(() => { if (!resolved) done() }, 100)
          })

          // Timeout after 30s (long-poll)
          const timer = setTimeout(done, 30_000)

          req.signal.addEventListener("abort", done)
        })

        return Response.json(
          { events, cursor: log.getCursor() },
          { headers: corsHeaders },
        )
      }

      // SSE stream from EventBus — real-time cross-agent events
      if (url.pathname === "/api/events/stream" && opts?.eventBus) {
        const bus = opts.eventBus
        const typeFilter = url.searchParams.get("type") || undefined

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            const send = (data: string) => {
              try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)) } catch { /* client disconnected */ }
            }

            // Send recent events as initial batch
            const recent = bus.getRecent(typeFilter ? { type: typeFilter } : undefined, 20)
            for (const evt of recent) {
              send(JSON.stringify(evt))
            }

            // Subscribe to new events
            const unsub = bus.onAny((evt) => {
              if (typeFilter && evt.type !== typeFilter) return
              send(JSON.stringify(evt))
            })

            // Clean up on disconnect
            req.signal.addEventListener("abort", () => {
              unsub()
              try { controller.close() } catch {}
            })
          },
        })

        return new Response(stream, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        })
      }

      // Status endpoint
      if (url.pathname === "/api/status") {
        const statuses: Record<string, unknown> = {}
        for (const [name, agent] of orchestrator.agents) {
          statuses[name] = {
            status: agent.status,
            sessionID: agent.sessionID,
            directory: agent.config.directory,
            url: agent.config.url,
            lastActivity: agent.lastActivity,
          }
        }
        return Response.json(statuses, { headers: corsHeaders })
      }

      // Messages endpoint
      if (url.pathname.startsWith("/api/messages/")) {
        const agentName = sanitizeParam(url.pathname.slice("/api/messages/".length))
        try {
          const msgs = await orchestrator.getMessages(agentName)
          return Response.json(msgs, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 404, headers: corsHeaders })
        }
      }

      // List pending permissions for all agents
      if (url.pathname === "/api/permissions" && req.method === "GET") {
        const permissions: Array<{ agent: string; requestID: string; properties: Record<string, unknown> }> = []
        for (const [name, agent] of orchestrator.agents) {
          try {
            const perms = await agentListPermissions(agent)
            for (const perm of perms) {
              const p = perm as Record<string, unknown>
              permissions.push({
                agent: name,
                requestID: (p.id ?? p.requestID ?? "") as string,
                properties: p,
              })
            }
          } catch {}
        }
        return Response.json(permissions, { headers: corsHeaders })
      }

      // Reply to a permission request
      if (url.pathname.startsWith("/api/permissions/") && req.method === "POST") {
        const parts = url.pathname.slice("/api/permissions/".length).split("/")
        const agentName = sanitizeParam(parts[0] ?? "")
        const requestID = sanitizeParam(parts.slice(1).join("/"))
        const agent = orchestrator.agents.get(agentName!)
        if (!agent || !requestID) {
          return Response.json({ error: "Invalid agent or requestID" }, { status: 400, headers: corsHeaders })
        }
        try {
          const body = await req.json() as { decision: string; reason?: string }
          const reply = body.decision === "approve" ? "once" : "reject"
          await agentReplyPermission(agent, requestID, reply, body.reason)
          log.push({
            type: "permission-resolved",
            agent: agentName!,
            requestID,
            decision: body.decision,
          })
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Send prompt to an agent from the dashboard
      if (url.pathname.startsWith("/api/prompt/") && req.method === "POST") {
        const agentName = sanitizeParam(url.pathname.slice("/api/prompt/".length))
        const agent = orchestrator.agents.get(agentName)
        if (!agent) {
          return Response.json({ error: `Unknown agent: ${agentName}` }, { status: 404, headers: corsHeaders })
        }
        try {
          const body = await req.json() as { text: string }
          if (!body.text?.trim()) {
            return Response.json({ error: "Empty prompt" }, { status: 400, headers: corsHeaders })
          }
          log.push({ type: "agent-prompt", agent: agentName, text: body.text })
          await orchestrator.prompt(agentName, body.text)
          // Record in prompt ledger
          const { recordPrompt: recordP } = await import("./prompt-ledger")
          recordP({
            source: "user", target: agentName, direction: "outbound",
            agentName, content: body.text,
          }).catch(() => {})
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Command endpoint — accepts orchestrator commands from the dashboard
      if (url.pathname === "/api/command" && req.method === "POST") {
        try {
          const body = await req.json() as { command: string }
          const cmd = body.command?.trim()
          if (!cmd) {
            return Response.json({ ok: false, error: "Empty command" }, { status: 400, headers: corsHeaders })
          }
          if (opts?.onCommand) {
            const result = await opts.onCommand(cmd)
            return Response.json(result, { headers: corsHeaders })
          }
          return Response.json({ ok: false, error: "Command handler not available" }, { status: 500, headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Project management endpoints
      if (url.pathname === "/api/projects" && req.method === "GET") {
        const pm = opts?.projectManager
        if (!pm) return Response.json([], { headers: corsHeaders })
        return Response.json(pm.listProjects(), { headers: corsHeaders })
      }

      if (url.pathname === "/api/projects/saved" && req.method === "GET") {
        const pm = opts?.projectManager
        if (!pm) return Response.json([], { headers: corsHeaders })
        const saved = await pm.getSavedProjects()
        return Response.json(saved, { headers: corsHeaders })
      }

      if (url.pathname === "/api/projects/restore" && req.method === "POST") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Project manager not available" }, { status: 500, headers: corsHeaders })
        try {
          const result = await pm.restoreProjects()
          return Response.json({ ok: true, ...result }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Memory for a specific agent
      if (url.pathname.match(/^\/api\/memory\/[^/]+$/) && req.method === "GET") {
        const agentName = sanitizeParam(url.pathname.split("/").pop()!)
        try {
          const store = await loadBrainMemory()
          const sessions = store.agentEntries?.[agentName] ?? store.entries.filter(e =>
            e.objective.includes(agentName) || agentName in e.agentLearnings
          )
          const projectNotes = store.projectNotes[agentName] ?? []
          const rawNotes = store.behavioralNotes?.[agentName] ?? []
          // Derive per-note fire stats for the Memory tab column.
          // latestCycle is the max cycle across all fires — cyclesSinceLastFire
          // is relative to that so the dashboard can surface notes that fire
          // often vs. notes that have gone quiet.
          let latestCycle = 0
          for (const n of rawNotes) {
            for (const f of n.fires) {
              if (f.cycle > latestCycle) latestCycle = f.cycle
            }
          }
          const decorate = (n: typeof rawNotes[number]) => {
            const fireCount = n.fires.length
            const lastFireCycle = fireCount > 0 ? n.fires[fireCount - 1]!.cycle : null
            const cyclesSinceLastFire = lastFireCycle !== null && latestCycle > 0
              ? Math.max(0, latestCycle - lastFireCycle)
              : null
            return {
              id: n.id,
              text: n.text,
              provenance: n.provenance,
              fires: n.fires,
              fireCount,
              cyclesSinceLastFire,
              promotedAt: n.promotedAt,
              archivedAt: n.archivedAt,
            }
          }
          const behavioralNotes = rawNotes.map(decorate)
          const archivedBehavioralNotes = (store.archivedBehavioralNotes?.[agentName] ?? []).map(decorate)
          return Response.json({ agentName, sessions, projectNotes, behavioralNotes, archivedBehavioralNotes }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ agentName, sessions: [], projectNotes: [], behavioralNotes: [], archivedBehavioralNotes: [] }, { headers: corsHeaders })
        }
      }

      if (url.pathname === "/api/projects/clone" && req.method === "POST") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Project manager not available" }, { status: 500, headers: corsHeaders })
        try {
          const body = await req.json() as {
            gitUrl?: string; parentDirectory?: string; targetName?: string
            directive?: string; name?: string; baseBranch?: string; model?: string
          }
          if (!body.gitUrl?.trim()) {
            return Response.json({ error: "gitUrl is required" }, { status: 400, headers: corsHeaders })
          }
          if (!body.parentDirectory?.trim()) {
            return Response.json({ error: "parentDirectory is required" }, { status: 400, headers: corsHeaders })
          }
          const cloned = await pm.cloneGithubRepo(body.gitUrl.trim(), body.parentDirectory.trim(), {
            targetName: body.targetName?.trim() || undefined,
          })
          const project = await pm.addProject(
            cloned,
            body.directive?.trim() || "Work on this project. Review the codebase, fix bugs, add features, and improve code quality.",
            body.name?.trim() || undefined,
            undefined,
            {
              baseBranch: body.baseBranch?.trim() || undefined,
              model: body.model?.trim() || undefined,
              // Seed the timeline with a clone event so the History drawer shows
              // "project began by cloning <url>" as the oldest entry.
              timeline: [{
                timestamp: Date.now(),
                kind: "cloned",
                summary: `Cloned ${body.gitUrl.trim()} → ${cloned}`,
                details: { url: body.gitUrl.trim(), directory: cloned },
              }],
            },
          )
          return Response.json({ ok: true, project, directory: cloned }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      if (url.pathname === "/api/projects" && req.method === "POST") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Project manager not available" }, { status: 500, headers: corsHeaders })
        try {
          const body = await req.json() as {
            directory: string
            directive?: string
            name?: string
            directiveHistory?: any[]
            baseBranch?: string
            model?: string
          }
          if (!body.directory?.trim()) {
            return Response.json({ error: "Directory is required" }, { status: 400, headers: corsHeaders })
          }
          const project = await pm.addProject(
            body.directory.trim(),
            body.directive?.trim() || "Work on this project. Review the codebase, fix bugs, add features, and improve code quality.",
            body.name?.trim() || undefined,
            body.directiveHistory || undefined,
            {
              baseBranch: body.baseBranch?.trim() || undefined,
              model: body.model?.trim() || undefined,
            },
          )
          return Response.json({ ok: true, project }, { headers: corsHeaders })
        } catch (err) {
          const msg = String(err)
          const status = msg.includes("already active") ? 409
            : msg.includes("does not exist") ? 404
            : msg.includes("currently running the orchestrator") ? 409
            : 500
          return Response.json({ ok: false, error: msg }, { status, headers: corsHeaders })
        }
      }

      if (url.pathname.startsWith("/api/projects/") && req.method === "DELETE") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Project manager not available" }, { status: 500, headers: corsHeaders })
        const projectId = sanitizeParam(url.pathname.slice("/api/projects/".length))
        try {
          await pm.removeProject(projectId)
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Update project directive. By default hot-swaps on the live supervisor (takes effect next cycle);
      // pass { restart: true } to additionally restart the supervisor (resets cycle count & session state).
      if (url.pathname.match(/^\/api\/projects\/[^/]+\/directive$/) && req.method === "PUT") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Project manager not available" }, { status: 500, headers: corsHeaders })
        const projectId = sanitizeParam(url.pathname.split("/")[3] ?? "")
        try {
          const body = await req.json() as { directive: string; restart?: boolean }
          if (!body.directive?.trim()) {
            return Response.json({ error: "Directive is required" }, { status: 400, headers: corsHeaders })
          }
          const directive = body.directive.trim()
          pm.updateDirective(projectId, directive)
          if (body.restart) {
            pm.restartSupervisor(projectId, directive)
          }
          return Response.json({ ok: true, restarted: !!body.restart }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Get chat history (paginated) for a project — resolves projectId to its agent name
      // and returns events from the persisted JSONL ring log, oldest-first.
      if (url.pathname.match(/^\/api\/projects\/[^/]+\/chat$/) && req.method === "GET") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ events: [] }, { headers: corsHeaders })
        const projectId = sanitizeParam(url.pathname.split("/")[3] ?? "")
        const project = pm.getProject(projectId)
        if (!project) return Response.json({ events: [] }, { headers: corsHeaders })
        const beforeRaw = url.searchParams.get("before")
        const limitRaw = url.searchParams.get("limit")
        const before = beforeRaw ? parseInt(beforeRaw, 10) : undefined
        const limit = Math.min(Math.max(parseInt(limitRaw ?? "200", 10) || 200, 1), 1000)
        const events = await readChatEvents(project.agentName, Number.isFinite(before) ? before : undefined, limit)
        return Response.json({ events, agentName: project.agentName }, { headers: corsHeaders })
      }

      // Get directive history for a project
      if (url.pathname.match(/^\/api\/projects\/[^/]+\/directive-history$/) && req.method === "GET") {
        const pm = opts?.projectManager
        if (!pm) return Response.json([], { headers: corsHeaders })
        const projectId = sanitizeParam(url.pathname.split("/")[3] ?? "")
        return Response.json(pm.getDirectiveHistory(projectId), { headers: corsHeaders })
      }

      if (url.pathname.match(/^\/api\/projects\/[^/]+\/timeline$/) && req.method === "GET") {
        const pm = opts?.projectManager
        if (!pm) return Response.json([], { headers: corsHeaders })
        const projectId = sanitizeParam(url.pathname.split("/")[3] ?? "")
        try {
          return Response.json(pm.getTimeline(projectId), { headers: corsHeaders })
        } catch {
          return Response.json([], { headers: corsHeaders })
        }
      }

      // Add a user comment on the directive (optionally on a specific history entry)
      if (url.pathname.match(/^\/api\/projects\/[^/]+\/directive-comment$/) && req.method === "POST") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Project manager not available" }, { status: 500, headers: corsHeaders })
        const projectId = sanitizeParam(url.pathname.split("/")[3] ?? "")
        try {
          const body = await req.json() as { comment: string; historyIndex?: number }
          if (!body.comment?.trim()) {
            return Response.json({ error: "Comment is required" }, { status: 400, headers: corsHeaders })
          }
          pm.addDirectiveComment(projectId, body.comment.trim(), body.historyIndex)
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Restart an agent's session
      if (url.pathname.match(/^\/api\/agents\/[^/]+\/restart$/) && req.method === "POST") {
        const agentName = sanitizeParam(url.pathname.split("/")[3] ?? "")
        try {
          const newSession = await orchestrator.restartAgent(agentName)
          return Response.json({ ok: true, sessionID: newSession }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Abort an agent's current work
      if (url.pathname.match(/^\/api\/agents\/[^/]+\/abort$/) && req.method === "POST") {
        const agentName = sanitizeParam(url.pathname.split("/")[3] ?? "")
        try {
          await orchestrator.abortAgent(agentName)
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Update project model
      if (url.pathname.match(/^\/api\/projects\/[^/]+\/model$/) && req.method === "PUT") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Project manager not available" }, { status: 500, headers: corsHeaders })
        const projectId = sanitizeParam(url.pathname.split("/")[3] ?? "")
        try {
          const body = await req.json() as { model: string }
          const modelName = body.model?.trim()
          if (!modelName || modelName === "default") {
            return Response.json({ error: "Please select a specific model from the dropdown" }, { status: 400, headers: corsHeaders })
          }
          pm.updateModel(projectId, modelName)
          // Restart supervisor with new model
          pm.restartSupervisor(projectId)
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Fetch available Ollama models (legacy endpoint — still works for backward compat)
      if (url.pathname === "/api/ollama-models") {
        const pm = opts?.projectManager
        const ollamaUrl = pm?.getOllamaUrl() ?? "http://127.0.0.1:11434"
        try {
          const res = await fetch(`${ollamaUrl}/api/tags`)
          if (!res.ok) return Response.json({ models: [] }, { headers: corsHeaders })
          const data = await res.json() as { models?: Array<{ name: string; size: number; modified_at: string; details?: { parameter_size?: string; family?: string; quantization_level?: string } }> }
          const models = (data.models ?? []).map(m => ({
            name: m.name,
            size: m.size,
            modified: m.modified_at,
            parameterSize: m.details?.parameter_size ?? null,
            family: m.details?.family ?? null,
            quantization: m.details?.quantization_level ?? null,
          }))
          return Response.json({ models }, { headers: corsHeaders })
        } catch {
          return Response.json({ models: [] }, { headers: corsHeaders })
        }
      }

      // ---- Provider management endpoints ----
      if (url.pathname === "/api/providers" && req.method === "GET") {
        try {
          const { loadProviders } = await import("./providers")
          const providers = await loadProviders()
          // Mask API keys in response (show only last 4 chars)
          const masked = providers.map(p => ({
            ...p,
            apiKey: p.apiKey ? "***" + p.apiKey.slice(-4) : "",
            hasKey: !!(p.apiKey || (p.apiKeyEnv && process.env[p.apiKeyEnv])),
          }))
          return Response.json({ providers: masked }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: `Failed to load providers: ${err instanceof Error ? err.message : String(err)}` }, { status: 500, headers: corsHeaders })
        }
      }

      if (url.pathname === "/api/providers" && req.method === "POST") {
        try {
          const { addOrUpdateProvider } = await import("./providers")
          const body = await req.json() as { id: string; name: string; baseUrl: string; type: string; apiKey?: string; apiKeyEnv?: string; models?: string[]; enabled?: boolean; defaultTemperature?: number; defaultMaxTokens?: number }
          await addOrUpdateProvider({
            id: body.id,
            name: body.name,
            baseUrl: body.baseUrl,
            type: (body.type as "openai-compatible" | "anthropic") || "openai-compatible",
            apiKey: body.apiKey ?? "",
            apiKeyEnv: body.apiKeyEnv,
            models: body.models ?? [],
            enabled: body.enabled ?? true,
            defaultTemperature: body.defaultTemperature,
            defaultMaxTokens: body.defaultMaxTokens,
          })
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: `Failed to add/update provider: ${err instanceof Error ? err.message : String(err)}` }, { status: 500, headers: corsHeaders })
        }
      }

      if (url.pathname.match(/^\/api\/providers\/[^/]+\/enable$/) && req.method === "POST") {
        try {
          const { enableProvider } = await import("./providers")
          const providerId = sanitizeParam(url.pathname.split("/")[3]!)
          const body = await req.json() as { enabled: boolean }
          const ok = await enableProvider(providerId, body.enabled)
          return Response.json({ ok }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: `Failed to enable provider: ${err instanceof Error ? err.message : String(err)}` }, { status: 500, headers: corsHeaders })
        }
      }

      // Report which active projects reference a given provider. The client uses this
      // before flipping a provider OFF so the user sees whose supervisors will break.
      if (url.pathname.match(/^\/api\/providers\/[^/]+\/usage$/) && req.method === "GET") {
        try {
          const { parseModelRef } = await import("./providers")
          const providerId = sanitizeParam(url.pathname.split("/")[3]!)
          const pm = opts?.projectManager
          const projects = pm?.listProjects() ?? []
          const using = projects
            .filter(p => p.model && parseModelRef(p.model).provider === providerId)
            .map(p => ({ id: p.id, name: p.name, model: p.model, status: p.status }))
          return Response.json({ providerId, projects: using }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: `Failed to compute usage: ${err instanceof Error ? err.message : String(err)}` }, { status: 500, headers: corsHeaders })
        }
      }

      if (url.pathname.match(/^\/api\/providers\/[^/]+\/apikey$/) && req.method === "POST") {
        try {
          const { setProviderApiKey } = await import("./providers")
          const providerId = sanitizeParam(url.pathname.split("/")[3]!)
          const body = await req.json() as { apiKey: string }
          const ok = await setProviderApiKey(providerId, body.apiKey)
          return Response.json({ ok }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: `Failed to set API key: ${err instanceof Error ? err.message : String(err)}` }, { status: 500, headers:corsHeaders })
        }
      }

      if (url.pathname.match(/^\/api\/providers\/[^/]+\/models$/) && req.method === "POST") {
        try {
          const { addModelToProvider } = await import("./providers")
          const providerId = sanitizeParam(url.pathname.split("/")[3]!)
          const body = await req.json() as { model: string }
          const ok = await addModelToProvider(providerId, body.model)
          return Response.json({ ok }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: `Failed to add model: ${err instanceof Error ? err.message : String(err)}` }, { status: 500, headers: corsHeaders })
        }
      }

      if (url.pathname.match(/^\/api\/providers\/[^/]+\/models$/) && req.method === "DELETE") {
        try {
          const { removeModelFromProvider } = await import("./providers")
          const providerId = sanitizeParam(url.pathname.split("/")[3]!)
          const body = await req.json() as { model: string }
          const ok = await removeModelFromProvider(providerId, body.model)
          return Response.json({ ok }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: `Failed to remove model: ${err instanceof Error ? err.message : String(err)}` }, { status: 500, headers: corsHeaders })
        }
      }

      // List all models across all enabled providers
      if (url.pathname === "/api/models" && req.method === "GET") {
        try {
          const { listAllModels } = await import("./providers")
          const models = await listAllModels()
          return Response.json({ models }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: `Failed to list models: ${err instanceof Error ? err.message : String(err)}` }, { status: 500, headers: corsHeaders })
        }
      }

      // Performance log endpoint
      if (url.pathname === "/api/performance" && req.method === "GET") {
        try {
          const { loadPerformanceLog } = await import("./performance-log")
          return Response.json(await loadPerformanceLog(), { headers: corsHeaders })
        } catch {
          return Response.json({ entries: [] }, { headers: corsHeaders })
        }
      }

      // Directory browser for folder picker — restricted to safe roots
      if (url.pathname === "/api/browse") {
        const homeDir = process.env.HOME || process.env.USERPROFILE || (process.platform === "win32" ? "C:\\Users" : "/home")
        const defaultPath = process.platform === "win32" ? "C:\\Users" : "/home"
        const requestedPath = url.searchParams.get("path") || defaultPath
        // Resolve to absolute and block sensitive system paths
        const resolved = resolve(requestedPath)
        const blocked = process.platform === "win32"
          ? [/^[A-Z]:\\Windows/i, /^[A-Z]:\\Program Files/i, /^[A-Z]:\\ProgramData/i, /^[A-Z]:\\\\System/i]
          : [/^\/(proc|sys|dev|boot|sbin|etc\/shadow)/]
        if (blocked.some(rx => rx.test(resolved))) {
          return Response.json({ current: resolved, directories: [] }, { headers: corsHeaders })
        }
        const dirs = listDirectories(resolved)
        return Response.json({ current: resolved, directories: dirs }, { headers: corsHeaders })
      }


      // --- Memory archive endpoints ---

      if (url.pathname === "/api/archives" && req.method === "GET") {
        const archives = await listArchives()
        return Response.json(archives, { headers: corsHeaders })
      }

      if (url.pathname.match(/^\/api\/archives\/[^/]+$/) && req.method === "GET") {
        const agentName = sanitizeParam(url.pathname.split("/").pop()!)
        const archive = await loadAgentArchive(agentName)
        if (!archive) return new Response("Not Found", { status: 404, headers: corsHeaders })
        return Response.json(archive, { headers: corsHeaders })
      }

      if (url.pathname.match(/^\/api\/archives\/[^/]+\/restore$/) && req.method === "POST") {
        const agentName = sanitizeParam(url.pathname.split("/")[3]!)
        const restored = await restoreAgentMemory(agentName)
        if (!restored) return Response.json({ ok: false, error: "No archive found" }, { status: 404, headers: corsHeaders })
        return Response.json({ ok: true }, { headers: corsHeaders })
      }

      // --- Team management endpoints ---

      // List team members
      if (url.pathname === "/api/team/members" && req.method === "GET") {
        const tm = opts?.getTeamManager?.()
        if (!tm) return Response.json({ members: [], active: false }, { headers: corsHeaders })
        return Response.json({ members: tm.listMembers(), active: true }, { headers: corsHeaders })
      }

      // Get pending hire requests
      if (url.pathname === "/api/team/hire-requests" && req.method === "GET") {
        const tm = opts?.getTeamManager?.()
        if (!tm) return Response.json([], { headers: corsHeaders })
        return Response.json(tm.getHireRequests(), { headers: corsHeaders })
      }

      // Approve a hire request
      if (url.pathname === "/api/team/hire-requests" && req.method === "POST") {
        const tm = opts?.getTeamManager?.()
        if (!tm) return Response.json({ error: "No team running" }, { status: 400, headers: corsHeaders })
        try {
          const body = await req.json() as { index: number; agentName: string }
          const reqs = tm.getHireRequests()
          if (body.index < 0 || body.index >= reqs.length) {
            return Response.json({ error: "Invalid index" }, { status: 400, headers: corsHeaders })
          }
          const hire = reqs[body.index]!
          tm.addMember({ role: hire.role, agentName: body.agentName, directory: hire.directory, directive: `Work on ${hire.role} tasks for the team goal.` })
          tm.removeHireRequest(body.index)
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Get pending dissolve requests
      if (url.pathname === "/api/team/dissolve-requests" && req.method === "GET") {
        const tm = opts?.getTeamManager?.()
        if (!tm) return Response.json([], { headers: corsHeaders })
        return Response.json(tm.getDissolveRequests(), { headers: corsHeaders })
      }

      // Approve a dissolve request
      if (url.pathname === "/api/team/dissolve-requests" && req.method === "POST") {
        const tm = opts?.getTeamManager?.()
        if (!tm) return Response.json({ error: "No team running" }, { status: 400, headers: corsHeaders })
        try {
          const body = await req.json() as { agentName: string }
          tm.removeMember(body.agentName)
          tm.removeDissolveRequest(body.agentName)
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Crash recovery info — returns details about previous crashed session
      if (url.pathname === "/api/crash-info" && req.method === "GET") {
        try {
          const { crashed, state } = await detectCrash()
          return Response.json({ crashed, state }, { headers: corsHeaders })
        } catch {
          return Response.json({ crashed: false, state: null }, { headers: corsHeaders })
        }
      }

      // User annotation feedback — saves to brain memory
      if (url.pathname === "/api/feedback" && req.method === "POST") {
        try {
          const body = await req.json() as {
            selectedText: string
            note: string
            panel: string   // "worker" | "supervisor" | "brain"
            agent: string
            feedbackType: string // "behavioral" | "project"
          }
          if (!body.note?.trim()) {
            return Response.json({ error: "Note is required" }, { status: 400, headers: corsHeaders })
          }
          const agentName = body.agent === "_brain" ? "_global" : body.agent
          const contextLabel = `[${body.panel}]`
          const fullNote = `User feedback ${contextLabel}: "${body.note.trim()}" (re: "${body.selectedText?.slice(0, 150) ?? ""}")`

          const store = await loadBrainMemory()
          if (body.feedbackType === "project") {
            await addProjectNote(store, agentName, fullNote)
          } else {
            await addBehavioralNote(store, agentName, fullNote, { source: "manual", cycle: null })
          }
          // Record in prompt ledger
          const { recordPrompt: recordP } = await import("./prompt-ledger")
          recordP({
            source: "user", target: agentName === "_global" ? "brain" : agentName,
            direction: "outbound", agentName: agentName === "_global" ? undefined : agentName,
            content: fullNote, tags: ["feedback", body.feedbackType],
          }).catch(() => {})
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // --- Analytics endpoints ---

      // List analytics sessions (optional ?agent= filter)
      if (url.pathname === "/api/analytics/sessions" && req.method === "GET") {
        try {
          const { loadAnalytics } = await import("./analytics")
          const store = await loadAnalytics()
          const agentFilter = url.searchParams.get("agent")
          const sessions = agentFilter
            ? store.sessions.filter(s => s.agentName === agentFilter)
            : store.sessions
          return Response.json(sessions.slice().reverse(), { headers: corsHeaders })
        } catch {
          return Response.json([], { headers: corsHeaders })
        }
      }

      // Single session detail
      if (url.pathname.match(/^\/api\/analytics\/sessions\/[^/]+$/) && req.method === "GET") {
        try {
          const { loadAnalytics } = await import("./analytics")
          const sessionId = sanitizeParam(url.pathname.split("/").pop() ?? "")
          const store = await loadAnalytics()
          const session = store.sessions.find(s => s.id === sessionId)
          if (!session) return Response.json({ error: "Session not found" }, { status: 404, headers: corsHeaders })
          const snapshots = store.snapshots.filter(s => s.agentName === session.agentName && s.timestamp >= session.startedAt && (!session.endedAt || s.timestamp <= session.endedAt))
          return Response.json({ session, snapshots }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Trigger AI evaluation for a session
      if (url.pathname.match(/^\/api\/analytics\/evaluate\/[^/]+$/) && req.method === "POST") {
        try {
          const { evaluateSession } = await import("./analytics")
          const sessionId = sanitizeParam(url.pathname.split("/").pop() ?? "")
          const body = await req.json() as { ollamaUrl?: string; model?: string }
          const pm = opts?.projectManager
          const ollamaUrl = body.ollamaUrl || pm?.getOllamaUrl() || "http://127.0.0.1:11434"
          const model = body.model || "llama3.2"
          const evaluation = await evaluateSession(sessionId, ollamaUrl, model)
          if (!evaluation) return Response.json({ error: "Evaluation failed" }, { status: 500, headers: corsHeaders })
          return Response.json(evaluation, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // A/B comparison between two sessions
      if (url.pathname === "/api/analytics/compare" && req.method === "POST") {
        try {
          const { compareSessions } = await import("./analytics")
          const body = await req.json() as { sessionA: string; sessionB: string; ollamaUrl?: string; model?: string }
          if (!body.sessionA || !body.sessionB) return Response.json({ error: "sessionA and sessionB required" }, { status: 400, headers: corsHeaders })
          const pm = opts?.projectManager
          const ollamaUrl = body.ollamaUrl || pm?.getOllamaUrl() || "http://127.0.0.1:11434"
          const model = body.model || "llama3.2"
          const comparison = await compareSessions(body.sessionA, body.sessionB, ollamaUrl, model)
          if (!comparison) return Response.json({ error: "Comparison failed" }, { status: 500, headers: corsHeaders })
          return Response.json(comparison, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // List comparisons
      if (url.pathname === "/api/analytics/comparisons" && req.method === "GET") {
        try {
          const { loadAnalytics } = await import("./analytics")
          const store = await loadAnalytics()
          return Response.json(store.comparisons.slice().reverse(), { headers: corsHeaders })
        } catch {
          return Response.json([], { headers: corsHeaders })
        }
      }

      // Timeline data for charts
      if (url.pathname === "/api/analytics/timeline" && req.method === "GET") {
        try {
          const { getTimelineData } = await import("./analytics")
          return Response.json(await getTimelineData(), { headers: corsHeaders })
        } catch {
          return Response.json([], { headers: corsHeaders })
        }
      }

      // ---- Pause / Resume endpoints ----

      if (url.pathname.match(/^\/api\/projects\/[^/]+\/pause$/) && req.method === "POST") {
        const projectId = sanitizeParam(url.pathname.split("/")[3]!)
        if (!opts?.projectManager?.getProject(projectId)) {
          return Response.json({ ok: false, error: "Project not found" }, { status: 404, headers: corsHeaders })
        }
        try {
          opts.projectManager.pauseProject(projectId)
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 400, headers: corsHeaders })
        }
      }

      if (url.pathname.match(/^\/api\/projects\/[^/]+\/resume$/) && req.method === "POST") {
        const projectId = sanitizeParam(url.pathname.split("/")[3]!)
        if (!opts?.projectManager?.getProject(projectId)) {
          return Response.json({ ok: false, error: "Project not found" }, { status: 404, headers: corsHeaders })
        }
        try {
          opts.projectManager.resumeProject(projectId)
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 400, headers: corsHeaders })
        }
      }

      if (url.pathname === "/api/pause-all" && req.method === "POST") {
        opts?.projectManager?.pauseAll()
        return Response.json({ ok: true }, { headers: corsHeaders })
      }

      if (url.pathname === "/api/resume-all" && req.method === "POST") {
        opts?.projectManager?.resumeAll()
        return Response.json({ ok: true }, { headers: corsHeaders })
      }

      // ---- Prompt Ledger endpoints ----

      if (url.pathname === "/api/ledger" && req.method === "GET") {
        try {
          const { loadLedger, queryLedger } = await import("./prompt-ledger")
          const store = await loadLedger()
          const query: import("./prompt-ledger").LedgerQuery = {}
          if (url.searchParams.get("source")) query.source = url.searchParams.get("source")!
          if (url.searchParams.get("agentName")) query.agentName = url.searchParams.get("agentName")!
          if (url.searchParams.get("since")) query.since = Number(url.searchParams.get("since"))
          if (url.searchParams.get("until")) query.until = Number(url.searchParams.get("until"))
          if (url.searchParams.get("search")) query.search = url.searchParams.get("search")!
          if (url.searchParams.get("tags")) query.tags = url.searchParams.get("tags")!.split(",")
          if (url.searchParams.get("limit")) query.limit = Number(url.searchParams.get("limit"))
          if (url.searchParams.get("offset")) query.offset = Number(url.searchParams.get("offset"))
          return Response.json(queryLedger(store, query), { headers: corsHeaders })
        } catch (err) {
          return Response.json({ entries: [], total: 0, error: String(err) }, { headers: corsHeaders })
        }
      }

      if (url.pathname === "/api/ledger/stats" && req.method === "GET") {
        try {
          const { loadLedger, getLedgerStats } = await import("./prompt-ledger")
          const store = await loadLedger()
          return Response.json(getLedgerStats(store), { headers: corsHeaders })
        } catch (err) {
          return Response.json({ bySource: {}, byAgent: {}, byHour: {}, error: String(err) }, { headers: corsHeaders })
        }
      }

      // ---- Event Bus endpoints ----
      if (url.pathname === "/api/events/bus/recent" && req.method === "GET") {
        if (!opts?.eventBus) return Response.json([], { headers: corsHeaders })
        const limit = parseInt(url.searchParams.get("limit") ?? "50", 10)
        const type = url.searchParams.get("type") || undefined
        const events = opts.eventBus.getRecent(type ? { type } : undefined, limit)
        return Response.json(events, { headers: corsHeaders })
      }

      // ---- Resource Manager endpoints ----
      if (url.pathname === "/api/resources/locks" && req.method === "GET") {
        if (!opts?.resourceManager) return Response.json({ locks: {}, llmQueueDepth: 0 }, { headers: corsHeaders })
        const locks: Record<string, { agentName: string; files: string[]; acquiredAt: number }> = {}
        for (const [agent, lock] of opts.resourceManager.getActiveLocks()) {
          locks[agent] = lock
        }
        return Response.json({
          locks,
          llmQueueDepth: opts.resourceManager.getLlmQueueDepth(),
          llmActive: opts.resourceManager.getLlmActiveCount(),
          llmMax: opts.resourceManager.getLlmMaxConcurrency(),
        }, { headers: corsHeaders })
      }

      if (url.pathname === "/api/resources/reset-llm" && req.method === "POST") {
        opts?.resourceManager?.resetLlmSlots()
        return Response.json({ ok: true }, { headers: corsHeaders })
      }

      if (url.pathname === "/api/resources/intents" && req.method === "GET") {
        if (!opts?.resourceManager) return Response.json({ intents: {} }, { headers: corsHeaders })
        const intents: Record<string, { description: string; files: string[]; declaredAt: number }> = {}
        for (const [agent, intent] of opts.resourceManager.getAllIntents()) {
          intents[agent] = { description: intent.description, files: intent.files, declaredAt: intent.declaredAt }
        }
        return Response.json({ intents }, { headers: corsHeaders })
      }

      // ---- Branch endpoints ----
      if (req.method === "GET" && url.pathname.match(/^\/api\/projects\/[^/]+\/branch$/)) {
        const projectId = sanitizeParam(url.pathname.split("/")[3]!)
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Not available" }, { status: 500, headers: corsHeaders })
        return Response.json({ branch: pm.getAgentBranch(projectId) }, { headers: corsHeaders })
      }

      if (req.method === "POST" && url.pathname.match(/^\/api\/projects\/[^/]+\/merge$/)) {
        const projectId = sanitizeParam(url.pathname.split("/")[3]!)
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Not available" }, { status: 500, headers: corsHeaders })
        const project = pm.getProject(projectId)
        if (!project) return Response.json({ error: "Unknown project" }, { status: 404, headers: corsHeaders })
        try {
          const body = (await req.json()) as { targetBranch?: string }
          const result = await pm.mergeAgentBranch(projectId, body.targetBranch)
          return Response.json(result, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400, headers: corsHeaders })
        }
      }

      if (req.method === "POST" && url.pathname.match(/^\/api\/projects\/[^/]+\/push-and-pr$/)) {
        const projectId = sanitizeParam(url.pathname.split("/")[3]!)
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Not available" }, { status: 500, headers: corsHeaders })
        const project = pm.getProject(projectId)
        if (!project) return Response.json({ error: "Unknown project" }, { status: 404, headers: corsHeaders })
        try {
          const body = (await req.json().catch(() => ({}))) as { title?: string; body?: string }
          const result = await pm.pushAndOpenPullRequest(projectId, { title: body.title, body: body.body })
          return Response.json(result, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400, headers: corsHeaders })
        }
      }

      if (req.method === "GET" && url.pathname.match(/^\/api\/projects\/[^/]+\/git-info$/)) {
        const projectId = sanitizeParam(url.pathname.split("/")[3]!)
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Not available" }, { status: 500, headers: corsHeaders })
        const project = pm.getProject(projectId)
        if (!project) return Response.json({ error: "Unknown project" }, { status: 404, headers: corsHeaders })
        try {
          const info = await pm.getGitInfo(projectId)
          return Response.json(info, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      if (req.method === "PUT" && url.pathname.match(/^\/api\/projects\/[^/]+\/base-branch$/)) {
        const projectId = sanitizeParam(url.pathname.split("/")[3]!)
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Not available" }, { status: 500, headers: corsHeaders })
        const project = pm.getProject(projectId)
        if (!project) return Response.json({ error: "Unknown project" }, { status: 404, headers: corsHeaders })
        try {
          const body = (await req.json()) as { baseBranch?: string }
          if (!body.baseBranch || !body.baseBranch.trim()) {
            return Response.json({ error: "baseBranch is required" }, { status: 400, headers: corsHeaders })
          }
          const info = await pm.setBaseBranch(projectId, body.baseBranch)
          return Response.json({ ok: true, gitInfo: info }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400, headers: corsHeaders })
        }
      }

      if (req.method === "DELETE" && url.pathname.match(/^\/api\/projects\/[^/]+\/remote-branch$/)) {
        const projectId = sanitizeParam(url.pathname.split("/")[3]!)
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Not available" }, { status: 500, headers: corsHeaders })
        const project = pm.getProject(projectId)
        if (!project) return Response.json({ error: "Unknown project" }, { status: 404, headers: corsHeaders })
        try {
          const result = await pm.deleteRemoteBranch(projectId)
          return Response.json(result, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400, headers: corsHeaders })
        }
      }

      // ---- Responsibilities endpoints ----
      if (url.pathname === "/api/responsibilities/catalog" && req.method === "GET") {
        const { RESPONSIBILITY_CATALOG } = await import("./responsibilities")
        return Response.json(RESPONSIBILITY_CATALOG, { headers: corsHeaders })
      }

      if (req.method === "GET" && url.pathname.match(/^\/api\/projects\/[^/]+\/responsibilities$/)) {
        const projectId = sanitizeParam(url.pathname.split("/")[3]!)
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Not available" }, { status: 500, headers: corsHeaders })
        try {
          return Response.json(pm.listResponsibilities(projectId), { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 404, headers: corsHeaders })
        }
      }

      if (req.method === "PATCH" && url.pathname.match(/^\/api\/projects\/[^/]+\/responsibilities\/[^/]+$/)) {
        const parts = url.pathname.split("/")
        const projectId = sanitizeParam(parts[3]!)
        const responsibilityId = decodeURIComponent(parts[5]!)
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Not available" }, { status: 500, headers: corsHeaders })
        try {
          const body = (await req.json()) as { enabled?: boolean; config?: Record<string, unknown> }
          let result
          if (body.config !== undefined) {
            result = pm.setResponsibilityConfig(projectId, responsibilityId, body.config)
          }
          if (body.enabled !== undefined) {
            result = pm.setResponsibilityEnabled(projectId, responsibilityId, body.enabled)
          }
          if (!result) return Response.json({ error: "No changes supplied" }, { status: 400, headers: corsHeaders })
          return Response.json({ ok: true, responsibility: result }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400, headers: corsHeaders })
        }
      }

      // ---- Validation config endpoint ----
      if (req.method === "POST" && url.pathname.match(/^\/api\/projects\/[^/]+\/validation$/)) {
        const projectId = sanitizeParam(url.pathname.split("/")[3]!)
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Not available" }, { status: 500, headers: corsHeaders })
        const project = pm.getProject(projectId)
        if (!project) return Response.json({ error: "Unknown project" }, { status: 404, headers: corsHeaders })
        try {
          const body = (await req.json()) as { command?: string; preset?: string; timeoutMs?: number; failAction?: string }
          pm.setValidationConfig(projectId, {
            command: body.command,
            preset: body.preset as any,
            timeoutMs: body.timeoutMs,
            failAction: (body.failAction as "warn" | "inject" | "pause") ?? "inject",
          })
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400, headers: corsHeaders })
        }
      }

      // ---- Token tracking endpoints ----
      if (url.pathname === "/api/tokens" && req.method === "GET") {
        if (!opts?.tokenTracker) return Response.json({ total: 0, agents: {} }, { headers: corsHeaders })
        const tracker = opts.tokenTracker
        const agents: Record<string, unknown> = {}
        for (const [agent, stats] of tracker.getAllStats()) {
          agents[agent] = stats
        }
        return Response.json({
          total: tracker.getTotalTokens(),
          agents,
          recent: tracker.getRecent(20),
        }, { headers: corsHeaders })
      }

      // Soft stop endpoint
      if (url.pathname === "/api/soft-stop" && req.method === "POST") {
        if (opts?.onSoftStop) {
          opts.onSoftStop()
          return Response.json({ ok: true, message: "Soft stop requested" }, { headers: corsHeaders })
        }
        return Response.json({ ok: false, message: "No brain-loop running" }, { status: 400, headers: corsHeaders })
      }

      // Dashboard HTML — served from pre-built cache (token injected once at startup)
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(injectedHtml, {
          headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
        })
      }

      // Static assets — CSS and JS served from pre-loaded cache
      if (url.pathname === "/dashboard-client.css") {
        return new Response(DASHBOARD_CSS, {
          headers: { ...corsHeaders, "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" },
        })
      }

      // Favicon — return the inline SVG to suppress browser 404 requests
      if (url.pathname === "/favicon.ico") {
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><radialGradient id='g' cx='32' cy='32' r='28'><stop offset='0%' stop-color='%239b8bff'/><stop offset='100%' stop-color='%235b4bdf'/></radialGradient></defs><rect width='64' height='64' rx='14' fill='%230a0a0f'/><line x1='32' y1='32' x2='16' y2='14' stroke='%234a4a6a' stroke-width='2'/><line x1='32' y1='32' x2='48' y2='14' stroke='%234a4a6a' stroke-width='2'/><line x1='32' y1='32' x2='16' y2='50' stroke='%234a4a6a' stroke-width='2'/><line x1='32' y1='32' x2='48' y2='50' stroke='%234a4a6a' stroke-width='2'/><circle cx='16' cy='14' r='6' fill='%232a2a3a' stroke='%234ade80' stroke-width='2'/><circle cx='48' cy='14' r='6' fill='%232a2a3a' stroke='%2360a5fa' stroke-width='2'/><circle cx='16' cy='50' r='6' fill='%232a2a3a' stroke='%23facc15' stroke-width='2'/><circle cx='48' cy='50' r='6' fill='%232a2a3a' stroke='%23c084fc' stroke-width='2'/><circle cx='32' cy='32' r='9' fill='url(%23g)'/><path d='M28 32 L31 35 L37 29' stroke='white' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>`
        return new Response(svg, {
          headers: { ...corsHeaders, "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
        })
      }

      if (url.pathname === "/dashboard-client.js") {
        return new Response(DASHBOARD_JS, {
          headers: { ...corsHeaders, "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" },
        })
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders })
      } catch (err) {
        console.error(`[dashboard] Unhandled error on ${req.method} ${url.pathname}:`, err)
        return Response.json(
          { error: "Internal server error", detail: err instanceof Error ? err.message : String(err) },
          { status: 500, headers: corsHeaders },
        )
      }
    },
  })



  return {
    stop() {
      persistUnsub()
      server.stop(true) // close all open connections immediately
    },
  }
}

/**
 * Try to bind a temporary server on the port. If it fails, the port is genuinely
 * in use. This is more reliable than Bun.connect, which can false-positive against
 * sockets lingering in TIME_WAIT/CLOSE_WAIT after a previous process was killed.
 * Bun.serve() crashes at a low level on EADDRINUSE before a JS catch block can
 * intercept it, so we detect conflicts here with a helpful error message.
 */
function checkPortAvailable(port: number): void {
  try {
    const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") })
    probe.stop(true)
  } catch {
    throw new Error(
      `Port ${port} is already in use. A previous orchestrator may not have shut down cleanly.\n` +
      `  - Try a different port: --dashboard-port ${port + 1}\n` +
      `  - Or kill the process using port ${port}:\n` +
      `    Windows:  netstat -ano | findstr :${port}  then  taskkill /PID <pid> /F\n` +
      `    Linux:    lsof -ti:${port} | xargs kill`,
    )
  }
}

/** Load dashboard assets from files once at startup */
const DASHBOARD_HTML = readFileSync(resolve(import.meta.dirname, "dashboard.html"), "utf-8")
const DASHBOARD_CSS = readFileSync(resolve(import.meta.dirname, "dashboard-client.css"), "utf-8")
const DASHBOARD_JS = readFileSync(resolve(import.meta.dirname, "dashboard-client.js"), "utf-8")
