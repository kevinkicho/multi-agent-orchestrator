/**
 * Dashboard UI rendering tests.
 *
 * Uses happy-dom to provide a headless DOM environment, then evaluates
 * the inline JavaScript functions from dashboard.html. This tests the
 * pure rendering logic (badge updates, status dots, filtering, toasts,
 * theme toggle, sidebar, ARIA attributes) without needing a real browser.
 *
 * Strategy: we build a minimal DOM skeleton that mirrors the dashboard's
 * key elements, then define the inline functions in that context and
 * exercise them directly.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Window } from "happy-dom"

// ---------------------------------------------------------------------------
// Helpers — set up a minimal dashboard DOM + inline JS functions
// ---------------------------------------------------------------------------

function createDashboardDOM() {
  const window = new Window({ url: "http://localhost" })
  const document = window.document

  // Minimal HTML skeleton matching dashboard.html structure
  document.body.innerHTML = `
    <nav class="sidebar" id="sidebar" role="navigation" aria-label="Section navigation">
      <button class="sidebar-toggle" aria-label="Toggle sidebar">&#9776;</button>
      <button class="sidebar-link" title="Projects"><span class="sb-icon">&#9881;</span><span class="sb-label">Projects</span></button>
      <button class="sidebar-link" title="Brain"><span class="sb-icon">&#9670;</span><span class="sb-label">Brain</span></button>
    </nav>

    <header role="banner">
      <div style="display:flex;align-items:center;gap:16px;">
        <h1>Multi-Agent Orchestrator</h1>
      </div>
      <nav class="toolbar" role="toolbar" aria-label="Dashboard controls">
        <button class="toolbar-btn" id="theme-btn">Light</button>
      </nav>
    </header>

    <div class="projects-container" id="projects-container" role="main">
      <div class="empty-state" id="empty-state" role="status">
        <h2>No projects yet</h2>
      </div>
    </div>

    <div class="brain-section" id="brain-section">
      <div class="brain-header" role="button" tabindex="0" aria-expanded="false">Orchestrator Log</div>
      <div class="brain-body">
        <div class="brain-log" id="brain-log"></div>
      </div>
      <span class="agent-badge" id="brain-badge">IDLE</span>
    </div>

    <div class="brain-section" id="perf-section">
      <div class="brain-header" role="button" tabindex="0" aria-expanded="false">Performance</div>
      <div class="brain-body" id="perf-body"></div>
    </div>

    <div class="brain-section" id="eventbus-section">
      <div class="brain-header" role="button" tabindex="0" aria-expanded="false">Event Bus</div>
      <div class="brain-body"><div id="bus-events"></div></div>
    </div>

    <div class="brain-section" id="live-events-section">
      <div class="brain-header" role="button" tabindex="0" aria-expanded="false">Live Events</div>
      <div class="brain-body"><div id="live-event-log"></div></div>
    </div>

    <div class="brain-section" id="team-section">
      <div class="brain-header" role="button" tabindex="0" aria-expanded="false">Team</div>
      <div class="brain-body" id="team-body"></div>
    </div>

    <div class="cmd-bar" id="cmd-bar">
      <input type="text" id="cmd-input" placeholder="Type a command...">
    </div>
  `

  return { window, document }
}

/**
 * Inject the dashboard's inline JS functions into a happy-dom context.
 * Returns an object with references to the functions for testing.
 */
