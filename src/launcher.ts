#!/usr/bin/env bun
/**
 * Launches all opencode serve instances + orchestrator in one command.
 * Reads from orchestrator.json for agent config.
 *
 * Usage: bun run src/launcher.ts [--auto-approve] [--dashboard-port 4000]
 */
import { spawn, type Subprocess } from "bun"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import type { AgentConfig } from "./agent"
import { resolveOpencode, buildOpencodeSpawnCmd, type OpencodeLaunch } from "./opencode-runtime"

type LauncherConfig = {
  agents: (AgentConfig & { model?: string })[]
  autoApprove?: boolean
  dashboardPort?: number
  brain?: { model?: string; ollamaUrl?: string }
}

function loadConfig(): LauncherConfig {
  const paths = [
    resolve(process.cwd(), "orchestrator.json"),
    resolve(import.meta.dirname, "..", "orchestrator.json"),
  ]
  for (const p of paths) {
    if (existsSync(p)) {
      console.log(`[launcher] Config: ${p}`)
      return JSON.parse(readFileSync(p, "utf-8"))
    }
  }
  throw new Error("No orchestrator.json found")
}

function extractPort(url: string): number {
  try {
    return parseInt(new URL(url).port, 10)
  } catch {
    return 0
  }
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/global/health`)
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function main() {
  const config = loadConfig()
  const procs: Subprocess[] = []
  // Forward all user-supplied CLI args to cli.ts verbatim. The previous
  // filter-based approach dropped the value after `--dashboard-port`,
  // resulting in `NaN` when a custom port was passed.
  const extraArgs = process.argv.slice(2)

  console.log("[launcher] === Multi-Agent Orchestrator Launcher ===")
  console.log(`[launcher] Starting ${config.agents.length} serve instances...\n`)

  // Resolve opencode binary (or source checkout via OPENCODE_DIR)
  let launch: OpencodeLaunch
  try {
    launch = resolveOpencode()
  } catch (err) {
    console.error(`[launcher] ${(err as Error).message}`)
    process.exit(1)
  }
  console.log(`[launcher] Using opencode ${launch.mode === "binary" ? `binary at ${launch.bin}` : `source at ${launch.cwd}`}\n`)

  // Launch serve instances
  for (const agent of config.agents) {
    const port = extractPort(agent.url)
    if (!port) {
      console.error(`[launcher] Invalid URL for ${agent.name}: ${agent.url}`)
      continue
    }

    console.log(`[launcher] Starting ${agent.name} on port ${port}...`)
    const proc = spawn({
      cmd: buildOpencodeSpawnCmd(launch, port),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_PROJECT_DIR: agent.directory,
      },
    })
    procs.push(proc)
  }

  // Wait for all servers to be ready
  console.log("\n[launcher] Waiting for servers to start...")
  const results = await Promise.all(
    config.agents.map(async (agent) => {
      const ok = await waitForServer(agent.url)
      if (ok) {
        console.log(`[launcher]   ${agent.name} ready at ${agent.url}`)
      } else {
        console.error(`[launcher]   ${agent.name} FAILED to start at ${agent.url}`)
      }
      return { name: agent.name, ok }
    }),
  )

  const allOk = results.every((r) => r.ok)
  if (!allOk) {
    console.error("\n[launcher] Some servers failed to start. Check logs above.")
    console.log("[launcher] Continuing with available servers...\n")
  }

  // Build CLI args for orchestrator. Config-derived args go first; the
  // user-supplied `extraArgs` are appended last so duplicated flags
  // (e.g. `--dashboard-port`) resolve in favor of the CLI override.
  const cliArgs: string[] = []
  for (const agent of config.agents) {
    cliArgs.push("--agent", `${agent.name}=${agent.url}=${agent.directory}`)
  }
  if (config.autoApprove) cliArgs.push("--auto-approve")
  if (config.dashboardPort) cliArgs.push("--dashboard-port", String(config.dashboardPort))
  cliArgs.push(...extraArgs)

  console.log("\n[launcher] Starting orchestrator...\n")

  // Launch orchestrator CLI in foreground (inherits stdio for interactive REPL)
  const orchestratorProc = spawn({
    cmd: ["bun", "run", resolve(import.meta.dirname, "cli.ts"), ...cliArgs],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  // Cleanup on exit — kill all child processes so ports are released
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    console.log("\n[launcher] Shutting down all processes...")
    try { orchestratorProc.kill() } catch {}
    for (const proc of procs) {
      try { proc.kill() } catch {}
    }
  }

  process.on("SIGINT", () => { cleanup(); process.exit(0) })
  process.on("SIGTERM", () => { cleanup(); process.exit(0) })
  process.on("SIGHUP", () => { cleanup(); process.exit(0) })
  process.on("uncaughtException", (err) => {
    console.error("[launcher] Uncaught:", err)
    cleanup()
    process.exit(1)
  })

  // Wait for orchestrator to exit, then clean up child serve processes
  await orchestratorProc.exited
  cleanup()
}

main().catch((err) => {
  console.error("[launcher] Fatal:", err)
  process.exit(1)
})
