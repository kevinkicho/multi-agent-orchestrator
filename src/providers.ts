/**
 * LLM Provider registry — supports cloud providers and local Ollama.
 * Most cloud providers use OpenAI-compatible API format.
 * Anthropic uses its own Messages API format.
 */

import { readJsonFile, writeJsonFile } from "./file-utils"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderType =
  | "openai-compatible"  // OpenAI, Groq, Together, Fireworks, DeepSeek, Ollama, etc.
  | "anthropic"          // Anthropic Messages API

export type LLMProvider = {
  /** Unique provider ID (e.g., "openai", "anthropic", "ollama") */
  id: string
  /** Human-readable name */
  name: string
  /** API base URL (no trailing slash) */
  baseUrl: string
  /** API type — determines request/response format */
  type: ProviderType
  /** API key (empty string for local providers like Ollama) */
  apiKey: string
  /** Environment variable name to read API key from (fallback if apiKey is empty) */
  apiKeyEnv?: string
  /** Available models for this provider (user-managed list) */
  models: string[]
  /** Whether this provider is enabled */
  enabled: boolean
  /** Default temperature for this provider */
  defaultTemperature?: number
  /** Default max tokens for this provider */
  defaultMaxTokens?: number
}

export type ModelRef = {
  /** Provider ID */
  provider: string
  /** Model name as the provider expects it */
  model: string
}

export type LLMRequestParams = {
  provider: string
  model: string
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  /** Request JSON-formatted output (Ollama format:"json", OpenAI response_format) */
  jsonMode?: boolean
}

export type LLMResponse = {
  content: string
  provider: string
  model: string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
}

// ---------------------------------------------------------------------------
// Built-in provider templates (user adds API keys)
// ---------------------------------------------------------------------------

export const PROVIDER_TEMPLATES: Omit<LLMProvider, "apiKey" | "enabled">[] = [
  {
    id: "ollama",
    name: "Ollama (Local)",
    baseUrl: "http://127.0.0.1:11434",
    type: "openai-compatible",
    models: [],
    defaultTemperature: 0.3,
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com",
    type: "openai-compatible",
    apiKeyEnv: "OPENAI_API_KEY",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o3", "o3-mini", "o4-mini"],
    defaultTemperature: 0.3,
    defaultMaxTokens: 16384,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    type: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: ["claude-opus-4-0", "claude-sonnet-4-5-20250514", "claude-haiku-4-5-20251001"],
    defaultTemperature: 0.3,
    defaultMaxTokens: 16384,
  },
  {
    id: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    type: "openai-compatible",
    apiKeyEnv: "GOOGLE_API_KEY",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    defaultTemperature: 0.3,
    defaultMaxTokens: 16384,
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai",
    type: "openai-compatible",
    apiKeyEnv: "GROQ_API_KEY",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
    defaultTemperature: 0.3,
    defaultMaxTokens: 16384,
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz",
    type: "openai-compatible",
    apiKeyEnv: "TOGETHER_API_KEY",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "mistralai/Mixtral-8x22B-Instruct-v0.1", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
    defaultTemperature: 0.3,
    defaultMaxTokens: 16384,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    type: "openai-compatible",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultTemperature: 0.3,
    defaultMaxTokens: 16384,
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference",
    type: "openai-compatible",
    apiKeyEnv: "FIREWORKS_API_KEY",
    models: ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
    defaultTemperature: 0.3,
    defaultMaxTokens: 16384,
  },
]

// ---------------------------------------------------------------------------
// Provider Registry (in-memory + persisted to JSON)
// ---------------------------------------------------------------------------

const PROVIDERS_FILE = "orchestrator-providers.json"

type ProvidersStore = {
  providers: LLMProvider[]
}

let _providerCache: LLMProvider[] | null = null

export async function loadProviders(): Promise<LLMProvider[]> {
  if (_providerCache) return _providerCache
  const store = await readJsonFile<ProvidersStore | null>(PROVIDERS_FILE, null)
  if (store?.providers) {
    _providerCache = store.providers
    return _providerCache
  }
  // First run: initialize with Ollama enabled by default (no API key needed)
  const defaults: LLMProvider[] = PROVIDER_TEMPLATES.map(t => ({
    ...t,
    apiKey: "",
    enabled: t.id === "ollama",
  }))
  await saveProviders(defaults)
  return defaults
}

export async function saveProviders(providers: LLMProvider[]): Promise<void> {
  _providerCache = providers
  await writeJsonFile(PROVIDERS_FILE, { providers })
}

