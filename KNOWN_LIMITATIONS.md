# Known Limitations

This document catalogs known durability and resilience limitations in the orchestrator. Each entry describes what the limitation is, why it exists (the tradeoff), and what alternatives were ruled out.

Changes to behavior that fix these limitations should reference the relevant section here so the rationale is preserved.

---

## 1. In-Memory State

**What:** The event bus (200-event ring buffer) and `DashboardLog` (500-event history) are purely in-memory. All state is lost on process restart — no events, logs, or dashboard history survive.

**Why:** Keeps the system simple and fast for a local development tool. No external dependencies to manage, no disk I/O on every event, no schema migrations.

**Ruled out:** External database (Redis, SQLite, LevelDB) for event persistence. Adds operational complexity (setup, migration, cleanup) for a tool that runs locally and is designed for short-lived sessions. Could be revisited if multi-instance or long-running deployment becomes a requirement.

---

## 2. LLM Call Timeouts

**Status: Partially addressed (Cycle 1).** LLM calls in supervisor and brain now have configurable timeouts (180s default for supervisor, 180s default for brain via `chatCompletionWithUsage`). The `chatCompletionWithUsage` call path now threads `timeoutMs` through to the provider layer, and the supervisor distinguishes timeout errors (`isTimeoutError`) from rate-limit and general failures with appropriate escalation. Remaining gap: if a provider returns a streaming response that hangs mid-stream, the abort signal may not cancel the stream cleanly — this depends on the HTTP client implementation.

**What (original issue):** The `chatCompletionWithUsage` call in the supervisor's main loop had no `AbortController` timeout. If the LLM provider (Ollama or cloud) hung without responding, the supervisor blocked indefinitely on that single call. No other cycles, commands, or health checks executed until it returned or the process was killed.

**Why (original):** This was a bug, not an intentional design choice. The `directOllamaCall` in `brain.ts` had a 300s timeout, but when routing through the provider system via `chatCompletionWithUsage`, no timeout signal was passed.

---

## 3. Silent Error Swallowing

**Status: Partially addressed (Cycle 1).** 10 genuinely swallowed unexpected errors in `supervisor.ts` and `brain.ts` now log via `console.error` or `emit()`. ~28 remaining silent catches are intentional best-effort operations (telemetry, git ops, warmup, fallback parsing) and are documented with `// Intentionally silent: best-effort [purpose]` comments.

**What (original issue):** Multiple `catch {}` and `catch (() => {})` blocks throughout `supervisor.ts` and `brain.ts` silently discarded errors. Examples: analytics session creation, conversation checkpoint saves, cycle recording, prompt ledger writes, and stale-busy recovery force-status mutations.

**Why (original):** Originally intended for resilience — the supervisor shouldn't crash on unexpected non-critical errors. If analytics fails, the supervisor should keep running; if checkpointing fails, the cycle should continue. This prevents cascade failures where a secondary subsystem takes down the primary orchestration loop.

**Ruled out:** Letting errors propagate uncaught would make the supervisor brittle — a transient disk write failure or analytics hiccup would kill an entire supervision session. The implemented fix is selective: genuinely unexpected errors (checkpoint failures, session management, core message collection) now log via `console.error` or `emit()`, while true best-effort operations (telemetry, git ops, warmup) remain silent with documented rationale.

---

## 4. Per-Agent Failure Isolation

**Status: Addressed (Cycle 2).** `promptAll` now returns `{ succeeded: string[], failed: Array<{agent, error}> }` instead of `void`. The brain's `prompt_all` handler surfaces partial failures to the LLM with actionable guidance (e.g., "Sent to 2/3 agents. Failed: broken: Unknown agent. Consider retrying failed agents individually with PROMPT."). The CLI also displays partial results. Tests cover all-success, partial-failure, and all-failure cases.

**What (original issue):** `promptAll` in `brain.ts` (line ~491) called `orchestrator.promptAll` without per-agent error handling. If any single agent prompt failed, the entire `PROMPT_ALL` command failed. Similarly, the `runAllParallel` function used `Promise.allSettled` which logged failures but didn't surface them to callers.

**Why (original):** All-or-nothing semantics were simpler to reason about and implement. Partial success requires defining what "partially succeeded" means, how to report it back to the LLM, and how the brain should react — all of which add significant complexity.

**Ruled out:** Automatic retry within `promptAll` — the brain should decide whether to retry, not the orchestrator. The orchestrator reports what happened; the brain decides next steps.

---

## 5. Race Conditions on Shared Mutable State

**What:** Several shared objects — `pauseState`, `softStop`, `directiveRef` — are mutated across async flows without synchronization. For example, `softStop.requested` is read by the supervisor loop on one async stack and set by the CLI/dashboard on another. `pauseInjected` is set in the main loop and checked in the same loop, but async interleaving between rounds could cause inconsistencies.

