import { describe, test, expect } from "bun:test"
import { resolve } from "path"
import { resolveOpencode, buildOpencodeSpawnCmd, type OpencodeLaunch } from "../opencode-runtime"

/**
 * Stub helpers so tests don't touch real fs / real PATH.
 * resolveOpencode accepts a ResolveOpencodeDeps object for injection.
 */
function makeDeps(opts: {
  env?: Record<string, string>
  files?: Set<string>
  pathBin?: string | null
  platformName?: NodeJS.Platform
  repoRoot?: string
}) {
  const files = opts.files ?? new Set<string>()
  return {
    env: opts.env ?? {},
    repoRoot: opts.repoRoot ?? "/repo",
    platformName: opts.platformName ?? ("linux" as NodeJS.Platform),
    fileExists: (p: string) => files.has(p),
    pathLookup: (_name: string) => opts.pathBin ?? null,
  }
}

describe("resolveOpencode", () => {
  describe("source mode (OPENCODE_DIR set)", () => {
    test("returns source launch when entry exists", () => {
      const cwd = resolve("/my/opencode")
      const entry = resolve(cwd, "src", "index.ts")
      const launch = resolveOpencode(makeDeps({
        env: { OPENCODE_DIR: cwd },
        files: new Set([entry]),
      }))
      expect(launch).toEqual({ mode: "source", entry, cwd })
    })

    test("throws with actionable message when entry missing", () => {
      const cwd = resolve("/wrong/path")
      expect(() => resolveOpencode(makeDeps({
        env: { OPENCODE_DIR: cwd },
        files: new Set(),
      }))).toThrow(/OPENCODE_DIR is set to/)
    })
  })

  describe("binary mode (OPENCODE_DIR unset)", () => {
    test("returns node_modules/.bin/opencode on Linux", () => {
      const bin = resolve("/repo", "node_modules", ".bin", "opencode")
      const launch = resolveOpencode(makeDeps({
        files: new Set([bin]),
        platformName: "linux",
      }))
      expect(launch).toEqual({ mode: "binary", bin })
    })

    test("returns node_modules/.bin/opencode.exe on Windows", () => {
      const bin = resolve("/repo", "node_modules", ".bin", "opencode.exe")
      const launch = resolveOpencode(makeDeps({
        files: new Set([bin]),
        platformName: "win32",
      }))
      expect(launch).toEqual({ mode: "binary", bin })
    })

    test("falls back to PATH when node_modules bin missing", () => {
      const launch = resolveOpencode(makeDeps({
        files: new Set(),
        pathBin: "/usr/local/bin/opencode",
      }))
      expect(launch).toEqual({ mode: "binary", bin: "/usr/local/bin/opencode" })
    })

    test("throws with install guidance when nothing is found", () => {
      expect(() => resolveOpencode(makeDeps({
        files: new Set(),
        pathBin: null,
      }))).toThrow(/opencode binary not found/)
    })
  })
})

describe("buildOpencodeSpawnCmd", () => {
  test("binary mode emits direct binary invocation", () => {
    const launch: OpencodeLaunch = { mode: "binary", bin: "/repo/node_modules/.bin/opencode" }
    expect(buildOpencodeSpawnCmd(launch, 12345)).toEqual([
      "/repo/node_modules/.bin/opencode",
      "serve",
      "--print-logs",
      "--log-level", "INFO",
      "--port", "12345",
      "--hostname", "127.0.0.1",
    ])
  })

  test("source mode routes through `bun run` with --cwd and --conditions", () => {
    const launch: OpencodeLaunch = {
      mode: "source",
      entry: "/src/opencode/src/index.ts",
      cwd: "/src/opencode",
    }
    expect(buildOpencodeSpawnCmd(launch, 23456)).toEqual([
      "bun", "run",
      "--cwd", "/src/opencode",
      "--conditions=browser",
      "/src/opencode/src/index.ts",
      "serve",
      "--print-logs",
      "--log-level", "INFO",
      "--port", "23456",
    ])
  })

  test("port is stringified — never passed as number", () => {
    const launch: OpencodeLaunch = { mode: "binary", bin: "opencode" }
    const cmd = buildOpencodeSpawnCmd(launch, 7)
    for (const arg of cmd) expect(typeof arg).toBe("string")
  })
})
