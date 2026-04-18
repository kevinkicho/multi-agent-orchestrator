import { describe, test, expect } from "bun:test"
import { parseModelRef, formatModelRef, resolveApiKey, PROVIDER_TEMPLATES, type LLMProvider } from "../providers"

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
