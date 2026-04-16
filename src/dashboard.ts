import { readFileSync } from "fs"
import { resolve } from "path"
import type { Orchestrator } from "./orchestrator"
import type { AgentState } from "./agent"
import { agentListPermissions, agentReplyPermission } from "./agent"
import type { ProjectManager } from "./project-manager"
import { listDirectories } from "./project-manager"

/** Decode and sanitize a URL path segment — strips path traversal and control characters */
function sanitizeParam(raw: string): string {
  return decodeURIComponent(raw).replace(/[\/\\\.]{2,}/g, "").replace(/[\x00-\x1f]/g, "")
}

export type DashboardEvent =
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
  | { type: "supervisor-status"; agent: string; status: "running" | "idle" | "done" | "reviewing" }
  | { type: "supervisor-alert"; agent: string; text: string }

/** Shared event log that the dashboard reads from */
export class DashboardLog {
  private listeners = new Set<(event: DashboardEvent) => void>()
  private history: DashboardEvent[] = []
  private maxHistory = 500

  push(event: DashboardEvent) {
    this.history.push(event)
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }
    for (const listener of this.listeners) {
      listener(event)
    }
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

      // SSE endpoint — long-poll style to avoid Bun chunked encoding issues
      if (url.pathname === "/api/events") {
        // Get cursor from query param (index into history)
        const since = parseInt(url.searchParams.get("since") ?? "0", 10)
        const history = log.getHistory()

        // If client is behind, send all missed events immediately
        if (since < history.length) {
          const missed = history.slice(since)
          return Response.json(
            { events: missed, cursor: history.length },
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
          { events, cursor: log.getHistory().length },
          { headers: corsHeaders },
        )
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
          const reply = body.decision === "approve"
            ? { type: "approve" as const }
            : { type: "deny" as const, reason: body.reason }
          await agentReplyPermission(agent, requestID, reply)
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

      if (url.pathname === "/api/projects" && req.method === "POST") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Project manager not available" }, { status: 500, headers: corsHeaders })
        try {
          const body = await req.json() as { directory: string; directive?: string; name?: string; directiveHistory?: any[] }
          if (!body.directory?.trim()) {
            return Response.json({ error: "Directory is required" }, { status: 400, headers: corsHeaders })
          }
          const project = await pm.addProject(
            body.directory.trim(),
            body.directive?.trim() || "Work on this project. Review the codebase, fix bugs, add features, and improve code quality.",
            body.name?.trim() || undefined,
            body.directiveHistory || undefined,
          )
          return Response.json({ ok: true, project }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
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

      // Update project directive
      if (url.pathname.match(/^\/api\/projects\/[^/]+\/directive$/) && req.method === "PUT") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Project manager not available" }, { status: 500, headers: corsHeaders })
        const projectId = sanitizeParam(url.pathname.split("/")[3] ?? "")
        try {
          const body = await req.json() as { directive: string }
          if (!body.directive?.trim()) {
            return Response.json({ error: "Directive is required" }, { status: 400, headers: corsHeaders })
          }
          pm.updateDirective(projectId, body.directive.trim())
          // Restart supervisor with new directive
          pm.restartSupervisor(projectId, body.directive.trim())
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Get directive history for a project
      if (url.pathname.match(/^\/api\/projects\/[^/]+\/directive-history$/) && req.method === "GET") {
        const pm = opts?.projectManager
        if (!pm) return Response.json([], { headers: corsHeaders })
        const projectId = sanitizeParam(url.pathname.split("/")[3] ?? "")
        return Response.json(pm.getDirectiveHistory(projectId), { headers: corsHeaders })
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
          if (!body.model?.trim()) {
            return Response.json({ error: "Model name is required" }, { status: 400, headers: corsHeaders })
          }
          pm.updateModel(projectId, body.model.trim())
          // Restart supervisor with new model
          pm.restartSupervisor(projectId)
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Fetch available Ollama models (proxy to Ollama API)
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

      // Saved projects (for restore) — includes directory existence check
      if (url.pathname === "/api/saved-projects" && req.method === "GET") {
        const pm = opts?.projectManager
        if (!pm) return Response.json([], { headers: corsHeaders })
        const { existsSync } = await import("fs")
        const saved = (await pm.loadSavedProjects()).map(p => ({
          ...p,
          directoryExists: existsSync(p.directory),
        }))
        return Response.json(saved, { headers: corsHeaders })
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

      return new Response("Not Found", { status: 404, headers: corsHeaders })
    },
  })



  return {
    stop() {
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

/** Load dashboard HTML from file once at startup */
const DASHBOARD_HTML = readFileSync(resolve(import.meta.dirname, "dashboard.html"), "utf-8")
