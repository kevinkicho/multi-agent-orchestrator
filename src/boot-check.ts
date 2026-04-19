/**
 * Boot-check — startup health/quota probe for every enabled LLM provider.
 *
 * When `bun run start` fires, the orchestrator needs to know up-front:
 *   - Is this provider reachable at all?
 *   - What models does it actually expose *right now*?
 *   - Is there quota left, or has the user blown through a weekly allowance?
 *   - Which model will the brain/default path resolve to, and is it viable?
 *
 * Without this probe the operator only discovers a dead provider once the
 * supervisor hangs on the first prompt. Running it at boot + exposing the
 * report to the dashboard lets the UI show a traffic-light banner and lets
 * the CLI log the diagnosis before a single worker spins up.
 */
import {
  loadProviders,
  resolveApiKey,
  resolveDefaultModel,
  type LLMProvider,
} from "./providers"

/** Outcome of probing a single provider. All timing/diagnostic data lives here
 *  so the dashboard can render a row per provider without re-querying. */
export type BootCheckResult = {
  providerId: string
  providerName: string
  enabled: boolean
  /** True when an API key is configured (via config or env). Always true for ollama. */
  hasKey: boolean
  /** TCP/HTTP reachability. null when the check was skipped (disabled, no key). */
  reachable: boolean | null
  /** Round-trip latency of the reachability probe, ms. null when skipped/failed. */
  latencyMs: number | null
  /** Live model list when the provider supports discovery (Ollama /api/tags).
   *  Falls back to `configuredModels` for providers without a list endpoint. */
  listedModels: string[] | null
  /** Models the user has pinned in orchestrator-providers.json. */
  configuredModels: string[]
  /** Outcome of a 1-token soft probe against the provider. */
  quotaStatus: "ok" | "exhausted" | "auth-error" | "unreachable" | "skipped" | "unknown"
  /** Human-readable detail — rendered in the dashboard on hover. */
  errorMessage: string | null
  checkedAt: number
}

/** Full report produced by one boot-check run. */
export type BootCheckReport = {
  startedAt: number
  completedAt: number
  providers: BootCheckResult[]
  /** Model resolveDefaultModel() picked — what the brain/default path will use. */
  brainModel: string | null
  /** Aggregate traffic-light: ready = at least one working provider, degraded =
   *  one enabled provider partially working, blocked = nothing routable. */
  brainStatus: "ready" | "degraded" | "blocked"
  /** One-line summary for CLI output. */
  summary: string
}

const SOFT_PROBE_TIMEOUT_MS = 8_000
const REACHABILITY_TIMEOUT_MS = 5_000

/** Reachability probe — a single HEAD/GET that tells us whether the base URL
 *  is even alive. For Ollama we hit `/api/tags` which also lists models; for
 *  everyone else we hit the root and accept any response (even 404) as "alive"
 *  because a 404 from a live server still proves TCP + TLS are fine. */
