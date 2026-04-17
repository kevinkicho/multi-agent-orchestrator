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

## 13. No Graceful Shutdown

**What:** The dashboard server (`dashboard.ts`) calls `server.stop(true)` which immediately kills all connections. In-flight HTTP requests, SSE streams, and long-poll connections are terminated without completion. There is no connection draining, no SSE close frame, and no signal to the orchestrator to stop agents gracefully.

**Why:** The dashboard is a local development tool that is typically stopped with Ctrl+C. Immediate shutdown is simpler and avoids the complexity of tracking in-flight requests, draining connections, and coordinating with the orchestrator.

**Ruled out:** Full graceful shutdown with connection draining (for now). This would require tracking all in-flight requests, implementing a drain timeout, sending SSE close frames, and signaling the orchestrator. A simpler improvement worth considering: registering SIGTERM/SIGINT handlers that call `server.stop(false)` with a 5-second drain timeout, and broadcasting a shutdown event to SSE clients.

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

### 20c. Performance Log Archive Files — Unbounded Disk Growth

**This is the only server-side unbounded growth issue.** The `performance-log.ts` module (`src/performance-log.ts`) archives performance entries to daily files under `.orchestrator-performance-archive/`. Active entries are capped at 500, and entries older than 7 days are archived. But **archive files are never cleaned up** — they accumulate indefinitely at one file per day.

**Risk:** Low in practice (one small JSON file per day, typically <100KB each), but over months of continuous operation, this directory grows without bound.

**Recommended fix:** Add a cleanup step that deletes archive files older than 30 days.

### 20d. pendingComments Array — No Hard Cap

The `pendingComments` array in `ProjectState` (`project-manager.ts:66`) has no maximum size. Comments accumulate between supervisor reads. The supervisor drains the array each cycle via `getUnreadComments()`, so in practice it rarely holds more than a few entries. But there's no safety net if a user rapidly submits many comments before the supervisor reads them.

**Recommended fix:** Cap at 50 entries, dropping the oldest when exceeded.

### 20e. Memory Estimate for 5 Agents Over 8 Hours

| Component | Per Agent | 5 Agents × 8 Hours | Notes |
|-----------|----------|-------------------|-------|
| Supervisor messages | ~60 entries (trimmed each cycle) | In-memory, GC'd each cycle | Local variable |
| DashboardLog history | Fixed 500 entries | ~500 entries shared | Ring buffer, server-side |
| EventBus buffer | Fixed 200 entries | ~200 entries shared | Ring buffer, server-side |
| Brain memory (per agent) | 20 entries + 20 notes + 10 behavioral | 150 entries total | Capped, written to disk |
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

3. **Server-side: Performance archive files** — One file per day, never cleaned up. After months of operation, this directory could accumulate hundreds of files. Not a memory issue, but an unbounded disk concern.

4. **Network: Poll loop HTTP requests** — 2 requests every 10 seconds (status + projects) plus 1 long-poll connection. This does NOT scale with agent count and is negligible for any reasonable deployment.