/**
 * Resolves where to find the opencode binary and builds the spawn command.
 *
 * Two launch modes:
 *   1. Binary mode (default) — uses the `opencode-ai` npm package's bundled
 *      platform binary, resolved from node_modules/.bin. Plain `bun install`
 *      is enough; no source clone required.
 *   2. Source mode (opt-in) — set OPENCODE_DIR to a local opencode checkout
 *      to run from TypeScript source via `bun run`. Only needed if you're
 *      hacking on opencode itself.
 */
import { existsSync } from "fs"
import { resolve } from "path"
import { platform } from "os"

export type OpencodeLaunch =
  | { mode: "binary"; bin: string }
  | { mode: "source"; entry: string; cwd: string }

export type ResolveOpencodeDeps = {
  env?: NodeJS.ProcessEnv
  repoRoot?: string
  /** Overrides platform detection (for tests) */
  platformName?: NodeJS.Platform
  /** Overrides existsSync (for tests) */
  fileExists?: (path: string) => boolean
  /** Overrides PATH lookup (for tests) */
  pathLookup?: (name: string) => string | null
}

export function resolveOpencode(deps: ResolveOpencodeDeps = {}): OpencodeLaunch {
  const env = deps.env ?? process.env
  const repoRoot = deps.repoRoot ?? resolve(import.meta.dirname, "..")
  const plat = deps.platformName ?? platform()
  const fileExists = deps.fileExists ?? existsSync
  const pathLookup = deps.pathLookup ?? ((name) => Bun.which(name))

  if (env.OPENCODE_DIR) {
    const cwd = resolve(env.OPENCODE_DIR)
    const entry = resolve(cwd, "src", "index.ts")
    if (!fileExists(entry)) {
      throw new Error(
        `OPENCODE_DIR is set to ${cwd}, but ${entry} does not exist. ` +
        `Point OPENCODE_DIR at an opencode source checkout, or unset it ` +
        `to use the bundled opencode-ai binary.`
      )
    }
    return { mode: "source", entry, cwd }
  }

  const binName = plat === "win32" ? "opencode.exe" : "opencode"
  const localBin = resolve(repoRoot, "node_modules", ".bin", binName)
  if (fileExists(localBin)) return { mode: "binary", bin: localBin }

  const pathBin = pathLookup("opencode")
  if (pathBin) return { mode: "binary", bin: pathBin }

  throw new Error(
    `opencode binary not found. Run \`bun install\` (opencode-ai is a dependency of this repo), ` +
    `install opencode globally so it is on PATH, or set OPENCODE_DIR to an opencode source checkout.`
  )
}

export function buildOpencodeSpawnCmd(launch: OpencodeLaunch, port: number): string[] {
  if (launch.mode === "binary") {
    return [launch.bin, "serve", "--port", String(port), "--hostname", "127.0.0.1"]
  }
  return [
    "bun", "run",
    "--cwd", launch.cwd,
    "--conditions=browser",
    launch.entry,
    "serve",
    "--port", String(port),
  ]
}

let cachedLaunch: OpencodeLaunch | null = null
export function getOpencodeLaunch(): OpencodeLaunch {
  if (!cachedLaunch) cachedLaunch = resolveOpencode()
  return cachedLaunch
}

/** Test-only: clears the resolution cache so subsequent getOpencodeLaunch() re-resolves. */
export function _resetOpencodeLaunchCache(): void {
  cachedLaunch = null
}
