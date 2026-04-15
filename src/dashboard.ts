import type { Orchestrator } from "./orchestrator"
import type { AgentState } from "./agent"
import { agentListPermissions, agentReplyPermission } from "./agent"
import type { ProjectManager } from "./project-manager"
import { listDirectories } from "./project-manager"

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
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
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
        "Access-Control-Allow-Headers": "Content-Type",
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
        const agentName = url.pathname.slice("/api/messages/".length)
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
        const agentName = parts[0]
        const requestID = parts.slice(1).join("/")
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
        const agentName = url.pathname.slice("/api/prompt/".length)
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
          const body = await req.json() as { directory: string; directive?: string; name?: string }
          if (!body.directory?.trim()) {
            return Response.json({ error: "Directory is required" }, { status: 400, headers: corsHeaders })
          }
          const project = await pm.addProject(
            body.directory.trim(),
            body.directive?.trim() || "Work on this project. Review the codebase, fix bugs, add features, and improve code quality.",
            body.name?.trim() || undefined,
          )
          return Response.json({ ok: true, project }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      if (url.pathname.startsWith("/api/projects/") && req.method === "DELETE") {
        const pm = opts?.projectManager
        if (!pm) return Response.json({ error: "Project manager not available" }, { status: 500, headers: corsHeaders })
        const projectId = url.pathname.slice("/api/projects/".length)
        try {
          await pm.removeProject(projectId)
          return Response.json({ ok: true }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders })
        }
      }

      // Directory browser for folder picker
      if (url.pathname === "/api/browse") {
        const dirPath = url.searchParams.get("path") || (process.platform === "win32" ? "C:\\Users" : "/")
        const dirs = listDirectories(dirPath)
        return Response.json({ current: dirPath, directories: dirs }, { headers: corsHeaders })
      }

      // Saved projects (for restore)
      if (url.pathname === "/api/saved-projects" && req.method === "GET") {
        const pm = opts?.projectManager
        if (!pm) return Response.json([], { headers: corsHeaders })
        return Response.json(pm.loadSavedProjects(), { headers: corsHeaders })
      }

      // Soft stop endpoint
      if (url.pathname === "/api/soft-stop" && req.method === "POST") {
        if (opts?.onSoftStop) {
          opts.onSoftStop()
          return Response.json({ ok: true, message: "Soft stop requested" }, { headers: corsHeaders })
        }
        return Response.json({ ok: false, message: "No brain-loop running" }, { status: 400, headers: corsHeaders })
      }

      // Dashboard HTML
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(DASHBOARD_HTML, {
          headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
        })
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders })
    },
  })

  console.log(`[dashboard] http://127.0.0.1:${port}`)

  return {
    stop() {
      server.stop()
    },
  }
}

