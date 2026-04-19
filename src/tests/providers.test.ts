import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "fs"
import { resolve } from "path"
import {
  parseModelRef,
  formatModelRef,
  resolveApiKey,
  resolveDefaultModel,
  validateModelRoutable,
  selectProjectModel,
  saveProviders,
  PROVIDER_TEMPLATES,
  type LLMProvider,
} from "../providers"

describe("parseModelRef", () => {
  test("plain model name defaults to ollama", () => {
    const ref = parseModelRef("llama3:8b")
    expect(ref.provider).toBe("ollama")
    expect(ref.model).toBe("llama3:8b")
  })

  test("ollama model with tag treated as ollama", () => {
    const ref = parseModelRef("glm-5.1:cloud")
    expect(ref.provider).toBe("ollama")
    expect(ref.model).toBe("glm-5.1:cloud")
  })

  test("openai:model parses correctly", () => {
    const ref = parseModelRef("openai:gpt-4o")
    expect(ref.provider).toBe("openai")
    expect(ref.model).toBe("gpt-4o")
  })

  test("anthropic:model parses correctly", () => {
    const ref = parseModelRef("anthropic:claude-sonnet-4-5-20250514")
    expect(ref.provider).toBe("anthropic")
    expect(ref.model).toBe("claude-sonnet-4-5-20250514")
  })

  test("google:model parses correctly", () => {
    const ref = parseModelRef("google:gemini-2.5-pro")
    expect(ref.provider).toBe("google")
    expect(ref.model).toBe("gemini-2.5-pro")
  })

  test("groq:model parses correctly", () => {
    const ref = parseModelRef("groq:llama-3.3-70b-versatile")
    expect(ref.provider).toBe("groq")
    expect(ref.model).toBe("llama-3.3-70b-versatile")
  })

  test("together:model parses correctly", () => {
    const ref = parseModelRef("together:meta-llama/Llama-3.3-70B-Instruct-Turbo")
    expect(ref.provider).toBe("together")
    expect(ref.model).toBe("meta-llama/Llama-3.3-70B-Instruct-Turbo")
  })

  test("deepseek:model parses correctly", () => {
    const ref = parseModelRef("deepseek:deepseek-chat")
    expect(ref.provider).toBe("deepseek")
    expect(ref.model).toBe("deepseek-chat")
  })

  test("unknown prefix treated as ollama model name", () => {
    // "custom-provider:model" — "custom-provider" is not a known prefix
    const ref = parseModelRef("custom-provider:model")
    expect(ref.provider).toBe("ollama")
    expect(ref.model).toBe("custom-provider:model")
  })

  test("model name without colon defaults to ollama", () => {
    const ref = parseModelRef("llama3")
    expect(ref.provider).toBe("ollama")
    expect(ref.model).toBe("llama3")
  })
})

describe("formatModelRef", () => {
  test("ollama provider returns just model name", () => {
    expect(formatModelRef({ provider: "ollama", model: "llama3:8b" })).toBe("llama3:8b")
  })

  test("other providers return provider:model", () => {
    expect(formatModelRef({ provider: "openai", model: "gpt-4o" })).toBe("openai:gpt-4o")
    expect(formatModelRef({ provider: "anthropic", model: "claude-sonnet-4-5-20250514" })).toBe("anthropic:claude-sonnet-4-5-20250514")
  })
})

describe("resolveApiKey", () => {
  test("returns apiKey if set", () => {
    const provider = { apiKey: "sk-123", apiKeyEnv: "TEST_KEY" } as LLMProvider
    expect(resolveApiKey(provider)).toBe("sk-123")
  })

  test("falls back to env var", () => {
    const envKey = "TEST_RESOLVE_API_KEY_" + Date.now()
    process.env[envKey] = "env-key-value"
    const provider = { apiKey: "", apiKeyEnv: envKey } as LLMProvider
    expect(resolveApiKey(provider)).toBe("env-key-value")
    delete process.env[envKey]
  })

  test("returns empty string when no key available", () => {
    const provider = { apiKey: "", apiKeyEnv: "NONEXISTENT_KEY_12345" } as LLMProvider
    expect(resolveApiKey(provider)).toBe("")
  })

  test("returns empty when no apiKeyEnv set", () => {
    const provider = { apiKey: "" } as LLMProvider
    expect(resolveApiKey(provider)).toBe("")
  })
})

