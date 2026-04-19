/**
 * Phase 1 tests for the learning-measurement loop:
 *   - Legacy string behavioral notes migrate to BehavioralNote objects on load.
 *   - Fire matching (substring + keyword overlap).
 *   - addBehavioralNote preserves fires + ID on topic-dedup replacement.
 *   - recordBehavioralNoteFires appends atomically.
 *
 * Uses a temp cwd so the real .orchestrator-memory.json is not touched.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { resolve } from "path"
import {
  loadBrainMemory,
  addBehavioralNote,
  recordBehavioralNoteFires,
  recordCycleOutcome,
  pruneAndPromoteBehavioralNotes,
  shouldPromote,
  shouldArchive,
  shouldUnpromote,
  computeOutcomeEvidence,
  getOutcomesForAgent,
  ARCHIVE_THRESHOLD_CYCLES,
  UNPROMOTE_FAILURE_THRESHOLD,
  CYCLE_OUTCOMES_CAP_PER_AGENT,
  type BehavioralNote,
  type CycleOutcome,
} from "../brain-memory"
import { matchFiresInText } from "../fire-tracker"

let originalCwd: string
let tmpDir: string

beforeEach(() => {
  originalCwd = process.cwd()
  tmpDir = resolve(originalCwd, `.test-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

// ---------------------------------------------------------------------------
// Migration: legacy string[] → BehavioralNote[]
// ---------------------------------------------------------------------------

describe("behavioralNotes migration", () => {
  test("wraps legacy string entries as source=legacy with empty fires", async () => {
    const legacyStore = {
      entries: [],
      projectNotes: {},
      behavioralNotes: {
        agent: ["use smaller prompts", "worker non-responsive"],
      },
    }
    writeFileSync(resolve(tmpDir, ".orchestrator-memory.json"), JSON.stringify(legacyStore))

    const store = await loadBrainMemory()
    const notes = store.behavioralNotes?.agent ?? []
    expect(notes.length).toBe(2)
    expect(notes[0]!.text).toBe("use smaller prompts")
    expect(notes[0]!.provenance.source).toBe("legacy")
    expect(notes[0]!.fires).toEqual([])
    expect(typeof notes[0]!.id).toBe("string")
    expect(notes[0]!.id.length).toBeGreaterThan(0)
  })

  test("mixed legacy and new-shape entries coexist after load", async () => {
    const mixedStore = {
      entries: [],
      projectNotes: {},
      behavioralNotes: {
        agent: [
          "legacy form",
          {
            id: "abc123",
            text: "new form",
            provenance: { source: "review", cycle: 4, createdAt: 111 },
            fires: [{ cycle: 5, at: 222 }],
          },
        ],
      },
    }
    writeFileSync(resolve(tmpDir, ".orchestrator-memory.json"), JSON.stringify(mixedStore))

    const store = await loadBrainMemory()
    const notes = store.behavioralNotes?.agent ?? []
    expect(notes.length).toBe(2)
    expect(notes[0]!.provenance.source).toBe("legacy")
    expect(notes[1]!.provenance.source).toBe("review")
    expect(notes[1]!.fires).toEqual([{ cycle: 5, at: 222 }])
  })
})

// ---------------------------------------------------------------------------
// addBehavioralNote with source attribution + topic-dedup preserves fires
// ---------------------------------------------------------------------------

describe("addBehavioralNote", () => {
  test("persists source + cycle in provenance", async () => {
    const store = await loadBrainMemory()
    const after = await addBehavioralNote(store, "agent", "cap rate-limits with backoff", { source: "review", cycle: 7 })
    const n = after.behavioralNotes!.agent![0]!
    expect(n.provenance.source).toBe("review")
    expect(n.provenance.cycle).toBe(7)
    expect(n.text).toBe("cap rate-limits with backoff")
    expect(n.fires).toEqual([])
  })

  test("topic-dedup replace preserves fires[] and ID from original note", async () => {
    const store = await loadBrainMemory()
    let after = await addBehavioralNote(store, "agent", "agent non-responsive — restart", { source: "manual", cycle: 1 })
    const originalId = after.behavioralNotes!.agent![0]!.id
    await recordBehavioralNoteFires("agent", [originalId], 2)

    // Longer wording on the same topic — should replace but preserve ID+fires
    after = await addBehavioralNote(
      await loadBrainMemory(),
      "agent",
      "agent non-responsive after 3 empty responses — restart session and use single-action prompts",
      { source: "review", cycle: 3 },
    )
    const replaced = after.behavioralNotes!.agent![0]!
    expect(replaced.id).toBe(originalId)
    expect(replaced.fires.length).toBe(1)
    expect(replaced.fires[0]!.cycle).toBe(2)
    expect(replaced.text.startsWith("agent non-responsive after 3")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// recordBehavioralNoteFires
// ---------------------------------------------------------------------------

describe("recordBehavioralNoteFires", () => {
  test("appends a fire entry for matching IDs only", async () => {
    const store = await loadBrainMemory()
    await addBehavioralNote(store, "agent", "first lesson", { source: "manual", cycle: 1 })
    await addBehavioralNote(await loadBrainMemory(), "agent", "second lesson about rate limits", { source: "manual", cycle: 1 })

    const loaded = await loadBrainMemory()
    const [a, b] = loaded.behavioralNotes!.agent!
    await recordBehavioralNoteFires("agent", [a!.id], 4)

    const after = await loadBrainMemory()
    const notes = after.behavioralNotes!.agent!
    expect(notes.find(n => n.id === a!.id)!.fires.length).toBe(1)
    expect(notes.find(n => n.id === a!.id)!.fires[0]!.cycle).toBe(4)
    expect(notes.find(n => n.id === b!.id)!.fires.length).toBe(0)
  })

  test("no-op when notes list is empty", async () => {
    const result = await recordBehavioralNoteFires("ghost-agent", ["nope"], 1)
    // With no notes, load returns undefined behavioralNotes for this agent
    expect(result === null || result.behavioralNotes?.["ghost-agent"] === undefined || result.behavioralNotes?.["ghost-agent"]?.length === 0).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fire matching heuristic
// ---------------------------------------------------------------------------

describe("matchFiresInText", () => {
  function mkNote(id: string, text: string): BehavioralNote {
    return { id, text, provenance: { source: "manual", cycle: null, createdAt: 0 }, fires: [] }
  }

  test("substring match on long keyword fires", () => {
    const notes = [mkNote("n1", "always run typecheck before committing")]
    const hits = matchFiresInText(notes, "I ran typecheck and it passed.")
    expect(hits).toEqual(["n1"])
  })

  test("keyword overlap fires below substring threshold", () => {
    const notes = [mkNote("n1", "behavioral notes rate-limit backoff recovery")]
    // Shared keywords: rate, backoff, recovery
    const hits = matchFiresInText(notes, "Observed recovery after rate backoff retries", 0.2)
    expect(hits).toContain("n1")
  })

  test("unrelated text produces no fire", () => {
    const notes = [mkNote("n1", "use typecheck before commits")]
    const hits = matchFiresInText(notes, "The weather was sunny all afternoon.")
    expect(hits).toEqual([])
  })

  test("empty notes list returns empty hits", () => {
    const hits = matchFiresInText([], "any text")
    expect(hits).toEqual([])
  })

  test("empty text returns empty hits", () => {
    const notes = [mkNote("n1", "something")]
    const hits = matchFiresInText(notes, "")
    expect(hits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Phase 2: prune + promote with evidence
// ---------------------------------------------------------------------------

describe("shouldPromote / shouldArchive predicates", () => {
  const mkNote = (opts: Partial<BehavioralNote> & { cycle?: number | null }): BehavioralNote => ({
    id: "x",
    text: "t",
    provenance: { source: "manual", cycle: opts.cycle ?? 0, createdAt: 0 },
    fires: [],
    ...opts,
  })

  // Empty outcomes map → every fire treated as "partial" (backward-compatible
  // baseline that preserves Phase 2 behavior).
  const noOutcomes = {}

  test("promotes with 3 fires across 2 cycles", () => {
    const n = mkNote({
      fires: [
        { cycle: 1, at: 1 }, { cycle: 1, at: 2 }, { cycle: 2, at: 3 },
      ],
    })
    expect(shouldPromote(n, noOutcomes)).toBe(true)
  })

  test("does not promote with 3 fires all in same cycle", () => {
    const n = mkNote({
      fires: [{ cycle: 5, at: 1 }, { cycle: 5, at: 2 }, { cycle: 5, at: 3 }],
    })
    expect(shouldPromote(n, noOutcomes)).toBe(false)
  })

  test("does not promote with only 2 fires", () => {
    const n = mkNote({
      fires: [{ cycle: 1, at: 1 }, { cycle: 2, at: 2 }],
    })
    expect(shouldPromote(n, noOutcomes)).toBe(false)
  })

  test("archives after threshold with zero fires", () => {
    const n = mkNote({ cycle: 1 })
    expect(shouldArchive(n, 1 + ARCHIVE_THRESHOLD_CYCLES)).toBe(true)
  })

  test("does not archive before threshold", () => {
    const n = mkNote({ cycle: 1 })
    expect(shouldArchive(n, 5)).toBe(false)
  })

  test("does not archive when note has fires", () => {
    const n = mkNote({ cycle: 1, fires: [{ cycle: 2, at: 1 }] })
    expect(shouldArchive(n, 50)).toBe(false)
  })

  test("legacy cycle=null uses baseline 0", () => {
    const n = mkNote({ cycle: null })
    expect(shouldArchive(n, ARCHIVE_THRESHOLD_CYCLES)).toBe(true)
    expect(shouldArchive(n, ARCHIVE_THRESHOLD_CYCLES - 1)).toBe(false)
  })

  test("promoted notes are not re-promoted and not archived", () => {
    const n = mkNote({
      cycle: 1,
      promotedAt: { at: 1, cycle: 2, originalText: "t", clarified: false },
    })
    expect(shouldPromote(n, noOutcomes)).toBe(false)
    expect(shouldArchive(n, 100)).toBe(false)
  })

  test("already-archived notes are not re-archived or promoted", () => {
    const n = mkNote({
      archivedAt: { at: 1, cycle: 2, reason: "no-fires" },
      fires: [{ cycle: 3, at: 1 }, { cycle: 4, at: 2 }, { cycle: 5, at: 3 }],
    })
    expect(shouldPromote(n, noOutcomes)).toBe(false)
    expect(shouldArchive(n, 100)).toBe(false)
  })
})

describe("pruneAndPromoteBehavioralNotes", () => {
  test("archives a zero-fire note older than threshold and keeps it visible via archivedBehavioralNotes", async () => {
    const store = await loadBrainMemory()
    await addBehavioralNote(store, "agent", "forgotten note", { source: "manual", cycle: 1 })

    const result = await pruneAndPromoteBehavioralNotes("agent", 1 + ARCHIVE_THRESHOLD_CYCLES)
    expect(result.archived.length).toBe(1)
    expect(result.promoted.length).toBe(0)

    const after = await loadBrainMemory()
    expect(after.behavioralNotes?.agent ?? []).toEqual([])
    const archived = after.archivedBehavioralNotes?.agent ?? []
    expect(archived.length).toBe(1)
    expect(archived[0]!.text).toBe("forgotten note")
    expect(archived[0]!.archivedAt?.reason).toBe("no-fires")
  })

  test("promotes a note with ≥3 fires across ≥2 cycles; preserves originalText when no clarifier", async () => {
    const store = await loadBrainMemory()
    await addBehavioralNote(store, "agent", "restart worker when non-responsive", { source: "manual", cycle: 1 })
    const loaded = await loadBrainMemory()
    const noteId = loaded.behavioralNotes!.agent![0]!.id
    await recordBehavioralNoteFires("agent", [noteId], 2)
    await recordBehavioralNoteFires("agent", [noteId], 3)
    await recordBehavioralNoteFires("agent", [noteId], 4)

    const result = await pruneAndPromoteBehavioralNotes("agent", 5)
    expect(result.promoted.length).toBe(1)
    expect(result.promoted[0]!.promotedAt?.originalText).toBe("restart worker when non-responsive")
    expect(result.promoted[0]!.promotedAt?.clarified).toBe(false)
    expect(result.promoted[0]!.text).toBe("restart worker when non-responsive")

    const after = await loadBrainMemory()
    expect(after.behavioralNotes?.agent?.length).toBe(1)
    expect(after.behavioralNotes?.agent?.[0]?.promotedAt).toBeDefined()
  })

  test("clarifier rewrites the text; originalText preserves the pre-rewrite wording", async () => {
    const store = await loadBrainMemory()
    await addBehavioralNote(store, "agent", "always restart worker when the worker becomes entirely non-responsive to incoming prompts", { source: "manual", cycle: 1 })
    const loaded = await loadBrainMemory()
    const noteId = loaded.behavioralNotes!.agent![0]!.id
    await recordBehavioralNoteFires("agent", [noteId], 2)
    await recordBehavioralNoteFires("agent", [noteId], 3)
    await recordBehavioralNoteFires("agent", [noteId], 4)

    const calls: string[] = []
    const clarifier = async (input: { noteText: string; agentName: string }) => {
      calls.push(input.noteText)
      return "WHEN worker non-responsive DO restart BECAUSE clears stuck state"
    }
    const result = await pruneAndPromoteBehavioralNotes("agent", 5, clarifier)
    expect(calls.length).toBe(1)
    expect(result.promoted.length).toBe(1)
    expect(result.promoted[0]!.text).toBe("WHEN worker non-responsive DO restart BECAUSE clears stuck state")
    expect(result.promoted[0]!.promotedAt?.originalText).toBe("always restart worker when the worker becomes entirely non-responsive to incoming prompts")
    expect(result.promoted[0]!.promotedAt?.clarified).toBe(true)
  })

  test("clarifier failure (null) leaves original text intact, clarified=false", async () => {
    const store = await loadBrainMemory()
    await addBehavioralNote(store, "agent", "original phrasing stays", { source: "manual", cycle: 1 })
    const loaded = await loadBrainMemory()
    const noteId = loaded.behavioralNotes!.agent![0]!.id
    await recordBehavioralNoteFires("agent", [noteId], 2)
    await recordBehavioralNoteFires("agent", [noteId], 3)
    await recordBehavioralNoteFires("agent", [noteId], 4)

    const result = await pruneAndPromoteBehavioralNotes("agent", 5, async () => null)
    expect(result.promoted[0]!.text).toBe("original phrasing stays")
    expect(result.promoted[0]!.promotedAt?.clarified).toBe(false)
  })

  test("no-op when nothing crosses either threshold", async () => {
    const store = await loadBrainMemory()
    await addBehavioralNote(store, "agent", "recent note", { source: "manual", cycle: 5 })
    const result = await pruneAndPromoteBehavioralNotes("agent", 6)
    expect(result).toEqual({ promoted: [], archived: [], unpromoted: [] })
  })

  test("promoted notes survive the non-promoted -10 cap", async () => {
    const store = await loadBrainMemory()
    // Seed one note, promote it via fires + prune/promote
    await addBehavioralNote(store, "agent", "lesson that matters", { source: "manual", cycle: 1 })
    let loaded = await loadBrainMemory()
    const targetId = loaded.behavioralNotes!.agent![0]!.id
    await recordBehavioralNoteFires("agent", [targetId], 2)
    await recordBehavioralNoteFires("agent", [targetId], 3)
    await recordBehavioralNoteFires("agent", [targetId], 4)
    await pruneAndPromoteBehavioralNotes("agent", 5)

    // Flood 12 regular notes — promoted should never be evicted
    for (let i = 0; i < 12; i++) {
      await addBehavioralNote(await loadBrainMemory(), "agent", `filler note ${i}`, { source: "manual", cycle: 10 + i })
    }
    loaded = await loadBrainMemory()
    const active = loaded.behavioralNotes!.agent ?? []
    expect(active.find(n => n.id === targetId)).toBeDefined()
    // Non-promoted cap = 10; plus the 1 promoted = 11 total
    expect(active.length).toBeLessThanOrEqual(11)
  })
})

// ---------------------------------------------------------------------------
// Phase 4: outcome recording, outcome-weighted evidence, un-promotion
// ---------------------------------------------------------------------------

describe("recordCycleOutcome", () => {
  test("persists outcome atomically and is retrievable", async () => {
    await recordCycleOutcome("agent", 3, "success", "done")
    const mem = await loadBrainMemory()
    const rec = mem.cycleOutcomes?.agent?.[3]
    expect(rec?.outcome).toBe("success")
    expect(rec?.reason).toBe("done")
    expect(rec?.cycle).toBe(3)
  })

  test("later outcome for the same cycle overwrites the earlier one", async () => {
    await recordCycleOutcome("agent", 5, "success", "done")
    await recordCycleOutcome("agent", 5, "failure", "done-false-progress")
    const mem = await loadBrainMemory()
    expect(mem.cycleOutcomes?.agent?.[5]?.outcome).toBe("failure")
    expect(mem.cycleOutcomes?.agent?.[5]?.reason).toBe("done-false-progress")
  })

  test("caps the outcome map at CYCLE_OUTCOMES_CAP_PER_AGENT", async () => {
    for (let c = 1; c <= CYCLE_OUTCOMES_CAP_PER_AGENT + 10; c++) {
      await recordCycleOutcome("agent", c, "partial", "exhausted")
    }
    const mem = await loadBrainMemory()
    const outcomes = mem.cycleOutcomes?.agent ?? {}
    const cycles = Object.keys(outcomes).map(Number).sort((a, b) => a - b)
    expect(cycles.length).toBe(CYCLE_OUTCOMES_CAP_PER_AGENT)
    // Dropped cycles are the oldest; kept cycles are the most recent.
    expect(cycles[0]).toBe(11)
    expect(cycles.at(-1)).toBe(CYCLE_OUTCOMES_CAP_PER_AGENT + 10)
  })

  test("outcomes for different agents stay isolated", async () => {
    await recordCycleOutcome("alice", 1, "success", "done")
    await recordCycleOutcome("bob", 1, "failure", "stop-failure")
    const mem = await loadBrainMemory()
    expect(mem.cycleOutcomes?.alice?.[1]?.outcome).toBe("success")
    expect(mem.cycleOutcomes?.bob?.[1]?.outcome).toBe("failure")
  })
})

describe("computeOutcomeEvidence", () => {
  const mkNote = (fires: Array<{ cycle: number; at: number }>, promotedCycle?: number): BehavioralNote => ({
    id: "x", text: "t",
    provenance: { source: "manual", cycle: 0, createdAt: 0 },
    fires,
    promotedAt: promotedCycle !== undefined
      ? { at: 1, cycle: promotedCycle, originalText: "t", clarified: false }
      : undefined,
  })

  test("splits fires by outcome; missing outcomes treated as partial", () => {
    const outcomes: Record<number, CycleOutcome> = { 1: "success", 2: "failure" }
    const note = mkNote([
      { cycle: 1, at: 1 }, { cycle: 2, at: 2 }, { cycle: 3, at: 3 },
    ])
    const ev = computeOutcomeEvidence(note, outcomes)
    expect(ev.successFires).toBe(1)
    expect(ev.failureFires).toBe(1)
    expect(ev.partialFires).toBe(1) // cycle 3 has no outcome record
    expect(ev.totalFires).toBe(3)
    expect(ev.distinctCycles).toBe(3)
  })

  test("since-promotion counters only include fires strictly after promotedAt.cycle", () => {
    const outcomes: Record<number, CycleOutcome> = {
      1: "success", 2: "success", 3: "failure", 4: "failure", 5: "failure",
    }
    const note = mkNote(
      [
        { cycle: 1, at: 1 }, { cycle: 2, at: 2 },
        { cycle: 3, at: 3 }, { cycle: 4, at: 4 }, { cycle: 5, at: 5 },
      ],
      /* promotedCycle */ 2,
    )
    const ev = computeOutcomeEvidence(note, outcomes)
    expect(ev.firesSincePromotion).toBe(3) // cycles 3, 4, 5
    expect(ev.failureSincePromotion).toBe(3)
    expect(ev.successSincePromotion).toBe(0)
  })

  test("unpromoted notes (no promotedAt) have zero since-promotion counters", () => {
    const outcomes: Record<number, CycleOutcome> = { 1: "failure" }
    const note = mkNote([{ cycle: 1, at: 1 }])
    const ev = computeOutcomeEvidence(note, outcomes)
    expect(ev.firesSincePromotion).toBe(0)
    expect(ev.failureSincePromotion).toBe(0)
  })
})

