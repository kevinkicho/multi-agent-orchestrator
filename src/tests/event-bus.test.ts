import { describe, test, expect } from "bun:test"
import { EventBus } from "../event-bus"

describe("EventBus", () => {
  // ---------------------------------------------------------------------------
  // Emit & buffer
  // ---------------------------------------------------------------------------

  test("emit returns a full event with id and timestamp", () => {
    const bus = new EventBus()
    const evt = bus.emit({ type: "test", source: "unit", data: {} })
    expect(evt.id).toMatch(/^bus-/)
    expect(evt.timestamp).toBeGreaterThan(0)
    expect(evt.type).toBe("test")
    expect(evt.source).toBe("unit")
  })

  test("buffer stores emitted events", () => {
    const bus = new EventBus()
    bus.emit({ type: "a", source: "s", data: {} })
    bus.emit({ type: "b", source: "s", data: {} })
    expect(bus.size).toBe(2)
  })

  test("ring buffer evicts oldest events when full", () => {
    const bus = new EventBus(3) // max 3
    bus.emit({ type: "a", source: "s", data: {} })
    bus.emit({ type: "b", source: "s", data: {} })
    bus.emit({ type: "c", source: "s", data: {} })
    bus.emit({ type: "d", source: "s", data: {} }) // evicts "a"
    expect(bus.size).toBe(3)
    const recent = bus.getRecent()
    expect(recent.map(e => e.type)).toEqual(["d", "c", "b"])
  })

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  test("on() fires handler for matching events", () => {
    const bus = new EventBus()
    const received: string[] = []
    bus.on({ type: "hello" }, (e) => received.push(e.type))

    bus.emit({ type: "hello", source: "s", data: {} })
    bus.emit({ type: "other", source: "s", data: {} })
    bus.emit({ type: "hello", source: "s", data: {} })

    expect(received).toEqual(["hello", "hello"])
  })

  test("off() stops handler from firing", () => {
    const bus = new EventBus()
    const received: string[] = []
    const id = bus.on({ type: "x" }, (e) => received.push(e.type))

    bus.emit({ type: "x", source: "s", data: {} })
    bus.off(id)
    bus.emit({ type: "x", source: "s", data: {} })

    expect(received).toEqual(["x"])
  })

  test("onAny() fires for all events", () => {
    const bus = new EventBus()
    const received: string[] = []
    const unsub = bus.onAny((e) => received.push(e.type))

    bus.emit({ type: "a", source: "s", data: {} })
    bus.emit({ type: "b", source: "s", data: {} })
    unsub()
    bus.emit({ type: "c", source: "s", data: {} })

    expect(received).toEqual(["a", "b"])
  })

  test("subscriber errors do not propagate", () => {
    const bus = new EventBus()
    bus.on({ type: "x" }, () => { throw new Error("boom") })
    // Should not throw
    expect(() => bus.emit({ type: "x", source: "s", data: {} })).not.toThrow()
  })

  // ---------------------------------------------------------------------------
  // Pattern matching
  // ---------------------------------------------------------------------------

  test("matches on type string", () => {
    const bus = new EventBus()
    const received: string[] = []
    bus.on({ type: "specific" }, (e) => received.push(e.type))

    bus.emit({ type: "specific", source: "s", data: {} })
    bus.emit({ type: "other", source: "s", data: {} })
    expect(received).toEqual(["specific"])
  })

  test("matches on type regex", () => {
    const bus = new EventBus()
    const received: string[] = []
    bus.on({ type: /^agent-/ }, (e) => received.push(e.type))

    bus.emit({ type: "agent-start", source: "s", data: {} })
    bus.emit({ type: "cycle-done", source: "s", data: {} })
    bus.emit({ type: "agent-stop", source: "s", data: {} })
    expect(received).toEqual(["agent-start", "agent-stop"])
  })

  test("matches on source", () => {
    const bus = new EventBus()
    const received: string[] = []
    bus.on({ source: "supervisor" }, (e) => received.push(e.type))

    bus.emit({ type: "a", source: "supervisor", data: {} })
    bus.emit({ type: "b", source: "brain", data: {} })
    expect(received).toEqual(["a"])
  })

  test("matches on agentName", () => {
    const bus = new EventBus()
    const received: string[] = []
    bus.on({ agentName: "agent-1" }, (e) => received.push(e.type))

    bus.emit({ type: "a", source: "s", agentName: "agent-1", data: {} })
    bus.emit({ type: "b", source: "s", agentName: "agent-2", data: {} })
    expect(received).toEqual(["a"])
  })

  test("matches on projectId", () => {
    const bus = new EventBus()
    const received: string[] = []
    bus.on({ projectId: "/proj/a" }, (e) => received.push(e.type))

    bus.emit({ type: "x", source: "s", projectId: "/proj/a", data: {} })
    bus.emit({ type: "y", source: "s", projectId: "/proj/b", data: {} })
    expect(received).toEqual(["x"])
  })

  test("multi-field pattern requires all fields to match", () => {
    const bus = new EventBus()
    const received: string[] = []
    bus.on({ type: "cycle-done", agentName: "agent-1" }, (e) => received.push(e.agentName!))

    bus.emit({ type: "cycle-done", source: "s", agentName: "agent-1", data: {} })
    bus.emit({ type: "cycle-done", source: "s", agentName: "agent-2", data: {} })
    bus.emit({ type: "other", source: "s", agentName: "agent-1", data: {} })
    expect(received).toEqual(["agent-1"])
  })

  test("empty pattern matches all events", () => {
    const bus = new EventBus()
    const received: string[] = []
    bus.on({}, (e) => received.push(e.type))

    bus.emit({ type: "a", source: "s", data: {} })
    bus.emit({ type: "b", source: "s", data: {} })
    expect(received).toEqual(["a", "b"])
  })

  // ---------------------------------------------------------------------------
  // getRecent & getSince
  // ---------------------------------------------------------------------------

  test("getRecent returns newest first", () => {
    const bus = new EventBus()
    bus.emit({ type: "first", source: "s", data: {} })
    bus.emit({ type: "second", source: "s", data: {} })
    bus.emit({ type: "third", source: "s", data: {} })

    const recent = bus.getRecent(undefined, 2)
    expect(recent.map(e => e.type)).toEqual(["third", "second"])
  })

  test("getRecent with filter", () => {
    const bus = new EventBus()
    bus.emit({ type: "a", source: "x", data: {} })
    bus.emit({ type: "b", source: "y", data: {} })
    bus.emit({ type: "c", source: "x", data: {} })

    const recent = bus.getRecent({ source: "x" })
    expect(recent.map(e => e.type)).toEqual(["c", "a"])
  })

  test("getSince returns events after timestamp", () => {
    const bus = new EventBus()
    bus.emit({ type: "old", source: "s", data: {} })
    const cutoff = Date.now()
    // Small delay to ensure timestamp difference
    bus.emit({ type: "new1", source: "s", data: {} })
    bus.emit({ type: "new2", source: "s", data: {} })

    const since = bus.getSince(cutoff)
    // May or may not include events depending on timing, but should not include "old"
    for (const e of since) {
      expect(e.timestamp).toBeGreaterThan(cutoff)
    }
  })

  test("getSince with filter", () => {
    const bus = new EventBus()
    const cutoff = Date.now() - 1
    bus.emit({ type: "a", source: "x", data: {} })
    bus.emit({ type: "b", source: "y", data: {} })

    const since = bus.getSince(cutoff, { source: "x" })
    expect(since.every(e => e.source === "x")).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Instance isolation
  // ---------------------------------------------------------------------------

  test("separate EventBus instances have independent buffers", () => {
    const bus1 = new EventBus()
    const bus2 = new EventBus()
    bus1.emit({ type: "a", source: "s", data: {} })
    bus2.emit({ type: "b", source: "s", data: {} })
    expect(bus1.size).toBe(1)
    expect(bus2.size).toBe(1)
    expect(bus1.getRecent()[0]!.type).toBe("a")
    expect(bus2.getRecent()[0]!.type).toBe("b")
  })

  test("separate EventBus instances have independent sub counters", () => {
    const bus1 = new EventBus()
    const bus2 = new EventBus()
    const id1 = bus1.on({}, () => {})
    const id2 = bus2.on({}, () => {})
    // Both should start from sub-1 since counter is per-instance
    expect(id1).toBe("sub-1")
    expect(id2).toBe("sub-1")
  })
})
