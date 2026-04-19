/**
 * Boot-check — exercises the per-provider probe logic with fetch stubbed.
 * We can't hit the real Ollama / opencode-go endpoints in CI, and even locally
 * the whole point of boot-check is to classify their responses correctly, so
 * stubbing fetch is the only way to assert each branch.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import type { LLMProvider } from "../providers"
import { checkProvider } from "../boot-check"

type FetchImpl = typeof globalThis.fetch
const origFetch = globalThis.fetch

function mkProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    id: "test",
    name: "Test Provider",
    baseUrl: "https://example.test",
    type: "openai-compatible",
    apiKey: "sk-test",
    models: ["model-a"],
    enabled: true,
    ...overrides,
  }
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  globalThis.fetch = (async (input: Parameters<FetchImpl>[0], init?: Parameters<FetchImpl>[1]) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString()
    return handler(url, init)
  }) as FetchImpl
}

afterEach(() => {
  globalThis.fetch = origFetch
})

describe("checkProvider — short-circuit cases", () => {
  test("disabled provider returns skipped without any network call", async () => {
    let called = false
    stubFetch(async () => { called = true; return new Response("nope") })
    const provider = mkProvider({ enabled: false })

    const result = await checkProvider(provider)

    expect(result.enabled).toBe(false)
    expect(result.quotaStatus).toBe("skipped")
    expect(result.reachable).toBeNull()
    expect(called).toBe(false)
  })

  test("enabled provider with missing key returns auth-error without probing", async () => {
    let called = false
    stubFetch(async () => { called = true; return new Response("nope") })
    const provider = mkProvider({ apiKey: "", apiKeyEnv: "DEFINITELY_NOT_SET_" + Date.now() })

    const result = await checkProvider(provider)

    expect(result.quotaStatus).toBe("auth-error")
    expect(result.hasKey).toBe(false)
    expect(called).toBe(false)
    expect(result.errorMessage).toMatch(/missing API key/)
  })

  test("ollama treated as key-OK even without apiKey set", async () => {
    stubFetch(async (url) => {
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "glm-5.1:cloud" }] })
      return Response.json({ choices: [{ message: { content: "" } }] })
    })
    const provider = mkProvider({ id: "ollama", apiKey: "", baseUrl: "http://127.0.0.1:11434" })

    const result = await checkProvider(provider)

    expect(result.hasKey).toBe(true)
    expect(result.reachable).toBe(true)
    expect(result.listedModels).toContain("glm-5.1:cloud")
  })
})

describe("checkProvider — reachability", () => {
  test("unreachable provider returns unreachable + captures error", async () => {
    stubFetch(async () => { throw new TypeError("fetch failed: ECONNREFUSED") })
    const provider = mkProvider()

    const result = await checkProvider(provider)

    expect(result.reachable).toBe(false)
    expect(result.quotaStatus).toBe("unreachable")
    expect(result.errorMessage).toMatch(/ECONNREFUSED|fetch failed/)
  })
})

describe("checkProvider — quota classification from probe response", () => {
  test("200 OK → quotaStatus 'ok'", async () => {
    stubFetch(async (url) => {
      if (url.includes("/v1/chat/completions")) {
        return Response.json({ choices: [{ message: { content: "pong" } }] })
      }
      return new Response("alive")
    })
    const result = await checkProvider(mkProvider())
    expect(result.quotaStatus).toBe("ok")
    expect(result.errorMessage).toBeNull()
  })

  test("429 → quotaStatus 'exhausted' with body captured", async () => {
    stubFetch(async (url) => {
      if (url.includes("/v1/chat/completions")) {
        return new Response("rate_limit_exceeded: weekly quota hit", { status: 429 })
      }
      return new Response("alive")
    })
    const result = await checkProvider(mkProvider())
    expect(result.quotaStatus).toBe("exhausted")
    expect(result.errorMessage).toMatch(/weekly quota/)
  })

  test("401 → quotaStatus 'auth-error'", async () => {
    stubFetch(async (url) => {
      if (url.includes("/v1/chat/completions")) {
        return new Response("invalid api key", { status: 401 })
      }
      return new Response("alive")
    })
    const result = await checkProvider(mkProvider())
    expect(result.quotaStatus).toBe("auth-error")
  })

  test("400 with 'quota' in body → also classified as exhausted", async () => {
    // Some providers return 400 with a quota message instead of 429.
    stubFetch(async (url) => {
      if (url.includes("/v1/chat/completions")) {
        return new Response("monthly quota exceeded", { status: 400 })
      }
      return new Response("alive")
    })
    const result = await checkProvider(mkProvider())
    expect(result.quotaStatus).toBe("exhausted")
  })
})

describe("checkProvider — anthropic path uses the /v1/messages endpoint", () => {
  test("routes anthropic providers to /v1/messages with x-api-key header", async () => {
    let probedUrl = ""
    let headers: Record<string, string> = {}
    stubFetch(async (url, init) => {
      probedUrl = url
      headers = Object.fromEntries(new Headers(init?.headers).entries())
      if (url.includes("/v1/messages")) {
        return Response.json({ content: [{ type: "text", text: "ok" }] })
      }
      return new Response("alive")
    })
    const provider = mkProvider({ type: "anthropic", baseUrl: "https://api.anthropic.com" })

    await checkProvider(provider)

    expect(probedUrl).toMatch(/\/v1\/messages$/)
    expect(headers["x-api-key"]).toBe("sk-test")
    expect(headers["anthropic-version"]).toBeDefined()
  })
})

describe("checkProvider — model listing", () => {
  test("merges ollama /api/tags models with configured models", async () => {
    stubFetch(async (url) => {
      if (url.endsWith("/api/tags")) {
        return Response.json({ models: [{ name: "live-1" }, { name: "live-2" }] })
      }
      return Response.json({ choices: [{ message: { content: "" } }] })
    })
    const provider = mkProvider({ id: "ollama", apiKey: "", baseUrl: "http://127.0.0.1:11434", models: ["configured-1"] })

    const result = await checkProvider(provider)

    expect(result.listedModels).toEqual(expect.arrayContaining(["configured-1", "live-1", "live-2"]))
  })

  test("non-ollama providers fall back to configured models for listedModels", async () => {
    stubFetch(async (url) => {
      if (url.includes("/v1/chat/completions")) {
        return Response.json({ choices: [{ message: { content: "ok" } }] })
      }
      return new Response("alive")
    })
    const provider = mkProvider({ models: ["m1", "m2"] })

    const result = await checkProvider(provider)

    expect(result.listedModels).toEqual(["m1", "m2"])
  })
})
