/**
 * Resource manager — advisory file locks and LLM concurrency semaphore.
 * Prevents agents from stepping on each other's files and throttles
 * concurrent Ollama requests.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileLock = {
  agentName: string
  files: string[]
  acquiredAt: number
}

export type ContentionWarning = {
  file: string
  heldBy: string
  requestedBy: string
}

export type WorkIntent = {
  agentName: string
  description: string
  files: string[]
  declaredAt: number
}

export type IntentConflict = {
  yourIntent: WorkIntent
  theirIntent: WorkIntent
  overlappingFiles: string[]
}

// ---------------------------------------------------------------------------
// ResourceManager class
// ---------------------------------------------------------------------------

export class ResourceManager {
  private fileLocks = new Map<string, FileLock>()
  private intents = new Map<string, WorkIntent>()
  private llmCurrent = 0
  private llmMax: number
  private llmWaiters: Array<() => void> = []

  constructor(maxLlmConcurrency = 2) {
    this.llmMax = maxLlmConcurrency
  }

  // -------------------------------------------------------------------------
  // Advisory file locks
  // -------------------------------------------------------------------------

  /** Register the files an agent is currently working on. */
  acquireFiles(agentName: string, files: string[]): void {
    this.fileLocks.set(agentName, {
      agentName,
      files,
      acquiredAt: Date.now(),
    })
  }

  /** Release an agent's file locks (e.g., when agent finishes or is removed). */
  releaseFiles(agentName: string): void {
    this.fileLocks.delete(agentName)
  }

  /** Check if any of the given files overlap with another agent's locks. */
  getConflicts(agentName: string, files: string[]): ContentionWarning[] {
    const warnings: ContentionWarning[] = []
    const fileSet = new Set(files)

    for (const [holder, lock] of this.fileLocks) {
      if (holder === agentName) continue
      for (const f of lock.files) {
        if (fileSet.has(f)) {
          warnings.push({
            file: f,
            heldBy: holder,
            requestedBy: agentName,
          })
        }
      }
    }

    return warnings
  }

  /** Get all active file locks (for dashboard display). */
  getActiveLocks(): Map<string, FileLock> {
    return new Map(this.fileLocks)
  }

  // -------------------------------------------------------------------------
  // Shared work intent ledger
  // -------------------------------------------------------------------------

  /** Declare what an agent intends to work on. Replaces any previous intent. */
  declareIntent(agentName: string, description: string, files: string[]): WorkIntent {
    const intent: WorkIntent = { agentName, description, files, declaredAt: Date.now() }
    this.intents.set(agentName, intent)
    return intent
  }

  /** Clear an agent's declared intent (e.g., when cycle ends or agent stops). */
  clearIntent(agentName: string): void {
    this.intents.delete(agentName)
  }

  /** Check if an agent's intended files overlap with any other agent's intent or locks. */
  getIntentConflicts(agentName: string): IntentConflict[] {
    const mine = this.intents.get(agentName)
    if (!mine || mine.files.length === 0) return []

    const myFiles = new Set(mine.files)
    const conflicts: IntentConflict[] = []

    for (const [holder, theirIntent] of this.intents) {
      if (holder === agentName) continue
      const overlap = theirIntent.files.filter(f => myFiles.has(f))
      if (overlap.length > 0) {
        conflicts.push({ yourIntent: mine, theirIntent, overlappingFiles: overlap })
      }
    }

    // Also check active file locks from agents that didn't declare intent
    for (const [holder, lock] of this.fileLocks) {
      if (holder === agentName) continue
      if (this.intents.has(holder)) continue // already compared via intents
      const overlap = lock.files.filter(f => myFiles.has(f))
      if (overlap.length > 0) {
        const syntheticIntent: WorkIntent = {
          agentName: holder, description: "(active file locks)", files: lock.files, declaredAt: lock.acquiredAt,
        }
        conflicts.push({ yourIntent: mine, theirIntent: syntheticIntent, overlappingFiles: overlap })
      }
    }

    return conflicts
  }

  /** Get all declared intents (for dashboard/visibility). */
  getAllIntents(): Map<string, WorkIntent> {
    return new Map(this.intents)
  }

  /** Format all agents' intents into a readable summary for LLM context. */
  formatIntentSummary(excludeAgent?: string): string {
    const entries: string[] = []
    for (const [agent, intent] of this.intents) {
      if (agent === excludeAgent) continue
      const fileList = intent.files.length > 0
        ? intent.files.slice(0, 10).join(", ") + (intent.files.length > 10 ? ` (+${intent.files.length - 10} more)` : "")
        : "(no specific files)"
      entries.push(`- ${agent}: ${intent.description} [files: ${fileList}]`)
    }
    return entries.length > 0 ? entries.join("\n") : "(no other agents have declared work intents)"
  }

  // -------------------------------------------------------------------------
  // LLM concurrency semaphore
  // -------------------------------------------------------------------------

  /** Acquire an LLM slot. Blocks (via promise) if at max concurrency. */
  async acquireLlmSlot(): Promise<void> {
    if (this.llmCurrent < this.llmMax) {
      this.llmCurrent++
      return
    }
    // Queue up and wait for a slot
    return new Promise<void>((resolve) => {
      this.llmWaiters.push(() => {
        this.llmCurrent++
        resolve()
      })
    })
  }

  /** Release an LLM slot. Wakes the next waiter if any. */
  releaseLlmSlot(): void {
    this.llmCurrent = Math.max(0, this.llmCurrent - 1)
    const next = this.llmWaiters.shift()
    if (next) next()
  }

  /** How many supervisors are waiting for an LLM slot. */
  getLlmQueueDepth(): number {
    return this.llmWaiters.length
  }

  /** Current number of active LLM slots. */
  getLlmActiveCount(): number {
    return this.llmCurrent
  }

  /** Max LLM concurrency setting. */
  getLlmMaxConcurrency(): number {
    return this.llmMax
  }

  // -------------------------------------------------------------------------
  // Rate-limit coordination — shared 429 cooldown across all agents
  // -------------------------------------------------------------------------

  private rateLimitCooldownUntil = 0
  private rateLimitHitCount = 0

  /** Signal that a rate limit was hit. All agents should back off. */
  reportRateLimit(agentName: string): void {
    this.rateLimitHitCount++
    // Escalating cooldown: 30s, 60s, 120s, 240s (cap 5 min)
    const cooldownMs = Math.min(30_000 * Math.pow(2, Math.min(this.rateLimitHitCount - 1, 4)), 300_000)
    this.rateLimitCooldownUntil = Math.max(this.rateLimitCooldownUntil, Date.now() + cooldownMs)
  }

  /** Check if we're in a global rate-limit cooldown. Returns ms remaining, or 0 if clear. */
  getRateLimitCooldown(): number {
    const remaining = this.rateLimitCooldownUntil - Date.now()
    if (remaining <= 0) {
      // Reset hit count when cooldown expires
      if (this.rateLimitHitCount > 0 && this.rateLimitCooldownUntil > 0) {
        this.rateLimitHitCount = 0
      }
      return 0
    }
    return remaining
  }

  /** Reset rate limit state (e.g., after a successful call) */
  clearRateLimit(): void {
    this.rateLimitCooldownUntil = 0
    this.rateLimitHitCount = 0
  }

  /** Get the number of rate limit hits for monitoring */
  getRateLimitHitCount(): number {
    return this.rateLimitHitCount
  }
}
