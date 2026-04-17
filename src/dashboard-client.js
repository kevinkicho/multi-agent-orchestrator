// API token injected by the server for authenticating mutating requests
const API_TOKEN = window.__API_TOKEN__ || ''

// Global error boundary — catch unhandled errors and promise rejections
// so the poll loop and SSE can recover instead of silently dying
window.onerror = function(message, source, lineno, colno, error) {
  console.error('[orchestrator-dashboard] Uncaught error:', message, source, lineno, colno, error)
  showNotification('Unexpected error: ' + (typeof message === 'string' ? message.slice(0, 200) : 'Unknown error'), 'error')
  return false // allow default handling too
}
window.addEventListener('unhandledrejection', function(event) {
  console.error('[orchestrator-dashboard] Unhandled promise rejection:', event.reason)
  showNotification('Unexpected error: ' + (event.reason instanceof Error ? event.reason.message : String(event.reason).slice(0, 200)), 'error')
  // Don't preventDefault — let the rejection still be logged to console
})

// Wrapper around fetch that automatically adds the API token header on mutating requests
function apiFetch(url, opts) {
  opts = opts || {}
  const method = (opts.method || 'GET').toUpperCase()
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    opts.headers = Object.assign({ 'X-API-Token': API_TOKEN }, opts.headers || {})
  }
  return fetch(url, opts)
}

// Sidebar navigation
function scrollToSection(id) {
  var el = document.getElementById(id)
  if (!el) return
  // If target is inside the admin drawer, open the drawer first
  var drawer = document.getElementById('admin-drawer')
  if (drawer && drawer.contains(el)) {
    openAdminDrawer()
    // Open the section if collapsed
    if (el.classList.contains('brain-section') && !el.classList.contains('open')) {
      el.classList.add('open')
    }
    setTimeout(function() { el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 280)
    return
  }
  // For projects-container or other main content
  if (el.classList.contains('brain-section') && !el.classList.contains('open')) {
    el.classList.add('open')
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function openAdminDrawer() {
  document.getElementById('admin-drawer').classList.add('open')
  document.getElementById('admin-drawer-overlay').classList.add('open')
}

function closeAdminDrawer() {
  document.getElementById('admin-drawer').classList.remove('open')
  document.getElementById('admin-drawer-overlay').classList.remove('open')
}

// Escape key closes drawer
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    var drawer = document.getElementById('admin-drawer')
    if (drawer && drawer.classList.contains('open')) {
      closeAdminDrawer()
      e.stopPropagation()
    }
  }
})

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
  return agentName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// Toggle project row open/closed and scroll logs to bottom if needed
function toggleProjectRow(rowEl) {
  rowEl.classList.toggle('open')
  if (rowEl.classList.contains('open')) {
    // Scroll any logs that received content while collapsed
    requestAnimationFrame(function() {
      rowEl.querySelectorAll('.panel-log').forEach(function(log) {
        if (log._needsScrollOnReveal) {
          log.scrollTop = log.scrollHeight
          log._needsScrollOnReveal = false
        }
      })
    })
  }
}

// Track recently removed agents so polling/events don't re-create their rows
const removedAgents = new Set()

function ensureAgent(name) {
  if (removedAgents.has(name)) return null
  if (projectRows[name]) return projectRows[name]

  const row = document.createElement('div')
  row.className = 'project-row open'
  row.id = 'row-' + name

  row.innerHTML = `
    <div class="project-row-header" onclick="toggleProjectRow(this.parentElement)" role="button" tabindex="0" aria-expanded="true" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}">
      <span class="project-row-arrow" aria-hidden="true">&#9654;</span>
      <span class="project-row-name">${escapeHtml(projectLabel(name))}</span>
      <span class="project-row-dir" id="dir-${name}"></span>
      <span class="project-row-port" id="port-${name}" style="font-size:9px;color:#666;margin-left:4px;font-family:monospace;"></span>
      <div class="project-row-badges">
        <span class="agent-badge badge-starting" id="projstatus-${name}" style="margin-right:8px;">STARTING</span>
        <span style="font-size:10px;color:#666;">Worker:</span>
        <span class="agent-badge badge-idle" id="wbadge-${name}">IDLE</span>
        <span style="font-size:10px;color:#666;margin-left:4px;">Supervisor:</span>
        <span class="agent-badge badge-idle" id="sbadge-${name}">IDLE</span>
        <span class="agent-badge" id="pausebadge-${name}" style="display:none;margin-right:4px;"></span>
        <button class="project-row-remove" id="pausebtn-${name}" onclick="event.stopPropagation();togglePause('${name}')" title="Pause supervisor after current cycle completes (click again to resume)" style="color:#f59e0b;border-color:#f59e0b;">Pause</button>
        <span class="agent-badge" id="branchbadge-${name}" style="display:none;background:#1e293b;color:#10b981;font-size:9px;margin-right:4px;"></span>
        <button class="project-row-remove" onclick="event.stopPropagation();mergeBranch(projectRows['${name}']?.projectId)" title="Merge the agent's isolated git branch back into the main branch" style="color:#10b981;border-color:#10b981;">Merge</button>
        <button class="project-row-remove" onclick="event.stopPropagation();setValidation(projectRows['${name}']?.projectId)" title="Set a shell command to run after each cycle (e.g. test suite) — fails trigger re-work" style="color:#22d3ee;border-color:#22d3ee;">Validate</button>
        <button class="project-row-remove" onclick="event.stopPropagation();openABTestModal('${name}')" title="Run two models side-by-side on the same task and compare results" style="color:#c084fc;border-color:#c084fc;">A/B</button>
        <button class="project-row-remove" onclick="event.stopPropagation();removeProject('${name}')" title="Stop supervisor, kill agent process, and remove this project">Remove</button>
      </div>
    </div>
    <div class="directive-section" onclick="event.stopPropagation()">
      <div class="directive-toggle" onclick="this.nextElementSibling.classList.toggle('open')">&#9660; Settings</div>
      <div class="directive-content" id="dcontent-${name}">
        <div class="drawer-tabs">
          <button class="drawer-tab active" onclick="switchDrawerTab('${name}','settings',this)">Settings</button>
          <button class="drawer-tab" onclick="switchDrawerTab('${name}','history',this)">History</button>
          <button class="drawer-tab" onclick="switchDrawerTab('${name}','memory',this)">Memory</button>
        </div>
        <div class="drawer-panel active" id="dtab-settings-${name}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:10px;color:#888;min-width:40px;">Model:</span>
            <select class="directive-text" id="msel-${name}" style="min-height:auto;height:26px;padding:2px 6px;flex:1;max-width:300px;">
              <option value="">(global default)</option>
            </select>
            <button class="directive-save" onclick="saveModel('${name}')" style="white-space:nowrap;">Change Model</button>
          </div>
          <div style="margin-bottom:4px;font-size:10px;color:#888;">Directive:</div>
          <textarea class="directive-text" id="dtxt-${name}" rows="3"></textarea>
          <div class="directive-actions">
            <button class="directive-save" onclick="saveDirective('${name}')">Save Directive &amp; Restart Supervisor</button>
          </div>
          <div style="margin-top:8px;display:flex;gap:6px;align-items:center;">
            <input type="text" class="directive-text" id="dcmt-${name}" placeholder="Leave feedback for supervisor..." style="min-height:auto;height:26px;padding:2px 8px;flex:1;">
            <button class="directive-save" onclick="sendComment('${name}')" style="white-space:nowrap;">Send Comment</button>
          </div>
        </div>
        <div class="drawer-panel" id="dtab-history-${name}">
          <div id="dhist-${name}" style="max-height:280px;overflow-y:auto;"></div>
        </div>
        <div class="drawer-panel" id="dtab-memory-${name}">
          <div id="dmem-${name}" style="max-height:280px;overflow-y:auto;"><em style="color:#555;">Click to load memory...</em></div>
        </div>
      </div>
    </div>
    <div class="project-row-body">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <span class="worker-icon">&#9881;</span>
            <span class="label">Worker</span>
            <span class="name">${escapeHtml(name)}</span>
          </div>
          <span class="agent-badge badge-idle" id="badge-${name}">IDLE</span>
        </div>
        <div class="panel-log" id="wlog-${name}"></div>
        <div class="agent-chatbox">
          <input type="text" id="chat-${name}" placeholder="Send prompt to ${name}..." onkeydown="if(event.key==='Enter')sendPrompt('${name}')">
          <button onclick="sendPrompt('${name}')">Send</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <span class="supervisor-icon">&#9670;</span>
            <span class="label">Supervisor</span>
          </div>
        </div>
        <div class="panel-log" id="slog-${name}"></div>
      </div>
    </div>
  `

  container.appendChild(row)

  const data = {
    row,
    workerLog: row.querySelector('#wlog-' + name),
    supervisorLog: row.querySelector('#slog-' + name),
    workerBadge: row.querySelector('#badge-' + name),
    supervisorBadge: row.querySelector('#sbadge-' + name),
    rowWorkerBadge: row.querySelector('#wbadge-' + name),
    rowSupervisorBadge: row.querySelector('#sbadge-' + name),
    projStatusBadge: row.querySelector('#projstatus-' + name),
    branchBadge: row.querySelector('#branchbadge-' + name),
    directiveText: row.querySelector('#dtxt-' + name),
    modelSelect: row.querySelector('#msel-' + name),
    dirLabel: row.querySelector('#dir-' + name),
    portLabel: row.querySelector('#port-' + name),
    link: row.querySelector('#link-' + name),
    chatInput: row.querySelector('#chat-' + name),
    chatBtn: row.querySelector('.agent-chatbox button'),
    projectId: null,
    // Aliases for backward compat with handleEvent/sendPrompt
    get log() { return this.workerLog },
    get badge() { return this.workerBadge },
    project: row.querySelector('#dir-' + name),
    status: 'idle',
    supervisorStatus: 'idle',
  }

  // Track when user starts editing the directive textarea
  if (data.directiveText) {
    data.directiveText.addEventListener('input', function() { this._userEdited = true })
    data.directiveText.addEventListener('blur', function() {
      // Clear edit flag after a short delay so polling can update if user moved away
      setTimeout(() => { this._userEdited = false }, 5000)
    })
  }

  projectRows[name] = data
  agents[name] = data
  return data
}

// -----------------------------------------------------------------------
// Virtual-scroll log manager
// -----------------------------------------------------------------------
// Each log panel keeps ALL entries in a lightweight backing array but
// only renders the most recent MAX_RENDERED items as DOM nodes.
// When the user scrolls to the top, a batch of older entries is
// materialized on demand. This keeps DOM size bounded no matter how
// long the orchestrator runs.
// -----------------------------------------------------------------------

const MAX_RENDERED = 200      // max DOM nodes per log panel
const RENDER_BATCH = 60       // how many older entries to render on scroll-up
const MAX_BACKING = 5000      // max entries kept in memory (older are discarded)
const logStores = new WeakMap() // logEl -> { entries: [], renderedStart: int }

function getStore(logEl) {
  let s = logStores.get(logEl)
  if (!s) {
    s = { entries: [], renderedStart: 0, pinned: true }
    logStores.set(logEl, s)
    // Track pinned state on user scroll + load older on scroll-up
    logEl.addEventListener('scroll', function() {
      if (logEl.scrollTop < 40) loadOlder(logEl)
      s.pinned = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60
    })
  }
  return s
}

/** Append a pre-built DOM node to a log panel through the virtual store */
function appendToLog(logEl, node) {
  const store = getStore(logEl)
  store.entries.push(node)

  // Trim backing array if it exceeds the memory cap
  if (store.entries.length > MAX_BACKING) {
    const excess = store.entries.length - MAX_BACKING
    store.entries.splice(0, excess)
    store.renderedStart = Math.max(0, store.renderedStart - excess)
  }

  // Use tracked pinned state from scroll events (more reliable than checking at append time).
  // If the element is hidden (display:none parent), defer scroll to when panel becomes visible.
  const isHidden = logEl.offsetParent === null

  // If we have too many DOM nodes, remove oldest rendered ones
  const rendered = logEl.children.length
  if (rendered >= MAX_RENDERED) {
    const toRemove = rendered - MAX_RENDERED + 1
    for (let i = 0; i < toRemove; i++) {
      if (logEl.firstChild) logEl.removeChild(logEl.firstChild)
    }
    store.renderedStart += toRemove
  }

  logEl.appendChild(node)

  if (store.pinned) {
    if (isHidden) {
      logEl._needsScrollOnReveal = true
    } else {
      logEl.scrollTop = logEl.scrollHeight
    }
  }
}

/** Render a batch of older entries when user scrolls to the top */
function loadOlder(logEl) {
  const store = logStores.get(logEl)
  if (!store || store.renderedStart <= 0) return

  const prevHeight = logEl.scrollHeight
  const batch = Math.min(RENDER_BATCH, store.renderedStart)
  const start = store.renderedStart - batch
  const frag = document.createDocumentFragment()
  for (let i = start; i < store.renderedStart; i++) {
    const original = store.entries[i]
    if (original) frag.appendChild(original)
  }
  logEl.insertBefore(frag, logEl.firstChild)
  store.renderedStart = start

  // Maintain scroll position so it doesn't jump
  logEl.scrollTop += logEl.scrollHeight - prevHeight
}

// -- Convenience wrappers that create nodes and route through appendToLog --

function addLogEntry(logEl, className, html) {
  const entry = document.createElement('div')
  entry.className = 'log-entry ' + className
  entry.innerHTML = '<span class="timestamp">' + ts() + '</span>' + html
  appendToLog(logEl, entry)
}

function makeHeader(text, maxLen) {
  const firstLine = text.split('\n')[0].trim()
  if (firstLine.length <= maxLen) return firstLine
  return firstLine.slice(0, maxLen) + '...'
}

