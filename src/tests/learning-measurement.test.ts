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
  pruneAndPromoteBehavioralNotes,
  shouldPromote,
  shouldArchive,
  ARCHIVE_THRESHOLD_CYCLES,
  type BehavioralNote,
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

  test("promotes with 3 fires across 2 cycles", () => {
    const n = mkNote({
      fires: [
        { cycle: 1, at: 1 }, { cycle: 1, at: 2 }, { cycle: 2, at: 3 },
      ],
    })
    expect(shouldPromote(n)).toBe(true)
  })

  test("does not promote with 3 fires all in same cycle", () => {
    const n = mkNote({
      fires: [{ cycle: 5, at: 1 }, { cycle: 5, at: 2 }, { cycle: 5, at: 3 }],
    })
    expect(shouldPromote(n)).toBe(false)
  })

  test("does not promote with only 2 fires", () => {
    const n = mkNote({
      fires: [{ cycle: 1, at: 1 }, { cycle: 2, at: 2 }],
    })
    expect(shouldPromote(n)).toBe(false)
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
    expect(shouldPromote(n)).toBe(false)
    expect(shouldArchive(n, 100)).toBe(false)
  })

  test("already-archived notes are not re-archived or promoted", () => {
    const n = mkNote({
      archivedAt: { at: 1, cycle: 2, reason: "no-fires" },
      fires: [{ cycle: 3, at: 1 }, { cycle: 4, at: 2 }, { cycle: 5, at: 3 }],
    })
    expect(shouldPromote(n)).toBe(false)
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
    expect(result).toEqual({ promoted: [], archived: [] })
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
