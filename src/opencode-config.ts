/**
 * Opencode config generator — bridges our orchestrator provider registry into
 * the shape opencode serve expects on disk.
 *
 * The gap this fixes: our orchestrator keeps its own provider registry
 * (orchestrator-providers.json) and routes LLM calls via llmCall(). But the
 * *worker* prompts flow through opencode serve, which reads ~/.config/opencode/
 * opencode.json for its provider list. If our registry has "opencode-go" but
 * opencode's config only knows "ollama", the worker silently falls back to
 * whatever opencode's default model points at — which is how a worker returns
 * empty responses without surfacing any error.
 *
 * Solution: before spawning opencode serve for a worker, we generate an
 * opencode.json into a scratch directory that we own, set the worker's cwd to
 * that scratch dir, and set OPENCODE_PROJECT_DIR to the actual project. Opencode
 * picks up the scratch config (merging with the global one) and the worker gets
 * access to exactly the providers we've enabled — with `{env:VAR}` templates
 * expanded from the worker's own environment.
 */
import { mkdir, writeFile } from "fs/promises"
import { resolve } from "path"
import type { LLMProvider } from "./providers"

/** Subset of opencode's provider config we care about. Extra fields opencode
 *  defines (mode overrides, cost tiers, etc.) are left for opencode's global
 *  config to supply — we only inject what the orchestrator actually owns. */
type OpencodeProviderEntry = {
  name: string
  npm: string
  options: {
    baseURL: string
    apiKey?: string
  }
  models: Record<string, { name: string }>
}

export type OpencodeConfigFile = {
  $schema: string
  provider: Record<string, OpencodeProviderEntry>
}

/** Normalize provider baseURL for opencode's @ai-sdk/openai-compatible SDK,
 *  which expects a full v1 root. Our providers.ts stores the host without the
 *  /v1 suffix (so callOpenAICompatible can append its own path). */
function toOpencodeBaseURL(provider: LLMProvider): string {
  const trimmed = provider.baseUrl.replace(/\/+$/, "")
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`
}

/** Pick the npm package opencode should use for this provider. Anthropic gets
 *  its own SDK; everyone else rides the OpenAI-compatible one. */
function toOpencodeNpm(provider: LLMProvider): string {
  return provider.type === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
}

/** Convert one of our provider entries into opencode's provider shape.
 *  Exported for tests — the writer uses this as a building block. */
export function toOpencodeProviderEntry(provider: LLMProvider): OpencodeProviderEntry {
  const models: Record<string, { name: string }> = {}
  for (const m of provider.models) {
    models[m] = { name: m }
  }

  const entry: OpencodeProviderEntry = {
    name: provider.name,
    npm: toOpencodeNpm(provider),
    options: {
      baseURL: toOpencodeBaseURL(provider),
    },
    models,
  }

  // Inline apiKey (preferred — user explicitly set it) or env template
  // (opencode expands {env:VAR} at config-load time so the key stays out of
  // our generated file's plaintext). Ollama never gets a key.
  if (provider.id !== "ollama") {
    if (provider.apiKey && provider.apiKey.length > 0) {
      entry.options.apiKey = provider.apiKey
    } else if (provider.apiKeyEnv) {
      entry.options.apiKey = `{env:${provider.apiKeyEnv}}`
    }
  }

  return entry
}

/** Build a full opencode.json object from our enabled providers. Disabled
 *  providers are skipped so opencode serve doesn't advertise routes that will
 *  fail. Pure function — safe to unit-test. */
export function buildOpencodeConfig(providers: LLMProvider[]): OpencodeConfigFile {
  const config: OpencodeConfigFile = {
    $schema: "https://opencode.ai/config.json",
    provider: {},
  }

  for (const p of providers) {
    if (!p.enabled) continue
    // Skip providers with no models — opencode would register an empty provider
    // and the worker would have no route to pick. The user still sees the
    // provider in our dashboard, which tells them to add models.
    if (p.models.length === 0) continue
    config.provider[p.id] = toOpencodeProviderEntry(p)
  }

  return config
}

/** Per-worker scratch directory root. Kept in the orchestrator repo (not the
 *  user's project dir) so we don't pollute the worker's worktree. Gitignored. */
export const SCRATCH_ROOT = ".orchestrator-workspaces"

/** Resolve the scratch dir for a given project ID. */
export function scratchDirFor(projectId: string, repoRoot?: string): string {
  const root = repoRoot ?? resolve(import.meta.dirname, "..")
  return resolve(root, SCRATCH_ROOT, projectId)
}

/** Ensure the scratch directory exists and contains an opencode.json derived
 *  from the given providers. Returns the path to the scratch dir. The caller
 *  spawns opencode with cwd = scratchDir so opencode picks up this config. */
export async function prepareWorkerScratch(
  projectId: string,
  providers: LLMProvider[],
  repoRoot?: string,
): Promise<string> {
  const dir = scratchDirFor(projectId, repoRoot)
  await mkdir(dir, { recursive: true })
  const config = buildOpencodeConfig(providers)
  const configPath = resolve(dir, "opencode.json")
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8")
  return dir
}
