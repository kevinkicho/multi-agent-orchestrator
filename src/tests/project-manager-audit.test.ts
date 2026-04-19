/**
 * auditSavedProjectModels — verifies the startup audit flags persisted projects
 * whose `model` targets a missing or disabled provider. The audit is the main
 * defense against a supervisor silently failing to route on boot after a user
 * disabled a provider between sessions.
 *
 * We read/write the real orchestrator-{providers,projects}.json files (snapshot
 * and restore) because that's what the method uses. ProjectManager is
 * instantiated with a minimal stub orchestrator; the audit path doesn't touch
 * spawning or network.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import { resolve } from "path"
import { ProjectManager } from "../project-manager"
import { DashboardLog } from "../dashboard"
import { saveProviders, type LLMProvider } from "../providers"
import type { Orchestrator } from "../orchestrator"

const PROVIDERS_PATH = resolve(process.cwd(), "orchestrator-providers.json")
const PROJECTS_PATH = resolve(process.cwd(), "orchestrator-projects.json")

function snap(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null
}
function restore(path: string, snapshot: string | null): void {
  if (snapshot === null) { if (existsSync(path)) unlinkSync(path) }
  else writeFileSync(path, snapshot)
}

function writeProjects(projects: Array<{ name: string; directory: string; directive: string; model?: string }>): void {
  writeFileSync(PROJECTS_PATH, JSON.stringify({ projects }, null, 2))
}

function makeProjectManager(): { pm: ProjectManager; log: DashboardLog } {
  const orchestrator: unknown = {
    agents: new Map(),
    async prompt() {}, async promptAll() { return { succeeded: [], failed: [] } },
    async getMessages() { return [] }, async status() { return new Map() },
    async addAgent() {}, removeAgent() {}, async abortAgent() {},
    async restartAgent() { return "s" }, forceResetAgentStatus() {}, shutdown() {},
  }
  const log = new DashboardLog()
  const pm = new ProjectManager(orchestrator as Orchestrator, log, { ollamaUrl: "http://127.0.0.1:11434" })
  return { pm, log }
}

describe("auditSavedProjectModels", () => {
  let providersSnap: string | null = null
  let projectsSnap: string | null = null

  beforeAll(() => {
    providersSnap = snap(PROVIDERS_PATH)
    projectsSnap = snap(PROJECTS_PATH)
  })
  afterAll(() => {
    restore(PROVIDERS_PATH, providersSnap)
    restore(PROJECTS_PATH, projectsSnap)
  })

  beforeEach(async () => {
    // Every test starts with a known provider registry so ordering doesn't matter.
    const providers: LLMProvider[] = [
      { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", type: "openai-compatible", apiKey: "sk", models: ["gpt-4o"], enabled: true },
      { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", type: "anthropic", apiKey: "sk-ant", models: ["claude-sonnet-4-5-20250514"], enabled: false },
      { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", type: "openai-compatible", apiKey: "", models: [], enabled: false },
    ]
    await saveProviders(providers)
  })

  test("returns empty list when no saved projects have a model", async () => {
    writeProjects([
      { name: "one", directory: "/tmp/one", directive: "" },
      { name: "two", directory: "/tmp/two", directive: "" },
    ])
    const { pm } = makeProjectManager()
    expect(await pm.auditSavedProjectModels()).toEqual([])
  })

  test("returns empty list when every pinned model routes to an enabled provider", async () => {
    writeProjects([
      { name: "healthy", directory: "/tmp/healthy", directive: "", model: "openai:gpt-4o" },
    ])
    const { pm } = makeProjectManager()
    expect(await pm.auditSavedProjectModels()).toEqual([])
  })

  test("flags a project pinned to a disabled provider", async () => {
    writeProjects([
      { name: "broken", directory: "/tmp/broken", directive: "", model: "anthropic:claude-sonnet-4-5-20250514" },
    ])
    const { pm, log } = makeProjectManager()
    const issues = await pm.auditSavedProjectModels()
    expect(issues).toHaveLength(1)
    expect(issues[0]!.project).toBe("broken")
    expect(issues[0]!.model).toBe("anthropic:claude-sonnet-4-5-20250514")
    expect(issues[0]!.reason).toContain("disabled")
    // Audit also pushes a dashboard warning so the user sees it in the UI
    expect(log.getHistory().some(e => e.type === "brain-thinking" && String((e as { text?: string }).text).includes("broken"))).toBe(true)
  })

  test("flags a project pinned to an unknown provider", async () => {
    writeProjects([
      { name: "ghost", directory: "/tmp/ghost", directive: "", model: "nonexistent-cloud:some-model" },
    ])
    const { pm } = makeProjectManager()
    const issues = await pm.auditSavedProjectModels()
    // Unknown prefix falls through parseModelRef to "ollama"; ollama is
    // disabled in our fixture so this still surfaces as an issue.
    expect(issues).toHaveLength(1)
    expect(issues[0]!.project).toBe("ghost")
  })

  test("returns multiple issues when several projects are broken", async () => {
    writeProjects([
      { name: "ok", directory: "/tmp/ok", directive: "", model: "openai:gpt-4o" },
      { name: "bad1", directory: "/tmp/bad1", directive: "", model: "anthropic:claude-sonnet-4-5-20250514" },
      { name: "bad2", directory: "/tmp/bad2", directive: "", model: "llama3:8b" }, // bare = ollama, disabled
    ])
    const { pm } = makeProjectManager()
    const issues = await pm.auditSavedProjectModels()
    expect(issues).toHaveLength(2)
    expect(issues.map(i => i.project).sort()).toEqual(["bad1", "bad2"])
  })

  test("returns empty list when the projects file is absent", async () => {
    if (existsSync(PROJECTS_PATH)) unlinkSync(PROJECTS_PATH)
    const { pm } = makeProjectManager()
    expect(await pm.auditSavedProjectModels()).toEqual([])
  })
})
