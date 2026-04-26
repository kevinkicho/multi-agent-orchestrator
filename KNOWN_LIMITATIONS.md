# Known Limitations

This document catalogs known durability and resilience limitations in the orchestrator. Each entry describes what the limitation is, why it exists (the tradeoff), and what alternatives were ruled out.

Changes to behavior that fix these limitations should reference the relevant section here so the rationale is preserved.

---

## For Future Agents

This doc is both a record of past tradeoffs and a pick-up queue. If you've been asked to "work on a known limitation," use the **Pick-up Queue** below to choose an item, then read that § for context and ruled-out alternatives before proposing a fix.

### Status legend

Each § starts with a status signal (either explicit `Status:` text or implicit in the framing):

- **Open** — no fix shipped yet; reasonable to work on.
- **Partially addressed** — some concrete improvements shipped; residual work documented inline.
- **Addressed** / **Fixed** / **Resolved** — done; kept in the doc so the rationale stays discoverable for anyone wondering "why was it built this way?"
- **Accepted** — tradeoff is intentional for a local, single-user dev tool. Only re-open if deployment context changes (multi-user, production exposure, paid APIs at scale).

### Pick-up queue

Only **Open** and **Partially addressed** items appear here, sorted high → low priority. The full context lives in the linked §.

| § | Title | Priority | Effort | Primary files | What a fix looks like |
|---|---|---|---|---|---|
| [38](#38-llm-usage-ledger-only-covers-the-orchestration-layer) | Worker LLM usage telemetry | **High** | M | `workers`, `src/llm-usage.ts` | Have worker processes append usage lines to a JSONL that the orchestrator tails — or add a small hook in opencode. Closes the biggest observability gap on paid APIs. |
| [7](#7-dashboard-api-limitations) | Request timeouts / rate limiting on dashboard | **High** | S | `src/dashboard.ts` | Wrap mutating route handlers with a 30s timeout helper; 413-reject requests that already overflow `Content-Length` (already done) but also add a simple token-bucket per session. |
| [8](#8-memory-not-saved-on-early-exit) | Memory not saved on circuit-break / max-rounds / abort | **High** | M | `src/supervisor.ts`, `src/brain-memory.ts` | Write a structured `{status:"interrupted", lastAction, reason}` entry to brain-memory on the early-exit paths. Feeds §36's outcome signal with real data. |
| [22d](#22d-scope-braints-still-uses-the-old-counter) | Migrate brain.ts to `FailureWindow` (team-manager done) | Medium | S | `src/brain.ts`, `src/failure-window.ts` | Mechanical change — replace `CircuitBreakerState` consecutive-failure pattern with a `FailureWindow` instance per the team-manager pattern landed in `9ff91df`. |
| [39](#39-multi-agent-coordination-protocol--no-claimrelease-on-parallel-pickups) | Multi-agent coordination protocol (claim/release) | **High** | M | `src/claims.ts` (new), `src/event-bus.ts`, `src/brain.ts`, `src/supervisor.ts`, `src/team-manager.ts`, `src/brain-manager.ts`, `src/dashboard.ts` | New `.orchestrator-claims.json` + `src/claims.ts` module with the canonical defaults pinned in §39 (30-min TTL, 5-min heartbeat, 5-s bid window). Ship §39a/§39b/§39c alongside or directly after — the protocol is unsafe in 8 h+ runs without all three. |
| [14](#14-crash-recovery-loses-mid-cycle-state) | Mid-cycle crash loses failure counters | Medium | M | `src/supervisor.ts`, `src/session-state.ts` | Checkpoint critical counters (`consecutiveFailedCycles`, `cycleRestartCount`, failure window snapshot) every N rounds so a crash recovery doesn't restart with zero backoff state. |
| [23](#23-dashboard-surfacing-of-write-failures) | Persistent write-failure log | Medium | S | `src/supervisor.ts`, `src/brain.ts`, `src/file-utils.ts` | Append failures to `.orchestrator-errors.jsonl` (capped at 500), surface from the dashboard. A supervisor running on stale memory after a silent write failure is one of the sharpest foot-guns left. |
| [25b](#25b-tradeoff-relevance-scoring-is-heuristic-not-semantic) | Shared-knowledge false negatives on untagged notes | Medium | S | `src/shared-knowledge.ts` | Always include the N most recent notes unconditionally alongside file-filtered ones — prevents a genuinely relevant note without `[files:]` tags from silently getting dropped. |
| [30b](#30b-tradeoff-generic-500-hides-context)–[d](#30d-supervisor-loadbrainmemory-guard) | Dashboard error-boundary gaps | Medium | M | `src/dashboard.ts` | Introduce a structured `dashboard-error` event type; route server-side handler errors and listener exceptions through it so operators see a single timeline of failures instead of console-only logs. |
| [34](#34-prunepromote-thresholds-are-static) | Adaptive prune/promote thresholds | Medium | L | `src/brain-memory.ts`, `src/meta-reflection.ts` | **Blocked on data.** Run a multi-week session; collect promotion/unpromotion stats; only then tune. Doing this without real observations is the bike-shed failure mode. |
| [33](#33-behavioral-note-fire-matching-is-heuristic) | Fire-matching heuristic accuracy | Medium | L | `src/fire-tracker.ts` | **Blocked on data.** Same rationale as §34. Consider embedding-based matching once it's clear where the heuristic misses. |
| [36](#36-cycle-outcomes-are-coarse-and-heuristic) | Coarse cycle outcome bucketing | Medium | L | `src/brain-memory.ts`, `src/supervisor.ts` | **Blocked on data.** Three-bucket taxonomy may need expansion or weighting, but we need real run-log evidence first. |
| [40](#40-no-councilquorum-mode-for-high-stakes-decisions) | Council/quorum mode for high-stakes decisions | Medium | M | `src/brain.ts`, `src/project-manager.ts`, `src/brain-memory.ts` | Fan a single judgment prompt out to N independent LLM calls (no shared context), aggregate by majority vote. Wire merge-approval and note-unpromotion first. |
| [41](#41-stigmergy-via-behavioral-notes-is-too-slow-for-concurrent-agents) | Real-time stigmergy channel for concurrent agents | Medium | M | `src/event-bus.ts`, `src/supervisor.ts`, `src/shared-knowledge.ts` | Publish `@lesson:`/`@signal:` markers onto a short-TTL bus channel alongside durable note storage so concurrently-running supervisors see fresh signals within the round, not the next cycle. |

### Workflow tips

- **Read before you code.** Every § documents what was *ruled out* and why. Many "obvious" fixes were considered and rejected — skipping that section is the fastest path to re-proposing a bad idea.
- **Status updates after shipping.** Change the §'s first paragraph to `**Status: Addressed.**` and add a short paragraph describing the concrete change. Preserve the original framing (rename "What:" to "What (original issue):") so future readers can still see what the world looked like before.
- **Test discipline.** `bun test` runs the full suite; add tests per module in `src/tests/` following the one-test-file-per-source-module convention. `bun x tsc --noEmit` has pre-existing `@types/node` env errors in the current tsconfig — grep out `Cannot find name 'process'|'Bun'|'fs'|'path'` when reviewing its output.
- **Effort scale.** `S` = under half a day, `M` = half-to-one day, `L` = multi-day or blocked on prerequisite work / data.
- **Scope discipline.** A fix for §X should only touch §X. If you notice a related limitation mid-fix, add a note to it rather than expanding scope silently — a small shipped change is better than a sprawling one that stalls in review.
- **Don't add to this queue casually.** The signal-to-noise of this doc depends on every entry being a real tradeoff with a ruled-out paragraph, not a TODO.

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

**Status: Pagination addressed.** `/api/ledger` has always honored `?limit=&offset=` via `queryLedger`. `/api/messages/<agent>` and `/api/performance` now accept the same params via a shared `sliceFromTail(items, params, {defaultLimit, maxLimit})` helper (tail-relative offset — `offset=0,limit=50` returns the most recent 50). Defaults are 200 for messages (max 1000) and 200 for performance (max 500). Response shape on `/api/messages` stays a bare array for backward compatibility; the pre-slice count is exposed via the `X-Total-Count` header. `/api/performance` returns `{ entries, total }`. `/api/status` is not paginated because it returns a fixed-size map keyed by agent name.

**Remaining limitations:**
- **No request timeouts** on slow operations like agent restart or git merge. A hung operation blocks the HTTP response indefinitely.
- **No rate limiting** on API endpoints. Any local process with the session token can make unlimited requests.
- **Dynamic imports** in handlers (e.g., `await import("./providers")`). These are resolved on each request rather than cached at startup, adding latency on cold paths.
- **No graceful request cancellation** — if a client disconnects mid-request, server-side work continues.

**Why:** The dashboard is a local development tool, not a production API. It serves a single user on localhost. Rate limiting and per-route timeouts add complexity that doesn't provide value for single-user local usage.

**Ruled out:** Full REST framework (Express, Hono middleware chains, etc.) is overkill for a local dashboard. Dynamic imports were chosen to avoid loading unused modules (e.g., providers, analytics) on every startup. A future refactor could move to eager imports if cold-path latency becomes noticeable.

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

---

## 10. LLM Retry Semaphore Release During Backoff

**What:** When an LLM call fails, the supervisor backs off (exponential delay: 5s→60s, or 30s→5min for persistent failures). Previously, the retry logic ran inside the `withLlmSlot` callback, meaning the LLM concurrency slot was held for the entire backoff period. Other agents waiting for a slot would be blocked even though no actual LLM call was in progress.

**Why:** The original design used `withLlmSlot(doLlmCall)` where `doLlmCall` contained both the initial call and the retry — simplifying slot management (acquire once, release once). This blocked other agents during backoff because the slot was never released between attempts.

**Resolution (Cycle 2):** The retry logic now runs outside the semaphore. On failure, the slot is released, then the backoff delay occurs (allowing other agents to use the slot), and the retry re-acquires the slot via a second `withLlmSlot` call. Timeout and rate-limit errors still break the cycle (don't retry) since they indicate issues that won't resolve within a single round.

**Thundering herd consideration:** Releasing the slot during backoff means more agents can make progress concurrently. When the backoff expires and the retrying agent re-acquires a slot, it simply joins the queue — the semaphore's max concurrency limit (default: 2) prevents unbounded parallel LLM calls. No thundering herd is possible because the semaphore serializes beyond its concurrency limit.

---

## 11. SSRF Risk in Dashboard API

**What:** The `POST /api/analytics/evaluate/:id` and `POST /api/analytics/compare` endpoints accept an `ollamaUrl` parameter from the request body and pass it directly to internal LLM calls. A malicious local process could craft a request with an `ollamaUrl` pointing to an internal network service, causing the orchestrator to make requests to arbitrary URLs.

**Why:** The orchestrator is designed as a local development tool that accepts Ollama URLs for flexibility. Users configure different Ollama instances (local, remote, cloud) and the dashboard needs to pass these URLs for evaluation features.

**Ruled out:** Validating URLs against an allowlist. The tool is localhost-only and auth-protected for mutating endpoints. A local attacker with dashboard access already has broad control over the system. If network exposure is needed, the orchestrator should be behind a reverse proxy with proper network policies.

---

## 12. Command Injection Risk in Validation API

**What:** The `POST /api/projects/:id/validation` endpoint accepts a `command` field that is stored and later executed as a shell command via `Bun.spawn`. While the dashboard only offers preset commands (`test`, `typecheck`, `lint`, `build`), the API accepts arbitrary strings that could inject shell commands. The `postCycleValidation` system also passes the command through to `Bun.spawn(["sh", "-c", val.command])`.

**Why:** The validation system is designed to run arbitrary project-specific build/test commands. Restricting to presets would limit flexibility for projects with custom validation needs.

**Ruled out:** Restricting to a fixed preset list. The current design trusts the operator (local user with dashboard access) to provide valid commands. If the dashboard is exposed to untrusted users, both the validation API and all other mutating endpoints need proper authentication and input sanitization, not just this one.

---

## 13. Graceful Dashboard Shutdown

**Status: Addressed.** `startDashboard` now returns both a `stop()` (immediate, legacy behavior) and a `gracefulStop({drainMs=5000})`. On SIGINT/SIGTERM/SIGHUP/uncaught-exception, `cli.ts::gracefulShutdown` awaits `gracefulStop(5000)`:

1. Every active SSE subscriber receives a `dashboard-shutdown` frame so clients can distinguish a clean shutdown from a network drop.
2. A 50 ms flush delay lets those bytes hit the wire.
3. Every tracked SSE controller is closed (SSE streams never terminate on their own, so `server.stop(false)` alone would hang on them).
4. `server.stop(false)` drains in-flight HTTP requests, raced against the remaining drain budget.
5. A final `server.stop(true)` force-closes anything still pending (hung long-polls, slow handlers) so shutdown can never hang indefinitely.

A second interrupt signal during shutdown force-exits immediately (`shuttingDown` flag), so operators impatient with a hung drain still have escape.

**Tradeoff: no cross-process coordination.** The drain stops HTTP/SSE activity on the dashboard but does not wait for in-flight LLM calls, worker process shutdown, or git operations. Those are shut down separately by `projectManager.shutdown()` and `orchestrator.shutdown()` (both synchronous, best-effort). A true end-to-end graceful shutdown that awaits worker exits would add complexity with little payoff — workers are killed by process signal and their cleanup is idempotent.

---

## 14. Crash Recovery Loses Mid-Cycle State

**What:** If the orchestrator process crashes mid-cycle, the supervisor loses: the conversation `messages` array, nudge escalation state, `consecutiveLlmFailures`, `consecutive429s`, `consecutiveEmptyResponses`, `consecutiveIdleCycles`, `cycleRestartCount`, and the `cycleHadProgress` flag. On restart, the supervisor resumes from the last checkpoint (saved at cycle completion), re-doing all work from that point. Post-validation memory entries that were deferred but not yet persisted are lost.

**Why:** Checkpointing every message and counter update would require disk I/O on every LLM round, dramatically increasing latency for local development. The current design checkpoints only at cycle boundaries (`saveConversationCheckpoint`, `checkpointSupervisor`), which is a reasonable tradeoff for a development tool.

**Ruled out:** Per-round or per-message checkpointing (too much I/O). A potential improvement: incremental checkpointing of critical counters (failure counts, cycle progress) every N rounds, so crash recovery doesn't start from zero backoff state.

---

## 15. Dashboard UI/UX Issues

### 15a. STUCK Agent Status Maps to Idle (Green) Dot

**Status: Fixed.** Added `case 'stuck': return 'dot-stuck'` to `statusToDot()` and a `.dot-stuck` CSS rule with pulsing orange background (`#fb923c; animation: pulse 0.6s infinite`). Also added `'dot-stuck'` label color mapping in `updateStatusBar()`.

**What (original issue):** The `statusToDot()` function in `dashboard-client.js` had no case for `'stuck'`, causing it to fall through to `default: return 'dot-idle'`. A stuck agent appeared as a green dot in the status bar — the most misleading possible representation.

---

### 15b. Brain Log Has No Virtual Scroll — Unbounded DOM Growth

**Status: Not a bug.** Investigation confirmed the brain log already routes through `addExpandableEntry` → `pushEntry` → virtual scroll system. The original audit finding was incorrect.

~~**What:** The brain log panel (`#brain-log`) appends entries directly to the DOM, causing unbounded growth in long sessions.~~

**Why:** The brain log was implemented before the virtual scroll system was added, and was never retrofitted.

**Fix:** Route all brain log additions through `pushEntry(brainLog, entry)` instead of direct DOM appends. The `getStore()` function already handles any element, including `brainLog`.

---

### 15c. SSE and Poll Loop Both Run Simultaneously

**What:** Both the SSE `onmessage` handler and the long-polling loop run concurrently. The SSE handler delivers events to the live event stream panel and processes `directive-updated` updates, while the poll loop delivers events to agent log panels via `handleEvent()`. The SSE handler does **not** update `cursor`, so when the poll loop next runs, it re-fetches the same events. However, since the two systems target different UI panels (live event stream vs. agent logs), there is no visible duplication in agent panels.

**Why:** SSE was added for lower-latency real-time updates on top of the existing poll loop, which provides a reliable fallback. Removing either would lose a capability.

**Remaining concern:** The SSE handler's directive update and the poll loop's `applyProjectData` can race on the `directiveText.value` field. The `_userEdited` flag mitigates this but has a timing window (see §15h).

**Possible fix:** Update `cursor` in the SSE `onmessage` handler so the poll loop skips already-delivered events. This would avoid unnecessary re-fetching and processing, though it wouldn't change visible behavior since the two systems target different panels.

---

### 15d. Export Captures Only Rendered (Visible) Entries

**Status: Fixed.** `exportLogs()` now iterates `logStores` backing arrays via `entryToText()` instead of `querySelectorAll` on DOM nodes. This captures the full `MAX_BACKING=5000` entries per panel instead of only the 200 currently rendered.

**What (original issue):** The `exportLogs()` function used `querySelectorAll` to iterate log entries, which only found DOM nodes currently rendered in the viewport.

**Why:** The export function was written before the virtual scroll system was added, and was never updated to iterate the backing store.

**Fix:** Change `exportLogs()` to iterate `logStores.get(logEl).entries` instead of `querySelectorAll`, so it captures the full `MAX_BACKING=5000` entries.

---

### 15e. Global Search Filters All DOM on Every Keystroke

**Status: Fixed.** `filterLogs()` now uses a 120ms debounce on the `oninput` handler. The search function iterates `logStores` backing arrays and correlates results with rendered DOM entries, avoiding the expensive `querySelectorAll` across all log entries on every keystroke.

**What (original issue):** The `filterLogs()` function ran `document.querySelectorAll` across the entire document on every `input` event.

**Why:** The search was designed for small sessions where querySelectorAll is fast. No debounce or indexing was implemented.

**Fix:** (a) Add a debounce (e.g., 150ms) to the search input handler, (b) search the `logStores` backing arrays instead of the DOM, or (c) maintain a search index that updates incrementally.

---

### 15f. Initial Load Failure State Never Clears on Recovery

**Status: Fixed.** The original empty-state HTML is now saved on page load. When the poll loop successfully recovers after an initial failure, `restoreEmptyState()` resets the error message to the original content. Additionally, when the poll loop encounters an error during initial cursor setup (`cursor === 0`), it shows a toast notification that live events may have been skipped.

**What (original issue):** If `/api/status` failed on initial page load, the empty-state div was overwritten with "Unable to connect" text that persisted even after the server came back.

**Why:** The initial load failure was designed as a one-time check, not a persistent state. Recovery was assumed to be a page reload.

**Fix:** When the poll loop successfully receives status data, reset the empty-state div to its original content.

---

### 15g. Status Bar Agent Names Aren't Clickable

**Status: Fixed.** Agent names in the status bar are now `<a>` elements with `onclick` handlers that call `scrollIntoView({behavior:'smooth', block:'center'})` to navigate to the corresponding project row.

**What (original issue):** The status bar showed agent names as `<span>` elements with no interaction.

**Why:** The status bar was originally a read-only indicator, not a navigation tool.

**Fix:** Wrap each agent name in an `<a>` tag (or add an `onclick`) that scrolls the corresponding project row into view, e.g., `document.getElementById('row-' + name).scrollIntoView({behavior:'smooth'})`.

---

### 15h. Directive Textarea Race Condition with Polling

**Status: Fixed.** The `_userEdited` flag is now set on both `input` and `focus` events and only cleared on successful `saveDirective()`. The previous 5-second `blur` timeout that could silently overwrite user edits has been removed.

**What (original issue):** The `_userEdited` flag on the directive textarea was set on `input` events and cleared 5 seconds after `blur`. If the 10-second `/api/projects` poll fired within that 5-second window, it overwrote the user's edit with the server's value. The user's changes were silently lost.

**Why:** The `_userEdited` mechanism was designed to prevent overwriting while the user is actively typing, but the blur → 5s → clear window is too long for passive focus loss.

**Fix:** Don't clear `_userEdited` on blur with a delay. Instead, only clear it when `saveDirective()` successfully saves, or when the user explicitly focuses away from the field without having typed.

---

### 15i. No Local Echo for Sent Prompts

**Status: Fixed.** `sendPrompt()` now appends a "You: <text>" entry to the worker log immediately after validation, before the API call. On failure, an error entry is appended instead of using `alert()`.

**What (original issue):** When a user sent a prompt via the chatbox, the text disappeared from the input but no entry appeared in the log until the server processed it.

**Why:** The chatbox was designed for fast local interactions where the server echo arrives quickly. No optimistic update was implemented.

**Fix:** Append an optimistic entry to the worker log immediately after the `apiFetch` call succeeds, before the server echo arrives.

---

### 15j. `cmdHistory` and `removedAgents` Grow Without Bound

**Status: Partially fixed.** `cmdHistory` is now capped at 100 entries (oldest entries are shifted). `removedAgents` retains its wholesale-clear-on-add behavior since its semantics require remembering removals.

**What (original issue):** `cmdHistory` pushed every command and never capped. `removedAgents` adds project names on removal and only clears wholesale on project addition.

**Why:** Originally designed for short-lived sessions where the set of agents is small. Not a practical issue in normal use, but technically unbounded.

---

## 16. Dashboard Performance Under Load

### 16a. Backing Store Trim Cost Amortized

**Status: Fixed.** The `splice(0, excess)` call in `pushEntry` only fires when the backing array exceeds `MAX_BACKING + TRIM_BATCH` (5100 entries), trimming 100 entries at a time. This amortizes the O(n) cost of array shifting from O(n) per event to O(n) per 100 events.

**What (original issue):** When a log panel's backing array reached 5,000 entries, every `pushEntry` call triggered `splice(0, 1)`, which shifts 4,999 elements. During active agent bursts (75+ events per cycle across 5 agents), this created O(5000) × 75 = ~375,000 element shifts per cycle. The UI became sluggish after 1-6 hours depending on cycle frequency.

### 16b. Layout Thrashing in pushEntry

**Status: Fixed.** `pushEntry` now defers `scrollTop` writes to `requestAnimationFrame`, batching layout reads and writes into a single frame. Previously, every log entry forced 1-2 synchronous layout computations via `offsetParent` and `scrollHeight`, causing 20-30 forced layouts per second during bursts.

**What (original issue):** Every `pushEntry` call read `logEl.offsetParent` and wrote `logEl.scrollTop = logEl.scrollHeight` synchronously. During active agent bursts, this caused layout thrashing — the browser could not batch reads and writes, leading to jank and dropped frames.

### 16c. Status Bar Rebuild on Every Status Event

**Status: Fixed.** `updateStatusBar()` now uses `requestAnimationFrame` debouncing — multiple status events in the same frame collapse into a single DOM update.

**What (original issue):** Every `agent-status` and `supervisor-status` event called `updateStatusBar()`, which rebuilds `innerHTML` for the entire status bar. With 5 active agents, this fired ~20 times per cycle burst, each destroying and recreating 5+ DOM nodes.

### 16d. Performance Expectations for Long-Running Sessions

With 5 agents running for 2+ hours:

- **Backing store memory:** ~17.5 MB total (50,000 entries across 11 panels × ~350 bytes each). Acceptable for modern browsers.
- **DOM node count:** ~2,550 nodes (5 agent rows × 70 static nodes + 5 × 2 × 200 virtual scroll + 200 brain + 200 events). Well within browser limits.
- **Backing array trim:** After filling, each panel trims 100 entries every ~100 events. The O(5000) splice happens once per 100 pushes, amortizing the cost.
- **Polling rate:** 3 fixed intervals (10s status, 60s models, 30s admin panels) + 1 persistent long-poll + 1 persistent SSE. Does NOT scale with agent count.
- **Remaining concern:** The `renderEntry()` function creates a new DOM node for every log entry. During active bursts, this can create 75-150 DOM nodes per cycle. With MAX_RENDERED=200 cap per panel, old nodes are removed, but creation cost scales with event frequency.

---

## 17. SSE vs Poll Architecture Decision

**What:** The dashboard runs both an SSE stream (`/api/events/stream`) and a long-poll loop (`/api/events`) simultaneously. The SSE stream delivers `BusEvent` objects (cross-agent notifications like intent-conflict, resource-contention, directive-updated) to the admin drawer's live event stream. The poll loop delivers `DashboardEvent` objects (agent-status, supervisor-thinking, agent-prompt, etc.) to agent log panels via `handleEvent()`.

**No duplication:** These are two different event channels (EventBus vs DashboardLog) feeding two different UI regions. The poll and SSE do NOT deliver the same events to the same panels. The only overlap is `directive-updated` events, which are handled by the SSE handler to update the directive textarea — but these are BusEvents not DashboardEvents, so the poll loop never delivers them.

**Why:** SSE provides lower-latency real-time updates. The poll loop provides a reliable fallback and delivers the detailed per-agent data that populates the main UI. Running both ensures responsiveness even when SSE reconnects.

**Tradeoff:** The poll loop fetches events that SSE may have already delivered conceptually (e.g., a cycle-completion BusEvent and a cycle-summary DashboardEvent describe the same occurrence). This is redundant network traffic but does NOT cause visual duplication since they target different UI panels.

---

## 18. Stuck Status Priority Tradeoff

**What:** The `effectiveStatus()` function determines what dot color an agent shows in the status bar. It resolves conflicts between the worker's status (idle, busy, stuck, error, disconnected) and the supervisor's status (busy, paused, completed, reviewing). The priority order is:

1. `paused` (supervisor) — always wins
2. `completed` (supervisor) — always wins
3. `error`, `disconnected`, `stuck` (worker) — wins over supervisor `busy`
4. `busy` (supervisor) — wins over worker `idle`
5. `idle` (worker) — fallback

**Why:** Originally, `stuck` was not in the priority list at all — it fell through to the default which returned `a.status`. But when the supervisor was `busy` (supervising the stuck agent), `effectiveStatus` would return `'busy'` instead of `'stuck'`, making the orange pulsing dot invisible at the exact moment it's most needed.

**Tradeoff:** Showing `stuck` instead of `busy` means a supervisor actively working on the stuck agent will show as "stuck" rather than "busy." This is correct because the stuck state is more actionable than the busy state — the user needs to know something is wrong, not just that work is happening.

---

## 19. Dashboard Scroll Batching Tradeoff

**What:** The `pushEntry()` function defers `scrollTop` writes to `requestAnimationFrame`. This batches layout reads/writes during active event bursts, eliminating layout thrashing. However, it introduces a 1-frame delay (up to 16ms) before a newly appended entry scrolls into view.

**Why:** Without batching, every `pushEntry` call forced 1-2 synchronous layout computations via `offsetParent` and `scrollHeight`. During bursts of 5+ active agents generating 75+ events per cycle, this caused 20-30 forced layouts per second, leading to dropped frames and jank.

**Tradeoff:** The 1-frame delay is imperceptible to users (16ms vs the 100-300ms event processing time), but it means the scroll position may lag slightly behind the actual content height. If a user manually scrolls during an active burst, the deferred rAF may race with their scroll gesture. The `store.pinned` flag mitigates this — if the user has scrolled up (unpinned), no scroll-to-bottom is attempted, so the rAF is a no-op.

---

## 20. Server-Side Memory and Growth Characteristics

### 20a. DashboardLog Ring Buffer

The `DashboardLog` class (`dashboard.ts:34-80`) maintains a `history` array capped at 500 entries. When it exceeds 500, it trims via `this.history = this.history.slice(trimCount)`, which creates a new array. This is an O(n) copy that happens roughly every time the buffer fills (every ~200-400 events, depending on how many agents generate how many events per cycle). The cost is negligible at 500 entries.

### 20b. EventBus Ring Buffer

The `EventBus` class (`event-bus.ts:38-76`) uses a `buffer` array capped at 200 entries. It uses `this.buffer.shift()` to trim, which is O(n) for 200 elements — negligible, but worth noting that a proper circular buffer would be O(1).

### 20c. Performance Log Archive Files — Self-Cleaning

**Status: Fixed.** Archive files older than 30 days are now deleted during `savePerformanceLog()`. The cleanup runs as a best-effort step after archiving, scanning the archive directory for `perf-*.json` files whose modification time exceeds `MAX_ARCHIVE_AGE_DAYS` (30).

**What (original issue):** Performance log archive files under `.orchestrator-performance-archive/` accumulated indefinitely at one file per day, with no cleanup mechanism.

**Tradeoff:** Setting the retention period to 30 days balances keeping enough history for trend analysis against disk usage. Each daily file is typically <100KB (500 entries × ~200 bytes), so 30 days of archives is ~3MB. If longer retention is needed, `MAX_ARCHIVE_AGE_DAYS` can be increased or set to `Infinity` to disable cleanup.

### 20d. pendingComments Array — Hard Cap at 50

**Status: Fixed.** `pendingComments` is now capped at 50 entries. When a new comment is pushed and the array exceeds 50, the oldest entries are discarded via `slice(-50)`.

**What (original issue):** The `pendingComments` array in `ProjectState` had no maximum size. Comments accumulated between supervisor reads. The supervisor drains the array each cycle, so in practice it rarely held more than a few entries, but there was no safety net if a user rapidly submitted many comments.

### 20e. Memory Estimate for 5 Agents Over 8 Hours

| Component | Per Agent | 5 Agents × 8 Hours | Notes |
|-----------|----------|-------------------|-------|
| Supervisor messages | ~60 entries (trimmed each cycle) | In-memory, GC'd each cycle | Local variable |
| DashboardLog history | Fixed 500 entries | ~500 entries shared | Ring buffer, server-side |
| EventBus buffer | Fixed 200 entries | ~200 entries shared | Ring buffer, server-side |
| Brain memory (per agent) | 20 entries + 20 notes + 10 behavioral (non-promoted) + 50 archived | 250 entries total | Capped, written to disk |
| Performance log | Fixed 500 entries | ~500 entries active + archive files | Archived to disk |
| Project state (per project) | ~1KB each | ~5KB total | Fixed per project |
| **Total server-side memory** | | **~2MB** | Well within limits |

| Client-side (browser) | Per Panel | 11 Panels Total | Notes |
|------------------------|----------|----------------|-------|
| Backing arrays (MAX_BACKING=5100) | ~5100 × 350 bytes | ~19.6 MB | Bounded, batch-trimmed |
| DOM nodes (MAX_RENDERED=200) | ~200 per panel | ~2,200 nodes | Bounded |
| Other JS state | ~5KB per agent | ~25KB | projectRows, agents, etc |
| **Total client-side memory** | | **~20 MB** | Acceptable for modern browsers |

### 20f. What Breaks First

**If pushed beyond 8 hours with 5+ agents:**

1. **Client-side: Backing array trim latency** — After panels fill to MAX_BACKING+TRIM_BATCH (5100 entries), the batch trim of 100 entries happens every ~100 events. With 5 agents generating 10+ events per cycle and cycles every 60-90 seconds, a panel fills in ~4-6 hours. After filling, the trim happens infrequently enough (once per 100 events) that the amortized cost is negligible.

2. **Client-side: DOM creation during bursts** — `renderEntry()` creates new DOM nodes for every log entry. During a burst of 5 agents cycling simultaneously, 75-150 DOM node creations happen in rapid succession. The MAX_RENDERED=200 cap per panel prevents unbounded DOM growth, but the creation cost scales with event frequency. This is the most likely source of perceived lag.

3. **Server-side: Performance archive files** — One file per day, auto-cleaned after 30 days. Archive files older than `MAX_ARCHIVE_AGE_DAYS` are deleted during `savePerformanceLog()`. Disk usage stays bounded at ~3MB for 30 days of archives.

4. **Network: Poll loop HTTP requests** — 2 requests every 10 seconds (status + projects) plus 1 long-poll connection. This does NOT scale with agent count and is negligible for any reasonable deployment.

## 21. Auto-Restart Exponential Backoff

### 21a. Behavior

When a supervisor stops due to failure, `ProjectManager` auto-restarts it with escalating delays. The first 3 failures use a fixed schedule (10s, 30s, 60s); after that, delays follow exponential backoff (30s × 2^(n-3)) capped at 10 minutes. The count resets on any of:

- Successful cycle completion (`onCycleComplete`)
- Clean supervisor stop (`isFailure=false`)
- Manual restart via `restartSupervisor()`
- Project removal or shutdown

### 21b. Opt-In Cap on Restart Attempts

**Status: Addressed.** `SupervisorLimits.maxSupervisorRestartAttempts` bounds the number of consecutive failed auto-restarts. When the count exceeds the cap, `ProjectManager.handleSupervisorStop` skips the setTimeout reschedule, logs a `SUPERVISOR GAVE UP` alert to the dashboard, and emits a `supervisor-given-up` event on the bus (`{ attempts, limit, summary, reason, isLlmBreaker }`). The counter still resets on successful cycle, clean stop, manual restart, or project removal, so a cap of 5 means "five consecutive failures without any intervening success" — not a lifetime ceiling.

**Default is `Infinity`**, preserving historical behavior. Set a finite value in `orchestrator.json` when running against paid APIs where permanently-broken projects would otherwise burn budget on a 10-minute retry loop.

### 21c. Tradeoff: Coarse Give-Up Signal

The cap is a single integer — there is no per-error-type tuning (e.g., "3 attempts on LLM-unreachable, 10 on other failures"). The LLM circuit breaker (§22) still applies independently within an attempt, so a single supervisor can burn its attempt budget on one kind of failure while other failure modes go untested. This is intentional: a richer policy would re-introduce the "infinite retry" failure mode when misconfigured. Operators who want differentiated handling should watch `supervisor-given-up` events and decide case-by-case.

## 22. LLM Circuit Breaker with Cross-Restart Escalation

### 22a. Behavior

The supervisor tracks LLM outcomes in a fixed-size rolling window (`FailureWindow`, default size 10 via `SupervisorLimits.llmFailureWindow`). When the number of `"fail"` entries in the window reaches `SupervisorLimits.maxConsecutiveLlmFailures` (default 5), the circuit breaker trips and the supervisor stops, calling `onSupervisorStop` with `reason="llm-unreachable"`. The window is cleared on trip so a re-started supervisor starts fresh rather than inheriting the tripping condition.

`ProjectManager` tracks `llmCircuitBreakerCounts` per project across restarts. Each breaker trip enforces a minimum cooldown: `5min × 2^(n-1)` for the nth consecutive trip (trip 1 = 5min, trip 2 = 10min, capped at 10min). This cooldown is applied on top of the normal auto-restart backoff via `max(normal_backoff, breaker_backoff)`.

The breaker count resets when the supervisor completes a full cycle successfully (`onCycleComplete`), on clean stop, manual restart, project removal, or shutdown.

### 22b. Addressed: Intermittent Recovery No Longer Hides Sustained Failure

**Status: Addressed.** Prior behavior: a single integer counter (`consecutiveLlmFailures`) was reset to 0 on any successful LLM call. A flaky provider succeeding 1 in 5 calls would pin the counter near zero and never trip — the supervisor burned tokens and wall-clock on an effectively unusable provider.

Current behavior: outcomes are tracked in a rolling window. With defaults, the breaker trips when 5 of the last 10 calls failed, regardless of how the successes and failures interleave. Intermediate escalation paths (the 3-failure "pause longer" guard, the retry backoff exponent) also use `failuresInWindow()`, so a flaky provider gets the same slowdown a fully-down provider would.

### 22c. Tradeoff: Window Size is a Single Knob

One window size applies uniformly to timeouts, generic errors, and retry failures. A provider that times out every 8th call — barely recoverable in practice — will trip a window-of-10 breaker at `maxConsecutiveLlmFailures=5` only if ~5 of those 10 also happened to be real failures. Operators who see false positives should raise `llmFailureWindow` (more tolerant, slower to trip); operators on paid APIs who want to fail fast should lower it. Per-error-class thresholds are deliberately ruled out — the failure taxonomy is already noisy (network hiccup vs. provider outage vs. model OOM) and per-class tuning multiplies the configuration surface without a clean way to validate which class a given failure really belongs to. Rate-limit (429) errors remain on a separate counter (`consecutive429s`, §26) because their recovery semantics (provider quotas) are genuinely different from network/model failures.

### 22d. Scope: brain.ts Still Uses the Old Counter

**Status: Partially addressed.** `src/team-manager.ts` was migrated to the canonical `FailureWindow` in commit `9ff91df` — its check-in loop now records both successes and failures into a window of 10 and ends the check-in early when failures hit 3, instead of resetting the counter on every success. The earlier agent-batch attempt at this migration (commit `254245d`) introduced a *local* `FailureWindow` class with an incompatible API (`recordFailure()` / `density()` / `shouldEscalate(threshold)`) that diverged from the canonical helper; that local class was deleted as part of the cleanup.

**Remaining:** `src/brain.ts` still uses the consecutive-failure counter via `command-recovery`'s `CircuitBreakerState` (a different abstraction from `FailureWindow`). Brain runs are short-lived and one-shot, so the blind spot is less load-bearing there, but for symmetry with supervisor and team-manager the migration is worth doing once a brain-mode flaky-provider observation justifies it.

**What (original issue):** The window fix applies only to `runAgentSupervisor` in `src/supervisor.ts`. `src/brain.ts` and `src/team-manager.ts` still use the `consecutiveLlmFailures = 0 on success` pattern. Both are short-lived loops (brain is a one-shot objective-driven run, team-manager pauses and resumes on a longer cadence), so the blind spot is less load-bearing there. `FailureWindow` is exported from `src/failure-window.ts` for when/if those loops are migrated; the migration is mechanical but out of scope for the §22b fix.

## 23. Dashboard Surfacing of Write Failures

### 23. No Persistent Record of Write Failures

Memory and conversation checkpoint write failures are surfaced to the `dashboardLog` as `supervisor-alert` (supervisor) or `brain-thinking` (brain) entries. These are in-memory only — if the server restarts, the alerts are lost. There is no persistent error log for write failures.

The `console.error` calls that accompany each dashboard push provide server-side console output, but these are ephemeral unless the operator has configured process stdout capture (e.g., systemd journal, PM2 logs). A write failure means the supervisor continues operating with stale memory — it may make decisions based on outdated information without realizing it.

**Mitigation:** Operators should monitor the dashboard for `WARNING:` prefixed messages. A future improvement could write failure records to a persistent error log file or integrate with structured logging.

## 24. Progress Assessment — Deterministic Signal Processing for Directive Evolution

### 24a. Behavior

After each supervisor cycle, `assessProgress()` computes a structured assessment from git diff stats, validation results, behavioral notes, and directive change tracking. The assessment produces:

- A `[PROGRESS]` block summarizing the cycle: files changed, lines added/removed, validation pass/fail, behavioral notes, trend indicator (improving/declining/stable/stalled), and whether the directive changed
- A `[DIRECTION]` suggestion block (when heuristics match): rule-based recommendations like "3 cycles with no changes — consider pivoting" or "validation failing consistently — simplify the directive"

Both blocks are injected into the supervisor's system prompt at the start of the next cycle, before the directive. Assessments are persisted in `progressAssessments` in brain memory (capped at 10 per agent) and used for trend computation across recent cycles.

### 24b. Tradeoff: Deterministic, Not Evaluative

The progress assessor is deterministic signal processing — it detects patterns (no changes, failing tests, stagnant directive) but cannot assess qualitative aspects of code changes (whether a refactoring improved maintainability, whether a new feature adds user value, whether code is well-structured). It gives the LLM supervisor a compass (trend data + heuristic suggestions) but not a map (understanding of *why* the trend exists or *what* specific change would be most valuable).

**Ruled out:** LLM-based evaluation (calling an LLM to assess cycle quality) because it would add latency and cost per cycle. The deterministic signals from git diffs and validation results are sufficient for steering directive evolution — the LLM supervisor itself provides the qualitative reasoning when it reads the `[PROGRESS]` and `[DIRECTION]` blocks and decides whether to use `@directive`.

### 24c. Trend Window

The trend indicator uses a window of the last 3 cycles. This means:
- **Short-lived fluctuations** (1-2 bad cycles followed by recovery) will be reflected as "declining" or "improving" trends, which may be noise
- **Gradual drifts** that span more than 3 cycles will only be partially captured — the trend shows recent direction, not long-term trajectory
- **Missing cycles** (crashes, restarts) create gaps in the assessment history, so the trend may skip over important context

### 24d. Heuristic Coverage

The current heuristics cover: stalled cycles (no changes), declining validation, improving validation with stable directive, large uncommitted changes, stable directive for 5+ cycles, stuck-sounding behavioral notes, and committed-but-no-delta patterns. They do **not** cover: security vulnerability patterns, performance regressions, test coverage trends, dependency drift, or user satisfaction signals. These would require different evaluation mechanisms (static analysis, benchmarking, telemetry) that are outside the scope of deterministic git-based assessment.

## 25. Shared Knowledge Store — Relevance Filtering and Persistence

### 25a. Behavior

Cross-agent knowledge is stored in `.orchestrator-shared.json`, separate from per-agent memory (`.orchestrator-memory.json`). Two write paths populate the store:

- **Auto-published progress summaries**: after each `@done:`, the supervisor's `ProgressAssessment` (trend, git delta, validation) is written to the shared store, replacing any previous entry for that agent. All other agents see progress summaries unconditionally in their system prompts.
- **Explicit `@share:` notes**: supervisors publish discoveries, lessons, or observations with optional `[files: ...]` tags. Notes are filtered for relevance before injection into other agents' prompts.

At cycle start, `formatRelevantKnowledge()` scores each note using a weighted heuristic: file-path overlap (10 points per overlapping file), recency (5 points if <5 minutes old, 2 points if <1 hour), and kind (3 points for lessons, 1 for discoveries). Notes scoring below 1 are dropped. Up to 10 relevant notes are injected. The store is capped at 50 notes and 20 progress entries, oldest evicted first.

### 25b. Tradeoff: Relevance Scoring Is Heuristic, Not Semantic

The file-overlap scoring determines relevance using path matching: exact match, directory prefix (e.g., `src/` overlaps `src/auth.ts`), and filename stem matching (e.g., `auth.ts` overlaps `auth.test.ts`). This is a structural heuristic — it has no understanding of *why* a note is relevant or whether the content applies to the reading agent's task.

**Consequences:**

- A note tagged `[files: src/auth.ts]` about a rate limiter race condition will be shown to agents working on `src/auth.ts`, even if the note is about an API endpoint they're not touching. The heuristic can't distinguish "auth endpoint" relevance from "file editing" relevance.
- Notes with no file tags and no recency (older than 1 hour, no overlap) score 0 and are silently dropped. This means a genuinely relevant but poorly-tagged note — e.g., `@share: the database migrations are flaky on Windows` with no file tags — will not reach agents who should see it. Supervisors must use `[files:]` tags for the relevance filter to work.
- The recency bias (5 points for <5 minutes, 2 for <1 hour) favors fresh notes over old ones. In long-running sessions, useful discoveries from hours ago may be suppressed in favor of recent but less important observations.

**Ruled out:** LLM-based relevance scoring (calling an LLM to evaluate whether a note applies to the current directive) would add latency and cost to every cycle start. The file-overlap heuristic is deterministic, fast, and requires no additional LLM calls. A future improvement could use embedding similarity between the note text and the current directive text, but this requires an embedding service that doesn't currently exist in the stack.

### 25c. Persistence and Consistency

The shared knowledge store uses the same write-lock pattern as brain memory (`withWriteLock`), serializing concurrent writes from multiple supervisors. However, the read path (`formatRelevantKnowledge`) operates on an in-memory snapshot loaded at cycle start. If two agents' cycles overlap significantly, Agent B may see Agent A's progress from the previous cycle but not the current one. This is acceptable because progress summaries are low-frequency (one per cycle) and slightly stale data is better than blocking for fresh data.

### 25d. `@share:` Requires Supervisor Judgment

`@share:` is explicit, not automatic. Behavioral notes (`@lesson:`) are still per-agent in brain memory — they're subjective observations about how a specific worker operates best, which may not apply to other agents. The supervisor must decide whether a discovery is worth broadcasting. This prevents the shared store from filling with low-value notes, but it means important discoveries may go unshared if the supervisor doesn't think to use `@share:`. Progress summaries, by contrast, are auto-published because they're structured and low-noise.

## 26. Rate-Limit (429) Backoff — Persistent with Decay

### 26a. Behavior

The 429 counter (`consecutive429s`) persists across supervisor cycles and decays by 1 on each successful LLM call, rather than resetting to 0. This means sustained rate-limiting produces escalating inter-cycle pauses (60s, 120s, 180s, ...) that persist even after a single successful call, and only fully recover after as many successes as there were 429s. The counter is capped at 10 to prevent unbounded escalation. The per-request cooldown within a cycle follows `min(30s × 2^(n-1), 5min)`.

### 26b. Tradeoff: Decay Rate Is a Heuristic

The per-success decay of `max(0, counter - 1)` means 3 successes fully recover from 3 consecutive 429s. This favors recovery speed over caution. A more conservative decay (e.g., halving: `counter / 2`) would take longer to recover but risk less under a truly rate-limited provider. The `-1` decay is appropriate because rate limits are typically burst limits that recover on their own — if the provider is truly down, 429s continue and the counter grows again.

### 26c. Tradeoff: Dual-Scope Escalation

The counter works alongside ResourceManager's global rate-limit cooldown, which blocks all agents after `reportRateLimit()`. An individual agent that hits 429 gets both the global pause AND its own escalating inter-cycle pause. This is intentional (the most-affected agent should back off the most) but can be surprising in multi-agent setups where one agent triggers rate limiting for all — the triggering agent gets double-penalized while other agents only get the global cooldown.

### 26d. Tradeoff: No Distinction Between Provider-Down and Burst-Limit

The counter doesn't distinguish between "provider entirely down" (infinite 429s) and "burst limit exceeded" (temporary 429s followed by recovery). A persistent counter treats both the same — it grows on every 429 and only shrinks on success. For a truly down provider, the counter caps at 10 (5-minute inter-cycle pause) and the supervisor keeps trying indefinitely, which is correct behavior. For a burst limit, the decay ensures rapid recovery once the quota resets.

## 27. Session State and File Write Atomicity on Windows

### 27a. Behavior

`atomicWrite` (used by all JSON persistence — session state, projects, memory, shared knowledge) writes to a temp file, then replaces the target. On POSIX systems, `renameSync` atomically replaces the target. On Windows, `renameSync` cannot overwrite an existing file, so `atomicWrite` first deletes the target with `unlinkSync`, then renames. This creates a ~1-2 microsecond window where neither the old nor the new file exists at the target path.

### 27b. Consequence

If the process crashes or loses power in that window:
- `.orchestrator-session.json` is lost — crash detection returns `{ crashed: false, state: null }` on next startup, and the supervisor starts fresh with no recovery prompt.
- `.orchestrator-projects.json` is lost — projects aren't restored, the user must re-add them.
- `.orchestrator-memory.json` or `.orchestrator-shared.json` is lost — agent memory and shared knowledge are reset.

### 27c. Accepted Risk

The window is approximately 1-2 microseconds between `unlinkSync` and `renameSync`. This is orders of magnitude less likely than a crash during the much longer `Bun.write` that precedes it (which would leave the temp file but not affect the target). The consequences of loss are mild (no data corruption, just a fresh start). Alternatives that fully eliminate the window (double-write with verification, fsync before rename) add significant latency (5-50ms per write) to every persistence call, which occurs multiple times per supervisor cycle. The current approach is the correct tradeoff for the risk level.

## §28 Dashboard UI: modals lack focus trapping

### 28a. Limitation

Modal dialogs (add project, annotation feedback, permission requests) do not trap keyboard focus. Pressing Tab while a modal is open cycles focus to background elements, and there is no `aria-modal` attribute.

### 28b. Accepted Risk

No known user workflow depends on keyboard-only modal interaction. The modals are primarily used with mouse input. Adding focus trapping and `aria-modal` would require a non-trivial overlay management layer. Accepted as low-priority accessibility debt.

## §29 Dashboard UI: `aria-expanded` not toggled on project rows

### 29a. Limitation

Project detail rows use JS-driven expand/collapse, but the trigger elements do not update `aria-expanded` to reflect the current state.

### 29b. Accepted Risk

Screen reader users are the primary consumers of `aria-expanded`. The dashboard is a developer monitoring tool, not an end-user product. Adding `aria-expanded` is straightforward but low priority.

## §30 Dashboard Fetch Handler Error Boundary

### 30a. Limitation

The dashboard HTTP handler now has a top-level `try/catch` that returns a generic 500 JSON response for unhandled exceptions. This catches errors from routes that previously had no individual error handling (archives, browse, status, events/stream, team, resources).

### 30b. Tradeoff: Generic 500 Hides Context

The 500 response includes only the error message (`err.message`), not the full stack trace. This is intentional — stack traces in API responses can leak implementation details. The full error is logged to the server console via `console.error` with the request method and URL for debugging. The tradeoff is that a developer seeing a 500 in the browser must check the server console for the full context. An alternative would be to include the stack trace in the response body behind a debug flag, but this adds complexity for a local development tool where console access is always available.

### 30c. DashboardLog Listener Error Isolation

`DashboardLog.push()` now wraps each listener call in `try/catch`. A buggy listener (e.g., SSE stream write to a disconnected client) can no longer crash the code that called `push()` — which is typically the supervisor or brain. The tradeoff is that listener errors are silently swallowed and logged to console. There is no mechanism for listeners to report errors back to the caller, and no UI notification. This is acceptable because listeners are passive consumers (SSE streams, event log) and their failure should not affect the orchestrator's core loop. The event bus (`EventBus.emit`) already follows this pattern.

### 30d. Supervisor loadBrainMemory Guard

The initial `loadBrainMemory()` call at cycle start is now wrapped in `try/catch`. If it throws (corrupted file, disk I/O error, migration failure), the supervisor falls back to an empty memory store and emits a WARNING. The tradeoff is that the supervisor loses all accumulated context — behavioral notes, project notes, and session history — for that cycle. Subsequent cycles will re-read the file, so if the error was transient, memory recovers on the next cycle. If the file is persistently corrupted, the supervisor operates with empty memory indefinitely. A more sophisticated approach would be to attempt a backup/restore from the archive, but this adds complexity for an edge case that is both rare and self-recovering.

## §31 SSE Manual Disconnect and Reconnect Resilience

### 31a. Problem

When a user clicked "Disconnect" on the SSE stream, the `EventSource.close()` triggered an `onerror` event, which called `disconnectSSE()` and then scheduled an auto-reconnect after a backoff delay. The user's disconnect was immediately undone. Additionally, `disconnectSSE()` set the status to "disconnected" which was then overwritten by `onerror`'s "reconnecting..." — a fragile ordering dependency.

### 31b. Fix

Introduced `sseUserDisconnected` flag to distinguish user-initiated disconnect from error-triggered disconnect. The `onerror` handler now checks this flag and skips auto-reconnect if set. `disconnectSSE()` clears any pending reconnect timer. A new `updateSSEStatusUI()` function centralizes status text and button updates, eliminating the fragile ordering.

### 31c. Visibility Reconnect

Added `visibilitychange` listener that reconnects SSE immediately when the page becomes visible after sleep/tab-switch. Resets backoff delay to base value. Skips reconnect if user manually disconnected SSE.

## §32 Dashboard UI Error Boundaries

### 32a. Null/Undefined Crash Guards

Multiple dashboard UI functions crashed on null/undefined inputs:
- `applyStatusData(null)` — `Object.entries(null)` throws
- `applyProjectData(null)` — `for...of null` throws
- `setBadge(undefined)` — `.toUpperCase()` on undefined throws
- `makeHeader(null)` — `.split()` on null throws
- `event.requestID` undefined in permission handlers — `.replace()` throws
- `evaluation.feedback` undefined in `renderSessionCard` — property access on undefined throws
- `renderScoreBars(null)` — property access on null throws
- `refreshBusEvents`, `refreshPerformance`, etc. — `getElementById(...).value` throws if element missing

All fixed with null guards, optional chaining, and default values.

### 32b. HTTP Response Checks

Six refresh functions (`refreshProviders`, `refreshBusEvents`, `refreshResources`, `refreshIntents`, `loadMemory`, `loadHistory`, `refreshTeam`) called `res.json()` without checking `res.ok`, so a 404/500 response produced an opaque JSON parse error. All now check `res.ok` and throw a descriptive error.

### 32c. Event Delegation Error Boundary

The `data-action` click handler switch had no try-catch. A sync throw in any action function (saveDirective, sendPrompt, mergeBranch, etc.) would propagate to `window.onerror` as a generic "Unexpected error" toast with no context. Now wrapped in try-catch with `showNotification` that includes the action name.

### 32d. Body Size Limit

Dashboard mutating endpoints now require a `Content-Length` header (rejects chunked transfers with 411) and enforce a 1MB limit (413). This prevents unbounded request body consumption on the local HTTP server.

---

## 33. Behavioral-note fire matching is heuristic

**What:** Each behavioral note in `.orchestrator-memory.json` now carries a `fires[]` array recording the cycles in which the note was judged relevant to an active text (a `@review` reply, or a worker response). The matching is pure heuristic — a substring match on any long keyword from the note, plus a keyword-overlap similarity threshold. There is no LLM evaluation of whether the match is meaningful.

**Why:** Per the learning-orchestrator directive, fire-tracking must not add another LLM call per cycle. A heuristic keeps the signal cheap enough to run on every review and every worker response without budget impact, which is what lets Phase 2 (prune/promote) have evidence to work from.

**Tradeoff:** False positives (a note about "restart" fires on any text mentioning "restart", even out of context) and false negatives (a note about "non-responsive workers" may not fire on a review that uses different vocabulary). The fire count is therefore a coarse proxy for relevance, not a precise measurement.

**Ruled out:** LLM-based match judging. Adds one aux call per review/response, inflates token spend, and introduces another failure mode (LLM timeouts) in a hot path. Phase 2 can re-evaluate if signal quality proves insufficient.

---

## 34. Prune/promote thresholds are static

**What:** Every `metaReflection.everyNCycles` cycles (default 5), `pruneAndPromoteBehavioralNotes` archives any non-promoted note with zero fires whose age ≥ 20 cycles, and promotes any note with ≥3 fires across ≥2 distinct cycles to principle status. The thresholds are constants, not per-agent or adaptive. Archived notes never re-enter the active pool.

**Why:** The thresholds come from the learning-orchestrator directive and are deliberately set by hand so behavior is predictable. A note with a single flaky keyword match can't gather 3 fires across 2 real cycles by accident, and a note that's genuinely useful will pass the bar within a reasonable number of cycles. Static numbers also make prune/promote decisions auditable — the `promotedAt.cycle` and `archivedAt.cycle` markers pin down exactly when a state change happened.

**Tradeoff:** A note that fires heavily in a single cycle but never again (e.g., a one-off incident) will not promote. A note that accrues 3 fires across 2 cycles with weak signal (two heuristic false positives in the same review) will promote. The directive calls the tradeoff explicitly: fire evidence drives promotion; the LLM pass only rewrites text for clarity.

**Ruled out:** Adaptive thresholds or per-agent tuning. Both add state to track and a feedback loop of their own. Before tuning, we need observations from a real long-run session — that's what Phase 3's observer is for.

---

## 35. Brain observer is episodic and narrowly scoped

**What:** `runBrainObserver` (Phase 3) fires once per `cycle-done` event when `brain.observer.enabled` is true in orchestrator.json. It reads the cycle's session summary plus the last 20 event types off the bus, sends one LLM call gated to a 150-char response, and either writes a single `[observer] ...` project-note via `addProjectNote` or does nothing. Default is `enabled: false`.

**Why:** The read-only boundary is enforced by the shape of `BrainObserverInput` — the observer never receives an `Orchestrator`, a `DashboardLog`, an `EventBus`, or any handle that could send a prompt or edit a directive. That's the structural guarantee: even if the LLM output were adversarial, the observer can only add one short note per cycle to a persisted file. Errors (LLM timeout, parse failure, write failure) are all swallowed — the observer is advisory, not part of any critical path.

**Tradeoff:** The observer sees only a single cycle summary at a time. It can't synthesize across long horizons on its own — that's delegated to the existing meta-reflection pass, which now also runs on evidence (fires) rather than raw history. The observer is a low-rate channel for incidental cross-project patterns the meta-reflection pass misses; expect most invocations to produce `NONE`.

**Ruled out:** A continuous observer that reads the event bus in real time. Would add another always-on LLM consumer and tangle the observer with transient state. Episodic-per-cycle keeps the budget predictable and the contract verifiable by reading one function signature. Also ruled out: letting the observer emit directives or prompts. That would collapse the read-only boundary and was the exact failure mode the directive called out.

---

## 36. Cycle outcomes are coarse and heuristic

**What:** Phase 4 closes the learning loop by tagging each cycle with one of `success` / `partial` / `failure` when the cycle ends. `recordCycleOutcome` stores the tag keyed by (agent, cycle) in `BrainMemoryStore.cycleOutcomes`; at prune/promote time every note's `fires[]` is resolved against this map to weight promotion and trigger un-promotion. Classification rules: `@done` clean → success; `@done` with a false-progress warning during the cycle → failure; `@stop` with failure language (`non-responsive|stuck|fail|cannot|unable|broken|crash|unresponsive|dead`) → failure; clean `@stop` → partial; cycle exhausted rounds → partial (or failure if false-progress was raised). The map is capped at the most recent 100 cycles per agent; fires that reference cycles outside that window fall back to "partial".

**Why:** Outcome is what turns fire-tracking from a relevance proxy into an effectiveness signal — a note that's constantly relevant but whose cycles keep failing is not a principle worth promoting. Tying promote/unpromote to real outcomes is the concrete difference between a feedback loop and a noise amplifier. The rules are intentionally regex-simple: same philosophy as Phase 1's heuristic fires — no LLM, no second failure mode on a hot path, auditable at a glance.

**Tradeoff:** The three-bucket taxonomy is genuinely lossy. A cycle that accomplished 60% of the task and was cleanly stopped gets `partial` and counts equally with a cycle where nothing happened. `@stop` failure-language matching will miss idiosyncratic phrasing ("agent ran out of steam", "gave up") and false-positive on benign uses ("cannot determine remaining work"). The UNPROMOTE_FAILURE_THRESHOLD=3 is the same kind of hand-set threshold that §34 flagged — no per-agent adaptation. On short sessions, noise in outcome tagging swamps signal; the loop needs dozens of cycles before promotion/un-promotion decisions stabilize.

**Ruled out:** (1) LLM-based cycle classification — adds one aux call per cycle, doubles a failure mode, and obscures the rule. (2) Continuous-valued outcome scores — harder to reason about, harder to audit, and the three buckets are enough for the coarse promote/unpromote decisions. (3) Automatic re-promotion when a previously un-promoted note accumulates fresh successes — deliberately left to the same `shouldPromote` path so un-promoted notes re-earn principle status through the same evidence bar as any other note. The `unpromotedAt.priorPromotion` field preserves the audit trail for a future re-promotion without special-casing the predicate.

---

## 37. Brain manager is advisory-only and structurally bounded

**What:** `startBrainManager` (Phase 5) starts a persistent loop at app init when `brain.manager.enabled` is true. Two capabilities in this first slice: a one-shot session-start briefing (summarizes promoted/unpromoted principles across all projects, optionally narrated by the brain model) and a periodic stuck-project detector that fires when any agent has `stuckThreshold` (default 3) consecutive non-success cycle outcomes. Default interval is 120 s, floored at 30 s. The manager emits dashboard events (`manager-briefing`, `manager-alert`) and writes advisory `[manager] …` project notes via `addProjectNote`. It shares the brain model and the same `llmCall` pipeline as the observer.

**Why:** The manager deliberately does not receive an `Orchestrator`, `DashboardLog`, `EventBus`, or any prompt-sending handle — it only gets the narrow `BrainManagerInput { ollamaUrl, model, emit, stuckThreshold?, _chat? }`. The `emit` surface is a single `push()` that takes a tagged `manager-alert | manager-briefing` event, which the caller routes to the real dashboard. That means the manager cannot send a worker prompt, edit a directive, or push to a branch even if its LLM output were adversarial. The read-only-for-prompts boundary from §35 extends to the manager: it can emit advisory writes (notes and dashboard events), but never actions that mutate running cycles. The `BrainManagerInput boundary` unit test pins this with a key whitelist so a future widening would break a test before it lands.

**Tradeoff:** The manager is one more continuous LLM consumer on the brain model — one briefing call at startup, one per-interval stuck pass thereafter. On local Ollama the cost is negligible; on a paid API it is proportional to the poll interval. The stuck detector is outcome-driven and therefore inherits §36's coarse bucketing: three consecutive `partial` cycles will trigger an alert identical to three `failure` cycles, even though they describe very different situations. Alerts are not deduped across passes — if an agent stays stuck, the user sees steady reminders, which is the intended behavior but can be noisy. The briefing is best-effort: if the LLM narrative step throws, the manager falls back to the deterministic factual text composed from memory.

**Ruled out:** (1) Giving the manager prompt-sending capability so it can nudge stuck agents directly. That collapses the read-only boundary and is exactly the failure mode §35 called out. Nudging remains the operator's decision surfaced through the dashboard. (2) A richer stuck-state ML model that considers cycle duration, tokens consumed, or error types. The point of this slice is a cheap, auditable trigger; anything smarter belongs in meta-reflection or a later phase. (3) Deduplicating alerts across passes — investigated and rejected as it can hide the fact that a project is still stuck.

---

## 38. LLM usage ledger only covers the orchestration layer

**What:** `src/llm-usage.ts` records per-call telemetry (provider, model, role, tokens if the provider returned them, duration, ok/err) for every LLM call that routes through `providers.llmCall`. The ledger powers the `/api/llm-usage` endpoint and the dashboard's LLM Usage panel (hourly stacked bar chart + role/provider/model breakdowns). Roles tracked: `brain`, `supervisor`, `observer`, `manager`, `team-manager`, `other`. Storage is a single JSON file capped at 20 000 entries.

**Why:** This is the "how much is the meta-layer actually consuming" view. It intentionally stays a separate file from `prompt-ledger.ts` — the prompt ledger carries content and is capped at 2 000 entries, which makes it unsuitable as a long-horizon usage log.

**Tradeoff:** The ledger does not capture **worker** LLM calls. Workers run as separate `opencode`/`claude` processes and hit their provider directly; nothing passes through `providers.llmCall` from that side. So the graph shows orchestration overhead (supervisor loops, brain, observer, manager) — not total spend. For a true "combined over time" view that includes workers, the worker process would have to either proxy through the orchestrator or emit its own usage events, both of which are larger changes than this slice.

---

## 39. Multi-agent coordination protocol — no claim/release on parallel pickups

**Status: Open.**

**What:** Multiple supervisors can independently pick up the same `KNOWN_LIMITATIONS.md` § when running concurrently because there is no claim/release protocol on the shared blackboard. The agent batch landed in commit `254245d` shipped three incompatible `FailureWindow` API shapes because one agent picked up §22d locally in `team-manager.ts`, another wrote tests for an imagined API in `brain.test.ts` and `brain-manager.test.ts`, and the canonical helper at `src/failure-window.ts` went untouched — none of them saw each other's claim. The same hazard applies to any §-pickup workflow that uses `KNOWN_LIMITATIONS.md` as a queue (which is the documented intent of the **Pick-up queue** above).

**Why:** The current model is hierarchical at *spawn time* (Brain decides who runs) but blackboard-self-pickup at *task selection* (the queue is exposed and agents choose). That hybrid has no synchronization point — each agent reads the queue at slightly different times and races. Hayes-Roth's classic blackboard architecture explicitly has a *control component* that decides which knowledge source to activate next; without that role, parallel pickup is exactly the failure mode we hit.

**What a fix looks like:**
1. Brain announces `task:available §X files=[...] effort=M priority=H` as a bus event.
2. Idle supervisors bid (with recent-context overlap and remaining token budget).
3. Brain awards exactly one and writes `claim:§X by agent-N expires=Date.now()+30min` to `.orchestrator-claims.json`.
4. Other agents scanning the queue skip §s with active claims.
5. On completion (or expiry) the claim is released — completed claims promote into a "done" log; expired claims unblock the §.

Heartbeat from the holder extends the TTL while work is in flight; if the holder crashes, the TTL expires and the § returns to the pool. See §39a/§39b/§39c for the complementary concerns that must ship alongside the core protocol.

**Canonical defaults (for autonomous runs ≥8 hours):** these parameters are pinned so that a future agent picking up §39 implements *this* version rather than re-litigating the design. Change only with explicit justification in a status update.

| Parameter | Value | Rationale |
|---|---|---|
| Claim TTL | **30 minutes** | Covers typical S/M § work without spurious re-pool. The TTL is the crash-recovery safety net, not the work budget — heartbeats keep it alive while the holder is genuinely working. Shorter TTLs invite duplicate-work bugs (the very thing being fixed) on transient LLM hiccups. |
| Heartbeat interval | **5 minutes**, fired automatically at supervisor cycle start | The supervisor cycle already runs every 30 s by default, so 5-min heartbeats happen "for free" with up to 6 renewal chances per TTL. |
| Bid window | **5 seconds, fixed**, no short-circuiting | On an 8 h run, ~50 assignments × 5 s = 4 min of bid-window latency (0.8 % of runtime). Cheap insurance against unfair winner-takes-all-by-200ms behavior compounding over the long run. |
| Task ID format | `limitations:<§>` for queue items, `ad-hoc:<slug>` otherwise | Explicit IDs are debuggable in overnight log review. §-renumbering is not a concern — KNOWN_LIMITATIONS.md is append-only, so existing IDs stay stable. |
| Bid audit log | **Keep**, capped at 200 entries (~40 KB) | Long runs need answers to "why did the Brain pick that agent?" without LLM-replay; storage is negligible. |
| Sweep interval | **60 seconds**, run from `brain-manager.ts` per §37's existing cadence | Cheap (one read + filter + conditional write), and reusing §37's loop avoids spawning yet another timer. |
| Storage location | `.orchestrator-claims.json` at orchestrator cwd, gitignored alongside other `.orchestrator-*.json` | Atomic writes via existing `writeJsonFile`. Keeps the shared-knowledge schema small instead of overloading it. |

**Schema sketch (canonical):**

```ts
type ClaimStatus = "claimed" | "completed" | "expired" | "released"

interface TaskClaim {
  taskId: string         // "limitations:22d" or "ad-hoc:<slug>"
  agentName: string
  claimedAt: number
  expiresAt: number      // refreshed by heartbeat
  lastHeartbeat: number
  status: ClaimStatus
  files: string[]        // declared touch list, used for conflict detection
  priority: "high" | "medium" | "low"
  effort: "S" | "M" | "L"
  resolvedAt?: number    // filled when status moves out of "claimed"
  resolution?: string
}

interface BidRecord {
  taskId: string
  bidder: string
  bidAt: number
  contextOverlap: number          // 0..1, deterministic from recent file activity
  tokenBudgetRemaining: number    // estimated tokens this agent has left
  awarded: boolean
  awardedTo?: string
}

interface ClaimsStore {
  active: TaskClaim[]
  completed: TaskClaim[]  // FIFO ring buffer, ~200 entries
  bids: BidRecord[]       // FIFO ring buffer, ~200 entries
}
```

**Tradeoff:** Coordination state is more state to keep consistent across crash/restart. Claims need durable persistence (they're not just in-memory like the event-bus ring buffer per §1) so a Brain restart doesn't lose track of who's working on what. TTLs are the safety net — the 30-min default comfortably exceeds typical agent work cycles so we don't spuriously re-award mid-flight, while still unblocking a crashed holder within ~35 min worst-case (5 min stale heartbeat + 30 min TTL).

**Cost on an 8 h run:** ~40 KB persistent state, ~50 awards × 5 s = 4 min total bid-window latency (0.8 % of runtime), zero added LLM calls (bid evaluation is a deterministic function of `contextOverlap` and `tokenBudgetRemaining`, not a prompt), one 60-s sweep tick reusing §37's loop. The claim surface is overhead-amortized — it does not add per-cycle cost to the supervisor inner loop.

**Ruled out:** (1) Pure first-write-wins on a directory marker file. Cheap to implement, but encourages races and gives no signal back to the announcing layer (Brain doesn't learn who claimed). (2) Pessimistic locks held across the entire agent lifetime. Too coarse — if the agent crashes the lock is held forever; TTL + heartbeat is strictly better. (3) Skipping the announce step and letting agents self-claim freely. That's the current model and it's the failure mode being fixed. (4) Pushing all assignment up to the Brain at spawn time (no blackboard claims at all) — simpler but loses the substrate value: the dashboard can no longer surface "who is working on what right now," and agents can no longer pick up urgent unclaimed work mid-session without a Brain restart. (5) Folding claims into the existing `shared-knowledge.ts` store. Considered to reduce file count, but conflates two concerns (shared learning vs. live coordination state) with very different read/write rates and audit needs. Separate file keeps the shared-knowledge schema stable and makes the claims log independently inspectable.

### 39a. Complementary: Brain restart recovery

**Status: Open (depends on §39).**

**What:** On an 8 h+ autonomous run, the Brain process will likely restart at some point (crash, OOM, deliberate operator restart). Without explicit handling, a naive restart would re-announce every active claim's underlying task and create a thundering herd of duplicate awards — the precise scenario §39 exists to prevent, just on a different trigger.

**What a fix looks like:** On Brain init, after `loadActiveClaims()`:
1. **Do not re-announce** any task with an active, unexpired claim — trust the supervisor that holds it.
2. **Do not re-award** anything during the bid-window grace period (~5 s); supervisors that survived the restart will heartbeat shortly and reclaim their slots.
3. Run `sweepExpiredClaims()` once at startup so any holder that died with the Brain doesn't permanently lock its §.
4. Re-emit `task-claimed` bus events for every active claim so the dashboard reflects current state without operator action.

Estimated effort: S (≤15 lines in the Brain init path).

**Tradeoff:** A small grace window after Brain restart during which no new awards happen. On the order of a single bid-window's worth of latency (5 s), well under the 8 h-run noise floor.

### 39b. Complementary: Stuck-claim detection via §37 brain-manager

**Status: Open (depends on §37 and §39).**

**What:** A wedged supervisor will heartbeat indefinitely (the cycle loop is alive, the work isn't), holding its § hostage for the entire 8 h run. Heartbeat liveness is necessary but not sufficient — we also need outcome liveness.

**What a fix looks like:** §37's existing stuck-project detector already fires `manager-alert` when an agent has `stuckThreshold` (default 3) consecutive non-success cycle outcomes. Wire that alert path to additionally call `releaseClaim(taskId, agentName, "stuck-project-detection")` when the alerting agent currently holds a claim. The released § returns to the announcement pool and another agent can take it.

Estimated effort: S (~5 lines added to the `manager-alert` handler in `brain-manager.ts`).

**Tradeoff:** False-positive releases if a §-fix is genuinely slow (legitimately L-effort work that looks like 3 stalled cycles). Mitigation: the current §37 default of 3 consecutive non-success outcomes is conservative; if false-positives become a problem, raise the threshold for claim-release specifically (e.g., 5 cycles) without touching the general alert threshold.

**Ruled out:** Building a separate stuck-detector for claims. §37 already has the signal; reusing it is simpler than maintaining two parallel heuristics.

### 39c. Complementary: Supervisor restart re-claim check

**Status: Open (depends on §39).**

**What:** The project-manager auto-restarts crashed supervisors. If a supervisor's claim TTL expired during the downtime and another agent took over the §, the restarted supervisor must not blindly resume work on the abandoned claim — it would race the new holder and produce exactly the §22d duplicate-work bug that §39 was built to prevent.

**What a fix looks like:** At supervisor cycle-start, before sending a heartbeat:
1. Call `isTaskClaimed(taskId)` against the store.
2. If the claim is still mine → `heartbeat()` and proceed normally.
3. If the claim is now held by a different agent → log the pre-emption to the dashboard, reset this supervisor's directive (clear any task-bound state), and return to the idle/bidding pool.
4. If no claim exists for this taskId → either the TTL expired or the work was completed elsewhere; same as case (3).

Estimated effort: S (~10 lines in the supervisor cycle-start path).

**Tradeoff:** One extra read per cycle (negligible — ~5 ms file read against a small JSON). Adds a clear "I was pre-empted" event to the dashboard, which is informational rather than load-bearing.

---

## 40. No council/quorum mode for high-stakes decisions

**Status: Open.**

**What:** All judgment calls (whether to merge an agent branch, whether a cycle constitutes progress, whether a behavioral note is worth promoting or un-promoting) flow through a single LLM call from a single agent. There is no mechanism to get N independent opinions on the same decision and aggregate them.

**Why:** Single-agent judgment is fine for cheap reversible decisions — the supervisor's per-cycle review fits this, since a wrong call costs one cycle and the next cycle can correct it. It is shakier for **irreversible or far-reach** decisions (merge to main, archive a behavioral note that influenced many past cycles, abandon a directive) where one agent's hallucination becomes durable state.

**What a fix looks like:** A `council(question, context, n=3) → { votes: Verdict[]; majority: Verdict; rationale: string[] }` helper in `src/brain.ts` that fans the same prompt out to N independent LLM calls (no shared message history between calls — independence is the entire point), then aggregates by majority vote with rationale collation. Wire two specific call sites first as proving ground: PR-merge approval (in `project-manager.ts`) and behavioral-note un-promotion (in `brain-memory.ts`'s `pruneAndPromoteBehavioralNotes`). Other call sites can opt in as evidence justifies.

**Tradeoff:** Cost. Council mode triples the LLM spend on whatever path uses it. Restrict to genuinely high-stakes call sites or budget will balloon — this is why `n=3` is the default and call sites are explicit, not implicit. Also: voters must be *truly independent* — same model with fresh context, no shared sub-prompt cache, no inter-vote message visibility — or you get groupthink and the majority is just the model's prior dressed up as a quorum.

**Ruled out:** (1) Sequential review (reviewer reads previous reviewer's verdict). Cheaper, but cheats the independence requirement; first reviewer anchors the rest. (2) Heterogeneous models (one Anthropic, one OpenAI, one Ollama) for the council. Better diversity in theory; rejected for now because providers are configured per-project and forcing multi-provider on every council call complicates the provider/credential model significantly. Worth revisiting once the council mechanism is in use and we can measure single-provider groupthink rates. (3) Auto-applying the council to every supervisor decision. Wrong scope — supervisors run hundreds of decisions per session and all of them being 3x cost is untenable; reserve council for the rare durable-state decisions.

---

## 41. Stigmergy via behavioral notes is too slow for concurrent agents

**Status: Open.**

**What:** Behavioral notes (`@lesson:` markers, fire-counts, promote/archive lifecycle in `brain-memory.ts`) function as pheromone trails that influence future agents, but propagation is per-cycle: a lesson published by agent-A right now does not reach concurrently-running agent-B until agent-B's next cycle starts and reloads memory. For lessons about "the workspace state agent-A just observed" or "I just touched src/X.ts, watch for conflicts," that delay is too long — agent-B may have already proceeded on stale assumptions before the next memory reload.

**Why:** The current design treats notes as durable cross-session learning, not real-time coordination. That is appropriate for the noted purpose ("how does this agent work best?") but inadequate for fast-moving coordination signals where the value of the signal decays in seconds, not cycles. The substrate is conflated — one channel doing two jobs.

**What a fix looks like:** A short-lived fresh-lessons channel on the event bus alongside the durable note store. When `@lesson:` (or a new `@signal:` marker for explicitly ephemeral coordination notes) fires, the supervisor publishes the content into both brain memory (durable) and onto the bus (ephemeral, ~5 minute TTL). Other supervisors subscribe and inject any unconsumed signals into their next prompt round — not their next cycle. A small dedup keyed on signal content prevents the same signal from being injected twice if it's also picked up via the durable path on the next cycle reload.

**Tradeoff:** Two paths to memory means two failure modes. If the bus drops a signal the durable note still survives; if the store fails the bus signal is fire-and-forget. The convention to keep clean: **ephemeral state changes on the bus, durable lessons in the store.** Mixing them has been a source of design drift in similar systems and needs explicit guidance in the supervisor prompts so the LLM knows which marker to use. Also: the bus channel is per-process (per §1), so cross-process coordination still requires the durable path — bus speeds up *this orchestrator instance's* concurrent agents, not multi-instance setups.

**Ruled out:** (1) Just polling the durable note store more frequently. Brain-memory reads are not free; tightening the polling interval would burn IO and still not be real-time. (2) Replacing the durable store with the bus entirely. Loses cross-session learning, which is a core feature of brain memory; the two purposes are genuinely different. (3) Embedding-based note matching to surface relevant notes faster (this is §33's territory). Better matching helps relevance but does not help latency — a note authored 30 seconds ago still needs 30 seconds of polling to surface even with perfect matching.

**Ruled out:** (1) Instrumenting workers by requiring them to forward token counts through a side-channel. Would couple the orchestrator to worker-process internals that we deliberately keep opaque. (2) Using the prompt ledger as the usage source — mixing content-bearing entries with high-frequency telemetry would blow the 2 000-entry cap on the ledger. (3) Routing worker calls through the orchestrator's provider layer — would add an extra network hop on the hottest path for marginal observability gain.