describe("outcome-weighted shouldPromote", () => {
  const mkNote = (fires: Array<{ cycle: number; at: number }>): BehavioralNote => ({
    id: "x", text: "t",
    provenance: { source: "manual", cycle: 0, createdAt: 0 },
    fires,
  })

  test("promotes when successFires ≥ failureFires", () => {
    const outcomes: Record<number, CycleOutcome> = {
      1: "success", 2: "success", 3: "failure",
    }
    const note = mkNote([{ cycle: 1, at: 1 }, { cycle: 2, at: 2 }, { cycle: 3, at: 3 }])
    expect(shouldPromote(note, outcomes)).toBe(true)
  })

  test("does NOT promote when failures outnumber successes", () => {
    const outcomes: Record<number, CycleOutcome> = {
      1: "failure", 2: "failure", 3: "success",
    }
    const note = mkNote([{ cycle: 1, at: 1 }, { cycle: 2, at: 2 }, { cycle: 3, at: 3 }])
    expect(shouldPromote(note, outcomes)).toBe(false)
  })

  test("promotes on all-partial evidence (backward-compat with pre-Phase-4 notes)", () => {
    const note = mkNote([{ cycle: 1, at: 1 }, { cycle: 1, at: 2 }, { cycle: 2, at: 3 }])
    expect(shouldPromote(note, {})).toBe(true)
  })

  test("distinct-cycles requirement still applies even with all successes", () => {
    const outcomes: Record<number, CycleOutcome> = { 5: "success" }
    const note = mkNote([{ cycle: 5, at: 1 }, { cycle: 5, at: 2 }, { cycle: 5, at: 3 }])
    expect(shouldPromote(note, outcomes)).toBe(false)
  })
})