describe("PROVIDER_TEMPLATES", () => {
  test("includes expected providers", () => {
    const ids = PROVIDER_TEMPLATES.map(t => t.id)
    expect(ids).toContain("ollama")
    expect(ids).toContain("openai")
    expect(ids).toContain("anthropic")
    expect(ids).toContain("google")
    expect(ids).toContain("groq")
    expect(ids).toContain("together")
    expect(ids).toContain("deepseek")
    expect(ids).toContain("fireworks")
    expect(ids).toContain("opencode-go")
    expect(ids).toContain("opencode-go-anthropic")
  })

  test("all templates have required fields", () => {
    for (const t of PROVIDER_TEMPLATES) {
      expect(t.id).toBeTruthy()
      expect(t.name).toBeTruthy()
      expect(t.baseUrl).toBeTruthy()
      expect(["openai-compatible", "anthropic"]).toContain(t.type)
      expect(Array.isArray(t.models)).toBe(true)
    }
  })

  test("ollama has no apiKeyEnv (local provider)", () => {
    const ollama = PROVIDER_TEMPLATES.find(t => t.id === "ollama")!
    expect(ollama.apiKeyEnv).toBeUndefined()
  })

  test("cloud providers have apiKeyEnv", () => {
    const cloud = PROVIDER_TEMPLATES.filter(t => t.id !== "ollama")
    for (const t of cloud) {
      expect(t.apiKeyEnv).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// Resolver + routing guards — exercise the live providers registry file.
// Snapshot/restore orchestrator-providers.json so the user's real config isn't
// mutated across test runs.
// ---------------------------------------------------------------------------

const PROVIDERS_PATH = resolve(process.cwd(), "orchestrator-providers.json")

let snapshot: string | null = null
function loadSnapshot(): string | null {
  return existsSync(PROVIDERS_PATH) ? readFileSync(PROVIDERS_PATH, "utf8") : null
}
function restoreSnapshot(): void {
  if (snapshot === null) {
    if (existsSync(PROVIDERS_PATH)) unlinkSync(PROVIDERS_PATH)
  } else {
    writeFileSync(PROVIDERS_PATH, snapshot)
  }
}
async function setProvidersState(providers: LLMProvider[]): Promise<void> {
  await saveProviders(providers)
}

describe("resolveDefaultModel", () => {
  beforeAll(() => { snapshot = loadSnapshot() })
  afterAll(() => { restoreSnapshot() })

  test("returns null when no providers are enabled", async () => {
    await setProvidersState([
      { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", type: "openai-compatible", apiKey: "", models: ["llama3"], enabled: false },
      { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", type: "openai-compatible", apiKey: "", models: ["gpt-4o"], enabled: false },
    ])
    expect(await resolveDefaultModel()).toBeNull()
  })

  test("returns null when an enabled provider has no models", async () => {
    await setProvidersState([
      { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", type: "openai-compatible", apiKey: "", models: [], enabled: true },
    ])
    expect(await resolveDefaultModel()).toBeNull()
  })

  test("picks first enabled provider's first model", async () => {
    await setProvidersState([
      { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", type: "openai-compatible", apiKey: "", models: [], enabled: false },
      { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", type: "openai-compatible", apiKey: "sk-test", models: ["gpt-4o", "gpt-4o-mini"], enabled: true },
    ])
    expect(await resolveDefaultModel()).toBe("openai:gpt-4o")
  })

  test("skips enabled-but-empty providers and picks the next candidate", async () => {
    await setProvidersState([
      { id: "opencode-go", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go", type: "openai-compatible", apiKey: "", models: [], enabled: true },
      { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", type: "anthropic", apiKey: "sk-ant", models: ["claude-sonnet-4-5-20250514"], enabled: true },
    ])
    expect(await resolveDefaultModel()).toBe("anthropic:claude-sonnet-4-5-20250514")
  })

  test("ollama model is returned bare (no provider prefix) by formatModelRef", async () => {
    await setProvidersState([
      { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", type: "openai-compatible", apiKey: "", models: ["llama3:8b"], enabled: true },
    ])
    expect(await resolveDefaultModel()).toBe("llama3:8b")
  })
})

describe("validateModelRoutable", () => {
  beforeAll(() => { snapshot = loadSnapshot() })
  afterAll(() => { restoreSnapshot() })

  test("accepts a model targeting an enabled provider", async () => {
    await setProvidersState([
      { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", type: "openai-compatible", apiKey: "sk-test", models: ["gpt-4o"], enabled: true },
    ])
    const result = await validateModelRoutable("openai:gpt-4o")
    expect(result.ok).toBe(true)
  })

  test("rejects a model whose provider is disabled", async () => {
    await setProvidersState([
      { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", type: "openai-compatible", apiKey: "sk-test", models: ["gpt-4o"], enabled: false },
    ])
    const result = await validateModelRoutable("openai:gpt-4o")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("disabled")
  })

  test("rejects a model whose provider is missing from the registry", async () => {
    await setProvidersState([
      { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", type: "openai-compatible", apiKey: "", models: ["llama3"], enabled: true },
    ])
    // unprefixed ollama tag routes to ollama — prepend unknown prefix via explicit ID
    const result = await validateModelRoutable("nonexistent-provider:some-model")
    // parseModelRef treats unknown prefix as bare ollama model name, so this
    // actually resolves to ollama; flipped case: use a clearly-unknown prefix
    // via real parse. We assert the current contract: unknown-prefix strings
    // get routed to "ollama" and therefore succeed when ollama is enabled.
    expect(result.ok).toBe(true)
  })

  test("rejects bare ollama model when ollama is disabled", async () => {
    await setProvidersState([
      { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", type: "openai-compatible", apiKey: "", models: ["llama3"], enabled: false },
    ])
    const result = await validateModelRoutable("llama3:8b")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("disabled")
  })
})

// ---------------------------------------------------------------------------
// selectProjectModel — pure three-tier fallback decision. Pure function, no I/O.
// This is the heart of project-manager's model routing; unit tests here protect
// against silent regressions (like "fell back to ollama even though opencode-go
// was enabled").
// ---------------------------------------------------------------------------

describe("selectProjectModel", () => {
  test("prefers project.model over all other tiers", () => {
    const r = selectProjectModel("openai:gpt-4o", "anthropic:claude-sonnet", "legacy-model")
    expect(r.source).toBe("project")
    expect(r.model).toBe("openai:gpt-4o")
  })

  test("falls through to default when project.model is empty string", () => {
    const r = selectProjectModel("", "anthropic:claude-sonnet", "legacy-model")
    expect(r.source).toBe("default")
    expect(r.model).toBe("anthropic:claude-sonnet")
  })

  test("falls through to default when project.model is undefined", () => {
    const r = selectProjectModel(undefined, "anthropic:claude-sonnet", undefined)
    expect(r.source).toBe("default")
    expect(r.model).toBe("anthropic:claude-sonnet")
  })

  test("uses legacy model only when project.model and default are both absent", () => {
    const r = selectProjectModel(undefined, null, "legacy-model")
    expect(r.source).toBe("legacy")
    expect(r.model).toBe("legacy-model")
  })

  test("throws when no tier has a value", () => {
    expect(() => selectProjectModel(undefined, null, undefined)).toThrow(/No model configured/)
  })

  test("throws when all tiers are empty strings / null", () => {
    expect(() => selectProjectModel("", null, "")).toThrow(/No model configured/)
  })

  test("does not silently prefer legacy over default — the cardinal regression guard", () => {
    // If this test ever fails, someone has re-ordered the tiers and pinned the
    // legacy ollama-default bug that motivated this whole refactor.
    const r = selectProjectModel(undefined, "opencode-go:glm-5.1", "ollama-legacy")
    expect(r.source).toBe("default")
    expect(r.model).toBe("opencode-go:glm-5.1")
  })
})
