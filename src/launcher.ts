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

const OPENCODE_BASE = process.env.OPENCODE_DIR
  ? resolve(process.env.OPENCODE_DIR)
  : resolve(import.meta.dirname, "..", "..", "opencode")
const OPENCODE_ENTRY = resolve(OPENCODE_BASE, "src", "index.ts")

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
  const args = process.argv.slice(2)
  const extraArgs = args.filter((a) => a === "--auto-approve" || a === "--verbose" || a.startsWith("--dashboard-port"))

  console.log("[launcher] === OpenCode Orchestrator Launcher ===")
  console.log(`[launcher] Starting ${config.agents.length} serve instances...\n`)

  // Verify opencode entry point exists
  if (!existsSync(OPENCODE_ENTRY)) {
    console.error(`[launcher] Cannot find opencode at ${OPENCODE_ENTRY}`)
    process.exit(1)
  }

  // Launch serve instances
  for (const agent of config.agents) {
    const port = extractPort(agent.url)
    if (!port) {
      console.error(`[launcher] Invalid URL for ${agent.name}: ${agent.url}`)
      continue
    }

    console.log(`[launcher] Starting ${agent.name} on port ${port}...`)
    const proc = spawn({
      cmd: [
        "bun",
        "run",
        "--cwd",
        OPENCODE_BASE,
        "--conditions=browser",
        OPENCODE_ENTRY,
        "serve",
        "--port",
        String(port),
      ],
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

  // Build CLI args for orchestrator
  const cliArgs: string[] = []
  for (const agent of config.agents) {
    cliArgs.push("--agent", `${agent.name}=${agent.url}=${agent.directory}`)
  }
  cliArgs.push(...extraArgs)
  if (config.autoApprove) cliArgs.push("--auto-approve")
  if (config.dashboardPort) cliArgs.push("--dashboard-port", String(config.dashboardPort))

  console.log("\n[launcher] Starting orchestrator...\n")

  // Launch orchestrator CLI in foreground (inherits stdio for interactive REPL)
  const orchestratorProc = spawn({
    cmd: ["bun", "run", resolve(import.meta.dirname, "cli.ts"), ...cliArgs],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  // Cleanup on exit
  const cleanup = () => {
    console.log("\n[launcher] Shutting down all processes...")
    orchestratorProc.kill()
    for (const proc of procs) {
      proc.kill()
    }
    process.exit(0)
  }

  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  // Wait for orchestrator to exit
  await orchestratorProc.exited
  cleanup()
}

main().catch((err) => {
  console.error("[launcher] Fatal:", err)
  process.exit(1)
})
