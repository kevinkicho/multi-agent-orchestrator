// ---------------------------------------------------------------------------
// Session state — crash detection and recovery checkpoint
// ---------------------------------------------------------------------------
// Writes a PID file on startup with the current process state.
// On next startup, if the PID file exists and the process is dead,
// we know the previous session crashed and offer recovery.
// Also provides periodic checkpoint saving so supervisors can resume
// from their last known cycle rather than starting from scratch.
// ---------------------------------------------------------------------------

import { resolve } from "path"
import { existsSync, unlinkSync } from "fs"
import { readJsonFile, writeJsonFile } from "./file-utils"

const STATE_FILE = ".orchestrator-session.json"

// Write lock to prevent concurrent read-modify-write races
// (heartbeat timer, parallel supervisor checkpoints, and shutdown all write to the same file)
let writeLock: Promise<void> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn, fn)
  writeLock = next.then(() => {}, () => {})
  return next
}

export type SupervisorCheckpoint = {
  agentName: string
  cycleNumber: number
  lastSummary: string
  directive: string
  status: "running" | "idle" | "done" | "error"
  updatedAt: number
}

export type SessionState = {
  pid: number
  startedAt: number
  lastHeartbeat: number
  dashboardPort: number
  mode: "projects" | "teams"
  /** Per-supervisor checkpoint so we can report and resume from last known state */
  supervisors: Record<string, SupervisorCheckpoint>
  /** Whether shutdown was clean (set to true during graceful shutdown) */
  cleanShutdown: boolean
}

function getStatePath(): string {
  return resolve(process.cwd(), STATE_FILE)
}

/** Read the previous session state file (if any) */
export async function loadSessionState(): Promise<SessionState | null> {
  return readJsonFile<SessionState | null>(getStatePath(), null)
}

/** Check if the previous session crashed (state file exists but process is dead or unclean) */
export async function detectCrash(): Promise<{
  crashed: boolean
  state: SessionState | null
}> {
  const state = await loadSessionState()
  if (!state) return { crashed: false, state: null }

  // If clean shutdown was recorded, no crash
  if (state.cleanShutdown) {
    return { crashed: false, state }
  }

  // Check if the old process is still running
  if (isProcessAlive(state.pid)) {
    // Previous instance is still running — not a crash, but a conflict
    return { crashed: false, state }
  }

  // Process is dead and shutdown wasn't clean → crash
  return { crashed: true, state }
}

/** Write a fresh session state file for the current process */
export async function initSessionState(opts: {
  dashboardPort: number
  mode: "projects" | "teams"
}): Promise<void> {
  const state: SessionState = {
    pid: process.pid,
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    dashboardPort: opts.dashboardPort,
    mode: opts.mode,
    supervisors: {},
    cleanShutdown: false,
  }
  await writeJsonFile(getStatePath(), state)
}

/** Update the heartbeat timestamp and optionally merge supervisor checkpoints */
export async function updateSessionHeartbeat(
  supervisors?: Record<string, SupervisorCheckpoint>,
): Promise<void> {
  await withWriteLock(async () => {
    const state = await loadSessionState()
    if (!state || state.pid !== process.pid) return
    state.lastHeartbeat = Date.now()
    if (supervisors) {
      state.supervisors = { ...state.supervisors, ...supervisors }
    }
    await writeJsonFile(getStatePath(), state)
  })
}

/** Save a checkpoint for a single supervisor (called after each cycle) */
export async function checkpointSupervisor(checkpoint: SupervisorCheckpoint): Promise<void> {
  await withWriteLock(async () => {
    const state = await loadSessionState()
    if (!state || state.pid !== process.pid) return
    state.lastHeartbeat = Date.now()
    state.supervisors[checkpoint.agentName] = checkpoint
    await writeJsonFile(getStatePath(), state)
  })
}

/** Mark the session as cleanly shut down */
export async function markCleanShutdown(): Promise<void> {
  await withWriteLock(async () => {
    const state = await loadSessionState()
    if (!state) return
    state.cleanShutdown = true
    await writeJsonFile(getStatePath(), state)
  })
}