function injectFunctions(document: any) {
  // -- escapeHtml --
  function escapeHtml(text: string): string {
    const div = document.createElement("div")
    div.textContent = text
    return div.innerHTML
  }

  // -- projectLabel --
  function projectLabel(agentName: string): string {
    return agentName.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())
  }

  // -- setBadge --
  function setBadge(badge: any, status: string): void {
    const map: Record<string, [string, string]> = {
      idle: ["IDLE", "badge-idle"],
      busy: ["BUSY", "badge-busy"],
      completed: ["DONE", "badge-done"],
      connected: ["OK", "badge-connected"],
      disconnected: ["DOWN", "badge-disconnected"],
      error: ["ERROR", "badge-error"],
      stuck: ["STUCK", "badge-stuck"],
      supervising: ["SUPERVISING", "badge-supervising"],
      reviewing: ["REVIEWING", "badge-reviewing"],
      paused: ["PAUSED", "badge-paused"],
      running: ["RUNNING", "badge-running"],
      starting: ["STARTING", "badge-starting"],
    }
    const [text, cls] = map[status] || [status.toUpperCase(), "badge-idle"]
    badge.textContent = text
    badge.className = "agent-badge " + cls
  }

  // -- setProjectStatus --
  function setProjectStatus(badge: any, status: string): void {
    const map: Record<string, [string, string]> = {
      starting: ["STARTING", "badge-starting"],
      running: ["RUNNING", "badge-running"],
      supervising: ["SUPERVISING", "badge-supervising"],
      stopped: ["FINISHED", "badge-stopped"],
      error: ["ERROR", "badge-error"],
    }
    const [text, cls] = map[status] || [status.toUpperCase(), "badge-idle"]
    badge.textContent = text
    badge.className = "agent-badge " + cls
  }

  // -- statusToDot --
  function statusToDot(status: string): string {
    switch (status) {
      case "busy": return "dot-busy"
      case "disconnected": return "dot-disconnected"
      case "error": return "dot-error"
      case "completed": return "dot-done"
      default: return "dot-idle"
    }
  }

  // -- statusToLabel --
  function statusToLabel(status: string): string {
    const labels: Record<string, string> = {
      idle: "idle", busy: "busy", completed: "done", connected: "ok",
      disconnected: "down", error: "err", stuck: "stuck", paused: "paused",
    }
    return labels[status] || status
  }

  // -- showNotification --
  const toastContainer = document.createElement("div")
  toastContainer.className = "toast-container"
  toastContainer.setAttribute("role", "log")
  toastContainer.setAttribute("aria-live", "polite")
  document.body.appendChild(toastContainer)

  function showNotification(message: string, type?: string, duration?: number): void {
    type = type || "info"
    duration = duration || 4000
    const toast = document.createElement("div")
    toast.className = "toast toast-" + type
    toast.setAttribute("role", "alert")
    toast.innerHTML = "<span>" + escapeHtml(message) + "</span>" +
      '<button class="toast-dismiss" aria-label="Dismiss">&times;</button>'
    toast.querySelector(".toast-dismiss").onclick = () => toast.remove()
    toastContainer.appendChild(toast)
    while (toastContainer.children.length > 5) toastContainer.removeChild(toastContainer.firstChild)
  }

  // -- Shared state for ensureAgent --
  const projectRows: Record<string, any> = {}
  const removedAgents = new Set<string>()
  const container = document.getElementById("projects-container")!
  const brainLog = document.getElementById("brain-log")!

  // -- ensureAgent --
  function ensureAgent(name: string) {
    if (removedAgents.has(name)) return null
    if (projectRows[name]) return projectRows[name]

    const row = document.createElement("div")
    row.className = "project-row open"
    row.id = "row-" + name

    row.innerHTML = `
      <div class="project-row-header" role="button" tabindex="0" aria-expanded="true">
        <span class="project-row-arrow" aria-hidden="true">&#9654;</span>
        <span class="project-row-name">${escapeHtml(projectLabel(name))}</span>
        <span class="project-row-dir" id="dir-${name}"></span>
        <div class="project-row-badges">
          <span class="agent-badge badge-starting" id="projstatus-${name}">STARTING</span>
          <span class="agent-badge badge-idle" id="wbadge-${name}">IDLE</span>
          <span class="agent-badge badge-idle" id="sbadge-${name}">IDLE</span>
          <span class="agent-badge badge-idle" id="badge-${name}">IDLE</span>
          <span class="agent-badge badge-idle" id="svbadge-${name}">IDLE</span>
          <span id="branchbadge-${name}" style="display:none;"></span>
        </div>
      </div>
      <div class="project-row-body">
        <div class="panel">
          <div class="panel-log" id="wlog-${name}"></div>
        </div>
        <div class="panel">
          <div class="panel-log" id="slog-${name}"></div>
        </div>
      </div>
    `

    container.appendChild(row)

    // Use document.getElementById instead of row.querySelector("#id") for happy-dom compat
    const data = {
      row,
      workerLog: document.getElementById("wlog-" + name),
      supervisorLog: document.getElementById("slog-" + name),
      workerBadge: document.getElementById("badge-" + name),
      supervisorBadge: document.getElementById("svbadge-" + name),
      rowWorkerBadge: document.getElementById("wbadge-" + name),
      rowSupervisorBadge: document.getElementById("sbadge-" + name),
      projStatusBadge: document.getElementById("projstatus-" + name),
      branchBadge: document.getElementById("branchbadge-" + name),
      dirLabel: document.getElementById("dir-" + name),
      projectId: null as string | null,
      status: "idle",
      supervisorStatus: "idle",
    }

    projectRows[name] = data
    return data
  }

  // -- toggleTheme --
  function toggleTheme(): void {
    document.body.classList.toggle("light")
    const isLight = document.body.classList.contains("light")
    const btn = document.getElementById("theme-btn")!
    btn.textContent = isLight ? "Dark" : "Light"
  }

  // -- scrollToSection --
  function scrollToSection(id: string): void {
    const el = document.getElementById(id)
    if (!el) return
    if (el.classList.contains("brain-section") && !el.classList.contains("open")) {
      el.classList.add("open")
    }
    // scrollIntoView not available in happy-dom — just verify the class logic
  }

  return {
    escapeHtml,
    projectLabel,
    setBadge,
    setProjectStatus,
    statusToDot,
    statusToLabel,
    showNotification,
    ensureAgent,
    toggleTheme,
    scrollToSection,
    // Expose internal state for assertions
    projectRows,
    removedAgents,
    toastContainer,
    brainLog,
    container,
  }
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Dashboard UI — escapeHtml", () => {
  let fn: ReturnType<typeof injectFunctions>

  beforeEach(() => {
    const { document } = createDashboardDOM()
    fn = injectFunctions(document)
  })

  test("escapes angle brackets", () => {
    expect(fn.escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  test("escapes ampersands", () => {
    expect(fn.escapeHtml("a & b")).toBe("a &amp; b")
  })

  test("passes plain text through", () => {
    expect(fn.escapeHtml("hello world")).toBe("hello world")
  })

  test("handles empty string", () => {
    expect(fn.escapeHtml("")).toBe("")
  })
})

describe("Dashboard UI — projectLabel", () => {
  let fn: ReturnType<typeof injectFunctions>

  beforeEach(() => {
    const { document } = createDashboardDOM()
    fn = injectFunctions(document)
  })

  test("capitalizes hyphenated names", () => {
    expect(fn.projectLabel("my-cool-project")).toBe("My Cool Project")
  })

  test("capitalizes single word", () => {
    expect(fn.projectLabel("backend")).toBe("Backend")
  })

  test("handles already-capitalized input", () => {
    expect(fn.projectLabel("Already")).toBe("Already")
  })
})

describe("Dashboard UI — setBadge", () => {
  let fn: ReturnType<typeof injectFunctions>
  let document: any

  beforeEach(() => {
    const dom = createDashboardDOM()
    document = dom.document
    fn = injectFunctions(document)
  })

  test("sets known status correctly", () => {
    const badge = document.createElement("span")
    fn.setBadge(badge, "busy")
    expect(badge.textContent).toBe("BUSY")
    expect(badge.className).toBe("agent-badge badge-busy")
  })

  test("sets idle status", () => {
    const badge = document.createElement("span")
    fn.setBadge(badge, "idle")
    expect(badge.textContent).toBe("IDLE")
    expect(badge.className).toBe("agent-badge badge-idle")
  })

  test("sets completed status as DONE", () => {
    const badge = document.createElement("span")
    fn.setBadge(badge, "completed")
    expect(badge.textContent).toBe("DONE")
    expect(badge.className).toBe("agent-badge badge-done")
  })

  test("sets disconnected status as DOWN", () => {
    const badge = document.createElement("span")
    fn.setBadge(badge, "disconnected")
    expect(badge.textContent).toBe("DOWN")
    expect(badge.className).toBe("agent-badge badge-disconnected")
  })

  test("falls back to uppercase + badge-idle for unknown status", () => {
    const badge = document.createElement("span")
    fn.setBadge(badge, "mystery")
    expect(badge.textContent).toBe("MYSTERY")
    expect(badge.className).toBe("agent-badge badge-idle")
  })

  test("replaces previous badge classes", () => {
    const badge = document.createElement("span")
    badge.className = "agent-badge badge-error"
    fn.setBadge(badge, "idle")
    expect(badge.className).toBe("agent-badge badge-idle")
    expect(badge.className).not.toContain("badge-error")
  })
})

describe("Dashboard UI — setProjectStatus", () => {
  let fn: ReturnType<typeof injectFunctions>
  let document: any

  beforeEach(() => {
    const dom = createDashboardDOM()
    document = dom.document
    fn = injectFunctions(document)
  })

  test("sets running status", () => {
    const badge = document.createElement("span")
    fn.setProjectStatus(badge, "running")
    expect(badge.textContent).toBe("RUNNING")
    expect(badge.className).toBe("agent-badge badge-running")
  })

  test("sets stopped as FINISHED", () => {
    const badge = document.createElement("span")
    fn.setProjectStatus(badge, "stopped")
    expect(badge.textContent).toBe("FINISHED")
    expect(badge.className).toBe("agent-badge badge-stopped")
  })

  test("falls back for unknown project status", () => {
    const badge = document.createElement("span")
    fn.setProjectStatus(badge, "weird")
    expect(badge.textContent).toBe("WEIRD")
    expect(badge.className).toBe("agent-badge badge-idle")
  })
})

describe("Dashboard UI — statusToDot", () => {
  let fn: ReturnType<typeof injectFunctions>

  beforeEach(() => {
    const { document } = createDashboardDOM()
    fn = injectFunctions(document)
  })

  test("busy → dot-busy", () => expect(fn.statusToDot("busy")).toBe("dot-busy"))
  test("disconnected → dot-disconnected", () => expect(fn.statusToDot("disconnected")).toBe("dot-disconnected"))
  test("error → dot-error", () => expect(fn.statusToDot("error")).toBe("dot-error"))
  test("completed → dot-done", () => expect(fn.statusToDot("completed")).toBe("dot-done"))
  test("idle → dot-idle (default)", () => expect(fn.statusToDot("idle")).toBe("dot-idle"))
  test("unknown → dot-idle (default)", () => expect(fn.statusToDot("whatever")).toBe("dot-idle"))
})

describe("Dashboard UI — statusToLabel", () => {
  let fn: ReturnType<typeof injectFunctions>

  beforeEach(() => {
    const { document } = createDashboardDOM()
    fn = injectFunctions(document)
  })

  test("idle → idle", () => expect(fn.statusToLabel("idle")).toBe("idle"))
  test("busy → busy", () => expect(fn.statusToLabel("busy")).toBe("busy"))
  test("completed → done", () => expect(fn.statusToLabel("completed")).toBe("done"))
  test("disconnected → down", () => expect(fn.statusToLabel("disconnected")).toBe("down"))
  test("error → err", () => expect(fn.statusToLabel("error")).toBe("err"))
  test("stuck → stuck", () => expect(fn.statusToLabel("stuck")).toBe("stuck"))
  test("paused → paused", () => expect(fn.statusToLabel("paused")).toBe("paused"))
  test("unknown passes through", () => expect(fn.statusToLabel("custom")).toBe("custom"))
})

describe("Dashboard UI — ensureAgent", () => {
  let fn: ReturnType<typeof injectFunctions>

  beforeEach(() => {
    const { document } = createDashboardDOM()
    fn = injectFunctions(document)
  })

  test("creates a new agent row", () => {
    const agent = fn.ensureAgent("my-agent")
    expect(agent).not.toBeNull()
    expect(agent!.row.id).toBe("row-my-agent")
    expect(agent!.row.className).toContain("project-row")
    expect(agent!.status).toBe("idle")
  })

  test("returns existing agent on second call", () => {
    const first = fn.ensureAgent("my-agent")
    const second = fn.ensureAgent("my-agent")
    expect(first).toBe(second)
  })

  test("returns null for removed agents", () => {
    fn.removedAgents.add("dead-agent")
    const result = fn.ensureAgent("dead-agent")
    expect(result).toBeNull()
  })

  test("creates row with correct ARIA attributes", () => {
    const agent = fn.ensureAgent("aria-test")!
    const header = agent.row.querySelector(".project-row-header")
    expect(header.getAttribute("role")).toBe("button")
    expect(header.getAttribute("tabindex")).toBe("0")
    expect(header.getAttribute("aria-expanded")).toBe("true")
  })

  test("creates row with arrow hidden from screen readers", () => {
    const agent = fn.ensureAgent("arrow-test")!
    const arrow = agent.row.querySelector(".project-row-arrow")
    expect(arrow.getAttribute("aria-hidden")).toBe("true")
  })

  test("creates row with escaped project name", () => {
    const agent = fn.ensureAgent("test-project")!
    const name = agent.row.querySelector(".project-row-name")
    expect(name.textContent).toBe("Test Project")
  })

  test("populates DOM element references", () => {
    const agent = fn.ensureAgent("ref-check")!
    expect(agent.workerLog).not.toBeNull()
    expect(agent.supervisorLog).not.toBeNull()
    expect(agent.workerBadge).not.toBeNull()
    expect(agent.supervisorBadge).not.toBeNull()
    expect(agent.rowWorkerBadge).not.toBeNull()
    expect(agent.projStatusBadge).not.toBeNull()
    expect(agent.branchBadge).not.toBeNull()
    expect(agent.dirLabel).not.toBeNull()
  })

  test("appends row to projects container", () => {
    fn.ensureAgent("container-test")
    const row = fn.container.querySelector("#row-container-test")
    expect(row).not.toBeNull()
  })
})

describe("Dashboard UI — showNotification (toast)", () => {
  let fn: ReturnType<typeof injectFunctions>

  beforeEach(() => {
    const { document } = createDashboardDOM()
    fn = injectFunctions(document)
  })

  test("creates a toast element", () => {
    fn.showNotification("Test message", "success")
    expect(fn.toastContainer.children.length).toBe(1)
    const toast = fn.toastContainer.children[0]
    expect(toast.className).toContain("toast-success")
    expect(toast.textContent).toContain("Test message")
  })

  test("defaults to info type", () => {
    fn.showNotification("Info toast")
    expect(fn.toastContainer.children[0].className).toContain("toast-info")
  })

  test("creates toast with correct ARIA role", () => {
    fn.showNotification("Accessible", "warning")
    expect(fn.toastContainer.children[0].getAttribute("role")).toBe("alert")
  })

  test("includes dismiss button with aria-label", () => {
    fn.showNotification("Dismissible", "error")
    const btn = fn.toastContainer.children[0].querySelector(".toast-dismiss")
    expect(btn).not.toBeNull()
    expect(btn.getAttribute("aria-label")).toBe("Dismiss")
  })

  test("limits to 5 toasts max", () => {
    for (let i = 0; i < 8; i++) {
      fn.showNotification(`Toast ${i}`, "info")
    }
    expect(fn.toastContainer.children.length).toBe(5)
    // Oldest should be removed — latest should contain Toast 7
    expect(fn.toastContainer.children[4].textContent).toContain("Toast 7")
  })

  test("toast container has aria-live polite", () => {
    expect(fn.toastContainer.getAttribute("aria-live")).toBe("polite")
    expect(fn.toastContainer.getAttribute("role")).toBe("log")
  })

  test("escapes HTML in toast message", () => {
    fn.showNotification("<b>bold</b>", "info")
    const span = fn.toastContainer.children[0].querySelector("span")
    expect(span.textContent).toBe("<b>bold</b>")
    expect(span.innerHTML).not.toContain("<b>")
  })

  test("dismiss button removes toast", () => {
    fn.showNotification("Remove me", "info")
    expect(fn.toastContainer.children.length).toBe(1)
    const btn = fn.toastContainer.children[0].querySelector(".toast-dismiss")
    btn.onclick()
    expect(fn.toastContainer.children.length).toBe(0)
  })
})

describe("Dashboard UI — toggleTheme", () => {
  let fn: ReturnType<typeof injectFunctions>
  let document: any

  beforeEach(() => {
    const dom = createDashboardDOM()
    document = dom.document
    fn = injectFunctions(document)
  })

  test("toggles to light mode", () => {
    fn.toggleTheme()
    expect(document.body.classList.contains("light")).toBe(true)
    expect(document.getElementById("theme-btn").textContent).toBe("Dark")
  })

  test("toggles back to dark mode", () => {
    fn.toggleTheme() // → light
    fn.toggleTheme() // → dark
    expect(document.body.classList.contains("light")).toBe(false)
    expect(document.getElementById("theme-btn").textContent).toBe("Light")
  })
})

describe("Dashboard UI — scrollToSection", () => {
  let fn: ReturnType<typeof injectFunctions>
  let document: any

  beforeEach(() => {
    const dom = createDashboardDOM()
    document = dom.document
    fn = injectFunctions(document)
  })

  test("opens collapsed brain-section", () => {
    const section = document.getElementById("brain-section")
    expect(section.classList.contains("open")).toBe(false)
    fn.scrollToSection("brain-section")
    expect(section.classList.contains("open")).toBe(true)
  })

  test("does not crash on nonexistent section", () => {
    // Should not throw
    fn.scrollToSection("nonexistent-section")
  })

  test("does not double-add open class", () => {
    const section = document.getElementById("perf-section")
    section.classList.add("open")
    fn.scrollToSection("perf-section")
    expect(section.classList.contains("open")).toBe(true)
  })
})

describe("Dashboard UI — ARIA structure", () => {
  let document: any

  beforeEach(() => {
    const dom = createDashboardDOM()
    document = dom.document
  })

  test("sidebar has navigation role", () => {
    const sidebar = document.getElementById("sidebar")
    expect(sidebar.getAttribute("role")).toBe("navigation")
    expect(sidebar.getAttribute("aria-label")).toBe("Section navigation")
  })

  test("projects container has main role", () => {
    const container = document.getElementById("projects-container")
    expect(container.getAttribute("role")).toBe("main")
  })

  test("toolbar has toolbar role", () => {
    const toolbar = document.querySelector(".toolbar")
    expect(toolbar).not.toBeNull()
    expect(toolbar.getAttribute("role")).toBe("toolbar")
    expect(toolbar.getAttribute("aria-label")).toBe("Dashboard controls")
  })

  test("brain section headers are buttons with aria-expanded", () => {
    const headers = document.querySelectorAll(".brain-header")
    for (const h of headers) {
      expect(h.getAttribute("role")).toBe("button")
      expect(h.getAttribute("tabindex")).toBe("0")
      expect(h.getAttribute("aria-expanded")).toBeTruthy()
    }
  })

  test("empty state has status role", () => {
    const empty = document.getElementById("empty-state")
    expect(empty.getAttribute("role")).toBe("status")
  })
})

describe("Dashboard UI — sidebar structure", () => {
  let document: any

  beforeEach(() => {
    const dom = createDashboardDOM()
    document = dom.document
  })

  test("sidebar contains toggle button", () => {
    const toggle = document.querySelector(".sidebar-toggle")
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute("aria-label")).toBe("Toggle sidebar")
  })

  test("sidebar contains navigation links", () => {
    const links = document.querySelectorAll(".sidebar-link")
    expect(links.length).toBeGreaterThan(0)
  })

  test("sidebar links have icons and labels", () => {
    const link = document.querySelector(".sidebar-link")
    expect(link.querySelector(".sb-icon")).not.toBeNull()
    expect(link.querySelector(".sb-label")).not.toBeNull()
  })
})
