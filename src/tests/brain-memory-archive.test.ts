/**
 * Tests for the brain memory archive/restore system and per-agent session entries.
 *
 * Uses a temp directory to isolate file I/O from the real project.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import {
  loadBrainMemory,
  saveBrainMemory,
  addMemoryEntry,
  addProjectNote,
  addBehavioralNote,
  archiveAgentMemory,
  loadAgentArchive,
  hasAgentArchive,
  restoreAgentMemory,
  listArchives,
  formatMemoryForPrompt,
  type BrainMemoryStore,
  type BrainMemoryEntry,
} from "../brain-memory"

// ---------------------------------------------------------------------------
// Temp directory setup — redirect process.cwd() for isolation
// ---------------------------------------------------------------------------

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
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(agent: string, summary: string, ts?: number): BrainMemoryEntry {
  return {
    timestamp: ts ?? Date.now(),
    objective: `${agent} cycle`,
    summary,
    agentLearnings: { [agent]: [`learned from ${summary}`] },
  }
}

function makeGlobalEntry(summary: string, ts?: number): BrainMemoryEntry {
  return {
    timestamp: ts ?? Date.now(),
    objective: "brain objective",
    summary,
    agentLearnings: {},
  }
}

// ---------------------------------------------------------------------------
// Migration: flat entries[] → per-agent agentEntries{}
// ---------------------------------------------------------------------------

describe("Brain memory migration", () => {
  test("migrates flat entries into per-agent buckets on load", async () => {
    // Write old-format store directly
    const oldStore = {
      entries: [
        makeEntry("alpha", "did stuff", 1000),
        makeEntry("beta", "did other stuff", 2000),
        makeEntry("alpha", "more stuff", 3000),
      ],
      projectNotes: {},
    }
    writeFileSync(resolve(tmpDir, ".orchestrator-memory.json"), JSON.stringify(oldStore))

    const store = await loadBrainMemory()
    // Old entries should be migrated to agentEntries
    expect(store.entries).toEqual([]) // cleared after migration
    expect(store.agentEntries?.["alpha"]?.length).toBe(2)
    expect(store.agentEntries?.["beta"]?.length).toBe(1)
  })

  test("puts entries with no agent learnings into _global", async () => {
    const oldStore = {
      entries: [makeGlobalEntry("brain did stuff", 1000)],
      projectNotes: {},
    }
    writeFileSync(resolve(tmpDir, ".orchestrator-memory.json"), JSON.stringify(oldStore))

    const store = await loadBrainMemory()
    expect(store.agentEntries?.["_global"]?.length).toBe(1)
  })

  test("already-migrated store is unchanged", async () => {
    const migratedStore: BrainMemoryStore = {
      entries: [],
      agentEntries: { alpha: [makeEntry("alpha", "stuff")] },
      projectNotes: {},
    }
    writeFileSync(resolve(tmpDir, ".orchestrator-memory.json"), JSON.stringify(migratedStore))

    const store = await loadBrainMemory()
    expect(store.agentEntries?.["alpha"]?.length).toBe(1)
    expect(store.entries).toEqual([])
  })

  test("caps each agent bucket at 20 during migration", async () => {
    const entries = Array.from({ length: 25 }, (_, i) => makeEntry("busy-agent", `entry-${i}`, i))
    const oldStore = { entries, projectNotes: {} }
    writeFileSync(resolve(tmpDir, ".orchestrator-memory.json"), JSON.stringify(oldStore))

    const store = await loadBrainMemory()
    expect(store.agentEntries?.["busy-agent"]?.length).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Per-agent addMemoryEntry
// ---------------------------------------------------------------------------

describe("addMemoryEntry per-agent", () => {
  test("writes to agentEntries[agentName]", async () => {
    const store = await loadBrainMemory()
    await addMemoryEntry(store, makeEntry("worker-1", "cycle 1"), "worker-1")
    await addMemoryEntry(store, makeEntry("worker-2", "cycle 1"), "worker-2")

    const loaded = await loadBrainMemory()
    expect(loaded.agentEntries?.["worker-1"]?.length).toBe(1)
    expect(loaded.agentEntries?.["worker-2"]?.length).toBe(1)
  })

  test("defaults to _global when no agentName given", async () => {
    const store = await loadBrainMemory()
    await addMemoryEntry(store, makeGlobalEntry("brain stuff"))

    const loaded = await loadBrainMemory()
    expect(loaded.agentEntries?.["_global"]?.length).toBe(1)
  })

  test("caps at 20 per agent", async () => {
    const store = await loadBrainMemory()
    for (let i = 0; i < 25; i++) {
      await addMemoryEntry(store, makeEntry("heavy", `entry-${i}`, i), "heavy")
    }

    const loaded = await loadBrainMemory()
    expect(loaded.agentEntries?.["heavy"]?.length).toBe(20)
    // Should keep the most recent
    expect(loaded.agentEntries?.["heavy"]?.[19]?.summary).toBe("entry-24")
  })
})

// ---------------------------------------------------------------------------
// Archive / Restore
// ---------------------------------------------------------------------------

describe("archiveAgentMemory", () => {
  test("creates archive file and removes agent from active store", async () => {
    const store = await loadBrainMemory()
    await addMemoryEntry(store, makeEntry("test-agent", "did work"), "test-agent")
    await addProjectNote(store, "test-agent", "important note")
    await addBehavioralNote(store, "test-agent", "always use small prompts")

    await archiveAgentMemory("test-agent", "Build the feature")

    // Archive file should exist
    const archivePath = resolve(tmpDir, ".orchestrator", "archives", "test-agent.json")
    expect(existsSync(archivePath)).toBe(true)

    // Archive should contain the data
    const archive = JSON.parse(readFileSync(archivePath, "utf-8"))
    expect(archive.agentName).toBe("test-agent")
    expect(archive.sessionSummaries.length).toBe(1)
    expect(archive.projectNotes).toEqual(["important note"])
    expect(archive.behavioralNotes).toEqual(["always use small prompts"])
    expect(archive.lastDirective).toBe("Build the feature")

    // Active store should be clean
    const active = await loadBrainMemory()
    expect(active.agentEntries?.["test-agent"]).toBeUndefined()
    expect(active.projectNotes["test-agent"]).toBeUndefined()
    expect(active.behavioralNotes?.["test-agent"]).toBeUndefined()
  })

  test("does not create archive file when agent has no data", async () => {
    await archiveAgentMemory("empty-agent")
    const archivePath = resolve(tmpDir, ".orchestrator", "archives", "empty-agent.json")
    expect(existsSync(archivePath)).toBe(false)
  })

  test("does not remove other agents' data", async () => {
    const store = await loadBrainMemory()
    await addProjectNote(store, "keep-me", "my note")
    await addProjectNote(store, "remove-me", "their note")

    await archiveAgentMemory("remove-me")

    const active = await loadBrainMemory()
    expect(active.projectNotes["keep-me"]).toEqual(["my note"])
    expect(active.projectNotes["remove-me"]).toBeUndefined()
  })
})

describe("loadAgentArchive", () => {
  test("returns null for non-existent agent", async () => {
    const archive = await loadAgentArchive("nonexistent")
    expect(archive).toBeNull()
  })

  test("returns archive data when file exists", async () => {
    const store = await loadBrainMemory()
    await addBehavioralNote(store, "archived-agent", "be concise")
    await archiveAgentMemory("archived-agent")

    const archive = await loadAgentArchive("archived-agent")
    expect(archive).not.toBeNull()
    expect(archive!.agentName).toBe("archived-agent")
    expect(archive!.behavioralNotes).toEqual(["be concise"])
  })
})

describe("hasAgentArchive", () => {
  test("returns false when no archive", async () => {
    expect(await hasAgentArchive("nope")).toBe(false)
  })

  test("returns true when archive exists", async () => {
    const store = await loadBrainMemory()
    await addProjectNote(store, "agent-x", "a note")
    await archiveAgentMemory("agent-x")
    expect(await hasAgentArchive("agent-x")).toBe(true)
  })
})

describe("restoreAgentMemory", () => {
  test("merges archive back into active store", async () => {
    // Set up data and archive it
    const store = await loadBrainMemory()
    await addMemoryEntry(store, makeEntry("restored", "old work", 1000), "restored")
    await addProjectNote(store, "restored", "old note")
    await addBehavioralNote(store, "restored", "old behavior")
    await archiveAgentMemory("restored")

    // Verify active store is clean
    let active = await loadBrainMemory()
    expect(active.agentEntries?.["restored"]).toBeUndefined()

    // Restore
    const ok = await restoreAgentMemory("restored")
    expect(ok).toBe(true)

    // Verify data is back
    active = await loadBrainMemory()
    expect(active.agentEntries?.["restored"]?.length).toBe(1)
    expect(active.projectNotes["restored"]).toEqual(["old note"])
    expect(active.behavioralNotes?.["restored"]).toEqual(["old behavior"])

    // Archive file should be deleted
    expect(await hasAgentArchive("restored")).toBe(false)
  })

  test("returns false when no archive exists", async () => {
    const ok = await restoreAgentMemory("nonexistent")
    expect(ok).toBe(false)
  })

  test("merges with existing active data without duplicating", async () => {
    // Create some active data
    const store = await loadBrainMemory()
    await addProjectNote(store, "merger", "active note")

    // Create an archive with different data
    await addBehavioralNote(store, "merger", "archived behavior")
    await archiveAgentMemory("merger")

    // Re-add active note (simulating the agent being re-added)
    const store2 = await loadBrainMemory()
    await addProjectNote(store2, "merger", "new active note")

    // Restore — should merge, not overwrite
    await restoreAgentMemory("merger")

    const final = await loadBrainMemory()
    expect(final.projectNotes["merger"]).toContain("new active note")
    expect(final.behavioralNotes?.["merger"]).toContain("archived behavior")
  })
})

describe("listArchives", () => {
  test("returns empty array when no archives", async () => {
    const archives = await listArchives()
    expect(archives).toEqual([])
  })

  test("lists archived agents", async () => {
    const store = await loadBrainMemory()
    await addProjectNote(store, "agent-a", "note a")
    await addProjectNote(store, "agent-b", "note b")
    await archiveAgentMemory("agent-a", "directive a")
    await archiveAgentMemory("agent-b", "directive b")

    const archives = await listArchives()
    expect(archives.length).toBe(2)
    const names = archives.map(a => a.agentName).sort()
    expect(names).toEqual(["agent-a", "agent-b"])
  })
})

// ---------------------------------------------------------------------------
// formatMemoryForPrompt with per-agent entries
// ---------------------------------------------------------------------------

describe("formatMemoryForPrompt with agentEntries", () => {
  test("reads from agentEntries when agentName provided", async () => {
    const store: BrainMemoryStore = {
      entries: [],
      agentEntries: {
        alpha: [makeEntry("alpha", "alpha did something")],
        beta: [makeEntry("beta", "beta did something")],
      },
      projectNotes: {},
    }

    const prompt = formatMemoryForPrompt(store, "alpha")
    expect(prompt).toContain("alpha did something")
    expect(prompt).not.toContain("beta did something")
  })

  test("merges all entries when no agentName", async () => {
    const store: BrainMemoryStore = {
      entries: [],
      agentEntries: {
        alpha: [makeEntry("alpha", "alpha work", 1000)],
        beta: [makeEntry("beta", "beta work", 2000)],
      },
      projectNotes: {},
    }

    const prompt = formatMemoryForPrompt(store)
    expect(prompt).toContain("alpha work")
    expect(prompt).toContain("beta work")
  })

  test("falls back to legacy entries when agentEntries empty", async () => {
    const store: BrainMemoryStore = {
      entries: [makeEntry("old-agent", "legacy work")],
      agentEntries: {},
      projectNotes: {},
    }

    const prompt = formatMemoryForPrompt(store, "old-agent")
    expect(prompt).toContain("legacy work")
  })
})
