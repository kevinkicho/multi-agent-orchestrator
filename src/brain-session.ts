/**
 * Brain session — the model ref chosen by the human for this session.
 *
 * Why this exists: `bun run start` used to auto-pick the first enabled
 * provider via `resolveDefaultModel()`, which silently committed users to a
 * model whose quota might be exhausted or whose endpoint might be down. The
 * operator only discovered the bad pick when the first supervisor cycle
 * stalled. This module inverts that contract — the orchestrator boots into
 * a "brain-pending" state, supervisor cycles pause, and the dashboard opens
 * a modal for the human to pick. No LLM calls fire until the pick is made.
 *
 * Persistence: writes the chosen ref to `.orchestrator-brain.json` at the
 * repo root on pick. This file is intentionally NOT auto-loaded at boot —
 * every `bun run start` boots with an empty gate and forces a fresh pick via
 * the dashboard modal. Writing still happens so `loadBrainSession()` remains
 * a usable primitive for tests and any future explicit-restore flow, and so
 * the operator can inspect what was last picked.
 *
 * Contract: `awaitBrainSession()` returns the current in-memory ref when
 * set, or blocks until `setBrainSession()` resolves it. This is the single
 * gate every cycle-driving path (supervisors, brain, manager, observer)
 * flows through, so the "no brain → no cycles" invariant is structural, not
 * a scattering of null checks.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import { resolve } from "path"

/** Runtime state lives at the repo root, alongside other `.orchestrator-*`
 *  files. Gitignored (see `.gitignore`). */
const BRAIN_STATE_FILE = ".orchestrator-brain.json"

type PersistedState = {
  ref: string
  pickedAt: number
}

let _current: string | null = null
let _loaded = false
const _waiters: Array<(ref: string) => void> = []
const _subscribers = new Set<(ref: string | null) => void>()

function stateFilePath(): string {
  return resolve(process.cwd(), BRAIN_STATE_FILE)
}

/** Load persisted state from disk into the in-memory singleton. Idempotent —
 *  safe to call more than once. Missing/corrupt file is treated as "unset"
 *  (state stays null). */
export function loadBrainSession(): string | null {
  if (_loaded) return _current
  _loaded = true
  const path = stateFilePath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf-8")
    const parsed = JSON.parse(raw) as PersistedState
    if (parsed && typeof parsed.ref === "string" && parsed.ref.length > 0) {
      _current = parsed.ref
      return _current
    }
  } catch {
    // Corrupt file — fall through to null. User can pick a fresh one.
  }
  return null
}

/** Return the currently-picked ref, or null if the user hasn't picked yet.
 *  Non-blocking — call `awaitBrainSession()` when you need to actually use
 *  the model. Does NOT auto-load from disk; callers that want the persisted
 *  value must call `loadBrainSession()` explicitly. */
export function getBrainSession(): string | null {
  return _current
}

/** Block until a brain ref is available, then return it. If already set,
 *  resolves immediately. Multiple concurrent callers all resolve to the same
 *  ref once `setBrainSession()` is called. Does NOT auto-load from disk —
 *  boots start with an empty gate and stay parked until the dashboard modal
 *  resolves the pick. */
export async function awaitBrainSession(): Promise<string> {
  if (_current) return _current
  return new Promise<string>(resolvePromise => {
    _waiters.push(resolvePromise)
  })
}

/** Record the human's pick. Persists to disk, wakes every blocked
 *  `awaitBrainSession()` caller, and notifies subscribers so the dashboard
 *  can re-render. Called from the `/api/brain-model` POST handler. */
export function setBrainSession(ref: string): void {
  if (!ref || typeof ref !== "string") {
    throw new Error("setBrainSession requires a non-empty string ref")
  }
  _current = ref
  _loaded = true
  try {
    const payload: PersistedState = { ref, pickedAt: Date.now() }
    writeFileSync(stateFilePath(), JSON.stringify(payload, null, 2), "utf-8")
  } catch {
    // Persistence failure shouldn't break the in-memory pick — the user can
    // re-pick next session. Silent by design; no dashboard channel here.
  }
  // Wake everyone waiting on the brain. Drain synchronously so callers don't
  // race with a subsequent `clearBrainSession()` that would re-null the state.
  const waiters = _waiters.splice(0)
  for (const w of waiters) {
    try { w(ref) } catch { /* waiter handler crash shouldn't block others */ }
  }
  for (const sub of _subscribers) {
    try { sub(ref) } catch { /* ditto */ }
  }
}

/** Forget the current pick. Next `awaitBrainSession()` call will block again
 *  until the user picks from the dashboard modal. Used by the "change brain
 *  model" path and by tests. */
export function clearBrainSession(): void {
  _current = null
  _loaded = true
  try { unlinkSync(stateFilePath()) } catch { /* already gone is fine */ }
  for (const sub of _subscribers) {
    try { sub(null) } catch {}
  }
}

/** Subscribe to pick/clear events. Returns an unsubscribe function. */
export function onBrainSessionChange(cb: (ref: string | null) => void): () => void {
  _subscribers.add(cb)
  return () => { _subscribers.delete(cb) }
}

/** Test helper — fully reset module state between test cases. Not exported
 *  from the module's public surface in the CLI sense; keep it for tests. */
export function _resetBrainSessionForTests(): void {
  _current = null
  _loaded = false
  _waiters.splice(0)
  _subscribers.clear()
}
