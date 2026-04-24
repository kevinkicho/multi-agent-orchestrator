import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { warmupModel, isModelWarmed } from "../brain"

type FetchCall = { url: string; body: unknown }

describe("warmupModel / isModelWarmed", () => {
  const originalFetch = globalThis.fetch
  let fetchCalls: FetchCall[]

  function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const bodyStr = typeof init?.body === "string" ? init.body : null
      fetchCalls.push({ url, body: bodyStr ? JSON.parse(bodyStr) : null })
      return handler(url, init)
    }) as unknown as typeof globalThis.fetch
  }

  beforeEach(() => {
    fetchCalls = []
    installFetch(async () => new Response("{}", { status: 200 }))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // Each test picks a unique model name — warmedModels is module-level state
  // that persists across tests, and we don't want bleed-through.
  const uniqueModel = (label: string) =>
    `brain-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  test("isModelWarmed returns false for a model that has never been warmed", () => {
    expect(isModelWarmed(uniqueModel("never"))).toBe(false)
  })

  test("warmupModel hits /api/generate with num_predict=1 and marks the model warmed", async () => {
    const model = uniqueModel("ok")
    expect(isModelWarmed(model)).toBe(false)

    await warmupModel("http://localhost:11434", model)

    expect(isModelWarmed(model)).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe("http://localhost:11434/api/generate")
    const body = fetchCalls[0]!.body as { model: string; options: { num_predict: number } }
    expect(body.model).toBe(model)
    expect(body.options.num_predict).toBe(1)
  })

  test("warmupModel is a no-op on the second call for the same model", async () => {
    const model = uniqueModel("dedupe")

    await warmupModel("http://localhost:11434", model)
    expect(fetchCalls).toHaveLength(1)

    await warmupModel("http://localhost:11434", model)
    expect(fetchCalls).toHaveLength(1)
  })

  test("warmupModel skips cloud providers (known provider prefix) without calling fetch", async () => {
    const model = `openai:${uniqueModel("cloud")}`

    await warmupModel("http://localhost:11434", model)

    expect(fetchCalls).toHaveLength(0)
    expect(isModelWarmed(model)).toBe(false)
  })

  test("warmupModel leaves the model unwarmed when fetch throws", async () => {
    installFetch(async () => {
      throw new Error("network down")
    })
    const model = uniqueModel("throws")

    await warmupModel("http://localhost:11434", model)

    expect(isModelWarmed(model)).toBe(false)
  })

  test("warmupModel leaves the model unwarmed when the response is non-OK", async () => {
    installFetch(async () => new Response("server error", { status: 500 }))
    const model = uniqueModel("500")

    await warmupModel("http://localhost:11434", model)

    expect(isModelWarmed(model)).toBe(false)
  })
})