// Expandable entry — shows truncated preview, click to see full text
// Used for any long log entry (supervisor thinking, brain thinking, etc.)
var EXPAND_THRESHOLD = 120

function addExpandableEntry(logEl, className, text) {
  if (text.length <= EXPAND_THRESHOLD) {
    addLogEntry(logEl, className, escapeHtml(text))
    return
  }
  var preview = text.slice(0, EXPAND_THRESHOLD).replace(/\n/g, ' ') + '...'
  var wrapper = document.createElement('div')
  wrapper.className = 'log-entry expandable ' + className
  wrapper.innerHTML = '<span class="timestamp">' + ts() + '</span>'
    + '<span class="expandable-preview">' + escapeHtml(preview) + '</span>'
    + '<pre class="expandable-full">' + escapeHtml(text) + '</pre>'
  wrapper.addEventListener('click', function() { wrapper.classList.toggle('expanded') })
  appendToLog(logEl, wrapper)
}

function addCollapsible(logEl, type, header, body, startOpen) {
  const wrapper = document.createElement('div')
  const cls = type === 'prompt' ? 'prompt-entry' : 'response-entry'
  wrapper.className = 'collapsible ' + cls + (startOpen ? ' open' : '')
  wrapper.innerHTML = '<div class="collapsible-header" onclick="this.parentElement.classList.toggle(&#39;open&#39;)">'
    + '<span class="collapsible-arrow">&#9654;</span>'
    + '<span>' + escapeHtml(header) + '</span>'
    + '<span class="timestamp">' + ts() + '</span>'
    + '</div>'
    + '<div class="collapsible-body">' + escapeHtml(body) + '</div>'
  appendToLog(logEl, wrapper)
}

function addCycleSummary(logEl, cycle, summary) {
  const el = document.createElement('div')
  el.className = 'cycle-summary'
  const title = cycle > 0 ? 'Cycle ' + cycle + ' Summary' : 'Final Summary'
  el.innerHTML = '<div class="cycle-summary-title">' + title + '</div>'
    + '<div class="cycle-summary-text">' + escapeHtml(summary) + '</div>'
  appendToLog(logEl, el)
}

function setBadge(badge, status) {
  const map = {
    idle: ['IDLE', 'badge-idle'],
    busy: ['BUSY', 'badge-busy'],
    completed: ['DONE', 'badge-done'],
    connected: ['OK', 'badge-connected'],
    disconnected: ['DOWN', 'badge-disconnected'],
    error: ['ERROR', 'badge-error'],
    stuck: ['STUCK', 'badge-stuck'],
    supervising: ['SUPERVISING', 'badge-supervising'],
    reviewing: ['REVIEWING', 'badge-reviewing'],
    paused: ['PAUSED', 'badge-paused'],
    running: ['RUNNING', 'badge-running'],
    starting: ['STARTING', 'badge-starting'],
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
    case 'paused': return 'dot-paused'
    default: return 'dot-idle'
  }
}

function statusToLabel(status) {
  const labels = { idle: 'idle', busy: 'busy', completed: 'done', connected: 'ok', disconnected: 'down', error: 'err', stuck: 'stuck', paused: 'paused' }
  return labels[status] || status
}

function effectiveStatus(a) {
  // Combined project status: supervisor state takes priority over momentary worker idle
  if (a.supervisorStatus === 'paused') return 'paused'
  if (a.supervisorStatus === 'completed') return 'completed'
  if (a.status === 'error' || a.status === 'disconnected') return a.status
  if (a.supervisorStatus === 'busy') return 'busy'
  return a.status
}

function updateStatusBar() {
  const items = Object.entries(projectRows).map(([name, a]) => {
    const combined = effectiveStatus(a)
    const dotClass = statusToDot(combined)
    const label = statusToLabel(combined)
    const labelColor = dotClass === 'dot-busy' ? '#facc15' : dotClass === 'dot-disconnected' || dotClass === 'dot-error' ? '#ef4444' : dotClass === 'dot-done' ? '#60a5fa' : dotClass === 'dot-paused' ? '#f59e0b' : '#4ade80'
    return '<span><span class="status-dot ' + dotClass + '" aria-hidden="true"></span>' + name + '<span class="status-dot-label" style="color:' + labelColor + ';margin-left:4px;">' + label + '</span></span>'
  })
  statusBar.innerHTML = items.join('')
}

function handleEvent(event) {
  if (event.type === 'heartbeat') return

  if (event.type === 'agent-status') {
    const agent = ensureAgent(event.agent)
    if (!agent) return
    agent.status = event.status
    setBadge(agent.workerBadge, event.status)
    setBadge(agent.rowWorkerBadge, event.status)
    const detail = event.detail ? ' (' + event.detail + ')' : ''
    addLogEntry(agent.workerLog, 'status', escapeHtml(event.status + detail))
    updateStatusBar()
    if (event.status === 'completed') {
      notify(event.agent + ' completed', detail || 'Task finished')
      showNotification(event.agent + ' completed', 'success')
    }
    if (event.status === 'error' || event.status === 'disconnected') {
      notify(event.agent + ' ' + event.status, detail || '')
      showNotification(event.agent + ' ' + event.status + (detail ? ': ' + detail : ''), 'error')
      if (agent.projStatusBadge) setProjectStatus(agent.projStatusBadge, 'error')
    }
  }

  if (event.type === 'agent-prompt') {
    const agent = ensureAgent(event.agent)
    if (!agent) return
    const header = 'PROMPT: ' + makeHeader(event.text, 80)
    addCollapsible(agent.workerLog, 'prompt', header, event.text, false)
  }

  if (event.type === 'agent-response') {
    const agent = ensureAgent(event.agent)
    if (!agent) return
    const header = 'RESPONSE: ' + makeHeader(event.text, 80)
    addCollapsible(agent.workerLog, 'response', header, event.text, false)
  }

  if (event.type === 'cycle-summary') {
    const agent = ensureAgent(event.agent)
    if (!agent) return
    addCycleSummary(agent.workerLog, event.cycle, event.summary)
  }

  if (event.type === 'agent-event') {
    const t = event.event?.type || ''
    if (['session.idle', 'session.error', 'permission.request'].includes(t)) {
      const agent = ensureAgent(event.agent)
      if (!agent) return
      addLogEntry(agent.workerLog, 'status', escapeHtml(t))
    }
  }

  if (event.type === 'permission-request') {
    notify(event.agent + ' needs permission', event.description || 'Review required')
    const agent = ensureAgent(event.agent)
    if (!agent) return
    const id = 'perm-' + event.requestID.replace(/[^a-zA-Z0-9]/g, '_')
    const desc = event.description || JSON.stringify(event.properties, null, 2)
    const html = '<div class="perm-request" id="' + id + '">'
      + '<div class="perm-title">Permission Request</div>'
      + '<div class="perm-detail">' + escapeHtml(desc) + '</div>'
      + '<div class="perm-actions">'
      + '<button class="perm-btn perm-approve" onclick="replyPermission(&#39;' + event.agent + '&#39;, &#39;' + event.requestID + '&#39;, &#39;approve&#39;, &#39;' + id + '&#39;)">Approve</button>'
      + '<button class="perm-btn perm-deny" onclick="replyPermission(&#39;' + event.agent + '&#39;, &#39;' + event.requestID + '&#39;, &#39;deny&#39;, &#39;' + id + '&#39;)">Deny</button>'
      + '</div></div>'
    const entry = document.createElement('div')
    entry.innerHTML = html
    appendToLog(agent.workerLog, entry)
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
    if (!agent) return
    const text = event.text
    const logEl = agent.supervisorLog

    // --- Cycle header: "===== agent — CYCLE N =====" ---
    if (text.includes('=====') && /CYCLE \d+/.test(text)) {
      const m = text.match(/CYCLE (\d+)/)
      const el = document.createElement('div')
      el.className = 'supervisor-entry sv-cycle-header'
      el.innerHTML = '<span class="sv-ts">' + ts() + '</span>Cycle ' + (m ? m[1] : '?')
      appendToLog(logEl, el)
      return
    }

    // --- LLM round response: "--- agent cycle N, round M ---" followed by full response ---
    if (/^--- .+ cycle \d+, round \d+ ---/.test(text)) {
      const m = text.match(/cycle (\d+), round (\d+)/)
      const header = 'Round ' + (m ? m[2] : '?')
      // Everything after the first line is the LLM response body
      const bodyStart = text.indexOf('\n')
      const body = bodyStart !== -1 ? text.slice(bodyStart + 1).trim() : ''
      // Extract command names for the header preview
      const cmds = (body.match(/^(PROMPT|WAIT|MESSAGES|REVIEW|RESTART|ABORT|NOTE_BEHAVIOR|NOTE|DIRECTIVE|CYCLE_DONE|STOP)\b/gm) || [])
      const preview = cmds.length > 0 ? ' — ' + cmds.join(', ') : ''

      const wrapper = document.createElement('div')
      wrapper.className = 'sv-llm-round'
      wrapper.innerHTML = '<div class="sv-llm-header" onclick="this.parentElement.classList.toggle(&#39;open&#39;)">'
        + '<span class="sv-llm-arrow">&#9654;</span>'
        + '<span>' + escapeHtml(header + preview) + '</span>'
        + '<span class="sv-ts">' + ts() + '</span>'
        + '</div>'
        + '<div class="sv-llm-body">' + escapeHtml(body || '(empty)') + '</div>'
      appendToLog(logEl, wrapper)
      return
    }

    // --- Categorize all other messages ---
    const el = document.createElement('div')
    el.className = 'supervisor-entry'

    // Errors / circuit breaker / unknown agent (check first — CIRCUIT BREAKER contains "restart caps")
    if (/CIRCUIT BREAKER|UNKNOWN AGENT|LLM request failed|LLM retry failed|Ollama persistently|Error |ALERT/i.test(text)) {
      el.className += ' sv-error'
    }
    // Rate limit / cooldown / throttle
    else if (/RATE LIMITED|429|cooling down|rate-limit|consecutive 429/i.test(text)) {
      el.className += ' sv-rate-limit'
    }
    // Restart / abort / review actions
    else if (/Restarting .+ session|Agent restarted|Aborting .+|RESTART CAP|Throttling restart|Throttling auto-restart|consecutive empty responses.*restarting|Sending review to|Requesting self-review/i.test(text)) {
      el.className += ' sv-action'
    }
    // Results from orchestrator (agent response, messages, etc.)
    else if (/^(Sent to |Recent messages from |.+ response:|Review results from |Agent .+ aborted|Error sending|Error reading)/i.test(text)) {
      el.className += ' sv-result'
    }
    // Notes and directives saved
    else if (/^(Note saved|Behavioral note saved|Directive updated)/i.test(text)) {
      el.className += ' sv-note'
    }
    // Lifecycle events (supervisor start/stop/done/soft stop)
    else if (/Supervisor start|Supervisor stop|supervisor ended|Soft stop|Completed \d+ cycles|Cycle \d+ complete/i.test(text)) {
      el.className += ' sv-lifecycle'
    }
    // Meta / low-priority info (pausing, waiting, nudging, empty response)
    else if (/^(Pausing |Waiting for |Retrying in |next cycle pause|LLM returned empty|Agent responsiveness low|WARNING:)/i.test(text)) {
      el.className += ' sv-meta'
    }

    if (text.length > EXPAND_THRESHOLD) {
      addExpandableEntry(logEl, el.className, text)
    } else {
      el.innerHTML = '<span class="sv-ts">' + ts() + '</span>' + escapeHtml(text)
      appendToLog(logEl, el)
    }
  }

  if (event.type === 'supervisor-alert') {
    const agent = ensureAgent(event.agent)
    if (agent) {
      addLogEntry(agent.supervisorLog, 'error', '<strong>ALERT:</strong> ' + escapeHtml(event.text))
    }
    notify(event.agent + ' alert', event.text)
    showNotification(event.agent + ': ' + (event.text || '').slice(0, 120), 'warning')
  }

  if (event.type === 'supervisor-status') {
    const agent = ensureAgent(event.agent)
    if (!agent) return
    // Only update supervisor-specific badges here.
    // Project status badge (projStatusBadge) is driven exclusively by
    // the backend ProjectState.status via applyProjectData() to avoid
    // conflicting writes between real-time events and polling.
    if (event.status === 'running') {
      setBadge(agent.supervisorBadge, 'supervising')
      setBadge(agent.rowSupervisorBadge, 'supervising')
      agent.supervisorStatus = 'busy'
    } else if (event.status === 'reviewing') {
      setBadge(agent.supervisorBadge, 'reviewing')
      setBadge(agent.rowSupervisorBadge, 'reviewing')
      agent.supervisorStatus = 'busy'
    } else if (event.status === 'paused') {
      setBadge(agent.supervisorBadge, 'paused')
      setBadge(agent.rowSupervisorBadge, 'paused')
      agent.supervisorStatus = 'paused'
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
    addExpandableEntry(brainLog, '', event.text || '')
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
    if (event.status === 'done') {
      notify('Brain finished', 'Objective completed')
      showNotification('Brain finished — objective completed', 'success')
    }
  }

  checkEmptyState()
}

// Fetch and apply status from backend
function applyStatusData(data) {
  for (const [name, info] of Object.entries(data)) {
    const agent = ensureAgent(name)
    if (!agent) continue
    const dirParts = (info.directory || '').replace(/\\/g, '/').split('/')
    const dirName = dirParts[dirParts.length - 1] || ''
    agent.dirLabel.textContent = info.directory || ''
    agent.link.href = info.url || '#'
    agent.status = info.status
    setBadge(agent.workerBadge, info.status)
    setBadge(agent.rowWorkerBadge, info.status)
  }
  updateStatusBar()
}

// Fetch and apply project data (directives, projectIds, project status)
function applyProjectData(projects) {
  for (const proj of projects) {
    const agent = projectRows[proj.agentName]
    if (!agent) continue
    agent.projectId = proj.id
    agent.directive = proj.directive
    if (agent.portLabel && proj.workerPort) {
      agent.portLabel.textContent = ':' + proj.workerPort
    }
    // Populate directive textarea (unless user is actively editing)
    if (agent.directiveText && !agent.directiveText._userEdited) {
      agent.directiveText.value = proj.directive || ''
    }
    if (agent.modelSelect && proj.model) {
      agent.modelSelect.value = proj.model
    }
    // Update project-level status badge
    if (agent.projStatusBadge && proj.status) {
      setProjectStatus(agent.projStatusBadge, proj.status)
    }
    // Update pause UI
    updatePauseUI(proj.agentName, proj.pauseStatus || 'none', proj.pauseRequestedAt)
    // Update branch badge
    if (proj.agentBranch && agent.branchBadge) {
      agent.branchBadge.textContent = proj.agentBranch
      agent.branchBadge.style.display = 'inline'
    }
  }
}

function setProjectStatus(badge, status) {
  const map = {
    starting: ['STARTING', 'badge-starting'],
    running: ['RUNNING', 'badge-running'],
    supervising: [null, null], // hidden — Worker/Supervisor badges already show this
    stopped: ['FINISHED', 'badge-stopped'],
    error: ['ERROR', 'badge-error'],
  }
  const [text, cls] = map[status] || [status.toUpperCase(), 'badge-idle']
  if (!text) {
    badge.style.display = 'none'
  } else {
    badge.style.display = ''
    badge.textContent = text
    badge.className = 'agent-badge ' + cls
  }
}

// --- Drag-to-annotate feedback system ---
const annotationPopup = document.createElement('div')
annotationPopup.className = 'annotation-popup'
annotationPopup.innerHTML = `
  <div class="ann-source" id="ann-source"></div>
  <div class="ann-selected" id="ann-selected"></div>
  <div class="ann-type">
    <label><input type="radio" name="ann-type" value="behavioral" checked> Behavioral</label>
    <label><input type="radio" name="ann-type" value="project"> Project Note</label>
  </div>
  <textarea id="ann-note" placeholder="Your feedback — this will guide agent decision-making..."></textarea>
  <div class="ann-actions">
    <button class="ann-btn ann-cancel" onclick="closeAnnotation()">Cancel</button>
    <button class="ann-btn ann-submit" onclick="submitAnnotation()">Send Feedback</button>
  </div>
`
document.body.appendChild(annotationPopup)

const annotationToast = document.createElement('div')
annotationToast.className = 'annotation-toast'
document.body.appendChild(annotationToast)

// General-purpose toast notification system
const toastContainer = document.createElement('div')
toastContainer.className = 'toast-container'
toastContainer.setAttribute('role', 'log')
toastContainer.setAttribute('aria-live', 'polite')
toastContainer.setAttribute('aria-label', 'Notifications')
document.body.appendChild(toastContainer)

/**
 * Show a toast notification.
 * @param {string} message - Text to display
 * @param {'success'|'error'|'warning'|'info'} type - Toast type
 * @param {number} duration - Auto-dismiss duration in ms (default 4000)
 */
function showNotification(message, type, duration) {
  type = type || 'info'
  duration = duration || 4000
  const toast = document.createElement('div')
  toast.className = 'toast toast-' + type
  toast.setAttribute('role', 'alert')
  toast.innerHTML = '<span>' + escapeHtml(message) + '</span><button class="toast-dismiss" aria-label="Dismiss">&times;</button>'
  toast.querySelector('.toast-dismiss').onclick = () => toast.remove()
  toastContainer.appendChild(toast)
  // Keep max 5 toasts visible
  while (toastContainer.children.length > 5) toastContainer.removeChild(toastContainer.firstChild)
  setTimeout(() => { if (toast.parentNode) toast.remove() }, duration)
}

let annotationContext = null

function detectPanel(el) {
  // Walk up to find which panel-log or brain-log the selection is inside
  let node = el
  while (node && node !== document.body) {
    if (node.classList && node.classList.contains('panel-log')) {
      const id = node.id || ''
      if (id.startsWith('wlog-')) return { panel: 'worker', agent: id.slice(5) }
      if (id.startsWith('slog-')) return { panel: 'supervisor', agent: id.slice(5) }
    }
    if (node.classList && node.classList.contains('brain-log')) {
      return { panel: 'brain', agent: '_brain' }
    }
    node = node.parentElement
  }
  return null
}

document.addEventListener('mouseup', function(e) {
  // Don't trigger inside the annotation popup itself
  if (annotationPopup.contains(e.target)) return

  const sel = window.getSelection()
  const text = sel ? sel.toString().trim() : ''
  if (text.length < 3) {
    // Too short — close popup if open and click is outside
    if (!annotationPopup.contains(e.target)) closeAnnotation()
    return
  }

  const range = sel.getRangeAt(0)
  const startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
  const context = detectPanel(startEl)
  if (!context) return // selection not inside a log panel

  // Position popup near mouse
  const x = Math.min(e.clientX, window.innerWidth - 340)
  const y = Math.min(e.clientY + 10, window.innerHeight - 250)
  annotationPopup.style.left = x + 'px'
  annotationPopup.style.top = y + 'px'

  document.getElementById('ann-source').textContent = context.panel.toUpperCase() + ' \u2014 ' + context.agent
  document.getElementById('ann-selected').textContent = text.slice(0, 300) + (text.length > 300 ? '...' : '')
  document.getElementById('ann-note').value = ''
  annotationPopup.classList.add('open')

  annotationContext = {
    selectedText: text.slice(0, 500),
    panel: context.panel,
    agent: context.agent,
  }

  // Focus the textarea after a tick
  setTimeout(() => document.getElementById('ann-note').focus(), 50)
})

function closeAnnotation() {
  annotationPopup.classList.remove('open')
  annotationContext = null
}

function showToast(msg) {
  annotationToast.textContent = msg
  annotationToast.style.display = 'block'
  // Force re-trigger animation
  annotationToast.style.animation = 'none'
  annotationToast.offsetHeight // reflow
  annotationToast.style.animation = ''
  setTimeout(() => { annotationToast.style.display = 'none' }, 2200)
}

async function submitAnnotation() {
  if (!annotationContext) return
  const note = document.getElementById('ann-note').value.trim()
  if (!note) { document.getElementById('ann-note').focus(); return }
  const feedbackType = document.querySelector('input[name="ann-type"]:checked').value

  const submitBtn = annotationPopup.querySelector('.ann-submit')
  submitBtn.disabled = true
  submitBtn.textContent = 'Sending...'

  try {
    const res = await apiFetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedText: annotationContext.selectedText,
        note: note,
        panel: annotationContext.panel,
        agent: annotationContext.agent,
        feedbackType: feedbackType,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      alert('Failed to send feedback: ' + (err.error || res.status))
    } else {
      closeAnnotation()
      showToast('Feedback saved \u2014 will guide agent decisions')
      window.getSelection().removeAllRanges()
    }
  } catch (err) {
    alert('Error: ' + err)
  }
  submitBtn.disabled = false
  submitBtn.textContent = 'Send Feedback'
}