describe("shouldUnpromote", () => {
  const mkPromoted = (fires: Array<{ cycle: number; at: number }>, promotedCycle: number): BehavioralNote => ({
    id: "x", text: "t",
    provenance: { source: "manual", cycle: 0, createdAt: 0 },
    fires,
    promotedAt: { at: 1, cycle: promotedCycle, originalText: "t", clarified: false },
  })

  test("un-promotes when failures-since-promotion hit threshold AND outnumber successes", () => {
    const outcomes: Record<number, CycleOutcome> = { 3: "failure", 4: "failure", 5: "failure" }
    const note = mkPromoted(
      [{ cycle: 3, at: 1 }, { cycle: 4, at: 2 }, { cycle: 5, at: 3 }],
      /* promoted at */ 2,
    )
    expect(shouldUnpromote(note, outcomes)).toBe(true)
  })

  test("does not un-promote when successes balance failures", () => {
    const outcomes: Record<number, CycleOutcome> = {
      3: "failure", 4: "failure", 5: "failure", 6: "success", 7: "success", 8: "success",
    }
    const note = mkPromoted(
      [
        { cycle: 3, at: 1 }, { cycle: 4, at: 2 }, { cycle: 5, at: 3 },
        { cycle: 6, at: 4 }, { cycle: 7, at: 5 }, { cycle: 8, at: 6 },
      ],
      2,
    )
    expect(shouldUnpromote(note, outcomes)).toBe(false)
  })

  test("ignores fires from BEFORE promotion when counting failure evidence", () => {
    const outcomes: Record<number, CycleOutcome> = {
      1: "failure", 2: "failure", 3: "failure", // all pre-promotion
      4: "success",
    }
    const note = mkPromoted(
      [{ cycle: 1, at: 1 }, { cycle: 2, at: 2 }, { cycle: 3, at: 3 }, { cycle: 4, at: 4 }],
      /* promoted at */ 3,
    )
    // Only cycle 4 counts after promotion; that's a success → no un-promote.
    expect(shouldUnpromote(note, outcomes)).toBe(false)
  })

  test("below threshold: ≥1 failure but < UNPROMOTE_FAILURE_THRESHOLD does not trigger", () => {
    const fails = UNPROMOTE_FAILURE_THRESHOLD - 1
    const fires: Array<{ cycle: number; at: number }> = []
    const outcomes: Record<number, CycleOutcome> = {}
    for (let i = 0; i < fails; i++) {
      fires.push({ cycle: 10 + i, at: i })
      outcomes[10 + i] = "failure"
    }
    const note = mkPromoted(fires, /* promoted at */ 9)
    expect(shouldUnpromote(note, outcomes)).toBe(false)
  })

  test("not-yet-promoted notes cannot be un-promoted", () => {
    const note: BehavioralNote = {
      id: "x", text: "t",
      provenance: { source: "manual", cycle: 0, createdAt: 0 },
      fires: [{ cycle: 1, at: 1 }, { cycle: 2, at: 2 }, { cycle: 3, at: 3 }],
    }
    const outcomes: Record<number, CycleOutcome> = { 1: "failure", 2: "failure", 3: "failure" }
    expect(shouldUnpromote(note, outcomes)).toBe(false)
  })
})