async function probeReachable(provider: LLMProvider): Promise<{ reachable: boolean; latencyMs: number; error?: string; modelsFromTags?: string[] }> {
  const startedAt = Date.now()
  try {
    if (provider.id === "ollama") {
      const res = await fetch(`${provider.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      })
      const latencyMs = Date.now() - startedAt
      if (!res.ok) return { reachable: false, latencyMs, error: `HTTP ${res.status}` }
      const data = await res.json() as { models?: Array<{ name: string }> }
      const modelsFromTags = (data.models ?? []).map(m => m.name)
      return { reachable: true, latencyMs, modelsFromTags }
    }

    const res = await fetch(provider.baseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - startedAt
    // Any response that came back = server is alive. Status codes are
    // irrelevant here — the soft probe below actually tests auth + quota.
    void res.text().catch(() => {})
    return { reachable: true, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - startedAt
    const msg = err instanceof Error ? err.message : String(err)
    return { reachable: false, latencyMs, error: msg }
  }
}

/** Soft 1-token probe — sends the absolute minimum request we can to confirm
 *  the provider will actually serve us. We deliberately bypass `llmCall` so
 *  this probe doesn't pollute the per-role usage telemetry (it's infrastructure
 *  checking, not real work). 429 → exhausted, 401/403 → auth-error, 2xx → ok. */
async function softProbe(provider: LLMProvider, apiKey: string, model: string): Promise<{ status: BootCheckResult["quotaStatus"]; error?: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SOFT_PROBE_TIMEOUT_MS)

    let response: Response
    try {
      if (provider.type === "anthropic") {
        response = await fetch(`${provider.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
          signal: controller.signal,
        })
      } else {
        const headers: Record<string, string> = { "Content-Type": "application/json" }
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
        response = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            temperature: 0,
          }),
          signal: controller.signal,
        })
      }
    } finally {
      clearTimeout(timer)
    }

    if (response.ok) return { status: "ok" }

    const bodyText = await response.text().catch(() => "")
    const trimmed = bodyText.slice(0, 400)
    if (response.status === 429) return { status: "exhausted", error: `429: ${trimmed}` }
    if (response.status === 401 || response.status === 403) return { status: "auth-error", error: `${response.status}: ${trimmed}` }
    // 400 with "quota" / "limit" / "exceeded" in the body is also exhaustion.
    const lower = trimmed.toLowerCase()
    if (lower.includes("quota") || lower.includes("rate limit") || lower.includes("exceeded")) {
      return { status: "exhausted", error: `${response.status}: ${trimmed}` }
    }
    return { status: "unknown", error: `HTTP ${response.status}: ${trimmed}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("abort") || msg.includes("timeout")) return { status: "unreachable", error: `timeout after ${SOFT_PROBE_TIMEOUT_MS}ms` }
    return { status: "unreachable", error: msg }
  }
}

/** Probe a single provider end-to-end. Disabled providers return a skipped
 *  result so the dashboard can still render them as "off" rather than hide
 *  them — operators want to see everything. */
export async function checkProvider(provider: LLMProvider): Promise<BootCheckResult> {
  const checkedAt = Date.now()
  const apiKey = resolveApiKey(provider)
  const hasKey = provider.id === "ollama" ? true : apiKey.length > 0
  const configuredModels = [...provider.models]

  if (!provider.enabled) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      enabled: false,
      hasKey,
      reachable: null,
      latencyMs: null,
      listedModels: null,
      configuredModels,
      quotaStatus: "skipped",
      errorMessage: "provider disabled in orchestrator-providers.json",
      checkedAt,
    }
  }

  if (!hasKey) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      enabled: true,
      hasKey: false,
      reachable: null,
      latencyMs: null,
      listedModels: null,
      configuredModels,
      quotaStatus: "auth-error",
      errorMessage: `missing API key (set ${provider.apiKeyEnv ?? "apiKey"} in providers config)`,
      checkedAt,
    }
  }

  const reach = await probeReachable(provider)
  if (!reach.reachable) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      enabled: true,
      hasKey,
      reachable: false,
      latencyMs: reach.latencyMs,
      listedModels: null,
      configuredModels,
      quotaStatus: "unreachable",
      errorMessage: reach.error ?? "unreachable",
      checkedAt,
    }
  }

  // Pick the first configured model for the soft probe. If no models are
  // configured we can still report reachability but skip the quota probe.
  const listedModels = reach.modelsFromTags
    ? Array.from(new Set([...configuredModels, ...reach.modelsFromTags]))
    : configuredModels.length > 0 ? configuredModels : null

  const probeModel = configuredModels[0] ?? reach.modelsFromTags?.[0]
  if (!probeModel) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      enabled: true,
      hasKey,
      reachable: true,
      latencyMs: reach.latencyMs,
      listedModels,
      configuredModels,
      quotaStatus: "unknown",
      errorMessage: "reachable but no models configured — add a model to probe quota",
      checkedAt,
    }
  }

  const probe = await softProbe(provider, apiKey, probeModel)
  return {
    providerId: provider.id,
    providerName: provider.name,
    enabled: true,
    hasKey,
    reachable: true,
    latencyMs: reach.latencyMs,
    listedModels,
    configuredModels,
    quotaStatus: probe.status,
    errorMessage: probe.error ?? null,
    checkedAt,
  }
}

/** Full boot-check: probe every provider in parallel, resolve the brain model,
 *  and compute an aggregate status. Never throws — infrastructure probes that
 *  blow up should surface in the report, not kill startup. */
export async function runBootCheck(): Promise<BootCheckReport> {
  const startedAt = Date.now()
  const providers = await loadProviders()

  const results = await Promise.all(providers.map(p => checkProvider(p).catch(err => {
    const msg = err instanceof Error ? err.message : String(err)
    const result: BootCheckResult = {
      providerId: p.id,
      providerName: p.name,
      enabled: p.enabled,
      hasKey: false,
      reachable: false,
      latencyMs: null,
      listedModels: null,
      configuredModels: [...p.models],
      quotaStatus: "unknown",
      errorMessage: `probe crashed: ${msg}`,
      checkedAt: Date.now(),
    }
    return result
  })))

  const brainModel = await resolveDefaultModel().catch(() => null)

  const healthyEnabled = results.filter(r => r.enabled && r.quotaStatus === "ok")
  const anyEnabled = results.some(r => r.enabled)
  const anyBlocked = results.some(r => r.enabled && (r.quotaStatus === "exhausted" || r.quotaStatus === "auth-error" || r.quotaStatus === "unreachable"))

  let brainStatus: BootCheckReport["brainStatus"]
  let summary: string
  if (!anyEnabled) {
    brainStatus = "blocked"
    summary = "No providers enabled — enable at least one provider in Settings."
  } else if (healthyEnabled.length === 0) {
    brainStatus = "blocked"
    const blockers = results.filter(r => r.enabled).map(r => `${r.providerId} (${r.quotaStatus})`).join(", ")
    summary = `All enabled providers are blocked: ${blockers}. Brain cannot route.`
  } else if (anyBlocked) {
    brainStatus = "degraded"
    summary = `${healthyEnabled.length} provider(s) healthy, some degraded. Brain model: ${brainModel ?? "none"}.`
  } else {
    brainStatus = "ready"
    summary = `${healthyEnabled.length} provider(s) healthy. Brain model: ${brainModel ?? "none"}.`
  }

  return {
    startedAt,
    completedAt: Date.now(),
    providers: results,
    brainModel,
    brainStatus,
    summary,
  }
}

// ---------------------------------------------------------------------------
// Cached report — kept in-process so the dashboard can read without re-probing
// ---------------------------------------------------------------------------

let _cachedReport: BootCheckReport | null = null

export function getCachedBootCheck(): BootCheckReport | null {
  return _cachedReport
}

export function setCachedBootCheck(report: BootCheckReport): void {
  _cachedReport = report
}

/** Run a fresh boot-check and cache it. Returns the new report. */
export async function refreshBootCheck(): Promise<BootCheckReport> {
  const report = await runBootCheck()
  setCachedBootCheck(report)
  return report
}