**Why:** JavaScript's single-threaded execution model makes true data races rare — only one microtask runs at a time. However, `await` points create interleaving opportunities where state can change between reads and writes. In practice, these are unlikely to cause issues because the supervisor loop is sequentially structured and the shared state is only modified at well-defined points.

**Ruled out:** Mutex/lock library (e.g., `AsyncLock`). Adds complexity and can introduce deadlocks if not carefully managed. The current race risk is low because: (a) the supervisor loop is sequential within each agent, (b) state mutations from external sources (CLI/dashboard) are intentional signal-like semantics, not competing writes, and (c) the worst case (e.g., a pause request being processed one round late) is non-catastrophic.

---

## 6. No Provider Health Check at Startup

**What:** The orchestrator starts and begins spawning agents and supervisors without verifying that the configured LLM provider (Ollama, OpenAI, etc.) is reachable and the configured model is available. The first indication of a problem is when the initial LLM call fails — which may be minutes after startup, after agents have already been spawned.

**Why:** Startup speed. A health check adds latency (model loading can take 30–60s on cold Ollama starts), and even a successful health check doesn't guarantee the provider will be available for subsequent calls. The supervisor already has retry logic and circuit breakers that handle provider failures after startup.

**Ruled out:** Pre-flight health check on startup. Would add 5–60 seconds to every cold start (depending on model size and whether Ollama needs to load). The model warmup (`warmupModel` in `brain.ts`) is already fire-and-forget — making it blocking would slow startup, and making it mandatory would prevent startup when Ollama is temporarily down. The current approach (fail fast, retry with backoff) is more resilient to transient provider unavailability.

---

## 7. Dashboard API Limitations

**What:** The dashboard HTTP server has several limitations:
- **No pagination** on list endpoints (`/api/ledger`, `/api/messages`, `/api/performance`, `/api/status`). These return unbounded arrays that grow over time.
- **No request timeouts** on slow operations like agent restart or git merge. A hung operation blocks the HTTP response indefinitely.
- **No rate limiting** on API endpoints. Any local process with the session token can make unlimited requests.
- **Dynamic imports** in handlers (e.g., `await import("./providers")`). These are resolved on each request rather than cached at startup, adding latency on cold paths.
- **No graceful request cancellation** — if a client disconnects mid-request, server-side work continues.

**Why:** The dashboard is a local development tool, not a production API. It serves a single user on localhost. Pagination, rate limiting, and request timeouts add complexity that doesn't provide value for single-user local usage.

**Ruled out:** Full REST framework (Express, Hono middleware chains, etc.) is overkill for a local dashboard. Dynamic imports were chosen to avoid loading unused modules (e.g., providers, analytics) on every startup. A future refactor could move to eager imports if cold-path latency becomes noticeable. Pagination should be added to `/api/ledger` and `/api/messages` if session lengths grow significantly.

---

## 8. Memory Not Saved on Early Exit

**What:** `addMemoryEntry` is only called on successful cycle completion (`@done:` command) or clean STOP. If the supervisor exits early due to: circuit breaker, max rounds, unknown agent, abort signal, or crash — no memory entry is saved for the partial work done. The next session starts with no record of what was attempted.

**Why:** Partial progress is ambiguous. Saving memory on every step would be noisy and could persist bad state (e.g., a circuit-breaking supervisor saving "progress" that was actually repeated failures). The cycle-based checkpoint system (`saveConversationCheckpoint`) does save conversation state on each cycle, which provides some recovery, but the semantic memory (notes, summaries) only captures clean completions.

**Ruled out:** Saving memory on every LLM round or step. Too noisy — would fill the memory store with incomplete thoughts and retry attempts. A better future approach would be saving a "partial progress" entry on early exit with a structured format (e.g., `{ status: "interrupted", lastAction: "...", reason: "..." }`) rather than skipping it entirely.

---

## 9. Dashboard Error Visibility vs. Debouncing

**What:** The dashboard's long-poll event loop and status polling previously swallowed all errors silently. On network failure or server crash, the dashboard showed no indication — it appeared alive but was frozen on stale data. Similarly, mutating actions (save directive, merge branch, etc.) had no button disabling, risking double-submits on slow networks.

**Why:** The original code favored simplicity: `.catch(() => {})` on polls kept the UI stable during transient errors, and no loading states kept the UI responsive for fast local operations. In practice, this made the dashboard appear broken when the server was actually down.

**Ruled out:** Aggressive error popups on every failed poll. A 10-second polling interval with 3-consecutive-failure threshold before showing "disconnected" balances responsiveness against flicker during transient network issues. SSE reconnection uses exponential backoff (1s→60s) for the same reason.