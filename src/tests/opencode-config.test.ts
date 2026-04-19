/**
 * opencode-config — we generate a per-worker opencode.json so that opencode
 * serve knows how to route to our enabled providers. Without this, opencode
 * reads only its global ~/.config/opencode/opencode.json, which on a fresh
 * clone only knows "ollama" — so any worker pinned to opencode-go/openai/etc.
 * silently falls back to Ollama and returns empty. These tests lock in the
 * generator's behavior so that invariant doesn't regress.
 */
import { describe, test, expect } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import type { LLMProvider } from "../providers"
import {
  buildOpencodeConfig,
  toOpencodeProviderEntry,
  prepareWorkerScratch,
  scratchDirFor,
} from "../opencode-config"

function mk(overrides: Partial<LLMProvider>): LLMProvider {
  return {
    id: "x",
    name: "X",
    baseUrl: "https://x.test",
    type: "openai-compatible",
    apiKey: "",
    models: ["m1"],
    enabled: true,
    ...overrides,
  }
}

describe("toOpencodeProviderEntry", () => {
  test("OpenAI-compatible provider gets the @ai-sdk/openai-compatible npm pkg", () => {
    const entry = toOpencodeProviderEntry(mk({ id: "opencode-go", baseUrl: "https://opencode.ai/zen/go" }))
    expect(entry.npm).toBe("@ai-sdk/openai-compatible")
  })

  test("Anthropic provider gets the @ai-sdk/anthropic npm pkg", () => {
    const entry = toOpencodeProviderEntry(mk({ id: "anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com" }))
    expect(entry.npm).toBe("@ai-sdk/anthropic")
  })

  test("appends /v1 to OpenAI-compatible baseURL (opencode's SDK expects it)", () => {
    const entry = toOpencodeProviderEntry(mk({ baseUrl: "https://opencode.ai/zen/go" }))
    expect(entry.options.baseURL).toBe("https://opencode.ai/zen/go/v1")
  })

  test("does not double-append /v1 when baseURL already ends in /v1", () => {
    const entry = toOpencodeProviderEntry(mk({ baseUrl: "https://opencode.ai/zen/go/v1" }))
    expect(entry.options.baseURL).toBe("https://opencode.ai/zen/go/v1")
  })

  test("strips trailing slashes from baseURL before appending /v1", () => {
    const entry = toOpencodeProviderEntry(mk({ baseUrl: "https://x.test/" }))
    expect(entry.options.baseURL).toBe("https://x.test/v1")
  })

  test("inlines apiKey when it's set on the provider", () => {
    const entry = toOpencodeProviderEntry(mk({ id: "openai", apiKey: "sk-literal", apiKeyEnv: "OPENAI_API_KEY" }))
    expect(entry.options.apiKey).toBe("sk-literal")
  })

  test("uses {env:VAR} template when only apiKeyEnv is set (keeps key out of disk)", () => {
    const entry = toOpencodeProviderEntry(mk({ id: "opencode-go", apiKey: "", apiKeyEnv: "OPENCODE_GO_API_KEY" }))
    expect(entry.options.apiKey).toBe("{env:OPENCODE_GO_API_KEY}")
  })

  test("ollama gets no apiKey at all (local, doesn't need auth)", () => {
    const entry = toOpencodeProviderEntry(mk({ id: "ollama", baseUrl: "http://127.0.0.1:11434", apiKeyEnv: undefined }))
    expect(entry.options.apiKey).toBeUndefined()
  })

  test("models are keyed by model name with shape { name: <id> }", () => {
    const entry = toOpencodeProviderEntry(mk({ models: ["glm-5.1", "kimi-k2.5"] }))
    expect(entry.models).toEqual({
      "glm-5.1": { name: "glm-5.1" },
      "kimi-k2.5": { name: "kimi-k2.5" },
    })
  })
})

describe("buildOpencodeConfig", () => {
  test("emits the $schema opencode expects", () => {
    const cfg = buildOpencodeConfig([])
    expect(cfg.$schema).toBe("https://opencode.ai/config.json")
  })

  test("skips disabled providers so opencode doesn't advertise dead routes", () => {
    const cfg = buildOpencodeConfig([
      mk({ id: "on", enabled: true }),
      mk({ id: "off", enabled: false }),
    ])
    expect(Object.keys(cfg.provider)).toEqual(["on"])
  })

  test("skips providers with no models (nothing to route to)", () => {
    const cfg = buildOpencodeConfig([
      mk({ id: "has-models", models: ["m"] }),
      mk({ id: "no-models", models: [] }),
    ])
    expect(Object.keys(cfg.provider).sort()).toEqual(["has-models"])
  })

  test("multiple enabled providers all land in the output", () => {
    const cfg = buildOpencodeConfig([
      mk({ id: "ollama", baseUrl: "http://127.0.0.1:11434", apiKeyEnv: undefined }),
      mk({ id: "opencode-go", apiKeyEnv: "OPENCODE_GO_API_KEY" }),
    ])
    expect(Object.keys(cfg.provider).sort()).toEqual(["ollama", "opencode-go"])
    expect(cfg.provider["ollama"]!.options.apiKey).toBeUndefined()
    expect(cfg.provider["opencode-go"]!.options.apiKey).toBe("{env:OPENCODE_GO_API_KEY}")
  })
})

describe("prepareWorkerScratch", () => {
  test("writes an opencode.json into a scratch dir under the given repo root", async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), "oc-cfg-"))
    try {
      const dir = await prepareWorkerScratch("proj-1", [mk({ id: "opencode-go", apiKeyEnv: "OPENCODE_GO_API_KEY" })], tmp)

      expect(dir).toBe(scratchDirFor("proj-1", tmp))
      const s = await stat(dir)
      expect(s.isDirectory()).toBe(true)

      const contents = await readFile(resolve(dir, "opencode.json"), "utf-8")
      const parsed = JSON.parse(contents)
      expect(parsed.$schema).toBe("https://opencode.ai/config.json")
      expect(parsed.provider["opencode-go"]).toBeDefined()
      expect(parsed.provider["opencode-go"].options.apiKey).toBe("{env:OPENCODE_GO_API_KEY}")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("rewrites an existing scratch opencode.json when providers change (no stale config)", async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), "oc-cfg-"))
    try {
      await prepareWorkerScratch("proj-1", [mk({ id: "a", models: ["m"] })], tmp)
      await prepareWorkerScratch("proj-1", [mk({ id: "b", models: ["m"] })], tmp)

      const contents = await readFile(resolve(scratchDirFor("proj-1", tmp), "opencode.json"), "utf-8")
      const parsed = JSON.parse(contents)
      expect(Object.keys(parsed.provider)).toEqual(["b"])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("different project IDs get isolated scratch dirs", async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), "oc-cfg-"))
    try {
      const dirA = await prepareWorkerScratch("p-a", [mk({ id: "a", models: ["m"] })], tmp)
      const dirB = await prepareWorkerScratch("p-b", [mk({ id: "b", models: ["m"] })], tmp)
      expect(dirA).not.toBe(dirB)

      const parsedA = JSON.parse(await readFile(resolve(dirA, "opencode.json"), "utf-8"))
      const parsedB = JSON.parse(await readFile(resolve(dirB, "opencode.json"), "utf-8"))
      expect(Object.keys(parsedA.provider)).toEqual(["a"])
      expect(Object.keys(parsedB.provider)).toEqual(["b"])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
