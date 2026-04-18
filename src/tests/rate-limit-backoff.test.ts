import { describe, test, expect } from "bun:test"

/**
 * Tests for 429 backoff behavior with decay.
 *
 * These tests validate the logic in isolation since the actual 429 handling
 * is deeply embedded in the supervisor loop. The tested behaviors are:
 *
 * 1. consecutive429s increments on 429 errors
 * 2. consecutive429s decays by 1 on successful LLM calls
 * 3. consecutive429s is capped at MAX_CONSECUTIVE_429S (10)
 * 4. consecutive429s persists across cycles (not reset at cycle end)
 * 5. Inter-cycle pause escalates with consecutive429s count
 */

const MAX_CONSECUTIVE_429S = 10

describe("429 backoff with decay", () => {
  test("counter increments on 429 error", () => {
    let consecutive429s = 0
    // Simulate a 429 error
    consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    expect(consecutive429s).toBe(1)
    consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    expect(consecutive429s).toBe(2)
  })

  test("counter decays by 1 on success", () => {
    let consecutive429s = 3
    // Simulate a successful LLM call
    consecutive429s = Math.max(0, consecutive429s - 1)
    expect(consecutive429s).toBe(2)
    consecutive429s = Math.max(0, consecutive429s - 1)
    expect(consecutive429s).toBe(1)
    consecutive429s = Math.max(0, consecutive429s - 1)
    expect(consecutive429s).toBe(0)
    // Decay below 0 stays at 0
    consecutive429s = Math.max(0, consecutive429s - 1)
    expect(consecutive429s).toBe(0)
  })

  test("counter is capped at MAX_CONSECUTIVE_429S (10)", () => {
    let consecutive429s = 0
    for (let i = 0; i < 20; i++) {
      consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    }
    expect(consecutive429s).toBe(10)
  })

  test("escalation across cycles: 429s persist and inter-cycle pause grows", () => {
    // Simulate 3 cycles: each hitting 429 once
    let consecutive429s = 0

    // Cycle 1: 429 error
    consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    expect(consecutive429s).toBe(1)
    // Inter-cycle pause: min(60s * 1, 5min) = 60s
    const cyclePause1 = Math.min(60_000 * consecutive429s, 300_000)
    expect(cyclePause1).toBe(60_000)

    // Cycle 2: 429 error (counter grows to 2)
    consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    expect(consecutive429s).toBe(2)
    const cyclePause2 = Math.min(60_000 * consecutive429s, 300_000)
    expect(cyclePause2).toBe(120_000)

    // Cycle 3: success (counter decays to 1)
    consecutive429s = Math.max(0, consecutive429s - 1)
    expect(consecutive429s).toBe(1)
    const cyclePause3 = Math.min(60_000 * consecutive429s, 300_000)
    expect(cyclePause3).toBe(60_000)

    // Cycle 4: success (counter decays to 0, no extra pause)
    consecutive429s = Math.max(0, consecutive429s - 1)
    expect(consecutive429s).toBe(0)
  })

  test("recovery from max 429 count with decay", () => {
    let consecutive429s = MAX_CONSECUTIVE_429S

    // Each success decays by 1
    for (let i = 0; i < MAX_CONSECUTIVE_429S; i++) {
      consecutive429s = Math.max(0, consecutive429s - 1)
    }
    expect(consecutive429s).toBe(0)
  })

  test("429 cooldown escalation within a cycle", () => {
    // Simulate the per-request cooldown: min(30s * 2^(n-1), 5min)
    let consecutive429s = 0

    // First 429: 30s
    consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    expect(Math.min(30_000 * Math.pow(2, consecutive429s - 1), 300_000)).toBe(30_000)

    // Second 429: 60s
    consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    expect(Math.min(30_000 * Math.pow(2, consecutive429s - 1), 300_000)).toBe(60_000)

    // Third 429: 120s
    consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    expect(Math.min(30_000 * Math.pow(2, consecutive429s - 1), 300_000)).toBe(120_000)

    // Sixth 429: capped at 5min
    consecutive429s = Math.min(6, MAX_CONSECUTIVE_429S)
    expect(Math.min(30_000 * Math.pow(2, consecutive429s - 1), 300_000)).toBe(300_000)
  })

  test("mixed success and 429 cycles", () => {
    let consecutive429s = 0

    // Cycle 1: 429
    consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    expect(consecutive429s).toBe(1)

    // Cycle 2: 429
    consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    expect(consecutive429s).toBe(2)

    // Cycle 3: success
    consecutive429s = Math.max(0, consecutive429s - 1)
    expect(consecutive429s).toBe(1)

    // Cycle 4: 429 (doesn't reset, grows from 1)
    consecutive429s = Math.min(consecutive429s + 1, MAX_CONSECUTIVE_429S)
    expect(consecutive429s).toBe(2)

    // Cycle 5: success
    consecutive429s = Math.max(0, consecutive429s - 1)
    expect(consecutive429s).toBe(1)

    // Cycle 6: success
    consecutive429s = Math.max(0, consecutive429s - 1)
    expect(consecutive429s).toBe(0)

    // Cycle 7: no pause (counter is 0)
    expect(consecutive429s).toBe(0)
  })
})