// NOTE: Dashboard HTML is embedded as a template literal for zero-dependency serving.
// This trades IDE support (no syntax highlighting / linting for the HTML/CSS/JS) for
// simplicity — there are no static assets to serve or build steps to run.
// If this grows further, consider extracting to a separate .html file loaded with readFileSync.
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3CradialGradient id='g' cx='32' cy='32' r='28'%3E%3Cstop offset='0%25' stop-color='%239b8bff'/%3E%3Cstop offset='100%25' stop-color='%235b4bdf'/%3E%3C/radialGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='14' fill='%230a0a0f'/%3E%3Cline x1='32' y1='32' x2='16' y2='14' stroke='%234a4a6a' stroke-width='2'/%3E%3Cline x1='32' y1='32' x2='48' y2='14' stroke='%234a4a6a' stroke-width='2'/%3E%3Cline x1='32' y1='32' x2='16' y2='50' stroke='%234a4a6a' stroke-width='2'/%3E%3Cline x1='32' y1='32' x2='48' y2='50' stroke='%234a4a6a' stroke-width='2'/%3E%3Ccircle cx='16' cy='14' r='6' fill='%232a2a3a' stroke='%234ade80' stroke-width='2'/%3E%3Ccircle cx='48' cy='14' r='6' fill='%232a2a3a' stroke='%2360a5fa' stroke-width='2'/%3E%3Ccircle cx='16' cy='50' r='6' fill='%232a2a3a' stroke='%23facc15' stroke-width='2'/%3E%3Ccircle cx='48' cy='50' r='6' fill='%232a2a3a' stroke='%23c084fc' stroke-width='2'/%3E%3Ccircle cx='32' cy='32' r='9' fill='url(%23g)'/%3E%3Cpath d='M28 32 L31 35 L37 29' stroke='white' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
  <title>OpenCode Orchestrator</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
      background: #0a0a0f;
      color: #e0e0e0;
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    header {
      background: #12121a;
      border-bottom: 1px solid #2a2a3a;
      padding: 10px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    header h1 {
      font-size: 16px;
      font-weight: 600;
      color: #8b8bff;
    }
    .status-bar {
      display: flex;
      gap: 16px;
      font-size: 12px;
    }
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .dot-idle { background: #4ade80; }
    .dot-busy { background: #facc15; animation: pulse 1s infinite; }
    .dot-disconnected { background: #ef4444; }
    .dot-error { background: #ef4444; }
    .dot-done { background: #60a5fa; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* Main scrollable area for project rows */
    .projects-container {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }
    .projects-container::-webkit-scrollbar { width: 8px; }
    .projects-container::-webkit-scrollbar-track { background: #0a0a0f; }
    .projects-container::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }

    /* Project row — one per project, contains worker + supervisor */
    .project-row {
      border-bottom: 2px solid #2a2a3a;
    }
    .project-row-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      background: #16162a;
      cursor: pointer;
      user-select: none;
    }
    .project-row-header:hover { background: #1a1a32; }
    .project-row-arrow {
      font-size: 11px;
      transition: transform 0.2s;
      color: #666;
      flex-shrink: 0;
    }
    .project-row.open .project-row-arrow { transform: rotate(90deg); }
    .project-row-name {
      font-weight: 700;
      font-size: 14px;
      color: #e0e0e0;
    }
    .project-row-dir {
      font-size: 11px;
      color: #666;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 300px;
    }
    .project-row-badges {
      display: flex;
      gap: 8px;
      margin-left: auto;
      align-items: center;
    }
    .project-row-badges .agent-badge {
      font-size: 9px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .project-row-remove {
      font-size: 11px;
      padding: 2px 10px;
      border: 1px solid #3a1a1a;
      border-radius: 4px;
      background: transparent;
      color: #ef4444;
      cursor: pointer;
      font-family: inherit;
      font-weight: 600;
      opacity: 0.5;
      transition: opacity 0.15s;
    }
    .project-row-remove:hover { opacity: 1; background: #2a1010; }

    /* Panels inside a project row */
    .project-row-body {
      display: none;
    }
    .project-row.open .project-row-body { display: flex; }
    .project-row-body {
      height: 380px;
    }

    /* Worker and supervisor panels — side by side */
    .panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #0f0f18;
    }
    .panel + .panel {
      border-left: 1px solid #2a2a3a;
    }
    .panel-header {
      padding: 6px 12px;
      background: #111122;
      border-bottom: 1px solid #2a2a3a;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .panel-title {
      font-weight: 600;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .panel-title .label { color: #888; }
    .panel-title .name { color: #e0e0e0; }
    .panel-title .worker-icon { color: #4ade80; }
    .panel-title .supervisor-icon { color: #c084fc; }
    .view-link {
      font-size: 10px;
      color: #8b8bff;
      text-decoration: none;
      margin-left: 8px;
    }
    .view-link:hover { text-decoration: underline; }

    .agent-badge {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-idle { background: #1a3a2a; color: #4ade80; }
    .badge-busy { background: #3a3a1a; color: #facc15; }
    .badge-done { background: #1a2a3a; color: #60a5fa; }
    .badge-disconnected { background: #3a1a1a; color: #ef4444; }
    .badge-supervising { background: #7c3aed; color: #fff; animation: pulse 1.5s infinite; }
    .badge-reviewing { background: #d946ef; color: #fff; animation: pulse 1.5s infinite; }

    .panel-log {
      flex: 1;
      overflow-y: auto;
      padding: 6px 10px;
      font-size: 12px;
      line-height: 1.5;
    }
    .panel-log::-webkit-scrollbar { width: 6px; }
    .panel-log::-webkit-scrollbar-track { background: transparent; }
    .panel-log::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

    .log-entry {
      padding: 3px 0;
      border-bottom: 1px solid #1a1a2a;
    }
    .log-entry.status { color: #60a5fa; }
    .log-entry.prompt { color: #c084fc; white-space: pre-wrap; border-left: 3px solid #8b8bff; padding-left: 8px; }
    .log-entry.response { color: #e0e0e0; white-space: pre-wrap; }
    .log-entry.error { color: #ef4444; }
    .log-entry .timestamp {
      color: #555;
      font-size: 10px;
      margin-right: 8px;
    }

    /* Collapsible entries */
    .collapsible {
      margin: 3px 0;
      border-radius: 4px;
      overflow: hidden;
    }
    .collapsible-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      user-select: none;
    }
    .collapsible-header:hover { opacity: 0.85; }
    .collapsible-arrow {
      font-size: 10px;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    .collapsible.open .collapsible-arrow { transform: rotate(90deg); }
    .collapsible-header .timestamp {
      color: #555;
      font-size: 10px;
      font-weight: 400;
      margin-left: auto;
      flex-shrink: 0;
    }
    .collapsible-body {
      display: none;
      padding: 6px 10px 8px 24px;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      max-height: 350px;
      overflow-y: auto;
    }
    .collapsible.open .collapsible-body { display: block; }

    .collapsible.prompt-entry {
      background: #14122a;
      border-left: 3px solid #8b8bff;
    }
    .collapsible.prompt-entry .collapsible-header { color: #c084fc; }
    .collapsible.prompt-entry .collapsible-body { color: #c084fc; }
    .collapsible.response-entry {
      background: #111118;
      border-left: 3px solid #4ade80;
    }
    .collapsible.response-entry .collapsible-header { color: #4ade80; }
    .collapsible.response-entry .collapsible-body { color: #e0e0e0; }

    /* Cycle summary */
    .cycle-summary {
      background: #1a1a30;
      border: 1px solid #8b8bff;
      border-radius: 6px;
      padding: 8px 12px;
      margin: 6px 0;
    }
    .cycle-summary-title {
      font-size: 12px;
      font-weight: 700;
      color: #8b8bff;
      margin-bottom: 4px;
    }
    .cycle-summary-text {
      font-size: 11px;
      color: #c0c0ff;
      white-space: pre-wrap;
    }

    /* Supervisor thinking entries */
    .supervisor-entry {
      font-size: 11px;
      color: #a78bfa;
      padding: 2px 8px;
      border-left: 2px solid #7c3aed;
      margin: 2px 0;
      opacity: 0.85;
    }
    .supervisor-entry.sv-heading {
      font-weight: 600;
      opacity: 1;
      color: #c084fc;
    }

    /* Agent chatbox */
    .agent-chatbox {
      display: flex;
      gap: 6px;
      padding: 6px 8px;
      background: #12121a;
      border-top: 1px solid #2a2a3a;
      flex-shrink: 0;
    }
    .agent-chatbox input {
      flex: 1;
      font-size: 12px;
      padding: 5px 10px;
      border: 1px solid #333;
      border-radius: 4px;
      background: #1a1a2a;
      color: #e0e0e0;
      font-family: inherit;
      outline: none;
    }
    .agent-chatbox input:focus { border-color: #8b8bff; }
    .agent-chatbox input::placeholder { color: #555; }
    .agent-chatbox button {
      font-size: 11px;
      padding: 5px 12px;
      border: 1px solid #8b8bff;
      border-radius: 4px;
      background: #1a1a3a;
      color: #8b8bff;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      flex-shrink: 0;
    }
    .agent-chatbox button:hover { background: #2a2a4a; }
    .agent-chatbox button:disabled { opacity: 0.4; cursor: default; }

    /* Permission request UI */
    .perm-request {
      background: #1a1a2e;
      border: 1px solid #facc15;
      border-radius: 6px;
      padding: 8px 12px;
      margin: 6px 0;
    }
    .perm-request.resolved { border-color: #333; opacity: 0.6; }
    .perm-title {
      color: #facc15;
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .perm-detail {
      color: #aaa;
      font-size: 11px;
      margin-bottom: 6px;
      white-space: pre-wrap;
      max-height: 80px;
      overflow-y: auto;
    }
    .perm-actions { display: flex; gap: 8px; }
    .perm-btn {
      font-size: 11px;
      padding: 4px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-family: inherit;
    }
    .perm-approve { background: #1a3a2a; color: #4ade80; }
    .perm-approve:hover { background: #2a4a3a; }
    .perm-deny { background: #3a1a1a; color: #ef4444; }
    .perm-deny:hover { background: #4a2a2a; }
    .perm-resolved-text { font-size: 11px; font-weight: 600; }

    /* Brain panel — collapsible at bottom */
    .brain-section {
      flex-shrink: 0;
      border-top: 2px solid #8b8bff;
    }
    .brain-header {
      padding: 8px 12px;
      background: #16162a;
      border-bottom: 1px solid #2a2a3a;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
    }
    .brain-header:hover { background: #1a1a32; }
    .brain-header h2 {
      font-size: 13px;
      font-weight: 600;
      color: #8b8bff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brain-arrow {
      font-size: 11px;
      transition: transform 0.2s;
      color: #666;
    }
    .brain-section.open .brain-arrow { transform: rotate(90deg); }
    .brain-body {
      display: none;
      height: 180px;
    }
    .brain-section.open .brain-body { display: block; }
    .brain-log {
      height: 100%;
      overflow-y: auto;
      padding: 8px 12px;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      color: #c0c0ff;
      background: #0f0f18;
    }
    .brain-log::-webkit-scrollbar { width: 6px; }
    .brain-log::-webkit-scrollbar-track { background: transparent; }
    .brain-log::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
    .brain-status {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
    }
    .brain-running { background: #2a1a3a; color: #c084fc; animation: pulse 1s infinite; }
    .brain-idle { background: #1a2a2a; color: #888; }

    /* Resize handle for brain panel */
    .resize-handle {
      height: 5px;
      background: #2a2a3a;
      cursor: ns-resize;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .resize-handle:hover { background: #8b8bff; }

    /* Toolbar */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .toolbar-btn {
      font-size: 11px;
      padding: 4px 10px;
      border: 1px solid #333;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-family: inherit;
      background: #1a1a2a;
      color: #aaa;
    }
    .toolbar-btn:hover { background: #2a2a3a; color: #fff; }
    .search-input {
      font-size: 11px;
      padding: 4px 10px;
      border: 1px solid #333;
      border-radius: 4px;
      background: #1a1a2a;
      color: #e0e0e0;
      font-family: inherit;
      width: 180px;
    }
    .search-input::placeholder { color: #555; }

    /* Add project button */
    .add-project-btn {
      background: #8b8bff;
      color: #fff;
      border: none;
      border-radius: 5px;
      padding: 4px 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .add-project-btn:hover { background: #7a7aee; }

    /* Empty state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #555;
      gap: 16px;
    }
    .empty-state h2 { color: #8b8bff; font-size: 18px; }
    .empty-state p { font-size: 13px; max-width: 400px; text-align: center; line-height: 1.5; }
    .empty-state button {
      padding: 10px 24px;
      background: #8b8bff;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      font-weight: 600;
    }
    .empty-state button:hover { background: #7a7aee; }

    /* Add Project modal */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 500;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: #16162a;
      border: 1px solid #2a2a4a;
      border-radius: 10px;
      padding: 24px;
      width: 520px;
      max-width: 90vw;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .modal h2 { font-size: 16px; color: #8b8bff; margin-bottom: 16px; }
    .modal label { display: block; font-size: 12px; color: #888; margin-bottom: 4px; margin-top: 12px; }
    .modal input, .modal textarea {
      width: 100%;
      background: #0f0f18;
      border: 1px solid #2a2a3a;
      color: #e0e0e0;
      font-family: inherit;
      font-size: 13px;
      padding: 8px 10px;
      border-radius: 5px;
      outline: none;
    }
    .modal input:focus, .modal textarea:focus { border-color: #8b8bff; }
    .modal textarea { resize: vertical; min-height: 60px; }
    .modal .modal-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
    .modal .modal-btn {
      padding: 8px 18px;
      border-radius: 5px;
      border: 1px solid #3a3a5a;
      background: transparent;
      color: #e0e0e0;
      font-family: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .modal .modal-btn.primary { background: #8b8bff; color: #fff; border-color: #8b8bff; }
    .modal .modal-btn.primary:hover { background: #7a7aee; }
    .modal .modal-btn:hover { background: #2a2a4a; }
    .modal .modal-btn:disabled { opacity: 0.4; cursor: default; }

    /* Folder picker */
    .folder-picker {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .folder-picker input { flex: 1; }
    .folder-picker button {
      padding: 8px 12px;
      background: #2a2a4a;
      border: 1px solid #3a3a5a;
      color: #c0c0ff;
      border-radius: 5px;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      white-space: nowrap;
    }
    .folder-picker button:hover { background: #3a3a5a; }

    /* Browse panel */
    .browse-panel {
      display: none;
      max-height: 200px;
      overflow-y: auto;
      background: #0a0a12;
      border: 1px solid #2a2a3a;
      border-radius: 5px;
      margin-top: 4px;
    }
    .browse-panel.open { display: block; }
    .browse-item {
      padding: 5px 10px;
      cursor: pointer;
      font-size: 12px;
      color: #c0c0ff;
      border-bottom: 1px solid #1a1a2a;
    }
    .browse-item:hover { background: #1a1a3a; }
    .browse-item.parent { color: #888; }

    /* Command bar */
    .cmd-bar {
      flex-shrink: 0;
      height: 38px;
      background: #0d0d14;
      border-top: 1px solid #2a2a3a;
      display: flex;
      align-items: center;
      padding: 0 12px;
      gap: 8px;
      z-index: 100;
    }
    .cmd-bar .cmd-prompt {
      color: #8b8bff;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      user-select: none;
    }
    .cmd-bar input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #e0e0e0;
      font-family: inherit;
      font-size: 13px;
      caret-color: #8b8bff;
    }
    .cmd-bar input::placeholder { color: #444; }
    .cmd-bar .cmd-help-btn {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 1px solid #3a3a5a;
      background: transparent;
      color: #6a6a9a;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .cmd-bar .cmd-help-btn:hover, .cmd-bar .cmd-help-btn.active {
      background: #8b8bff;
      color: #fff;
      border-color: #8b8bff;
    }
    .cmd-bar .cmd-status {
      font-size: 11px;
      color: #555;
      white-space: nowrap;
    }

    /* Help palette */
    .cmd-palette {
      display: none;
      position: fixed;
      bottom: 44px;
      left: 50%;
      transform: translateX(-50%);
      background: #16162a;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      padding: 12px 16px;
      z-index: 200;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.5);
      min-width: 480px;
      max-width: 90vw;
    }
    .cmd-palette.open { display: block; }
    .cmd-palette h3 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #6a6a9a;
      margin-bottom: 8px;
    }
    .cmd-palette .cmd-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2px 20px;
    }
    .cmd-palette .cmd-item {
      display: flex;
      gap: 8px;
      padding: 3px 0;
      font-size: 12px;
      cursor: pointer;
      border-radius: 3px;
    }
    .cmd-palette .cmd-item:hover { background: rgba(139,139,255,0.08); }
    .cmd-palette .cmd-key {
      color: #c084fc;
      font-weight: 600;
      white-space: nowrap;
      min-width: 130px;
    }
    .cmd-palette .cmd-desc { color: #888; }

    /* Light theme */
    body.light { background: #f5f5f5; color: #222; }
    body.light header { background: #e8e8f0; border-color: #ccc; }
    body.light header h1 { color: #5b4bdf; }
    body.light .projects-container { background: #f0f0f5; }
    body.light .projects-container::-webkit-scrollbar-track { background: #f0f0f5; }
    body.light .projects-container::-webkit-scrollbar-thumb { background: #bbb; }
    body.light .project-row { border-color: #ccc; }
    body.light .project-row-header { background: #e8e8f0; }
    body.light .project-row-header:hover { background: #ddd; }
    body.light .project-row-name { color: #222; }
    body.light .project-row-dir { color: #888; }
    body.light .panel { background: #fff; }
    body.light .panel-header { background: #f0f0f5; border-color: #ccc; }
    body.light .panel-title .label { color: #888; }
    body.light .panel-title .name { color: #222; }
    body.light .panel-log { color: #222; }
    body.light .panel-log::-webkit-scrollbar-thumb { background: #bbb; }
    body.light .log-entry { border-color: #e0e0e0; }
    body.light .log-entry.status { color: #2563eb; }
    body.light .log-entry.prompt { color: #7c3aed; border-color: #7c3aed; }
    body.light .log-entry .timestamp { color: #999; }
    body.light .collapsible.prompt-entry { background: #f0eeff; border-color: #7c3aed; }
    body.light .collapsible.prompt-entry .collapsible-header { color: #7c3aed; }
    body.light .collapsible.prompt-entry .collapsible-body { color: #5b21b6; }
    body.light .collapsible.response-entry { background: #eefff5; border-color: #16a34a; }
    body.light .collapsible.response-entry .collapsible-header { color: #16a34a; }
    body.light .collapsible.response-entry .collapsible-body { color: #222; }
    body.light .cycle-summary { background: #eeeeff; border-color: #5b4bdf; }
    body.light .cycle-summary-title { color: #5b4bdf; }
    body.light .cycle-summary-text { color: #333; }
    body.light .collapsible-header .timestamp { color: #999; }
    body.light .supervisor-entry { color: #6d28d9; border-color: #7c3aed; }
    body.light .supervisor-entry.sv-heading { color: #5b21b6; }
    body.light .agent-chatbox { background: #f0f0f5; border-color: #ccc; }
    body.light .agent-chatbox input { background: #fff; color: #222; border-color: #bbb; }
    body.light .agent-chatbox input:focus { border-color: #5b4bdf; }
    body.light .agent-chatbox input::placeholder { color: #aaa; }
    body.light .agent-chatbox button { background: #eeeeff; color: #5b4bdf; border-color: #5b4bdf; }
    body.light .agent-chatbox button:hover { background: #ddddef; }
    body.light .brain-section { border-color: #5b4bdf; }
    body.light .brain-header { background: #e8e8f0; border-color: #ccc; }
    body.light .brain-header:hover { background: #ddd; }
    body.light .brain-header h2 { color: #5b4bdf; }
    body.light .brain-log { background: #fff; color: #333; }
    body.light .brain-log::-webkit-scrollbar-thumb { background: #bbb; }
    body.light .toolbar-btn { background: #e0e0e0; color: #333; border-color: #bbb; }
    body.light .toolbar-btn:hover { background: #d0d0d0; }
    body.light .search-input { background: #fff; color: #222; border-color: #bbb; }
    body.light .search-input::placeholder { color: #aaa; }
    body.light .resize-handle { background: #ccc; }
    body.light .resize-handle:hover { background: #5b4bdf; }
    body.light .cmd-bar { background: #e8e8f0; border-color: #ccc; }
    body.light .cmd-bar input { color: #222; }
    body.light .cmd-bar input::placeholder { color: #aaa; }
    body.light .cmd-bar .cmd-prompt { color: #5b4bdf; }
    body.light .cmd-bar .cmd-help-btn { border-color: #bbb; color: #888; }
    body.light .cmd-bar .cmd-help-btn:hover, body.light .cmd-bar .cmd-help-btn.active { background: #5b4bdf; color: #fff; }
    body.light .cmd-palette { background: #fff; border-color: #ccc; box-shadow: 0 -4px 20px rgba(0,0,0,0.1); }
    body.light .cmd-palette h3 { color: #888; }
    body.light .cmd-palette .cmd-key { color: #7c3aed; }
    body.light .cmd-palette .cmd-desc { color: #666; }
    body.light .cmd-palette .cmd-item:hover { background: rgba(91,75,223,0.06); }
    body.light .modal { background: #fff; border-color: #ccc; }
    body.light .modal h2 { color: #5b4bdf; }
    body.light .modal input, body.light .modal textarea { background: #f5f5f5; color: #222; border-color: #ccc; }
    body.light .modal .modal-btn { color: #222; border-color: #bbb; }
    body.light .modal .modal-btn.primary { background: #5b4bdf; color: #fff; }
    body.light .browse-panel { background: #f5f5f5; border-color: #ccc; }
    body.light .browse-item { color: #5b4bdf; border-color: #eee; }
    body.light .browse-item:hover { background: #eeeeff; }
    body.light .empty-state h2 { color: #5b4bdf; }
    body.light .empty-state button { background: #5b4bdf; }
  </style>
</head>
<body>
  <header>
    <div style="display:flex;align-items:center;gap:16px;">
      <h1>OpenCode Orchestrator</h1>
      <button class="add-project-btn" onclick="openAddProject()">+ Add Project</button>
      <div class="status-bar" id="status-bar"></div>
    </div>
    <div class="toolbar">
      <input type="text" class="search-input" id="search-input" placeholder="Filter logs..." oninput="filterLogs(this.value)">
      <button class="toolbar-btn" onclick="exportLogs()">Export</button>
      <button class="toolbar-btn" id="theme-btn" onclick="toggleTheme()">Light</button>
    </div>
  </header>

  <div class="projects-container" id="projects-container">
    <div class="empty-state" id="empty-state">
      <h2>No projects yet</h2>
      <p>Add a project folder to get started. The orchestrator will spawn a worker agent and supervisor for each project automatically.</p>
      <button onclick="openAddProject()">+ Add Project</button>
    </div>
  </div>

  <!-- Add Project Modal -->
  <div class="modal-overlay" id="add-project-modal">
    <div class="modal">
      <h2>Add Project</h2>
      <label>Project Folder</label>
      <div class="folder-picker">
        <input type="text" id="proj-dir" placeholder="C:\\Users\\you\\my-project">
        <button onclick="toggleBrowse()">Browse</button>
      </div>
      <div class="browse-panel" id="browse-panel"></div>
      <label>Project Name (optional)</label>
      <input type="text" id="proj-name" placeholder="Auto-detected from folder name">
      <label>Directive / Goals</label>
      <textarea id="proj-directive" placeholder="What should the agent work on? e.g., Fix all TypeScript errors and add missing tests"></textarea>
      <div class="modal-actions">
        <button class="modal-btn" onclick="closeAddProject()">Cancel</button>
        <button class="modal-btn primary" id="proj-submit" onclick="submitProject()">Add Project</button>
      </div>
    </div>
  </div>

  <div class="resize-handle" id="resize-handle"></div>
  <div class="brain-section open" id="brain-section">
    <div class="brain-header" onclick="document.getElementById('brain-section').classList.toggle('open')">
      <h2><span class="brain-arrow">&#9654;</span> Brain / Orchestrator</h2>
      <div style="display:flex;align-items:center;gap:8px;" onclick="event.stopPropagation()">
        <button class="toolbar-btn" id="soft-stop-btn" onclick="softStop()" style="display:none;color:#facc15;border-color:#facc15;">Soft Stop</button>
        <span class="brain-status brain-idle" id="brain-badge">IDLE</span>
      </div>
    </div>
    <div class="brain-body">
      <div class="brain-log" id="brain-log"></div>
    </div>
  </div>

  <div class="cmd-bar">
    <span class="cmd-prompt">orchestrator&gt;</span>
    <input type="text" id="cmd-input" placeholder="Type a command... (press ? for help)" autocomplete="off" spellcheck="false">
    <span class="cmd-status" id="cmd-status"></span>
    <button class="cmd-help-btn" id="cmd-help-btn" title="Command reference">?</button>
  </div>

  <div class="cmd-palette" id="cmd-palette">
    <h3>Commands</h3>
    <div class="cmd-grid">
      <div class="cmd-item" onclick="cmdFill('')"><span class="cmd-key">&lt;agent&gt; &lt;prompt&gt;</span><span class="cmd-desc">Send prompt to agent</span></div>
      <div class="cmd-item" onclick="cmdFill('all ')"><span class="cmd-key">all &lt;prompt&gt;</span><span class="cmd-desc">Prompt all agents</span></div>
      <div class="cmd-item" onclick="cmdFill('brain ')"><span class="cmd-key">brain &lt;objective&gt;</span><span class="cmd-desc">One-shot brain</span></div>
      <div class="cmd-item" onclick="cmdFill('brain-loop ')"><span class="cmd-key">brain-loop &lt;directive&gt;</span><span class="cmd-desc">Parallel per-agent supervisors</span></div>
      <div class="cmd-item" onclick="cmdFill('brain-queue')"><span class="cmd-key">brain-queue</span><span class="cmd-desc">Run task queue</span></div>
      <div class="cmd-item" onclick="cmdFill('stop')"><span class="cmd-key">stop</span><span class="cmd-desc">Soft stop brain loop</span></div>
      <div class="cmd-item" onclick="cmdFill('tasks')"><span class="cmd-key">tasks</span><span class="cmd-desc">Show task queue</span></div>
      <div class="cmd-item" onclick="cmdFill('task add ')"><span class="cmd-key">task add &lt;title&gt;</span><span class="cmd-desc">Add a task</span></div>
      <div class="cmd-item" onclick="cmdFill('status')"><span class="cmd-key">status</span><span class="cmd-desc">Agent status</span></div>
      <div class="cmd-item" onclick="cmdFill('messages ')"><span class="cmd-key">messages &lt;agent&gt;</span><span class="cmd-desc">Recent messages</span></div>
    </div>
  </div>

  <script>
    // Track project rows and their agent data
    const projectRows = {}  // keyed by agent name
    const agents = {}       // compatibility alias — same objects
    const brainLog = document.getElementById('brain-log')
    const brainBadge = document.getElementById('brain-badge')
    const container = document.getElementById('projects-container')
    const statusBar = document.getElementById('status-bar')
    let cursor = 0

    function ts() {
      return new Date().toLocaleTimeString()
    }

    function escapeHtml(text) {
      const div = document.createElement('div')
      div.textContent = text
      return div.innerHTML
    }

    // Derive a human-friendly project name from the agent name
    function projectLabel(agentName) {
      // Agent names are like "my-project" — capitalize nicely
      return agentName.replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase())
    }

    function ensureAgent(name) {
      if (projectRows[name]) return projectRows[name]

      const row = document.createElement('div')
      row.className = 'project-row open'
      row.id = 'row-' + name

      row.innerHTML = \`
        <div class="project-row-header" onclick="this.parentElement.classList.toggle('open')">
          <span class="project-row-arrow">&#9654;</span>
          <span class="project-row-name">\${escapeHtml(projectLabel(name))}</span>
          <span class="project-row-dir" id="dir-\${name}"></span>
          <div class="project-row-badges">
            <span style="font-size:10px;color:#666;">Worker:</span>
            <span class="agent-badge badge-idle" id="wbadge-\${name}">IDLE</span>
            <span style="font-size:10px;color:#666;margin-left:4px;">Supervisor:</span>
            <span class="agent-badge badge-idle" id="sbadge-\${name}">IDLE</span>
            <button class="project-row-remove" onclick="event.stopPropagation();removeProject('\${name}')" title="Remove project">Remove</button>
          </div>
        </div>
        <div class="project-row-body">
          <div class="panel">
            <div class="panel-header">
              <div class="panel-title">
                <span class="worker-icon">&#9881;</span>
                <span class="label">Worker</span>
                <span class="name">\${escapeHtml(name)}</span>
                <a class="view-link" id="link-\${name}" href="#" target="_blank">open UI</a>
              </div>
              <span class="agent-badge badge-idle" id="badge-\${name}">IDLE</span>
            </div>
            <div class="panel-log" id="wlog-\${name}"></div>
            <div class="agent-chatbox">
              <input type="text" id="chat-\${name}" placeholder="Send prompt to \${name}..." onkeydown="if(event.key==='Enter')sendPrompt('\${name}')">
              <button onclick="sendPrompt('\${name}')">Send</button>
            </div>
          </div>
          <div class="panel">
            <div class="panel-header">
              <div class="panel-title">
                <span class="supervisor-icon">&#9670;</span>
                <span class="label">Supervisor</span>
              </div>
              <span class="agent-badge badge-idle" id="svbadge-\${name}">IDLE</span>
            </div>
            <div class="panel-log" id="slog-\${name}"></div>
          </div>
        </div>
      \`

      container.appendChild(row)

      const data = {
        row,
        workerLog: row.querySelector('#wlog-' + name),
        supervisorLog: row.querySelector('#slog-' + name),
        workerBadge: row.querySelector('#badge-' + name),
        supervisorBadge: row.querySelector('#svbadge-' + name),
        rowWorkerBadge: row.querySelector('#wbadge-' + name),
        rowSupervisorBadge: row.querySelector('#sbadge-' + name),
        dirLabel: row.querySelector('#dir-' + name),
        link: row.querySelector('#link-' + name),
        chatInput: row.querySelector('#chat-' + name),
        chatBtn: row.querySelector('.agent-chatbox button'),
        // Aliases for backward compat with handleEvent/sendPrompt
        get log() { return this.workerLog },
        get badge() { return this.workerBadge },
        project: row.querySelector('#dir-' + name),
        status: 'idle',
        supervisorStatus: 'idle',
      }

      projectRows[name] = data
      agents[name] = data
      return data
    }

    function addLogEntry(logEl, className, html) {
      const entry = document.createElement('div')
      entry.className = 'log-entry ' + className
      entry.innerHTML = '<span class="timestamp">' + ts() + '</span>' + html
      logEl.appendChild(entry)
      logEl.scrollTop = logEl.scrollHeight
    }

    function makeHeader(text, maxLen) {
      const firstLine = text.split('\\n')[0].trim()
      if (firstLine.length <= maxLen) return firstLine
      return firstLine.slice(0, maxLen) + '...'
    }

    function addCollapsible(logEl, type, header, body, startOpen) {
      const wrapper = document.createElement('div')
      const cls = type === 'prompt' ? 'prompt-entry' : 'response-entry'
      wrapper.className = 'collapsible ' + cls + (startOpen ? ' open' : '')
      wrapper.innerHTML = '<div class="collapsible-header" onclick="this.parentElement.classList.toggle(\\'open\\')">'
        + '<span class="collapsible-arrow">&#9654;</span>'
        + '<span>' + escapeHtml(header) + '</span>'
        + '<span class="timestamp">' + ts() + '</span>'
        + '</div>'
        + '<div class="collapsible-body">' + escapeHtml(body) + '</div>'
      logEl.appendChild(wrapper)
      logEl.scrollTop = logEl.scrollHeight
    }

    function addCycleSummary(logEl, cycle, summary) {
      const el = document.createElement('div')
      el.className = 'cycle-summary'
      const title = cycle > 0 ? 'Cycle ' + cycle + ' Summary' : 'Final Summary'
      el.innerHTML = '<div class="cycle-summary-title">' + title + '</div>'
        + '<div class="cycle-summary-text">' + escapeHtml(summary) + '</div>'
      logEl.appendChild(el)
      logEl.scrollTop = logEl.scrollHeight
    }

    function setBadge(badge, status) {
      const map = {
        idle: ['IDLE', 'badge-idle'],
        busy: ['BUSY', 'badge-busy'],
        completed: ['DONE', 'badge-done'],
        connected: ['OK', 'badge-idle'],
        disconnected: ['DOWN', 'badge-disconnected'],
        error: ['ERROR', 'badge-disconnected'],
        supervising: ['SUPERVISING', 'badge-supervising'],
        reviewing: ['REVIEWING', 'badge-reviewing'],
      }
      const [text, cls] = map[status] || [status.toUpperCase(), 'badge-idle']
      badge.textContent = text
      badge.className = 'agent-badge ' + cls
    }

    function statusToDot(status) {
      switch (status) {
        case 'busy': return 'dot-busy'
        case 'disconnected': return 'dot-disconnected'
        case 'error': return 'dot-error'
        case 'completed': return 'dot-done'
        default: return 'dot-idle'
      }
    }

    function updateStatusBar() {
      const items = Object.entries(projectRows).map(([name, a]) => {
        return '<span><span class="status-dot ' + statusToDot(a.status) + '"></span>' + name + '</span>'
      })
      statusBar.innerHTML = items.join('')
    }

    function handleEvent(event) {
      if (event.type === 'heartbeat') return

      if (event.type === 'agent-status') {
        const agent = ensureAgent(event.agent)
        agent.status = event.status
        setBadge(agent.workerBadge, event.status)
        setBadge(agent.rowWorkerBadge, event.status)
        const detail = event.detail ? ' (' + event.detail + ')' : ''
        addLogEntry(agent.workerLog, 'status', escapeHtml(event.status + detail))
        updateStatusBar()
        if (event.status === 'completed') {
          notify(event.agent + ' completed', detail || 'Task finished')
        }
        if (event.status === 'error' || event.status === 'disconnected') {
          notify(event.agent + ' ' + event.status, detail || '')
        }
      }

      if (event.type === 'agent-prompt') {
        const agent = ensureAgent(event.agent)
        const header = 'PROMPT: ' + makeHeader(event.text, 80)
        addCollapsible(agent.workerLog, 'prompt', header, event.text, false)
      }

      if (event.type === 'agent-response') {
        const agent = ensureAgent(event.agent)
        const header = 'RESPONSE: ' + makeHeader(event.text, 80)
        addCollapsible(agent.workerLog, 'response', header, event.text, false)
      }

      if (event.type === 'cycle-summary') {
        const agent = ensureAgent(event.agent)
        addCycleSummary(agent.workerLog, event.cycle, event.summary)
      }

      if (event.type === 'agent-event') {
        const t = event.event?.type || ''
        if (['session.idle', 'session.error', 'permission.request'].includes(t)) {
          const agent = ensureAgent(event.agent)
          addLogEntry(agent.workerLog, 'status', escapeHtml(t))
        }
      }

      if (event.type === 'permission-request') {
        notify(event.agent + ' needs permission', event.description || 'Review required')
        const agent = ensureAgent(event.agent)
        const id = 'perm-' + event.requestID.replace(/[^a-zA-Z0-9]/g, '_')
        const desc = event.description || JSON.stringify(event.properties, null, 2)
        const html = '<div class="perm-request" id="' + id + '">'
          + '<div class="perm-title">Permission Request</div>'
          + '<div class="perm-detail">' + escapeHtml(desc) + '</div>'
          + '<div class="perm-actions">'
          + '<button class="perm-btn perm-approve" onclick="replyPermission(\\'' + event.agent + '\\', \\'' + event.requestID + '\\', \\'approve\\', \\'' + id + '\\')">Approve</button>'
          + '<button class="perm-btn perm-deny" onclick="replyPermission(\\'' + event.agent + '\\', \\'' + event.requestID + '\\', \\'deny\\', \\'' + id + '\\')">Deny</button>'
          + '</div></div>'
        const entry = document.createElement('div')
        entry.innerHTML = html
        agent.workerLog.appendChild(entry)
        agent.workerLog.scrollTop = agent.workerLog.scrollHeight
      }

      if (event.type === 'permission-resolved') {
        const id = 'perm-' + event.requestID.replace(/[^a-zA-Z0-9]/g, '_')
        const el = document.getElementById(id)
        if (el) {
          el.classList.add('resolved')
          const actions = el.querySelector('.perm-actions')
          if (actions) {
            const color = event.decision === 'approve' ? '#4ade80' : '#ef4444'
            actions.innerHTML = '<span class="perm-resolved-text" style="color:' + color + '">' + event.decision.toUpperCase() + 'D</span>'
          }
        }
      }

      if (event.type === 'supervisor-thinking') {
        const agent = ensureAgent(event.agent)
        const entry = document.createElement('div')
        entry.className = 'supervisor-entry'
        if (event.text.includes('=====') || event.text.startsWith('Supervisor started') || event.text.startsWith('Cycle ')) {
          entry.className += ' sv-heading'
        }
        entry.textContent = event.text
        agent.supervisorLog.appendChild(entry)
        agent.supervisorLog.scrollTop = agent.supervisorLog.scrollHeight
      }

      if (event.type === 'supervisor-status') {
        const agent = ensureAgent(event.agent)
        if (event.status === 'running') {
          setBadge(agent.supervisorBadge, 'supervising')
          setBadge(agent.rowSupervisorBadge, 'supervising')
          agent.supervisorStatus = 'busy'
        } else if (event.status === 'reviewing') {
          setBadge(agent.supervisorBadge, 'reviewing')
          setBadge(agent.rowSupervisorBadge, 'reviewing')
          agent.supervisorStatus = 'busy'
        } else if (event.status === 'done') {
          setBadge(agent.supervisorBadge, 'completed')
          setBadge(agent.rowSupervisorBadge, 'completed')
          agent.supervisorStatus = 'completed'
        } else {
          setBadge(agent.supervisorBadge, 'idle')
          setBadge(agent.rowSupervisorBadge, 'idle')
          agent.supervisorStatus = 'idle'
        }
        updateStatusBar()
      }

      if (event.type === 'brain-thinking') {
        const entry = document.createElement('div')
        entry.textContent = event.text
        brainLog.appendChild(entry)
        brainLog.scrollTop = brainLog.scrollHeight
      }

      if (event.type === 'brain-status') {
        brainBadge.textContent = event.status.toUpperCase()
        brainBadge.className = 'brain-status ' + (event.status === 'running' ? 'brain-running' : 'brain-idle')
        if (event.status === 'running') {
          softStopBtn.style.display = ''
          softStopBtn.textContent = 'Soft Stop'
          softStopBtn.disabled = false
          softStopBtn.style.opacity = '1'
        } else {
          softStopBtn.style.display = 'none'
        }
        if (event.status === 'done') notify('Brain finished', 'Objective completed')
      }

      checkEmptyState()
    }

    // Fetch and apply status from backend
    function applyStatusData(data) {
      for (const [name, info] of Object.entries(data)) {
        const agent = ensureAgent(name)
        const dirParts = (info.directory || '').replace(/\\\\\\\\/g, '/').split('/')
        const dirName = dirParts[dirParts.length - 1] || ''
        agent.dirLabel.textContent = info.directory || ''
        agent.link.href = info.url || '#'
        agent.status = info.status
        setBadge(agent.workerBadge, info.status)
        setBadge(agent.rowWorkerBadge, info.status)
      }
      updateStatusBar()
    }

    // Fetch initial status
    fetch('/api/status').then(r => r.json()).then(data => { applyStatusData(data); checkEmptyState() })

    // Poll backend every 10s to keep status in sync
    setInterval(() => {
      fetch('/api/status').then(r => r.json()).then(applyStatusData).catch(() => {})
    }, 10000)

    // Soft stop
    const softStopBtn = document.getElementById('soft-stop-btn')
    async function softStop() {
      try {
        const res = await fetch('/api/soft-stop', { method: 'POST' })
        const data = await res.json()
        if (data.ok) {
          softStopBtn.textContent = 'Stopping...'
          softStopBtn.disabled = true
          softStopBtn.style.opacity = '0.5'
        } else {
          alert(data.message || 'Cannot soft stop right now')
        }
      } catch (err) {
        alert('Error: ' + err)
      }
    }

    // Browser notifications
    let notificationsEnabled = false
    async function enableNotifications() {
      if (!('Notification' in window)) return
      if (Notification.permission === 'granted') {
        notificationsEnabled = true
        return
      }
      if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission()
        notificationsEnabled = perm === 'granted'
      }
    }
    enableNotifications()

    function notify(title, body) {
      if (!notificationsEnabled || document.hasFocus()) return
      try { new Notification(title, { body, icon: '/favicon.ico' }) } catch {}
    }

    // Theme toggle
    function toggleTheme() {
      document.body.classList.toggle('light')
      const isLight = document.body.classList.contains('light')
      document.getElementById('theme-btn').textContent = isLight ? 'Dark' : 'Light'
      localStorage.setItem('orch-theme', isLight ? 'light' : 'dark')
    }
    if (localStorage.getItem('orch-theme') === 'light') {
      document.body.classList.add('light')
      document.getElementById('theme-btn').textContent = 'Dark'
    }

    // Search/filter
    function filterLogs(query) {
      const q = query.toLowerCase()
      document.querySelectorAll('.log-entry, .perm-request, .collapsible, .cycle-summary, .supervisor-entry').forEach(el => {
        el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none'
      })
      brainLog.querySelectorAll('div').forEach(el => {
        el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none'
      })
    }

    // Export logs
    function exportLogs() {
      const lines = []
      lines.push('=== OpenCode Orchestrator Log Export ===')
      lines.push('Exported: ' + new Date().toISOString())
      lines.push('')
      for (const [name, a] of Object.entries(projectRows)) {
        lines.push('--- ' + name + ' (Worker) ---')
        a.workerLog.querySelectorAll('.log-entry, .collapsible, .cycle-summary').forEach(el => {
          lines.push(el.textContent)
        })
        lines.push('')
        lines.push('--- ' + name + ' (Supervisor) ---')
        a.supervisorLog.querySelectorAll('.supervisor-entry, .log-entry, .cycle-summary').forEach(el => {
          lines.push(el.textContent)
        })
        lines.push('')
      }
      lines.push('--- Brain ---')
      brainLog.querySelectorAll('div').forEach(el => {
        lines.push(el.textContent)
      })
      const blob = new Blob([lines.join('\\n')], { type: 'text/plain' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'orchestrator-log-' + new Date().toISOString().slice(0,19).replace(/:/g,'-') + '.txt'
      a.click()
    }

    // Resizable brain panel
    const resizeHandle = document.getElementById('resize-handle')
    const brainSection = document.getElementById('brain-section')
    const brainBody = brainSection.querySelector('.brain-body')
    let isResizing = false
    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true
      e.preventDefault()
    })
    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return
      const viewH = window.innerHeight
      const newH = viewH - e.clientY - 38  // subtract cmd-bar height
      const clamped = Math.max(60, Math.min(viewH - 200, newH))
      brainBody.style.height = clamped + 'px'
      if (!brainSection.classList.contains('open')) brainSection.classList.add('open')
    })
    document.addEventListener('mouseup', () => { isResizing = false })

    // Remove project
    async function removeProject(agentName) {
      if (!confirm('Remove project "' + agentName + '"? This will stop the agent and supervisor.')) return
      try {
        const res = await fetch('/api/projects')
        const projects = await res.json()
        // Match by agentName (sanitized slug), name (display name), or case-insensitive name
        const proj = projects.find(p =>
          p.agentName === agentName ||
          p.name === agentName ||
          (p.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') === agentName
        )
        if (proj) {
          const delRes = await fetch('/api/projects/' + proj.id, { method: 'DELETE' })
          if (!delRes.ok) {
            const err = await delRes.json().catch(() => ({}))
            alert('Failed to remove: ' + (err.error || delRes.status))
            return
          }
        } else {
          alert('Could not find project for agent: ' + agentName)
          return
        }
        // Remove the row from DOM
        const row = document.getElementById('row-' + agentName)
        if (row) row.remove()
        delete projectRows[agentName]
        delete agents[agentName]
        updateStatusBar()
        checkEmptyState()
      } catch (err) {
        alert('Error removing project: ' + err)
      }
    }

    // Permission reply handler
    async function replyPermission(agent, requestID, decision, elemId) {
      try {
        const res = await fetch('/api/permissions/' + agent + '/' + requestID, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        })
        if (!res.ok) {
          const err = await res.json()
          alert('Permission reply failed: ' + (err.error || res.status))
        }
      } catch (err) {
        alert('Network error: ' + err)
      }
    }

    // Send prompt from chatbox
    async function sendPrompt(agentName) {
      const agent = projectRows[agentName]
      if (!agent) return
      const input = agent.chatInput
      const btn = agent.chatBtn
      const text = input.value.trim()
      if (!text) return

      input.disabled = true
      btn.disabled = true
      btn.textContent = '...'

      try {
        const res = await fetch('/api/prompt/' + agentName, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        if (!res.ok) {
          const err = await res.json()
          alert('Failed to send prompt: ' + (err.error || res.status))
        } else {
          input.value = ''
        }
      } catch (err) {
        alert('Network error: ' + err)
      }

      input.disabled = false
      btn.disabled = false
      btn.textContent = 'Send'
      input.focus()
    }

    // --- Project management ---
    const addProjectModal = document.getElementById('add-project-modal')
    const emptyState = document.getElementById('empty-state')
    const browsePanel = document.getElementById('browse-panel')

    function openAddProject() {
      addProjectModal.classList.add('open')
      document.getElementById('proj-dir').focus()
    }
    function closeAddProject() {
      addProjectModal.classList.remove('open')
      browsePanel.classList.remove('open')
    }

    function checkEmptyState() {
      if (Object.keys(projectRows).length > 0 && emptyState) {
        emptyState.style.display = 'none'
      } else if (Object.keys(projectRows).length === 0 && emptyState) {
        emptyState.style.display = ''
      }
    }

    async function submitProject() {
      const dir = document.getElementById('proj-dir').value.trim()
      const name = document.getElementById('proj-name').value.trim()
      const directive = document.getElementById('proj-directive').value.trim()
      if (!dir) { alert('Please enter a project folder path.'); return }

      const btn = document.getElementById('proj-submit')
      btn.disabled = true
      btn.textContent = 'Starting...'

      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ directory: dir, name: name || undefined, directive: directive || undefined }),
        })
        const data = await res.json()
        if (data.ok) {
          closeAddProject()
          document.getElementById('proj-dir').value = ''
          document.getElementById('proj-name').value = ''
          document.getElementById('proj-directive').value = ''
          checkEmptyState()
        } else {
          alert('Failed to add project: ' + (data.error || 'Unknown error'))
        }
      } catch (err) {
        alert('Network error: ' + err)
      }
      btn.disabled = false
      btn.textContent = 'Add Project'
    }

    // Directory browser
    let browseOpen = false
    async function toggleBrowse() {
      browseOpen = !browseOpen
      if (!browseOpen) { browsePanel.classList.remove('open'); return }
      const current = document.getElementById('proj-dir').value.trim() || (navigator.platform.startsWith('Win') ? 'C:\\\\Users' : '/')
      await loadBrowse(current)
    }

    async function loadBrowse(path) {
      try {
        const res = await fetch('/api/browse?path=' + encodeURIComponent(path))
        const data = await res.json()
        browsePanel.innerHTML = ''
        browsePanel.classList.add('open')
        const selBtn = document.createElement('div')
        selBtn.className = 'browse-item'
        selBtn.style.fontWeight = '600'
        selBtn.style.color = '#4ade80'
        selBtn.textContent = 'Select: ' + data.current
        selBtn.onclick = () => {
          document.getElementById('proj-dir').value = data.current
          browsePanel.classList.remove('open')
          browseOpen = false
        }
        browsePanel.appendChild(selBtn)
        for (const dir of data.directories) {
          const item = document.createElement('div')
          item.className = 'browse-item' + (dir.name === '..' ? ' parent' : '')
          item.textContent = dir.name === '..' ? '.. (up)' : dir.name
          item.onclick = () => loadBrowse(dir.path)
          browsePanel.appendChild(item)
        }
      } catch (err) {
        browsePanel.innerHTML = '<div class="browse-item">Error loading directory</div>'
        browsePanel.classList.add('open')
      }
    }

    // Load saved projects on startup (show restore option)
    fetch('/api/saved-projects').then(r => r.json()).then(saved => {
      if (saved && saved.length > 0 && Object.keys(projectRows).length === 0) {
        const entry = document.createElement('div')
        entry.style.color = '#8b8bff'
        entry.innerHTML = 'Previous projects found: ' + saved.map(p => p.name).join(', ') + '. <span style="cursor:pointer;text-decoration:underline" onclick="restoreSavedProjects()">Click to restore</span>'
        brainLog.appendChild(entry)
      }
    }).catch(() => {})

    async function restoreSavedProjects() {
      try {
        const res = await fetch('/api/saved-projects')
        const saved = await res.json()
        for (const proj of saved) {
          try {
            await fetch('/api/projects', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(proj),
            })
          } catch {}
        }
        checkEmptyState()
      } catch (err) {
        alert('Restore failed: ' + err)
      }
    }

    // Enter key in modal inputs submits the form
    document.getElementById('proj-dir').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitProject() }
    })
    document.getElementById('proj-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitProject() }
    })

    // Close modal on Escape or overlay click
    addProjectModal.addEventListener('click', (e) => {
      if (e.target === addProjectModal) closeAddProject()
    })

    // Command bar
    const cmdInput = document.getElementById('cmd-input')
    const cmdStatus = document.getElementById('cmd-status')
    const cmdHelpBtn = document.getElementById('cmd-help-btn')
    const cmdPalette = document.getElementById('cmd-palette')
    const cmdHistory = []
    let cmdHistoryIdx = -1

    cmdHelpBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      cmdPalette.classList.toggle('open')
      cmdHelpBtn.classList.toggle('active')
    })

    document.addEventListener('click', (e) => {
      if (!cmdPalette.contains(e.target) && e.target !== cmdHelpBtn) {
        cmdPalette.classList.remove('open')
        cmdHelpBtn.classList.remove('active')
      }
    })

    function cmdFill(text) {
      cmdInput.value = text
      cmdInput.focus()
      cmdPalette.classList.remove('open')
      cmdHelpBtn.classList.remove('active')
    }

    cmdInput.addEventListener('keydown', async (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (cmdHistory.length === 0) return
        if (cmdHistoryIdx < cmdHistory.length - 1) cmdHistoryIdx++
        cmdInput.value = cmdHistory[cmdHistory.length - 1 - cmdHistoryIdx]
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (cmdHistoryIdx > 0) {
          cmdHistoryIdx--
          cmdInput.value = cmdHistory[cmdHistory.length - 1 - cmdHistoryIdx]
        } else {
          cmdHistoryIdx = -1
          cmdInput.value = ''
        }
      } else if (e.key === 'Enter') {
        const cmd = cmdInput.value.trim()
        if (!cmd) return
        cmdHistory.push(cmd)
        cmdHistoryIdx = -1
        cmdInput.value = ''
        cmdInput.disabled = true
        cmdStatus.textContent = 'running...'
        cmdStatus.style.color = '#facc15'

        try {
          const res = await fetch('/api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd }),
          })
          const data = await res.json()
          if (data.ok) {
            cmdStatus.textContent = data.output ? 'done' : 'sent'
            cmdStatus.style.color = '#4ade80'
            if (data.output) {
              const entry = document.createElement('div')
              entry.style.color = '#8b8bff'
              entry.textContent = '> ' + cmd + '\\n' + data.output
              entry.style.whiteSpace = 'pre-wrap'
              brainLog.appendChild(entry)
              brainLog.scrollTop = brainLog.scrollHeight
            }
          } else {
            cmdStatus.textContent = data.error || 'error'
            cmdStatus.style.color = '#ef4444'
          }
        } catch (err) {
          cmdStatus.textContent = 'network error'
          cmdStatus.style.color = '#ef4444'
        }

        cmdInput.disabled = false
        cmdInput.focus()
        setTimeout(() => { cmdStatus.textContent = '' }, 4000)
      } else if (e.key === '?' && cmdInput.value === '') {
        e.preventDefault()
        cmdPalette.classList.toggle('open')
        cmdHelpBtn.classList.toggle('active')
      }
    })

    // Global keyboard shortcut: / to focus command bar
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault()
        cmdInput.focus()
      }
      if (e.key === 'Escape') {
        cmdPalette.classList.remove('open')
        cmdHelpBtn.classList.remove('active')
        cmdInput.blur()
      }
    })

    // Long-polling event loop
    async function pollEvents() {
      while (true) {
        try {
          const res = await fetch('/api/events?since=' + cursor)
          if (!res.ok) {
            await new Promise(r => setTimeout(r, 2000))
            continue
          }
          const data = await res.json()
          cursor = data.cursor
          for (const event of data.events) {
            handleEvent(event)
          }
        } catch (err) {
          console.log('Poll error, retrying...', err)
          await new Promise(r => setTimeout(r, 2000))
        }
      }
    }
    pollEvents()
  </script>
</body>
</html>
`