describe("pruneAndPromoteBehavioralNotes — un-promotion integration", () => {
  test("un-promotes a promoted note whose post-promotion evidence is ≥3 failures", async () => {
    const store = await loadBrainMemory()
    await addBehavioralNote(store, "agent", "principle under test", { source: "manual", cycle: 1 })
    let loaded = await loadBrainMemory()
    const noteId = loaded.behavioralNotes!.agent![0]!.id

    // Three successful fires → promote
    await recordCycleOutcome("agent", 2, "success", "done")
    await recordCycleOutcome("agent", 3, "success", "done")
    await recordCycleOutcome("agent", 4, "success", "done")
    await recordBehavioralNoteFires("agent", [noteId], 2)
    await recordBehavioralNoteFires("agent", [noteId], 3)
    await recordBehavioralNoteFires("agent", [noteId], 4)
    const promoteResult = await pruneAndPromoteBehavioralNotes("agent", 5)
    expect(promoteResult.promoted.length).toBe(1)

    // Three failure fires after promotion → un-promote
    await recordCycleOutcome("agent", 6, "failure", "stop-failure")
    await recordCycleOutcome("agent", 7, "failure", "stop-failure")
    await recordCycleOutcome("agent", 8, "failure", "stop-failure")
    await recordBehavioralNoteFires("agent", [noteId], 6)
    await recordBehavioralNoteFires("agent", [noteId], 7)
    await recordBehavioralNoteFires("agent", [noteId], 8)

    const unpromoteResult = await pruneAndPromoteBehavioralNotes("agent", 9)
    expect(unpromoteResult.unpromoted.length).toBe(1)
    expect(unpromoteResult.promoted.length).toBe(0)
    expect(unpromoteResult.archived.length).toBe(0)

    const after = await loadBrainMemory()
    const note = after.behavioralNotes!.agent!.find(n => n.id === noteId)!
    expect(note.promotedAt).toBeUndefined()
    expect(note.unpromotedAt).toBeDefined()
    expect(note.unpromotedAt?.failureFires).toBe(3)
    expect(note.unpromotedAt?.successFires).toBe(0)
    expect(note.unpromotedAt?.priorPromotion?.originalText).toBe("principle under test")
  })

  test("does not un-promote when post-promotion evidence is mixed but net-positive", async () => {
    const store = await loadBrainMemory()
    await addBehavioralNote(store, "agent", "still solid", { source: "manual", cycle: 1 })
    let loaded = await loadBrainMemory()
    const noteId = loaded.behavioralNotes!.agent![0]!.id

    for (const c of [2, 3, 4]) await recordCycleOutcome("agent", c, "success", "done")
    for (const c of [2, 3, 4]) await recordBehavioralNoteFires("agent", [noteId], c)
    await pruneAndPromoteBehavioralNotes("agent", 5)

    // Post-promotion: 2 failures, 2 successes (tie — failures do NOT outnumber)
    await recordCycleOutcome("agent", 6, "failure", "stop-failure")
    await recordCycleOutcome("agent", 7, "success", "done")
    await recordCycleOutcome("agent", 8, "failure", "stop-failure")
    await recordCycleOutcome("agent", 9, "success", "done")
    for (const c of [6, 7, 8, 9]) await recordBehavioralNoteFires("agent", [noteId], c)

    const result = await pruneAndPromoteBehavioralNotes("agent", 10)
    expect(result.unpromoted.length).toBe(0)

    const after = await loadBrainMemory()
    expect(after.behavioralNotes!.agent!.find(n => n.id === noteId)?.promotedAt).toBeDefined()
  })

  test("getOutcomesForAgent returns cycle→outcome view used by promote/unpromote", async () => {
    await recordCycleOutcome("agent", 1, "success", "done")
    await recordCycleOutcome("agent", 2, "failure", "stop-failure")
    const mem = await loadBrainMemory()
    const view = getOutcomesForAgent(mem, "agent")
    expect(view[1]).toBe("success")
    expect(view[2]).toBe("failure")
    expect(view[99]).toBeUndefined()
  })
})