// Allow Escape to close popup
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && annotationPopup.classList.contains('open')) {
    closeAnnotation()
  }
})

// Performance comparison
window.refreshPerformance = async function() {
  const el = document.getElementById('perf-content')
  el.innerHTML = 'Loading...'
  try {
    const res = await fetch('/api/performance')
    if (!res.ok) {
      el.innerHTML = 'Failed to load performance data (HTTP ' + res.status + ')'
      return
    }
    const log = await res.json()
    const entries = log.entries || []
    if (entries.length === 0) {
      el.innerHTML = 'No performance data yet. Data is logged as supervisors run cycles.'
      return
    }
    // Aggregate by model
    const stats = {}
    for (const e of entries) {
      if (!stats[e.model]) stats[e.model] = { cycles: 0, errors: 0, restarts: 0, stuck: 0, stops: 0, durations: [], projects: new Set() }
      const s = stats[e.model]
      s.projects.add(e.projectName || e.agentName)
      if (e.event === 'cycle_complete') { s.cycles++; if (e.durationMs) s.durations.push(e.durationMs) }
      if (e.event === 'cycle_error') s.errors++
      if (e.event === 'restart') s.restarts++
      if (e.event === 'stuck') s.stuck++
      if (e.event === 'supervisor_stop') s.stops++
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:11px;">'
    html += '<tr style="border-bottom:1px solid #2a2a3a;color:#888;text-align:left;">'
    html += '<th style="padding:4px 8px;">Model</th><th>Cycles</th><th>Errors</th><th>Restarts</th><th>Stuck</th><th>Stops</th><th>Avg Cycle</th><th>Projects</th></tr>'
    for (const [model, s] of Object.entries(stats)) {
      const avg = s.durations.length > 0 ? Math.round(s.durations.reduce((a,b) => a+b, 0) / s.durations.length / 1000) + 's' : '-'
      const errRate = s.cycles > 0 ? Math.round(s.errors / (s.cycles + s.errors) * 100) + '%' : '-'
      html += '<tr style="border-bottom:1px solid #1a1a2a;">'
      html += '<td style="padding:4px 8px;color:#e0e0e0;font-weight:600;">' + escapeHtml(model) + '</td>'
      html += '<td style="color:#4ade80;">' + s.cycles + '</td>'
      html += '<td style="color:' + (s.errors > 0 ? '#ef4444' : '#666') + ';">' + s.errors + ' (' + errRate + ')</td>'
      html += '<td style="color:' + (s.restarts > 0 ? '#fb923c' : '#666') + ';">' + s.restarts + '</td>'
      html += '<td style="color:' + (s.stuck > 0 ? '#fb923c' : '#666') + ';">' + s.stuck + '</td>'
      html += '<td style="color:' + (s.stops > 0 ? '#facc15' : '#666') + ';">' + s.stops + '</td>'
      html += '<td>' + avg + '</td>'
      html += '<td style="color:#888;font-size:10px;">' + Array.from(s.projects).join(', ') + '</td>'
      html += '</tr>'
    }
    html += '</table>'
    html += '<div style="margin-top:8px;font-size:10px;color:#555;">Total entries: ' + entries.length + '</div>'
    el.innerHTML = html
  } catch (err) {
    el.innerHTML = 'Error loading: ' + err
  }
}

// --- Analytics UI ---
let analyticsSelectedA = null
let analyticsSelectedB = null

function scoreColor(v) {
  if (v >= 8) return '#4ade80'
  if (v >= 5) return '#facc15'
  return '#ef4444'
}

function scoreBadge(v) {
  if (v == null) return '<span style="color:#666;">-</span>'
  return '<span style="color:' + scoreColor(v) + ';font-weight:700;">' + v + '/10</span>'
}

function fmtDuration(ms) {
  if (!ms) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  return Math.round(s / 60) + 'm ' + (s % 60) + 's'
}

function renderScoreBars(scores) {
  const dims = ['taskCompletion', 'codeQuality', 'correctness', 'progressEfficiency', 'overall']
  const labels = { taskCompletion: 'Task Completion', codeQuality: 'Code Quality', correctness: 'Correctness', progressEfficiency: 'Efficiency', overall: 'Overall' }
  let html = '<div style="display:flex;flex-direction:column;gap:4px;margin:8px 0;">'
  for (const d of dims) {
    const v = scores[d] || 0
    const pct = v * 10
    html += '<div style="display:flex;align-items:center;gap:8px;font-size:11px;">'
    html += '<span style="width:100px;color:#aaa;text-align:right;">' + labels[d] + '</span>'
    html += '<div style="flex:1;height:14px;background:#1a1a2a;border-radius:3px;overflow:hidden;">'
    html += '<div style="height:100%;width:' + pct + '%;background:' + scoreColor(v) + ';border-radius:3px;transition:width 0.3s;"></div>'
    html += '</div>'
    html += '<span style="width:32px;color:' + scoreColor(v) + ';font-weight:700;">' + v + '</span>'
    html += '</div>'
  }
  html += '</div>'
  return html
}

function renderSessionCard(s, idx) {
  const dur = fmtDuration(s.metrics?.durationMs)
  const gitDelta = '+' + (s.metrics?.insertions || 0) + ' -' + (s.metrics?.deletions || 0) + ', ' + (s.metrics?.filesChanged || 0) + ' files'
  const overallScore = s.evaluation?.scores?.overall
  const statusColor = s.status === 'completed' ? '#4ade80' : s.status === 'failed' ? '#ef4444' : s.status === 'running' ? '#facc15' : '#888'
  const directiveTrunc = (s.directive || '').length > 80 ? s.directive.slice(0, 80) + '...' : (s.directive || '')

  let html = '<div class="analytics-card" id="acard-' + idx + '" style="border:1px solid #2a2a3a;border-radius:6px;padding:10px 12px;margin-bottom:8px;background:#12121a;cursor:pointer;" onclick="toggleAnalyticsCard(' + idx + ')">'
  html += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">'
  html += '<div style="display:flex;gap:12px;align-items:center;">'
  html += '<span style="color:#8b8bff;font-weight:700;">' + escapeHtml(s.agentName) + '</span>'
  html += '<span style="color:#666;font-size:10px;">' + escapeHtml(s.model) + '</span>'
  html += '<span style="color:' + statusColor + ';font-size:10px;text-transform:uppercase;">' + s.status + '</span>'
  html += '</div>'
  html += '<div style="display:flex;gap:12px;align-items:center;font-size:11px;">'
  html += '<span style="color:#888;">' + (s.metrics?.totalCycles || 0) + ' cycles</span>'
  html += '<span style="color:#888;">' + dur + '</span>'
  html += '<span style="color:#888;">' + gitDelta + '</span>'
  if (overallScore != null) {
    html += scoreBadge(overallScore)
  } else {
    html += '<button onclick="event.stopPropagation();evaluateSession(\'' + s.id + '\', ' + idx + ')" style="background:#2a2a3a;border:1px solid #444;color:#c084fc;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;">Evaluate</button>'
  }
  // Compare checkbox
  html += '<label onclick="event.stopPropagation()" style="font-size:10px;color:#888;display:flex;align-items:center;gap:4px;">'
  html += '<input type="checkbox" class="compare-cb" data-id="' + s.id + '" onchange="updateCompareSelection(this)">'
  html += 'Compare</label>'
  html += '</div>'
  html += '</div>'
  html += '<div style="font-size:10px;color:#666;margin-top:4px;">' + escapeHtml(directiveTrunc) + '</div>'

  // Expanded detail (hidden by default)
  html += '<div class="analytics-detail" id="adetail-' + idx + '" style="display:none;margin-top:10px;border-top:1px solid #2a2a3a;padding-top:10px;">'
  if (s.evaluation) {
    html += renderScoreBars(s.evaluation.scores)
    const fb = s.evaluation.feedback
    if (fb.summary) html += '<div style="font-size:11px;color:#ccc;margin:6px 0;">' + escapeHtml(fb.summary) + '</div>'
    if (fb.strengths?.length) {
      html += '<div style="font-size:10px;color:#4ade80;margin-top:4px;">Strengths:</div><ul style="font-size:10px;color:#aaa;margin:2px 0 4px 16px;">'
      fb.strengths.forEach(function(st) { html += '<li>' + escapeHtml(st) + '</li>' })
      html += '</ul>'
    }
    if (fb.weaknesses?.length) {
      html += '<div style="font-size:10px;color:#ef4444;margin-top:4px;">Weaknesses:</div><ul style="font-size:10px;color:#aaa;margin:2px 0 4px 16px;">'
      fb.weaknesses.forEach(function(w) { html += '<li>' + escapeHtml(w) + '</li>' })
      html += '</ul>'
    }
    if (fb.suggestions?.length) {
      html += '<div style="font-size:10px;color:#facc15;margin-top:4px;">Suggestions:</div><ul style="font-size:10px;color:#aaa;margin:2px 0 4px 16px;">'
      fb.suggestions.forEach(function(sg) { html += '<li>' + escapeHtml(sg) + '</li>' })
      html += '</ul>'
    }
    html += '<button onclick="event.stopPropagation();evaluateSession(\'' + s.id + '\', ' + idx + ')" style="background:#2a2a3a;border:1px solid #444;color:#c084fc;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;margin-top:6px;">Re-evaluate</button>'
  }
  // Cycle summaries
  if (s.cycleSummaries?.length) {
    html += '<div style="font-size:10px;color:#888;margin-top:8px;">Cycle summaries:</div>'
    html += '<div style="max-height:120px;overflow-y:auto;font-size:10px;color:#aaa;margin-top:4px;">'
    s.cycleSummaries.forEach(function(c) {
      html += '<div style="margin-bottom:3px;"><span style="color:#666;">#' + c.cycleNumber + ' (' + fmtDuration(c.durationMs) + '):</span> ' + escapeHtml(c.summary) + '</div>'
    })
    html += '</div>'
  }
  html += '</div>'
  html += '</div>'
  return html
}

function toggleAnalyticsCard(idx) {
  const detail = document.getElementById('adetail-' + idx)
  if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none'
}

window.evaluateSession = async function(sessionId, idx) {
  const btn = event?.target
  if (btn) { btn.textContent = 'Evaluating...'; btn.disabled = true }
  try {
    const res = await apiFetch('/api/analytics/evaluate/' + sessionId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    await refreshAnalytics()
  } catch (err) {
    if (btn) { btn.textContent = 'Failed'; btn.disabled = false }
    console.error('Evaluation error:', err)
  }
}

function updateCompareSelection(cb) {
  const checked = document.querySelectorAll('.compare-cb:checked')
  if (checked.length > 2) {
    cb.checked = false
    return
  }
  analyticsSelectedA = checked.length >= 1 ? checked[0].dataset.id : null
  analyticsSelectedB = checked.length >= 2 ? checked[1].dataset.id : null
  const compareBtn = document.getElementById('compare-btn')
  if (compareBtn) compareBtn.style.display = checked.length === 2 ? 'inline-block' : 'none'
}

async function runComparison() {
  if (!analyticsSelectedA || !analyticsSelectedB) return
  const btn = document.getElementById('compare-btn')
  if (btn) { btn.textContent = 'Comparing...'; btn.disabled = true }
  try {
    const res = await apiFetch('/api/analytics/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionA: analyticsSelectedA, sessionB: analyticsSelectedB })
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const cmp = await res.json()
    showCompareModal(cmp)
  } catch (err) {
    alert('Comparison failed: ' + err)
  } finally {
    if (btn) { btn.textContent = 'Compare Selected'; btn.disabled = false }
  }
}

function showCompareModal(cmp) {
  const modal = document.getElementById('analytics-compare-modal')
  const content = document.getElementById('compare-content')
  if (!cmp.aiComparison) {
    content.innerHTML = '<div style="color:#888;">No comparison data.</div>'
    modal.style.display = 'flex'
    return
  }
  const ai = cmp.aiComparison
  const winnerColor = ai.winner === 'A' ? '#4ade80' : ai.winner === 'B' ? '#60a5fa' : '#facc15'
  let html = '<div style="text-align:center;margin-bottom:12px;">'
  html += '<span style="font-size:18px;font-weight:700;color:' + winnerColor + ';">Winner: Session ' + ai.winner.toUpperCase() + '</span>'
  html += '</div>'
  html += '<div style="font-size:12px;color:#ccc;margin-bottom:12px;">' + escapeHtml(ai.reasoning) + '</div>'
  if (ai.dimensionComparison?.length) {
    html += '<table style="width:100%;border-collapse:collapse;font-size:11px;">'
    html += '<tr style="border-bottom:1px solid #2a2a3a;color:#888;"><th style="text-align:left;padding:4px 8px;">Dimension</th><th>Session A</th><th>Session B</th><th style="text-align:left;padding-left:12px;">Notes</th></tr>'
    ai.dimensionComparison.forEach(function(d) {
      const aColor = scoreColor(d.sessionAScore)
      const bColor = scoreColor(d.sessionBScore)
      html += '<tr style="border-bottom:1px solid #1a1a2a;">'
      html += '<td style="padding:4px 8px;color:#e0e0e0;">' + escapeHtml(d.dimension) + '</td>'
      html += '<td style="text-align:center;color:' + aColor + ';font-weight:700;">' + d.sessionAScore + '</td>'
      html += '<td style="text-align:center;color:' + bColor + ';font-weight:700;">' + d.sessionBScore + '</td>'
      html += '<td style="padding-left:12px;color:#888;font-size:10px;">' + escapeHtml(d.notes) + '</td>'
      html += '</tr>'
    })
    html += '</table>'
  }
  content.innerHTML = html
  modal.style.display = 'flex'
}

function closeCompareModal() {
  document.getElementById('analytics-compare-modal').style.display = 'none'
}

function renderTimeline(timeline) {
  const el = document.getElementById('analytics-timeline')
  if (!timeline?.length) { el.innerHTML = ''; return }
  const maxDur = Math.max(...timeline.map(t => t.durationMs || 1))
  let html = '<div style="font-size:11px;color:#888;margin-bottom:6px;">Cycle Timeline (width = duration, color = status)</div>'
  html += '<div style="display:flex;flex-direction:column;gap:2px;">'
  timeline.slice(-60).forEach(function(t) {
    const pct = Math.max(2, Math.round((t.durationMs / maxDur) * 100))
    const color = t.hadError ? '#ef4444' : t.hadRestart ? '#fb923c' : '#4ade80'
    html += '<div style="display:flex;align-items:center;gap:6px;font-size:10px;">'
    html += '<span style="width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#666;">' + escapeHtml(t.agentName) + ' #' + t.cycleNumber + '</span>'
    html += '<div style="flex:1;height:10px;background:#1a1a2a;border-radius:2px;overflow:hidden;">'
    html += '<div style="height:100%;width:' + pct + '%;background:' + color + ';border-radius:2px;"></div>'
    html += '</div>'
    html += '<span style="width:40px;color:#666;text-align:right;">' + fmtDuration(t.durationMs) + '</span>'
    html += '</div>'
  })
  html += '</div>'
  el.innerHTML = html
}

function renderTrends(sessions) {
  const el = document.getElementById('analytics-trends')
  if (!sessions?.length) { el.innerHTML = ''; return }
  // Avg cycle duration
  const allDurs = sessions.flatMap(s => s.metrics?.cycleDurations || [])
  const avgDur = allDurs.length > 0 ? Math.round(allDurs.reduce((a, b) => a + b, 0) / allDurs.length) : 0
  // Error rate
  const totalCycles = sessions.reduce((a, s) => a + (s.metrics?.totalCycles || 0), 0)
  const totalErrors = sessions.reduce((a, s) => a + (s.metrics?.totalErrors || 0), 0)
  const errRate = totalCycles > 0 ? Math.round(totalErrors / (totalCycles + totalErrors) * 100) : 0
  // Avg AI score
  const scored = sessions.filter(s => s.evaluation?.scores?.overall)
  const avgScore = scored.length > 0 ? (scored.reduce((a, s) => a + s.evaluation.scores.overall, 0) / scored.length).toFixed(1) : '-'

  const box = 'background:#16162a;border:1px solid #2a2a3a;border-radius:6px;padding:8px 14px;font-size:11px;min-width:120px;'
  let html = ''
  html += '<div style="' + box + '"><div style="color:#888;">Avg Cycle</div><div style="font-size:16px;font-weight:700;color:#60a5fa;">' + fmtDuration(avgDur) + '</div></div>'
  html += '<div style="' + box + '"><div style="color:#888;">Error Rate</div><div style="font-size:16px;font-weight:700;color:' + (errRate > 20 ? '#ef4444' : errRate > 5 ? '#facc15' : '#4ade80') + ';">' + errRate + '%</div></div>'
  html += '<div style="' + box + '"><div style="color:#888;">Avg AI Score</div><div style="font-size:16px;font-weight:700;color:' + (avgScore === '-' ? '#666' : scoreColor(parseFloat(avgScore))) + ';">' + avgScore + '</div></div>'
  html += '<div style="' + box + '"><div style="color:#888;">Sessions</div><div style="font-size:16px;font-weight:700;color:#e0e0e0;">' + sessions.length + '</div></div>'
  el.innerHTML = html
}

window.refreshAnalytics = async function() {
  const sessEl = document.getElementById('analytics-sessions')
  sessEl.innerHTML = 'Loading...'
  try {
    const [sessRes, timelineRes] = await Promise.all([
      fetch('/api/analytics/sessions'),
      fetch('/api/analytics/timeline')
    ])
    const sessions = sessRes.ok ? await sessRes.json() : []
    const timeline = timelineRes.ok ? await timelineRes.json() : []

    renderTrends(sessions)

    if (sessions.length === 0) {
      sessEl.innerHTML = 'No analytics sessions yet. Data is recorded as supervisors run.'
      document.getElementById('analytics-timeline').innerHTML = ''
      return
    }

    let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
    html += '<span style="color:#888;font-size:11px;">Recent sessions (' + sessions.length + ')</span>'
    html += '<button id="compare-btn" onclick="runComparison()" style="display:none;background:#2a2a3a;border:1px solid #c084fc;color:#c084fc;border-radius:4px;padding:3px 10px;font-size:10px;cursor:pointer;">Compare Selected</button>'
    html += '</div>'
    sessions.slice(0, 20).forEach(function(s, i) {
      html += renderSessionCard(s, i)
    })
    sessEl.innerHTML = html

    renderTimeline(timeline)
  } catch (err) {
    sessEl.innerHTML = 'Error loading analytics: ' + err
  }
}

// Connection state indicator for the status bar
let connectionState = 'connected' // 'connected' | 'degraded' | 'disconnected'
let consecutivePollFailures = 0

function updateConnectionIndicator() {
  const indicator = document.getElementById('connection-indicator')
  if (!indicator) return
  if (connectionState === 'connected') {
    indicator.textContent = ''
    indicator.style.color = ''
  } else if (connectionState === 'degraded') {
    indicator.textContent = '⚠ Reconnecting...'
    indicator.style.color = '#f59e0b'
  } else {
    indicator.textContent = '✗ Disconnected'
    indicator.style.color = '#ef4444'
  }
}

function setConnectionState(state) {
  if (connectionState === state) return
  connectionState = state
  updateConnectionIndicator()
}

// Fetch initial status with error handling
let initialLoadSucceeded = false
fetch('/api/status').then(r => { if (!r.ok) throw new Error('status ' + r.status); return r.json() }).then(data => {
  applyStatusData(data); checkEmptyState(); initialLoadSucceeded = true; setConnectionState('connected'); consecutivePollFailures = 0
}).catch(err => {
  console.error('Initial status load failed:', err)
  setConnectionState('disconnected')
  const emptyEl = document.getElementById('empty-state')
  if (emptyEl) emptyEl.innerHTML = '<h2>Unable to connect</h2><p style="color:#aaa;">The orchestrator server is not responding. Please check that it is running and refresh the page.</p><button onclick="location.reload()">Retry</button>'
})
fetch('/api/projects').then(r => { if (!r.ok) throw new Error('projects ' + r.status); return r.json() }).then(data => { applyProjectData(data); if (!initialLoadSucceeded) { initialLoadSucceeded = true; setConnectionState('connected'); consecutivePollFailures = 0 } }).catch(err => {
  console.error('Initial projects load failed:', err)
  if (!initialLoadSucceeded) setConnectionState('disconnected')
})

// Poll backend every 10s to keep status in sync
setInterval(() => {
  fetch('/api/status').then(r => { if (!r.ok) throw new Error('status ' + r.status); return r.json() }).then(data => { applyStatusData(data); setConnectionState('connected'); consecutivePollFailures = 0 }).catch(err => {
    consecutivePollFailures++
    if (consecutivePollFailures >= 3) setConnectionState('disconnected')
    else setConnectionState('degraded')
  })
  fetch('/api/projects').then(r => { if (!r.ok) throw new Error('projects ' + r.status); return r.json() }).then(applyProjectData).catch(() => {})
}, 10000)

// Soft stop
const softStopBtn = document.getElementById('soft-stop-btn')
async function softStop() {
  try {
    const res = await apiFetch('/api/soft-stop', { method: 'POST' })
    if (!res.ok) {
      alert('Failed to soft stop: server returned ' + res.status)
      return
    }
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

// Search/filter — global across all panels, projects, events, and logs
function filterLogs(query) {
  const q = query.toLowerCase()

  // Filter log entries in worker/supervisor panels
  document.querySelectorAll('.log-entry, .perm-request, .collapsible, .cycle-summary, .supervisor-entry, .sv-llm-round').forEach(el => {
    el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none'
  })

  // Filter brain log
  brainLog.querySelectorAll('div').forEach(el => {
    el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none'
  })

  // Filter project rows by name/directory
  document.querySelectorAll('.project-row').forEach(row => {
    if (!q) { row.style.display = ''; return }
    const name = row.querySelector('.project-row-name')?.textContent?.toLowerCase() || ''
    const dir = row.querySelector('.project-row-dir')?.textContent?.toLowerCase() || ''
    const hasMatchInLogs = row.querySelector('.log-entry:not([style*="display: none"]), .supervisor-entry:not([style*="display: none"]), .collapsible:not([style*="display: none"])')
    row.style.display = name.includes(q) || dir.includes(q) || hasMatchInLogs ? '' : 'none'
  })

  // Filter live event stream entries
  document.querySelectorAll('#live-event-log > div').forEach(el => {
    el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none'
  })

  // Filter bus events
  document.querySelectorAll('#bus-events > div').forEach(el => {
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
    a.supervisorLog.querySelectorAll('.supervisor-entry, .sv-llm-round, .log-entry, .cycle-summary').forEach(el => {
      lines.push(el.textContent)
    })
    lines.push('')
  }
  lines.push('--- Brain ---')
  brainLog.querySelectorAll('div').forEach(el => {
    lines.push(el.textContent)
  })
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'orchestrator-log-' + new Date().toISOString().slice(0,19).replace(/:/g,'-') + '.txt'
  a.click()
}

// -----------------------------------------------------------------------
// Directive / Settings panel functions
// -----------------------------------------------------------------------

async function saveDirective(agentName) {
  const agent = projectRows[agentName]
  if (!agent || !agent.projectId) { alert('Project not found for ' + agentName); return }
  const btn = agent.directiveText?.closest('.directive-section')?.querySelector('.directive-save')
  const text = agent.directiveText.value.trim()
  if (!text) { alert('Directive cannot be empty'); return }
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...' }
  try {
    const res = await apiFetch('/api/projects/' + agent.projectId + '/directive', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directive: text }),
    })
    const data = await res.json()
    if (data.ok) {
      agent.directiveText._userEdited = false
      addLogEntry(agent.supervisorLog, 'status', 'Directive updated. Supervisor restarting...')
    } else {
      alert('Failed to save directive: ' + (data.error || 'Unknown error'))
    }
  } catch (err) {
    alert('Error saving directive: ' + err)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Directive & Restart Supervisor' }
  }
}

async function saveModel(agentName) {
  const agent = projectRows[agentName]
  if (!agent || !agent.projectId) { alert('Project not found for ' + agentName); return }
  const model = agent.modelSelect.value
  if (!model) {
    addLogEntry(agent.supervisorLog, 'status', 'Model already set to global default — no change needed.')
    return
  }
  const btn = agent.modelSelect?.closest('div')?.querySelector('.directive-save')
  if (btn) { btn.disabled = true; btn.textContent = 'Changing...' }
  try {
    const res = await apiFetch('/api/projects/' + agent.projectId + '/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
    const data = await res.json()
    if (data.ok) {
      addLogEntry(agent.supervisorLog, 'status', 'Model changed to: ' + model + '. Supervisor restarting...')
    } else {
      alert('Failed to change model: ' + (data.error || 'Unknown error'))
    }
  } catch (err) {
    alert('Error changing model: ' + err)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Change Model' }
  }
}

async function sendComment(agentName) {
  const agent = projectRows[agentName]
  if (!agent || !agent.projectId) { alert('Project not found'); return }
  const input = document.getElementById('dcmt-' + agentName)
  const btn = input?.nextElementSibling
  const comment = input.value.trim()
  if (!comment) { alert('Please enter a comment.'); return }
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...' }
  try {
    const res = await apiFetch('/api/projects/' + agent.projectId + '/directive-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment }),
    })
    const data = await res.json()
    if (data.ok) {
      input.value = ''
      addLogEntry(agent.supervisorLog, 'status', 'Comment sent to supervisor: "' + comment.slice(0, 80) + '"')
      const histEl = document.getElementById('dhist-' + agentName)
      if (histEl && histEl.style.display !== 'none') loadHistory(agentName)
    } else {
      alert('Failed: ' + (data.error || 'Unknown error'))
    }
  } catch (err) {
    alert('Error: ' + err)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send Comment' }
  }
}

function switchDrawerTab(agentName, tabName, btn) {
  var content = document.getElementById('dcontent-' + agentName)
  if (!content) return
  // Deactivate all tabs and panels
  content.querySelectorAll('.drawer-tab').forEach(function(t) { t.classList.remove('active') })
  content.querySelectorAll('.drawer-panel').forEach(function(p) { p.classList.remove('active') })
  // Activate selected
  btn.classList.add('active')
  var panel = document.getElementById('dtab-' + tabName + '-' + agentName)
  if (panel) panel.classList.add('active')
  // Auto-load data when switching to tabs
  if (tabName === 'history') loadHistory(agentName)
  if (tabName === 'memory') loadMemory(agentName)
}

async function loadMemory(agentName) {
  var el = document.getElementById('dmem-' + agentName)
  if (!el) return
  el.innerHTML = '<em style="color:#555;">Loading memory...</em>'
  try {
    var res = await apiFetch('/api/memory/' + agentName)
    var data = await res.json()
    var html = ''

    // Behavioral notes
    if (data.behavioralNotes && data.behavioralNotes.length > 0) {
      html += '<div class="mem-section">'
      html += '<div class="mem-section-title">Behavioral Notes</div>'
      for (var i = 0; i < data.behavioralNotes.length; i++) {
        html += '<div class="mem-entry mem-behavioral">' + escapeHtml(data.behavioralNotes[i]) + '</div>'
      }
      html += '</div>'
    }

    // Project notes
    if (data.projectNotes && data.projectNotes.length > 0) {
      html += '<div class="mem-section">'
      html += '<div class="mem-section-title">Project Notes</div>'
      for (var i = 0; i < data.projectNotes.length; i++) {
        html += '<div class="mem-entry mem-project">' + escapeHtml(data.projectNotes[i]) + '</div>'
      }
      html += '</div>'
    }

    // Session summaries
    if (data.sessions && data.sessions.length > 0) {
      html += '<div class="mem-section">'
      html += '<div class="mem-section-title">Session Summaries</div>'
      var sessions = data.sessions.slice().reverse() // most recent first
      for (var i = 0; i < sessions.length; i++) {
        var s = sessions[i]
        var date = new Date(s.timestamp).toLocaleString()
        var learnings = s.agentLearnings && s.agentLearnings[agentName]
          ? s.agentLearnings[agentName] : []
        html += '<div class="mem-entry mem-session">'
        html += '<div class="mem-session-header">'
        html += '<span class="mem-date">' + escapeHtml(date) + '</span>'
        html += '<span class="mem-objective">' + escapeHtml(s.objective || '').slice(0, 120) + '</span>'
        html += '</div>'
        if (s.summary) {
          html += '<div class="mem-summary">' + escapeHtml(s.summary) + '</div>'
        }
        if (learnings.length > 0) {
          html += '<div class="mem-learnings">'
          html += '<span class="mem-learnings-label">Learnings:</span>'
          for (var j = 0; j < learnings.length; j++) {
            html += '<div class="mem-learning-item">' + escapeHtml(learnings[j]) + '</div>'
          }
          html += '</div>'
        }
        html += '</div>'
      }
      html += '</div>'
    }

    if (!html) {
      html = '<em style="color:#555;font-size:11px;">No memory records yet. Memory accumulates as the supervisor runs cycles.</em>'
    }

    el.innerHTML = html
  } catch (err) {
    el.innerHTML = '<em style="color:#ef4444;font-size:11px;">Error loading memory: ' + err + '</em>'
  }
}

// toggleHistory kept for backward compat but now called from switchDrawerTab
function toggleHistory(agentName) {
  loadHistory(agentName)
}

async function loadHistory(agentName) {
  const agent = projectRows[agentName]
  if (!agent || !agent.projectId) return
  const histEl = document.getElementById('dhist-' + agentName)
  if (!histEl) return
  histEl.innerHTML = '<div style="color:#666;font-size:10px;">Loading...</div>'
  try {
    const res = await fetch('/api/projects/' + agent.projectId + '/directive-history')
    const history = await res.json()
    if (!history || history.length === 0) {
      histEl.innerHTML = '<div style="color:#666;font-size:10px;">No history yet.</div>'
      return
    }
    const reversed = [...history].reverse()
    let html = ''
    for (let i = 0; i < reversed.length; i++) {
      const entry = reversed[i]
      const isLatest = i === 0
      const date = new Date(entry.timestamp)
      const timeStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const sourceColor = entry.source === 'user' ? '#8b8bff' : '#fb923c'
      const sourceLabel = entry.source === 'user' ? 'USER' : 'SUPERVISOR'
      const borderColor = isLatest ? '#4ade80' : '#2a2a3a'
      html += '<div style="border-left:2px solid ' + borderColor + ';padding:4px 0 8px 10px;margin-left:6px;font-size:10px;'
        + (isLatest ? '' : 'opacity:0.7;') + '">'
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">'
      html += '<span style="color:' + sourceColor + ';font-weight:600;font-size:9px;text-transform:uppercase;">' + sourceLabel + '</span>'
      html += '<span style="color:#555;">' + timeStr + '</span>'
      if (isLatest) html += '<span style="color:#4ade80;font-size:9px;font-weight:600;">CURRENT</span>'
      html += '</div>'
      html += '<div style="color:#c0c0c0;line-height:1.4;white-space:pre-wrap;max-height:80px;overflow:hidden;">' + escapeHtml(entry.text.slice(0, 300)) + (entry.text.length > 300 ? '...' : '') + '</div>'
      if (entry.comment) {
        html += '<div style="margin-top:3px;padding:3px 6px;background:#1a1a2a;border-radius:3px;color:#8b8bff;font-style:italic;">'
        html += '&#128172; ' + escapeHtml(entry.comment)
        if (entry.commentRead) html += ' <span style="color:#4ade80;font-size:9px;">(read by supervisor)</span>'
        else html += ' <span style="color:#facc15;font-size:9px;">(pending)</span>'
        html += '</div>'
      }
      if (!isLatest) {
        const origIdx = history.length - 1 - i
        html += '<div style="margin-top:3px;display:flex;gap:8px;align-items:center;">'
        html += '<span style="cursor:pointer;color:#6366f1;text-decoration:underline;font-size:9px;" onclick="revertDirective(\'' + agentName + '\', ' + origIdx + ')">Revert to this version</span>'
        html += '<input type="text" id="hcmt-' + agentName + '-' + origIdx + '" placeholder="Add comment..." style="flex:1;font-size:9px;padding:2px 6px;background:#0a0a14;border:1px solid #2a2a3a;border-radius:3px;color:#c0c0c0;font-family:inherit;" onclick="event.stopPropagation()">'
        html += '<span style="cursor:pointer;color:#4ade80;font-size:9px;font-weight:600;" onclick="sendHistoryComment(\'' + agentName + '\', ' + origIdx + ')">Send</span>'
        html += '</div>'
      }
      html += '</div>'
    }
    histEl.innerHTML = html
  } catch (err) {
    histEl.innerHTML = '<div style="color:#ef4444;font-size:10px;">Error loading history: ' + err + '</div>'
  }
}

function revertDirective(agentName, historyIndex) {
  const agent = projectRows[agentName]
  if (!agent || !agent.projectId) return
  fetch('/api/projects/' + agent.projectId + '/directive-history').then(r => r.json()).then(history => {
    if (!history[historyIndex]) return
    const text = history[historyIndex].text
    if (!confirm('Revert directive to:\n\n"' + text.slice(0, 200) + '"\n\nThis will restart the supervisor.')) return
    agent.directiveText.value = text
    agent.directiveText._userEdited = true
    saveDirective(agentName)
  })
}

async function sendHistoryComment(agentName, historyIndex) {
  const agent = projectRows[agentName]
  if (!agent || !agent.projectId) { alert('Project not found'); return }
  const input = document.getElementById('hcmt-' + agentName + '-' + historyIndex)
  if (!input) return
  const comment = input.value.trim()
  if (!comment) { alert('Please enter a comment.'); return }
  try {
    const res = await apiFetch('/api/projects/' + agent.projectId + '/directive-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment, historyIndex }),
    })
    const data = await res.json()
    if (data.ok) {
      input.value = ''
      addLogEntry(agent.supervisorLog, 'status', 'Comment sent on historical directive entry.')
      loadHistory(agentName)
    } else {
      alert('Failed: ' + (data.error || 'Unknown error'))
    }
  } catch (err) {
    alert('Error: ' + err)
  }
}

// Fetch available Ollama models and populate selects
let ollamaModels = []
async function refreshOllamaModels() {
  try {
    const res = await fetch('/api/ollama-models')
    const data = await res.json()
    ollamaModels = data.models || []
    for (const [name, agent] of Object.entries(projectRows)) {
      if (!agent.modelSelect) continue
      const current = agent.modelSelect.value
      while (agent.modelSelect.options.length > 1) agent.modelSelect.remove(1)
      for (const m of ollamaModels) {
        const opt = document.createElement('option')
        opt.value = m.name
        const params = m.parameterSize || ''
        const quant = m.quantization || ''
        const detail = [params, quant].filter(Boolean).join(', ')
        opt.textContent = m.name + (detail ? ' (' + detail + ')' : '')
        agent.modelSelect.appendChild(opt)
      }
      if (current) agent.modelSelect.value = current
    }
  } catch {}
}
refreshOllamaModels()
setInterval(refreshOllamaModels, 60000)

// Remove project
async function removeProject(agentName) {
  if (!confirm('Remove project "' + agentName + '"? This will stop the agent and supervisor.')) return
  try {
    let projectId = projectRows[agentName]?.projectId
    if (!projectId) {
      const res = await fetch('/api/projects')
      if (!res.ok) throw new Error('Failed to fetch projects')
      const projects = await res.json()
      const proj = projects.find(p =>
        p.agentName === agentName ||
        p.name === agentName ||
        (p.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') === agentName
      )
      if (!proj) {
        alert('Could not find project for agent: ' + agentName)
        return
      }
      projectId = proj.id
    }
    const delRes = await apiFetch('/api/projects/' + projectId, { method: 'DELETE' })
    if (!delRes.ok) {
      const err = await delRes.json().catch(() => ({}))
      alert('Failed to remove: ' + (err.error || delRes.status))
      return
    }
    // Mark as removed so polling/events don't re-create the row
    removedAgents.add(agentName)
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

// ---- Pause / Resume ----

async function getProjectId(agentName) {
  let projectId = projectRows[agentName]?.projectId
  if (!projectId) {
    const res = await fetch('/api/projects')
    if (!res.ok) return null
    const projects = await res.json()
    const proj = projects.find(p => p.agentName === agentName || p.name === agentName)
    if (proj) projectId = proj.id
  }
  return projectId
}

async function togglePause(agentName) {
  const projectId = await getProjectId(agentName)
  if (!projectId) { alert('Cannot find project for ' + agentName); return }
  const agent = projectRows[agentName]
  const isPaused = agent?.supervisorStatus === 'paused'
  const endpoint = isPaused ? 'resume' : 'pause'
  try {
    const res = await apiFetch('/api/projects/' + projectId + '/' + endpoint, { method: 'POST' })
    if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Failed'); return }
  } catch (err) { alert('Error: ' + err) }
}

async function pauseAll() {
  try {
    const res = await apiFetch('/api/pause-all', { method: 'POST' })
    if (!res.ok) { const err = await res.json().catch(() => ({})); showNotification('Pause all failed: ' + (err.error || res.status), 'error') }
  } catch (err) { showNotification('Pause all error: ' + err, 'error') }
}

async function resumeAll() {
  try {
    const res = await apiFetch('/api/resume-all', { method: 'POST' })
    if (!res.ok) { const err = await res.json().catch(() => ({})); showNotification('Resume all failed: ' + (err.error || res.status), 'error') }
  } catch (err) { showNotification('Resume all error: ' + err, 'error') }
}

// Update pause button text based on status
function updatePauseUI(agentName, pauseStatus, pauseRequestedAt) {
  const btn = document.getElementById('pausebtn-' + agentName)
  const badge = document.getElementById('pausebadge-' + agentName)
  if (!btn) return
  if (pauseStatus === 'requested') {
    btn.textContent = 'Resume'
    btn.style.color = '#22d3ee'
    btn.style.borderColor = '#22d3ee'
    if (badge) {
      badge.style.display = 'inline'
      badge.className = 'agent-badge'
      badge.style.background = '#f59e0b'
      badge.style.color = '#000'
      badge.style.fontSize = '9px'
      const ago = pauseRequestedAt ? Math.round((Date.now() - pauseRequestedAt) / 1000) : 0
      badge.textContent = 'PAUSING...'
      badge.title = 'Requested ' + ago + 's ago'
    }
    // Hide supervisor badge — pause badge shows the state
    const sBadge = document.getElementById('sbadge-' + agentName)
    if (sBadge) sBadge.style.display = 'none'
  } else if (pauseStatus === 'paused') {
    btn.textContent = 'Resume'
    btn.style.color = '#22d3ee'
    btn.style.borderColor = '#22d3ee'
    if (badge) {
      badge.style.display = 'inline'
      badge.className = 'agent-badge badge-paused'
      badge.textContent = 'PAUSED'
      badge.style.fontSize = '9px'
    }
    // Hide supervisor badge — pause badge already shows the state
    const sBadge = document.getElementById('sbadge-' + agentName)
    if (sBadge) sBadge.style.display = 'none'
    // Add amber left border to project row
    const row = document.getElementById('row-' + agentName)
    if (row) row.style.borderLeft = '3px solid #f59e0b'
  } else {
    btn.textContent = 'Pause'
    btn.style.color = '#f59e0b'
    btn.style.borderColor = '#f59e0b'
    if (badge) badge.style.display = 'none'
    // Restore supervisor badge visibility
    const sBadge = document.getElementById('sbadge-' + agentName)
    if (sBadge) sBadge.style.display = ''
    const row = document.getElementById('row-' + agentName)
    if (row) row.style.borderLeft = ''
  }
}

// ---- Prompt Ledger ----

let ledgerOffset = 0
const LEDGER_PAGE_SIZE = 25

window.refreshLedger = async function() {
  ledgerOffset = 0
  await loadLedgerPage()
}

async function loadLedgerPage() {
  const source = document.getElementById('ledger-source')?.value || ''
  const agentName = document.getElementById('ledger-agent')?.value || ''
  const search = document.getElementById('ledger-search')?.value || ''
  const params = new URLSearchParams()
  if (source) params.set('source', source)
  if (agentName) params.set('agentName', agentName)
  if (search) params.set('search', search)
  params.set('limit', String(LEDGER_PAGE_SIZE))
  params.set('offset', String(ledgerOffset))

  try {
    const res = await fetch('/api/ledger?' + params)
    if (!res.ok) return
    const data = await res.json()
    const tbody = document.getElementById('ledger-rows')
    if (!tbody) return
    tbody.innerHTML = ''
    for (const e of data.entries) {
      const tr = document.createElement('tr')
      tr.style.borderBottom = '1px solid #1a1a2a'
      const t = new Date(e.timestamp)
      const time = t.toLocaleTimeString()
      const srcColor = { user: '#4ade80', brain: '#60a5fa', supervisor: '#facc15', manager: '#fb923c', agent: '#c084fc', system: '#888' }[e.source] || '#888'
      tr.innerHTML = '<td style="padding:3px 4px;color:#666;white-space:nowrap;">' + time + '</td>'
        + '<td style="padding:3px 4px;color:' + srcColor + ';">' + escapeHtml(e.source) + '</td>'
        + '<td style="padding:3px 4px;color:#666;">' + (e.direction === 'outbound' ? '&rarr;' : '&larr;') + '</td>'
        + '<td style="padding:3px 4px;color:#ccc;">' + escapeHtml(e.agentName || '-') + '</td>'
        + '<td style="padding:3px 4px;color:#aaa;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(e.content.slice(0, 200)) + '</td>'
        + '<td style="padding:3px 4px;color:#666;">' + (e.tags || []).join(', ') + '</td>'
      tbody.appendChild(tr)
    }
    document.getElementById('ledger-total').textContent = data.total + ' entries'
    const page = Math.floor(ledgerOffset / LEDGER_PAGE_SIZE) + 1
    const pages = Math.ceil(data.total / LEDGER_PAGE_SIZE)
    document.getElementById('ledger-page-info').textContent = 'Page ' + page + ' / ' + Math.max(1, pages)
    document.getElementById('ledger-prev').disabled = ledgerOffset <= 0
    document.getElementById('ledger-next').disabled = ledgerOffset + LEDGER_PAGE_SIZE >= data.total
  } catch {}
}

window.ledgerPage = function(dir) {
  ledgerOffset = Math.max(0, ledgerOffset + dir * LEDGER_PAGE_SIZE)
  loadLedgerPage()
}

// ---- A/B Test Modal ----

let abTestProjectName = ''

async function openABTestModal(agentName) {
  abTestProjectName = agentName
  const projectId = await getProjectId(agentName)
  document.getElementById('ab-project-id').value = projectId || ''
  // Load current directive into both textareas
  const agent = projectRows[agentName]
  const directive = agent?.directive || ''
  document.getElementById('ab-directive-a').value = directive
  document.getElementById('ab-directive-b').value = directive
  // Load models from all enabled providers
  try {
    const res = await apiFetch('/api/models')
    if (res.ok) {
      const data = await res.json()
      const selA = document.getElementById('ab-model-a')
      const selB = document.getElementById('ab-model-b')
      selA.innerHTML = ''
      selB.innerHTML = ''
      var lastProvider = ''
      for (const m of data.models || []) {
        var value = m.provider === 'ollama' ? m.model : m.provider + ':' + m.model
        var label = m.providerName + ' / ' + m.model
        if (m.provider !== lastProvider) {
          selA.innerHTML += '<option disabled>── ' + m.providerName + ' ──</option>'
          selB.innerHTML += '<option disabled>── ' + m.providerName + ' ──</option>'
          lastProvider = m.provider
        }
        selA.innerHTML += '<option value="' + value + '">' + label + '</option>'
        selB.innerHTML += '<option value="' + value + '">' + label + '</option>'
      }
    }
  } catch {}
  document.getElementById('ab-test-modal').style.display = 'flex'
}

function closeABTestModal() {
  document.getElementById('ab-test-modal').style.display = 'none'
}

async function startABTest() {
  const projectId = document.getElementById('ab-project-id').value
  if (!projectId) { alert('No project ID'); return }
  const body = {
    variants: [
      {
        model: document.getElementById('ab-model-a').value,
        directive: document.getElementById('ab-directive-a').value,
        maxCycles: parseInt(document.getElementById('ab-cycles-a').value) || 3,
      },
      {
        model: document.getElementById('ab-model-b').value,
        directive: document.getElementById('ab-directive-b').value,
        maxCycles: parseInt(document.getElementById('ab-cycles-b').value) || 3,
      },
    ],
  }
  try {
    const res = await apiFetch('/api/projects/' + projectId + '/ab-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      alert('Failed to start A/B test: ' + (err.error || res.status))
      return
    }
    closeABTestModal()
    alert('A/B test started! Check the brain log for progress updates.')
  } catch (err) {
    alert('Error: ' + err)
  }
}

// Permission reply handler
async function replyPermission(agent, requestID, decision, elemId) {
  try {
    const res = await apiFetch('/api/permissions/' + agent + '/' + requestID, {
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
    const res = await apiFetch('/api/prompt/' + agentName, {
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
  document.getElementById('proj-dir').value = ''
  document.getElementById('proj-name').value = ''
  document.getElementById('proj-directive').value = ''
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
    const res = await apiFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: dir, name: name || undefined, directive: directive || undefined }),
    })
    if (!res.ok) {
      alert('Failed to add project: server returned ' + res.status)
      btn.disabled = false
      btn.textContent = 'Add Project'
      return
    }
    const data = await res.json()
    if (data.ok) {
      closeAddProject()
      document.getElementById('proj-dir').value = ''
      document.getElementById('proj-name').value = ''
      document.getElementById('proj-directive').value = ''
      // Clear removed-agents guard so new/re-added projects can appear
      removedAgents.clear()
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
  const current = document.getElementById('proj-dir').value.trim() || (navigator.platform.startsWith('Win') ? 'C:\\Users' : '/')
  await loadBrowse(current)
}

async function loadBrowse(path) {
  try {
    const res = await fetch('/api/browse?path=' + encodeURIComponent(path))
    if (!res.ok) {
      browsePanel.innerHTML = '<div class="browse-item">Error loading directory (HTTP ' + res.status + ')</div>'
      browsePanel.classList.add('open')
      return
    }
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

// Check for crash info on startup
fetch('/api/crash-info').then(r => r.ok ? r.json() : null).then(data => {
  if (data && data.crashed && data.state) {
    const sv = data.state.supervisors || {}
    const svNames = Object.keys(sv)
    const startTime = new Date(data.state.startedAt).toLocaleString()
    const lastBeat = new Date(data.state.lastHeartbeat).toLocaleString()

    // Show crash banner in brain log
    const banner = document.createElement('div')
    banner.style.cssText = 'background:#3a1a1a;border:1px solid #ef4444;border-radius:6px;padding:10px 14px;margin:4px 0;'
    let html = '<div style="color:#ef4444;font-weight:700;font-size:12px;margin-bottom:6px;">Previous session crashed (PID ' + data.state.pid + ')</div>'
    html += '<div style="color:#fca5a5;font-size:11px;line-height:1.6;">'
    html += 'Started: ' + escapeHtml(startTime) + '<br>'
    html += 'Last heartbeat: ' + escapeHtml(lastBeat) + '<br>'
    if (svNames.length > 0) {
      html += '<div style="margin-top:4px;font-weight:600;">Supervisors at crash:</div>'
      for (const name of svNames) {
        const s = sv[name]
        const statusColor = s.status === 'error' ? '#ef4444' : s.status === 'done' ? '#60a5fa' : '#4ade80'
        html += '<div style="margin-left:8px;">'
        html += '<span style="color:' + statusColor + ';font-weight:600;">' + escapeHtml(name) + '</span>'
        html += ' — cycle #' + s.cycleNumber + ' (' + s.status + ')'
        if (s.lastSummary) {
          html += '<div style="color:#999;font-size:10px;margin-left:12px;max-height:40px;overflow:hidden;">' + escapeHtml(s.lastSummary.slice(0, 200)) + '</div>'
        }
        html += '</div>'
      }
    }
    html += '</div>'
    banner.innerHTML = html
    appendToLog(brainLog, banner)
    // Open brain panel so the crash banner is visible
    if (!document.getElementById('brain-section').classList.contains('open')) {
      document.getElementById('brain-section').classList.add('open')
    }
  }
}).catch(() => {})

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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && addProjectModal.classList.contains('open')) {
    closeAddProject()
  }
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
      const res = await apiFetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      })
      if (!res.ok) {
        cmdStatus.textContent = 'server error: ' + res.status
        cmdStatus.style.color = '#ef4444'
        return
      }
      const data = await res.json()
      if (data.ok) {
        cmdStatus.textContent = data.output ? 'done' : 'sent'
        cmdStatus.style.color = '#4ade80'
        if (!data.output) showNotification('Command sent', 'success', 2000)
        if (data.output) {
          const entry = document.createElement('div')
          entry.style.color = '#8b8bff'
          entry.textContent = '> ' + cmd + '\n' + data.output
          entry.style.whiteSpace = 'pre-wrap'
          appendToLog(brainLog, entry)
        }
      } else {
        cmdStatus.textContent = data.error || 'error'
        cmdStatus.style.color = '#ef4444'
        showNotification(data.error || 'Command failed', 'error')
      }
    } catch (err) {
      cmdStatus.textContent = 'network error'
      cmdStatus.style.color = '#ef4444'
      showNotification('Network error: ' + err, 'error')
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

// Keep aria-expanded in sync for all collapsible section headers
const ariaObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.attributeName === 'class') {
      const section = m.target
      const isOpen = section.classList.contains('open')
      const header = section.querySelector('.brain-header, .project-row-header')
      if (header && header.hasAttribute('aria-expanded')) {
        header.setAttribute('aria-expanded', String(isOpen))
      }
    }
  }
})
document.querySelectorAll('.brain-section, .project-row').forEach(el => {
  ariaObserver.observe(el, { attributes: true, attributeFilter: ['class'] })
})

// Long-polling event loop with connection state tracking
let pollConsecutiveFailures = 0
async function pollEvents() {
  while (true) {
    try {
      const res = await fetch('/api/events?since=' + cursor)
      if (!res.ok) {
        pollConsecutiveFailures++
        if (pollConsecutiveFailures >= 3) setConnectionState('disconnected')
        else setConnectionState('degraded')
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      const data = await res.json()
      cursor = data.cursor
      for (const event of data.events) {
        handleEvent(event)
      }
      // Successful poll — only set connected if not in SSE disconnect state
      // SSE disconnect is tracked by sseConnected=false while sseSource was previously active
      if (sseConnected || !sseSource) {
        // Either SSE is connected, or we don't use SSE — poll success means connected
        setConnectionState('connected')
      }
      pollConsecutiveFailures = 0
    } catch (err) {
      pollConsecutiveFailures++
      if (pollConsecutiveFailures >= 3) setConnectionState('disconnected')
      else setConnectionState('degraded')
      console.error('[orchestrator-dashboard] Poll event error:', err)
      // If handleEvent threw, cursor hasn't advanced — skip stale events by advancing cursor
      // so we don't get stuck in a loop crashing on the same bad event
      if (cursor === 0) cursor = Date.now()
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}
// Start poll loop with crash recovery — if pollEvents throws out of the while loop,
// restart it after a delay
function startPolling() {
  pollEvents().catch(err => {
    console.error('[orchestrator-dashboard] Poll loop exited unexpectedly:', err)
    showNotification('Event stream crashed — reconnecting...', 'error')
    setTimeout(startPolling, 5000)
  })
}
startPolling()

// ---- LLM Providers ----
var ollamaAvailableModels = [] // cached from /api/ollama-models

async function refreshProviders() {
  try {
    const res = await apiFetch('/api/providers')
    const data = await res.json()
    const container = document.getElementById('providers-list')
    if (!data.providers || data.providers.length === 0) {
      container.innerHTML = '<em style="color:#555;">No providers configured</em>'
      return
    }
    // Pre-fetch Ollama models for the picker
    try {
      var modelsRes = await apiFetch('/api/ollama-models')
      var modelsData = await modelsRes.json()
      ollamaAvailableModels = (modelsData.models || []).map(function(m) { return m.name })
    } catch (e) { ollamaAvailableModels = [] }

    const rows = data.providers.map(function(p) {
      var statusColor = p.enabled ? '#10b981' : '#666'
      var statusText = p.enabled ? 'ON' : 'OFF'
      var keyStatus = p.hasKey ? '<span style="color:#10b981;">key set</span>' : '<span style="color:#ef4444;">no key</span>'
      if (p.id === 'ollama') keyStatus = '<span style="color:#888;">local</span>'
      var models = p.models.length > 0 ? p.models.join(', ') : '(none)'
      var urlLabel = p.baseUrl ? '<span style="color:#555;font-size:9px;" title="' + escapeHtml(p.baseUrl) + '">' + escapeHtml(p.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')) + '</span>' : ''
      // For Ollama: show a select dropdown; for others: text prompt
      var addModelBtn = p.id === 'ollama'
        ? '<select id="ollama-model-picker" onchange="addOllamaModel(this)" style="background:#0f0f1a;border:1px solid #666;color:#888;padding:1px 4px;font-size:9px;border-radius:3px;cursor:pointer;max-width:120px;">' +
          '<option value="">+Model</option>' +
          ollamaAvailableModels.filter(function(m) { return p.models.indexOf(m) === -1 }).map(function(m) {
            return '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>'
          }).join('') +
          '</select>'
        : '<button onclick="promptAddModel(\'' + p.id + '\')" style="background:none;border:1px solid #666;color:#888;padding:1px 6px;font-size:9px;border-radius:3px;cursor:pointer;">+Model</button>'
      return '<div style="padding:6px 0;border-bottom:1px solid #1a1a2e;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
        '<button onclick="toggleProvider(\'' + p.id + '\',' + !p.enabled + ')" style="background:none;border:1px solid ' + statusColor + ';color:' + statusColor + ';padding:1px 6px;font-size:9px;border-radius:3px;cursor:pointer;min-width:28px;">' + statusText + '</button>' +
        '<span style="color:#06b6d4;font-weight:bold;min-width:80px;">' + escapeHtml(p.name) + '</span>' +
        urlLabel +
        '<span style="color:#888;font-size:10px;">' + keyStatus + '</span>' +
        (p.id !== 'ollama' ? '<button onclick="promptApiKey(\'' + p.id + '\',\'' + p.name + '\')" style="background:none;border:1px solid #666;color:#888;padding:1px 6px;font-size:9px;border-radius:3px;cursor:pointer;">Key</button>' : '') +
        addModelBtn +
        '</div>' +
        '<div style="color:#aaa;font-size:10px;margin-top:2px;padding-left:36px;">' + escapeHtml(models) + '</div>' +
        '</div>'
    }).join('')
    container.innerHTML = rows
  } catch (err) {
    document.getElementById('providers-list').innerHTML = '<em style="color:#ef4444;">Error: ' + err + '</em>'
  }
}

async function addOllamaModel(selectEl) {
  var model = selectEl.value
  if (!model) return
  selectEl.value = '' // reset dropdown
  try {
    await apiFetch('/api/providers/ollama/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model })
    })
    refreshProviders()
  } catch (err) { alert('Error: ' + err) }
}

async function toggleProvider(id, enabled) {
  try {
    await apiFetch('/api/providers/' + id + '/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    })
    refreshProviders()
  } catch (err) { alert('Error: ' + err) }
}

async function promptApiKey(id, name) {
  var key = prompt('Enter API key for ' + name + ':')
  if (key === null) return
  try {
    await apiFetch('/api/providers/' + id + '/apikey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key })
    })
    refreshProviders()
  } catch (err) { alert('Error: ' + err) }
}

async function promptAddModel(providerId) {
  var model = prompt('Enter model name to add:')
  if (!model) return
  try {
    await apiFetch('/api/providers/' + providerId + '/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model })
    })
    refreshProviders()
  } catch (err) { alert('Error: ' + err) }
}

async function addCustomProvider() {
  var id = document.getElementById('new-provider-id').value.trim()
  var name = document.getElementById('new-provider-name').value.trim()
  var baseUrl = document.getElementById('new-provider-url').value.trim()
  var type = document.getElementById('new-provider-type').value
  var apiKey = document.getElementById('new-provider-key').value
  var modelsStr = document.getElementById('new-provider-models').value.trim()
  if (!id || !name || !baseUrl) { alert('ID, Name, and Base URL are required'); return }
  var models = modelsStr ? modelsStr.split(',').map(function(m) { return m.trim() }).filter(Boolean) : []
  try {
    await apiFetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, name: name, baseUrl: baseUrl, type: type, apiKey: apiKey, models: models, enabled: true })
    })
    document.getElementById('new-provider-id').value = ''
    document.getElementById('new-provider-name').value = ''
    document.getElementById('new-provider-url').value = ''
    document.getElementById('new-provider-key').value = ''
    document.getElementById('new-provider-models').value = ''
    refreshProviders()
  } catch (err) { alert('Error: ' + err) }
}

