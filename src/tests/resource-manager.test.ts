import { describe, test, expect } from "bun:test"
import { ResourceManager } from "../resource-manager"

describe("ResourceManager — file locks", () => {
  test("acquireFiles registers a lock", () => {
    const rm = new ResourceManager()
    rm.acquireFiles("agent-1", ["src/a.ts", "src/b.ts"])
    const locks = rm.getActiveLocks()
    expect(locks.size).toBe(1)
    expect(locks.get("agent-1")!.files).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("releaseFiles removes a lock", () => {
    const rm = new ResourceManager()
    rm.acquireFiles("agent-1", ["src/a.ts"])
    rm.releaseFiles("agent-1")
    expect(rm.getActiveLocks().size).toBe(0)
  })

  test("acquireFiles replaces previous lock for same agent", () => {
    const rm = new ResourceManager()
    rm.acquireFiles("agent-1", ["src/a.ts"])
    rm.acquireFiles("agent-1", ["src/b.ts"])
    expect(rm.getActiveLocks().get("agent-1")!.files).toEqual(["src/b.ts"])
  })

  test("getConflicts detects overlapping files between agents", () => {
    const rm = new ResourceManager()
    rm.acquireFiles("agent-1", ["src/a.ts", "src/shared.ts"])
    rm.acquireFiles("agent-2", ["src/b.ts", "src/shared.ts"])

    const conflicts = rm.getConflicts("agent-2", ["src/shared.ts", "src/c.ts"])
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.file).toBe("src/shared.ts")
    expect(conflicts[0]!.heldBy).toBe("agent-1")
    expect(conflicts[0]!.requestedBy).toBe("agent-2")
  })

  test("getConflicts does not self-conflict", () => {
    const rm = new ResourceManager()
    rm.acquireFiles("agent-1", ["src/a.ts"])
    const conflicts = rm.getConflicts("agent-1", ["src/a.ts"])
    expect(conflicts.length).toBe(0)
  })

  test("getConflicts returns empty when no overlap", () => {
    const rm = new ResourceManager()
    rm.acquireFiles("agent-1", ["src/a.ts"])
    rm.acquireFiles("agent-2", ["src/b.ts"])
    const conflicts = rm.getConflicts("agent-2", ["src/b.ts"])
    expect(conflicts.length).toBe(0)
  })

  test("getActiveLocks returns a copy (not live reference)", () => {
    const rm = new ResourceManager()
    rm.acquireFiles("agent-1", ["src/a.ts"])
    const copy = rm.getActiveLocks()
    rm.releaseFiles("agent-1")
    expect(copy.size).toBe(1) // copy unchanged
    expect(rm.getActiveLocks().size).toBe(0) // original updated
  })
})

describe("ResourceManager — work intent ledger", () => {
  test("declareIntent stores intent", () => {
    const rm = new ResourceManager()
    const intent = rm.declareIntent("agent-1", "Refactor auth", ["src/auth.ts"])
    expect(intent.agentName).toBe("agent-1")
    expect(intent.description).toBe("Refactor auth")
    expect(intent.files).toEqual(["src/auth.ts"])
    expect(rm.getAllIntents().size).toBe(1)
  })

  test("declareIntent replaces previous intent for same agent", () => {
    const rm = new ResourceManager()
    rm.declareIntent("agent-1", "Old work", ["src/old.ts"])
    rm.declareIntent("agent-1", "New work", ["src/new.ts"])
    expect(rm.getAllIntents().size).toBe(1)
    expect(rm.getAllIntents().get("agent-1")!.description).toBe("New work")
  })

  test("clearIntent removes intent", () => {
    const rm = new ResourceManager()
    rm.declareIntent("agent-1", "Work", ["src/a.ts"])
    rm.clearIntent("agent-1")
    expect(rm.getAllIntents().size).toBe(0)
  })

  test("getIntentConflicts detects overlapping files between intents", () => {
    const rm = new ResourceManager()
    rm.declareIntent("agent-1", "Auth work", ["src/auth.ts", "src/middleware.ts"])
    rm.declareIntent("agent-2", "Middleware refactor", ["src/middleware.ts", "src/routes.ts"])

    const conflicts = rm.getIntentConflicts("agent-2")
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.overlappingFiles).toEqual(["src/middleware.ts"])
    expect(conflicts[0]!.theirIntent.agentName).toBe("agent-1")
  })

  test("getIntentConflicts does not self-conflict", () => {
    const rm = new ResourceManager()
    rm.declareIntent("agent-1", "Work", ["src/a.ts"])
    expect(rm.getIntentConflicts("agent-1")).toEqual([])
  })

  test("getIntentConflicts returns empty when no files declared", () => {
    const rm = new ResourceManager()
    rm.declareIntent("agent-1", "Thinking about stuff", [])
    rm.declareIntent("agent-2", "Also thinking", ["src/a.ts"])
    expect(rm.getIntentConflicts("agent-1")).toEqual([])
  })

  test("getIntentConflicts also checks file locks from non-intent agents", () => {
    const rm = new ResourceManager()
    // agent-1 has file locks but no intent
    rm.acquireFiles("agent-1", ["src/shared.ts"])
    // agent-2 declares intent overlapping with agent-1's locks
    rm.declareIntent("agent-2", "Edit shared", ["src/shared.ts"])

    const conflicts = rm.getIntentConflicts("agent-2")
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.theirIntent.agentName).toBe("agent-1")
    expect(conflicts[0]!.theirIntent.description).toBe("(active file locks)")
  })

  test("getIntentConflicts skips file-lock agents that also have intents", () => {
    const rm = new ResourceManager()
    // agent-1 has both intent and file locks on same file
    rm.declareIntent("agent-1", "Auth work", ["src/auth.ts"])
    rm.acquireFiles("agent-1", ["src/auth.ts"])
    rm.declareIntent("agent-2", "Also auth", ["src/auth.ts"])

    // Should only get 1 conflict (from intent), not 2 (intent + lock)
    const conflicts = rm.getIntentConflicts("agent-2")
    expect(conflicts.length).toBe(1)
  })

  test("formatIntentSummary excludes specified agent", () => {
    const rm = new ResourceManager()
    rm.declareIntent("agent-1", "Work A", ["src/a.ts"])
    rm.declareIntent("agent-2", "Work B", ["src/b.ts"])

    const summary = rm.formatIntentSummary("agent-1")
    expect(summary).toContain("agent-2")
    expect(summary).not.toContain("agent-1")
  })

  test("formatIntentSummary returns placeholder when no other intents", () => {
    const rm = new ResourceManager()
    rm.declareIntent("agent-1", "Work A", ["src/a.ts"])
    const summary = rm.formatIntentSummary("agent-1")
    expect(summary).toContain("no other agents")
  })

  test("formatIntentSummary truncates long file lists", () => {
    const rm = new ResourceManager()
    const files = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`)
    rm.declareIntent("agent-1", "Big refactor", files)
    const summary = rm.formatIntentSummary()
    expect(summary).toContain("+5 more")
  })

  test("getAllIntents returns a copy", () => {
    const rm = new ResourceManager()
    rm.declareIntent("agent-1", "Work", ["src/a.ts"])
    const copy = rm.getAllIntents()
    rm.clearIntent("agent-1")
    expect(copy.size).toBe(1) // copy unchanged
    expect(rm.getAllIntents().size).toBe(0)
  })
})

describe("ResourceManager — LLM semaphore", () => {
  test("acquireLlmSlot increments active count", async () => {
    const rm = new ResourceManager(2)
    await rm.acquireLlmSlot()
    expect(rm.getLlmActiveCount()).toBe(1)
    await rm.acquireLlmSlot()
    expect(rm.getLlmActiveCount()).toBe(2)
  })

  test("releaseLlmSlot decrements active count", async () => {
    const rm = new ResourceManager(2)
    await rm.acquireLlmSlot()
    await rm.acquireLlmSlot()
    rm.releaseLlmSlot()
    expect(rm.getLlmActiveCount()).toBe(1)
  })

  test("releaseLlmSlot does not go below 0", () => {
    const rm = new ResourceManager(2)
    rm.releaseLlmSlot()
    rm.releaseLlmSlot()
    expect(rm.getLlmActiveCount()).toBe(0)
  })

  test("acquireLlmSlot blocks at max concurrency then resumes on release", async () => {
    const rm = new ResourceManager(1)
    await rm.acquireLlmSlot() // takes the only slot

    let resolved = false
    const pending = rm.acquireLlmSlot().then(() => { resolved = true })

    // Should be queued
    expect(rm.getLlmQueueDepth()).toBe(1)
    expect(resolved).toBe(false)

    // Release the slot — should wake the waiter
    rm.releaseLlmSlot()
    await pending

    expect(resolved).toBe(true)
    expect(rm.getLlmActiveCount()).toBe(1)
    expect(rm.getLlmQueueDepth()).toBe(0)
  })

  test("multiple waiters are served in FIFO order", async () => {
    const rm = new ResourceManager(1)
    await rm.acquireLlmSlot()

    const order: number[] = []
    const p1 = rm.acquireLlmSlot().then(() => order.push(1))
    const p2 = rm.acquireLlmSlot().then(() => order.push(2))
    expect(rm.getLlmQueueDepth()).toBe(2)

    rm.releaseLlmSlot() // wake #1
    await p1
    rm.releaseLlmSlot() // wake #2
    await p2

    expect(order).toEqual([1, 2])
  })

  test("getLlmMaxConcurrency returns configured max", () => {
    expect(new ResourceManager(5).getLlmMaxConcurrency()).toBe(5)
    expect(new ResourceManager().getLlmMaxConcurrency()).toBe(2) // default
  })
})