export async function getProvider(id: string): Promise<LLMProvider | undefined> {
  const providers = await loadProviders()
  return providers.find(p => p.id === id)
}

export async function getEnabledProviders(): Promise<LLMProvider[]> {
  const providers = await loadProviders()
  return providers.filter(p => p.enabled)
}

export async function addOrUpdateProvider(provider: LLMProvider): Promise<void> {
  const providers = await loadProviders()
  const idx = providers.findIndex(p => p.id === provider.id)
  if (idx >= 0) {
    providers[idx] = provider
  } else {
    providers.push(provider)
  }
  await saveProviders(providers)
}

export async function removeProvider(id: string): Promise<boolean> {
  const providers = await loadProviders()
  const idx = providers.findIndex(p => p.id === id)
  if (idx < 0) return false
  providers.splice(idx, 1)
  await saveProviders(providers)
  return true
}

export async function enableProvider(id: string, enabled: boolean): Promise<boolean> {
  const providers = await loadProviders()
  const provider = providers.find(p => p.id === id)
  if (!provider) return false
  provider.enabled = enabled
  await saveProviders(providers)
  return true
}

export async function setProviderApiKey(id: string, apiKey: string): Promise<boolean> {
  const providers = await loadProviders()
  const provider = providers.find(p => p.id === id)
  if (!provider) return false
  provider.apiKey = apiKey
  await saveProviders(providers)
  return true
}

export async function addModelToProvider(providerId: string, model: string): Promise<boolean> {
  const providers = await loadProviders()
  const provider = providers.find(p => p.id === providerId)
  if (!provider) return false
  if (!provider.models.includes(model)) {
    provider.models.push(model)
    await saveProviders(providers)
  }
  return true
}

export async function removeModelFromProvider(providerId: string, model: string): Promise<boolean> {
  const providers = await loadProviders()
  const provider = providers.find(p => p.id === providerId)
  if (!provider) return false
  const idx = provider.models.indexOf(model)
  if (idx < 0) return false
  provider.models.splice(idx, 1)
  await saveProviders(providers)
  return true
}

// ---------------------------------------------------------------------------
// Resolve API key (config value → env var fallback)
// ---------------------------------------------------------------------------

export function resolveApiKey(provider: LLMProvider): string {
  if (provider.apiKey) return provider.apiKey
  if (provider.apiKeyEnv) {
    const envVal = process.env[provider.apiKeyEnv]
    if (envVal) return envVal
  }
  return ""
}

// ---------------------------------------------------------------------------
// List all available models across enabled providers
// ---------------------------------------------------------------------------