// ---- Event Bus ----
async function refreshBusEvents() {
  const typeFilter = document.getElementById('bus-type-filter').value
  let url = '/api/events/bus/recent?limit=100'
  if (typeFilter) url += '&type=' + encodeURIComponent(typeFilter)
  try {
    const res = await apiFetch(url)
    const events = await res.json()
    const container = document.getElementById('bus-events')
    const countEl = document.getElementById('bus-count')
    countEl.textContent = events.length + ' events'
    if (events.length === 0) {
      container.innerHTML = '<em style="color:#555;">No events</em>'
      return
    }
    const rows = events.map(e => {
      const time = new Date(e.timestamp).toLocaleTimeString()
      const typeColor = e.type.includes('warning') || e.type.includes('contention') ? '#f97316' :
        e.type.includes('stop') || e.type.includes('false') ? '#ef4444' :
        e.type.includes('done') || e.type.includes('merged') ? '#10b981' : '#8b5cf6'
      const data = JSON.stringify(e.data).slice(0, 120)
      return '<div style="padding:3px 0;border-bottom:1px solid #1a1a2e;">' +
        '<span style="color:#666;margin-right:8px;">' + time + '</span>' +
        '<span style="color:' + typeColor + ';margin-right:8px;font-weight:bold;">' + e.type + '</span>' +
        (e.agentName ? '<span style="color:#22d3ee;margin-right:8px;">' + e.agentName + '</span>' : '') +
        '<span style="color:#555;">' + data + '</span>' +
        '</div>'
    }).join('')
    container.innerHTML = rows
  } catch (err) {
    document.getElementById('bus-events').innerHTML = '<em style="color:#ef4444;">Error: ' + err + '</em>'
  }
}