/** Remove the session state file entirely */
export function removeSessionState(): void {
  try {
    const p = getStatePath()
    if (existsSync(p)) unlinkSync(p)
  } catch {}
}

/** Check if a process with the given PID is alive */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = test if process exists
    return true
  } catch (err) {
    // EPERM means the process exists but we can't signal it (different UID
    // or container namespace). Treat it as alive — otherwise crash detection
    // can falsely claim a live orchestrator has crashed and try to liberate
    // its port.
    return (err as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

/**
 * Find the PID of whatever is currently listening on the given TCP port.
 * Returns `null` if nothing is listening or the lookup fails.
 *
 * Uses `netstat -ano` on Windows and `lsof -ti` on unix. Best-effort —
 * callers should treat `null` as "can't tell" rather than "port is free."
 */
export async function findPortHolder(port: number): Promise<number | null> {
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(["netstat", "-ano", "-p", "tcp"], { stdout: "pipe", stderr: "ignore" })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/.test(line)) continue
        // "  TCP    0.0.0.0:4000    0.0.0.0:0    LISTENING    12345"
        const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/)
        if (m && parseInt(m[1]!, 10) === port) return parseInt(m[2]!, 10)
      }
      return null
    }
    const proc = Bun.spawn(["lsof", "-ti", `:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const first = out.trim().split(/\s+/)[0]
    return first ? parseInt(first, 10) : null
  } catch {
    return null
  }
}

/**
 * If `port` is still occupied by `prevState.pid`, terminate that process
 * and wait up to 5s for the OS to release the socket. Only acts when the
 * port holder's PID matches the recorded session — we refuse to kill a
 * random unrelated process that happens to occupy the port.
 *
 * Returns true if the port was successfully liberated (or was already free).
 */
export async function tryLiberatePort(port: number, prevState: SessionState | null): Promise<boolean> {
  if (!isPortBound(port)) return true
  if (!prevState || prevState.dashboardPort !== port) return false

  const holderPid = await findPortHolder(port)
  if (!holderPid) return false

  // Only kill if the holder matches the previous orchestrator's PID
  if (holderPid !== prevState.pid) {
    console.warn(`[startup] Port ${port} is held by PID ${holderPid}, which does not match the previous orchestrator (PID ${prevState.pid}). Leaving it alone.`)
    return false
  }

  console.log(`[startup] Port ${port} is held by orphaned orchestrator (PID ${holderPid}) — terminating it to free the port.`)
  try { process.kill(holderPid) } catch { /* already dead */ }

  // Poll up to 5s for the socket to release
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (!isPortBound(port)) return true
  }
  return !isPortBound(port)
}

/** Probe whether anything is currently bound to `port` on localhost. */
function isPortBound(port: number): boolean {
  try {
    const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") })
    probe.stop(true)
    return false
  } catch {
    return true
  }
}

/** Format a crash report for display */
export function formatCrashReport(state: SessionState): string {
  const startTime = new Date(state.startedAt).toLocaleString()
  const lastBeat = new Date(state.lastHeartbeat).toLocaleString()
  const supervisors = Object.values(state.supervisors)

  const lines: string[] = [
    `Previous session (PID ${state.pid}) did not shut down cleanly.`,
    `  Started:        ${startTime}`,
    `  Last heartbeat: ${lastBeat}`,
    `  Mode:           ${state.mode}`,
    `  Dashboard port: ${state.dashboardPort}`,
  ]

  if (supervisors.length > 0) {
    lines.push(`  Supervisors at time of crash:`)
    for (const sv of supervisors) {
      const age = timeSince(sv.updatedAt)
      lines.push(`    ${sv.agentName}: cycle #${sv.cycleNumber} (${sv.status}) — ${age} ago`)
      if (sv.lastSummary) {
        const summary = sv.lastSummary.length > 120
          ? sv.lastSummary.slice(0, 120) + "..."
          : sv.lastSummary
        lines.push(`      Last summary: ${summary}`)
      }
    }
  }

  return lines.join("\n")
}

function timeSince(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m`
  return `${Math.round(diff / 3600_000)}h`
}
