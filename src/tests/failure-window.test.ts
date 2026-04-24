/**
 * Tests for FailureWindow — the rolling-window replacement for the
 * consecutive-failure counter the supervisor circuit breaker used to use.
 *
 * The critical case is a flaky provider: the OLD code reset on every single
 * success, so an 80%-failure provider still reported 0–1 consecutive failures
 * and never tripped. The NEW code counts failures by density in the window,
 * so a 5-in-10 failure rate trips even if some successes are mixed in.
 * See KNOWN_LIMITATIONS §22b.
 */
import { describe, test, expect } from "bun:test"
import { FailureWindow } from "../failure-window"

describe("FailureWindow", () => {
  test("rejects non-positive sizes", () => {
    expect(() => new FailureWindow(0)).toThrow()
    expect(() => new FailureWindow(-1)).toThrow()
    expect(() => new FailureWindow(Number.POSITIVE_INFINITY)).toThrow()
  })

  test("counts failures across a rolling window", () => {
    const w = new FailureWindow(5)
    w.record(false); w.record(false); w.record(true); w.record(false)
    expect(w.failures()).toBe(3)
    expect(w.length()).toBe(4)
  })

  test("evicts oldest entries past the size limit", () => {
    const w = new FailureWindow(3)
    w.record(false); w.record(false); w.record(false); w.record(true)
    // Window now: [fail, fail, ok]
    expect(w.failures()).toBe(2)
    expect(w.length()).toBe(3)
    w.record(true)
    // Window now: [fail, ok, ok]
    expect(w.failures()).toBe(1)
  })

  test("clear() empties the window", () => {
    const w = new FailureWindow(3)
    w.record(false); w.record(false)
    w.clear()
    expect(w.failures()).toBe(0)
    expect(w.length()).toBe(0)
  })

  test("snapshot returns a copy that callers can mutate freely", () => {
    const w = new FailureWindow(3)
    w.record(false)
    const snap = w.snapshot() as unknown as string[]
    expect(snap).toEqual(["fail"])
    snap.push("ok")
    expect(w.length()).toBe(1) // external mutation doesn't leak in
  })

  // --- The behavior §22b was introduced to fix ---

  test("flaky provider (1-in-2 success) still trips at the density threshold", () => {
    // Simulate a 50% failure rate: fail, ok, fail, ok, fail, ok, fail, ok, fail, ok
    // The OLD counter-based code would never see more than 1 consecutive
    // failure and never trip. The window-based check trips once density
    // exceeds the threshold.
    const w = new FailureWindow(10)
    const TRIP_AT = 5
    const trace: number[] = []
    const pattern: boolean[] = [false, true, false, true, false, true, false, true, false, true]
    for (const ok of pattern) {
      w.record(ok)
      trace.push(w.failures())
    }
    // After the 9th call (pattern index 8, fail), window = 5 fails + 4 oks → trips
    expect(trace.some(f => f >= TRIP_AT)).toBe(true)
    expect(w.failures()).toBe(5)
  })

  test("healthy provider (1-in-10 failure) never trips", () => {
    const w = new FailureWindow(10)
    const TRIP_AT = 5
    // 1 failure every 10 calls, sustained for 100 calls
    for (let i = 0; i < 100; i++) w.record(i % 10 !== 0)
    expect(w.failures()).toBeLessThan(TRIP_AT)
  })

  test("provider that recovers walks the counter back down", () => {
    const w = new FailureWindow(10)
    for (let i = 0; i < 5; i++) w.record(false)
    expect(w.failures()).toBe(5)
    // Recovery: 10 straight successes should fully clear failures from the window
    for (let i = 0; i < 10; i++) w.record(true)
    expect(w.failures()).toBe(0)
  })
})