// ---- Resources ----
async function refreshResources() {
  try {
    const res = await apiFetch('/api/resources/locks')
    const data = await res.json()
    const llmEl = document.getElementById('llm-status')
    llmEl.innerHTML = '<span style="color:#8b5cf6;">LLM Slots:</span> ' +
      data.llmActive + '/' + data.llmMax + ' active' +
      (data.llmQueueDepth > 0 ? ', <span style="color:#f97316;">' + data.llmQueueDepth + ' waiting</span>' : '')

    const locksEl = document.getElementById('file-locks')
    const lockEntries = Object.entries(data.locks)
    if (lockEntries.length === 0) {
      locksEl.innerHTML = '<em style="color:#555;">No active file locks</em>'
      return
    }
    const rows = lockEntries.map(([agent, lock]) => {
      const files = lock.files.slice(0, 5).join(', ') + (lock.files.length > 5 ? '...' : '')
      const age = Math.round((Date.now() - lock.acquiredAt) / 1000)
      return '<div style="padding:3px 0;border-bottom:1px solid #1a1a2e;">' +
        '<span style="color:#22d3ee;margin-right:8px;">' + agent + '</span>' +
        '<span style="color:#aaa;">' + files + '</span>' +
        '<span style="color:#666;margin-left:8px;">(' + age + 's ago)</span></div>'
    }).join('')
    locksEl.innerHTML = rows
  } catch (err) {
    document.getElementById('file-locks').innerHTML = '<em style="color:#ef4444;">Error: ' + err + '</em>'
  }
}