export async function listAllModels(): Promise<Array<{ provider: string; providerName: string; model: string }>> {
  const providers = await getEnabledProviders()
  const result: Array<{ provider: string; providerName: string; model: string }> = []

  for (const p of providers) {
    // For Ollama, also try fetching live model list
    if (p.id === "ollama") {
      try {
        const res = await fetch(`${p.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          const data = await res.json() as { models?: Array<{ name: string }> }
          const liveModels = (data.models ?? []).map(m => m.name)
          // Merge live models with configured models
          const allModels = new Set([...p.models, ...liveModels])
          for (const model of allModels) {
            result.push({ provider: p.id, providerName: p.name, model })
          }
          continue
        }
      } catch { /* Ollama not running — use configured models only */ }
    }
    for (const model of p.models) {
      result.push({ provider: p.id, providerName: p.name, model })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Parse a "provider:model" string into a ModelRef
// ---------------------------------------------------------------------------

export function parseModelRef(modelStr: string): ModelRef {
  const colonIdx = modelStr.indexOf(":")
  // If no colon or starts with colon, treat entire string as model with "ollama" default
  // But be careful: Ollama models use ":" for tags (e.g., "llama3:8b")
  // Convention: provider prefix uses "/" or explicit "provider:model" with known provider IDs
  const knownPrefixes = new Set(PROVIDER_TEMPLATES.map(t => t.id))

  if (colonIdx > 0) {
    const prefix = modelStr.slice(0, colonIdx)
    if (knownPrefixes.has(prefix)) {
      return { provider: prefix, model: modelStr.slice(colonIdx + 1) }
    }
  }
  // No recognized provider prefix — default to "ollama"
  return { provider: "ollama", model: modelStr }
}

export function formatModelRef(ref: ModelRef): string {
  if (ref.provider === "ollama") return ref.model
  return `${ref.provider}:${ref.model}`
}

// ---------------------------------------------------------------------------
// LLM API call — routes to correct provider
// ---------------------------------------------------------------------------

export async function llmCall(params: LLMRequestParams): Promise<LLMResponse> {
  const providers = await loadProviders()
  const provider = providers.find(p => p.id === params.provider)
  if (!provider) {
    throw new Error(`Unknown LLM provider: "${params.provider}". Available: ${providers.map(p => p.id).join(", ")}`)
  }
  if (!provider.enabled) {
    throw new Error(`Provider "${params.provider}" is not enabled. Enable it in the dashboard or config.`)
  }

  const apiKey = resolveApiKey(provider)
  if (!apiKey && provider.id !== "ollama") {
    throw new Error(`No API key for provider "${params.provider}". Set it via dashboard, config, or ${provider.apiKeyEnv ?? "environment variable"}.`)
  }

  const temperature = params.temperature ?? provider.defaultTemperature ?? 0.3
  const maxTokens = params.maxTokens ?? provider.defaultMaxTokens ?? 16384
  const timeoutMs = params.timeoutMs ?? 300_000

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    if (provider.type === "anthropic") {
      return await callAnthropic(provider, apiKey, params, temperature, maxTokens, controller, params.jsonMode)
    } else {
      return await callOpenAICompatible(provider, apiKey, params, temperature, maxTokens, controller, params.jsonMode)
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible API call (OpenAI, Groq, Together, Fireworks, Ollama, etc.)
// ---------------------------------------------------------------------------

async function callOpenAICompatible(
  provider: LLMProvider,
  apiKey: string,
  params: LLMRequestParams,
  temperature: number,
  maxTokens: number,
  controller: AbortController,
  jsonMode?: boolean,
): Promise<LLMResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    temperature,
    max_tokens: maxTokens,
  }

  if (jsonMode) {
    // Ollama uses "format": "json", OpenAI-compatible uses response_format
    if (provider.id === "ollama") {
      body.format = "json"
    } else {
      body.response_format = { type: "json_object" }
    }
  }

  const response = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  })

  if (!response.ok) {
    const body = await response.text()
    const err = new Error(`${provider.name} API error: ${response.status} ${body}`) as Error & { statusCode?: number }
    err.statusCode = response.status
    throw err
  }

  type ChatResponse = {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }

  const data = await response.json() as ChatResponse
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    throw new Error(`${provider.name} returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`)
  }

  return {
    content,
    provider: provider.id,
    model: params.model,
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    } : undefined,
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API call
// ---------------------------------------------------------------------------

async function callAnthropic(
  provider: LLMProvider,
  apiKey: string,
  params: LLMRequestParams,
  temperature: number,
  maxTokens: number,
  controller: AbortController,
  jsonMode?: boolean,
): Promise<LLMResponse> {
  // Anthropic requires system message separated from the messages array
  let systemContent = ""
  const messages: Array<{ role: "user" | "assistant"; content: string }> = []

  for (const msg of params.messages) {
    if (msg.role === "system") {
      systemContent += (systemContent ? "\n\n" : "") + msg.content
    } else {
      messages.push({ role: msg.role, content: msg.content })
    }
  }

  // Anthropic requires alternating user/assistant messages starting with user
  // Merge consecutive same-role messages
  const merged: Array<{ role: "user" | "assistant"; content: string }> = []
  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1]!.role === msg.role) {
      merged[merged.length - 1]!.content += "\n\n" + msg.content
    } else {
      merged.push({ ...msg })
    }
  }

  const response = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: maxTokens,
      temperature,
      ...(systemContent ? { system: systemContent } : {}),
      messages: merged,
    }),
    signal: controller.signal,
  })

  if (!response.ok) {
    const body = await response.text()
    const err = new Error(`Anthropic API error: ${response.status} ${body}`) as Error & { statusCode?: number }
    err.statusCode = response.status
    throw err
  }

  type AnthropicResponse = {
    content?: Array<{ type: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  const data = await response.json() as AnthropicResponse
  const textBlocks = (data.content ?? []).filter(b => b.type === "text" && b.text)
  const content = textBlocks.map(b => b.text!).join("\n")
  if (!content) {
    throw new Error(`Anthropic returned no text content: ${JSON.stringify(data).slice(0, 200)}`)
  }

  return {
    content,
    provider: provider.id,
    model: params.model,
    usage: data.usage ? {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
      totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
    } : undefined,
  }
}