// ---- Work Intents ----
async function refreshIntents() {
  try {
    const res = await apiFetch('/api/resources/intents')
    const data = await res.json()
    const container = document.getElementById('intents-list')
    const entries = Object.entries(data.intents)
    if (entries.length === 0) {
      container.innerHTML = '<em style="color:#555;">No declared work intents</em>'
      return
    }
    const rows = entries.map(function(entry) {
      var agent = entry[0], intent = entry[1]
      var files = intent.files.length > 0
        ? intent.files.slice(0, 8).join(', ') + (intent.files.length > 8 ? '...' : '')
        : '(no specific files)'
      var age = Math.round((Date.now() - intent.declaredAt) / 1000)
      return '<div style="padding:4px 0;border-bottom:1px solid #1a1a2e;">' +
        '<span style="color:#22d3ee;font-weight:bold;margin-right:8px;">' + agent + '</span>' +
        '<span style="color:#e2e8f0;">' + intent.description + '</span><br>' +
        '<span style="color:#f59e0b;font-size:10px;margin-left:12px;">files: ' + files + '</span>' +
        '<span style="color:#666;margin-left:8px;font-size:10px;">(' + age + 's ago)</span></div>'
    }).join('')
    container.innerHTML = rows
  } catch (err) {
    document.getElementById('intents-list').innerHTML = '<em style="color:#ef4444;">Error: ' + err + '</em>'
  }
}

// ---- Team Hierarchy ----
async function refreshTeam() {
  const container = document.getElementById('team-content')
  try {
    const res = await fetch('/api/team/members')
    const data = await res.json()
    if (!data.active) {
      container.innerHTML = '<em style="color:#555;">Team mode is not active. Start with "team-loop" command to enable.</em>'
      return
    }
    const members = data.members || []
    if (members.length === 0) {
      container.innerHTML = '<em style="color:#555;">No team members yet.</em>'
      return
    }

    // Build a visual tree: Manager at top, members branching below
    let html = '<div style="display:flex;flex-direction:column;align-items:center;gap:0;">'

    // Manager node
    html += '<div style="background:#2a1a3a;border:2px solid #d946ef;border-radius:8px;padding:8px 16px;text-align:center;min-width:160px;">'
    html += '<div style="font-size:10px;color:#d946ef;text-transform:uppercase;font-weight:700;">Manager</div>'
    html += '<div style="font-size:13px;color:#e0e0e0;font-weight:600;">Team Orchestrator</div>'
    html += '</div>'

    // Connector line
    html += '<div style="width:2px;height:16px;background:#d946ef;"></div>'

    // Horizontal connector bar
    if (members.length > 1) {
      html += '<div style="height:2px;background:#d946ef;width:' + Math.min(members.length * 160, 600) + 'px;max-width:90%;"></div>'
    }

    // Member nodes in a row
    html += '<div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:0;">'
    for (const m of members) {
      const statusColor = m.status === 'idle' ? '#4ade80' : m.status === 'busy' || m.status === 'running' ? '#facc15' : m.status === 'error' ? '#ef4444' : m.status === 'paused' ? '#f59e0b' : m.status === 'completed' || m.status === 'done' ? '#60a5fa' : '#888'
      const statusLabel = (m.status || 'unknown').toUpperCase()
      html += '<div style="display:flex;flex-direction:column;align-items:center;">'
      // Vertical connector from bar to node
      html += '<div style="width:2px;height:12px;background:#d946ef;"></div>'
      // Member card
      html += '<div style="background:#1a1a2e;border:1px solid #3a3a5a;border-radius:6px;padding:8px 12px;min-width:140px;text-align:center;">'
      html += '<div style="font-size:10px;color:#c084fc;text-transform:uppercase;font-weight:600;">' + escapeHtml(m.role || 'member') + '</div>'
      html += '<div style="font-size:12px;color:#e0e0e0;font-weight:600;margin:2px 0;">' + escapeHtml(m.agentName) + '</div>'
      html += '<div style="display:flex;align-items:center;justify-content:center;gap:4px;margin-top:4px;">'
      html += '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + statusColor + ';" aria-hidden="true"></span>'
      html += '<span style="font-size:9px;color:' + statusColor + ';font-weight:600;">' + statusLabel + '</span>'
      html += '</div>'
      // Directive snippet
      if (m.directive) {
        html += '<div style="font-size:9px;color:#666;margin-top:4px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(m.directive) + '">' + escapeHtml(m.directive.slice(0, 50)) + '</div>'
      }
      // Last summary
      if (m.recentSummary) {
        html += '<div style="font-size:9px;color:#555;margin-top:2px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(m.recentSummary) + '">' + escapeHtml(m.recentSummary.slice(0, 50)) + '</div>'
      }
      html += '</div></div>'
    }
    html += '</div></div>'

    // Hire requests
    const hireRes = await fetch('/api/team/hire-requests')
    const hireReqs = hireRes.ok ? await hireRes.json() : []
    if (hireReqs.length > 0) {
      html += '<div style="margin-top:12px;border-top:1px solid #2a2a3a;padding-top:8px;">'
      html += '<div style="font-size:11px;color:#f59e0b;font-weight:600;margin-bottom:4px;">Pending Hire Requests (' + hireReqs.length + ')</div>'
      for (const r of hireReqs) {
        html += '<div style="font-size:11px;color:#aaa;padding:2px 0;">' + escapeHtml(r.role) + ' at ' + escapeHtml(r.directory || '?') + '</div>'
      }
      html += '</div>'
    }

    container.innerHTML = html
  } catch (err) {
    container.innerHTML = '<em style="color:#ef4444;">Error loading team data: ' + err + '</em>'
  }
}

// ---- Live Event Stream (SSE) ----
let sseSource = null
let sseConnected = false
let sseReconnectDelay = 1000 // Start with 1s, exponential backoff up to 60s
const SSE_MAX_DELAY = 60000
const SSE_BASE_DELAY = 1000

function toggleSSE() {
  if (sseConnected) disconnectSSE()
  else connectSSE()
}

function connectSSE() {
  const typeFilter = document.getElementById('sse-type-filter').value
  const url = '/api/events/stream' + (typeFilter ? '?type=' + encodeURIComponent(typeFilter) : '')
  sseSource = new EventSource(url)
  sseSource.onopen = function() {
    sseConnected = true
    sseReconnectDelay = SSE_BASE_DELAY // Reset backoff on successful connection
    setConnectionState('connected')
    document.getElementById('sse-status').textContent = 'connected'
    document.getElementById('sse-status').style.color = '#22c55e'
    document.getElementById('sse-toggle-btn').textContent = 'Disconnect'
  }
  sseSource.onmessage = function(e) {
    try {
      const evt = JSON.parse(e.data)
      appendEventToLog(evt)
      if (evt.type === 'directive-updated' && evt.agentName) {
        const agent = projectRows[evt.agentName]
        if (agent && evt.data?.directive) {
          agent.directive = evt.data.directive
          if (agent.directiveText && !agent.directiveText._userEdited) {
            agent.directiveText.value = evt.data.directive
          }
        }
      }
    } catch {} // Intentionally silent: best-effort SSE event parsing
  }
  sseSource.onerror = function() {
    disconnectSSE()
    // Exponential backoff with jitter
    const delay = Math.min(sseReconnectDelay, SSE_MAX_DELAY) + Math.random() * 1000
    sseReconnectDelay = sseReconnectDelay * 2
    document.getElementById('sse-status').textContent = 'reconnecting...'
    document.getElementById('sse-status').style.color = '#f59e0b'
    setTimeout(function() { if (!sseConnected) connectSSE() }, delay)
  }
}

function disconnectSSE() {
  if (sseSource) { sseSource.close(); sseSource = null }
  sseConnected = false
  document.getElementById('sse-status').textContent = 'disconnected'
  document.getElementById('sse-status').style.color = '#555'
  document.getElementById('sse-toggle-btn').textContent = 'Connect'
}

function reconnectSSE() {
  if (sseConnected) { disconnectSSE(); connectSSE() }
}

function clearEventLog() {
  document.getElementById('live-event-log').innerHTML = '<em style="color:#555;">Log cleared</em>'
}

function appendEventToLog(evt) {
  const container = document.getElementById('live-event-log')
  // Remove placeholder
  if (container.querySelector('em')) container.innerHTML = ''
  const typeColors = {
    'cycle-start': '#22d3ee', 'cycle-done': '#22c55e',
    'agent-notification': '#f59e0b', 'intent-conflict': '#ef4444',
    'resource-contention': '#f97316', 'validation-result': '#8b5cf6',
    'false-progress-warning': '#ef4444', 'directive-updated': '#c084fc',
  }
  const color = typeColors[evt.type] || '#888'
  const time = new Date(evt.timestamp).toLocaleTimeString()
  const agent = evt.agentName ? ' <span style="color:#22d3ee;">' + evt.agentName + '</span>' : ''
  const summary = evt.data ? ' ' + JSON.stringify(evt.data).slice(0, 120) : ''
  const line = document.createElement('div')
  line.style.cssText = 'padding:2px 0;border-bottom:1px solid #111;'
  line.innerHTML = '<span style="color:#555;">' + time + '</span> ' +
    '<span style="color:' + color + ';">' + evt.type + '</span>' +
    agent + '<span style="color:#666;">' + summary + '</span>'
  container.appendChild(line)
  // Keep max 200 entries
  while (container.children.length > 200) container.removeChild(container.firstChild)
  container.scrollTop = container.scrollHeight
}

// ---- Auto-refresh: all panels refresh on a unified interval ----
// SSE auto-connects on page load
setTimeout(() => { connectSSE() }, 1500)

// ---- Check for saved projects to restore ----
setTimeout(async function() {
  try {
    const res = await apiFetch('/api/projects/saved')
    const saved = await res.json()
    if (!saved || saved.length === 0) return
    // Only show if no projects are currently active
    const activeRes = await apiFetch('/api/projects')
    const active = await activeRes.json()
    if (active && active.length > 0) return

    // Show restore banner
    var banner = document.createElement('div')
    banner.id = 'restore-banner'
    banner.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:24px 32px;z-index:300;box-shadow:0 8px 32px rgba(0,0,0,0.6);text-align:center;max-width:500px;'
    var names = saved.map(function(p) { return p.name }).join(', ')
    banner.innerHTML =
      '<div style="font-size:14px;color:#e0e0e0;margin-bottom:12px;font-weight:600;">Restore Previous Session?</div>' +
      '<div style="font-size:12px;color:#888;margin-bottom:16px;">Found ' + saved.length + ' saved project' + (saved.length > 1 ? 's' : '') + ':</div>' +
      '<div style="font-size:13px;color:#c084fc;margin-bottom:20px;word-break:break-word;">' + escapeHtml(names) + '</div>' +
      '<div style="display:flex;gap:12px;justify-content:center;">' +
        '<button id="restore-yes" style="background:#22c55e;color:#fff;border:none;padding:8px 24px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">Restore All</button>' +
        '<button id="restore-no" style="background:#333;color:#aaa;border:1px solid #555;padding:8px 24px;border-radius:6px;cursor:pointer;font-size:13px;">Start Fresh</button>' +
      '</div>'
    // Overlay
    var overlay = document.createElement('div')
    overlay.id = 'restore-overlay'
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:299;'
    document.body.appendChild(overlay)
    document.body.appendChild(banner)

    document.getElementById('restore-yes').onclick = async function() {
      this.disabled = true
      this.textContent = 'Restoring...'
      try {
        var rr = await apiFetch('/api/projects/restore', { method: 'POST' })
        var result = await rr.json()
        if (result.restored && result.restored.length > 0) {
          showNotification('Restored ' + result.restored.length + ' project' + (result.restored.length > 1 ? 's' : '') + ': ' + result.restored.join(', '), 'success')
        }
        if (result.failed && result.failed.length > 0) {
          showNotification('Failed to restore: ' + result.failed.join('; '), 'warning')
        }
      } catch (err) {
        showNotification('Restore failed: ' + err, 'error')
      }
      banner.remove()
      overlay.remove()
    }

    document.getElementById('restore-no').onclick = function() {
      banner.remove()
      overlay.remove()
    }
  } catch (e) { /* no saved projects or API not ready */ }
}, 2500)

// Refresh all data panels every 30 seconds
setInterval(() => {
  // Only refresh panels that are currently open to save bandwidth
  if (document.getElementById('perf-section')?.classList.contains('open')) refreshPerformance()
  if (document.getElementById('eventbus-section')?.classList.contains('open')) refreshBusEvents()
  if (document.getElementById('resources-section')?.classList.contains('open')) refreshResources()
  if (document.getElementById('intents-section')?.classList.contains('open')) refreshIntents()
}, 30000)

// ---- Per-project branch & validation UI helpers ----
async function mergeBranch(projectId) {
  if (!confirm('Merge agent branch into main?')) return
  // Find the merge button by looking for rows matching this projectId
  let mergeBtn = null
  for (const [name, agent] of Object.entries(projectRows)) {
    if (agent.projectId === projectId) {
      const row = document.getElementById('row-' + name)
      if (row) {
        const btns = row.querySelectorAll('.project-row-remove')
        for (const btn of btns) { if (btn.textContent.trim() === 'Merge') { mergeBtn = btn; break } }
      }
      break
    }
  }
  if (mergeBtn) { mergeBtn.disabled = true; mergeBtn.textContent = 'Merging...' }
  try {
    const res = await apiFetch('/api/projects/' + projectId + '/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetBranch: 'main' }),
    })
    const result = await res.json()
    if (result.success) {
      showNotification('Merge successful', 'success')
    } else {
      showNotification('Merge failed: ' + (result.output || 'Unknown error'), 'error')
    }
  } catch (err) { showNotification('Merge error: ' + err, 'error') }
  finally { if (mergeBtn) { mergeBtn.disabled = false; mergeBtn.textContent = 'Merge' } }
}

async function setValidation(projectId) {
  var choice = prompt('Validation preset or command.\nPresets: test, typecheck, lint, build, test+typecheck\nOr enter a custom command (e.g., "bun test"):\n\nEnter preset name or command:')
  if (!choice) return
  var presets = ['test', 'typecheck', 'lint', 'build', 'test+typecheck']
  var body = presets.includes(choice.trim().toLowerCase())
    ? { preset: choice.trim().toLowerCase(), failAction: 'inject' }
    : { command: choice, failAction: 'inject' }
  try {
    const res = await apiFetch('/api/projects/' + projectId + '/validation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      showNotification('Validation set: ' + (body.preset || body.command), 'success')
    } else {
      const err = await res.json().catch(() => ({}))
      showNotification('Failed to set validation: ' + (err.error || res.status), 'error')
    }
  } catch (err) { showNotification('Error: ' + err, 'error') }
}
