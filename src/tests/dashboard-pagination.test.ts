/**
 * Tests for the shared pagination helper used by /api/messages and /api/performance.
 *
 * The helper slices "from the newest end" — `offset=0,limit=N` returns the
 * last N items in their original order, so a dashboard that wants "show me
 * recent activity" gets a sensible default without writing pagination logic
 * client-side. See KNOWN_LIMITATIONS §7.
 */
import { describe, test, expect } from "bun:test"
import { sliceFromTail } from "../dashboard"

function makeParams(pairs: Record<string, string | undefined>): URLSearchParams {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(pairs)) {
    if (v !== undefined) p.set(k, v)
  }
  return p
}

describe("sliceFromTail", () => {
  const items = Array.from({ length: 50 }, (_, i) => i) // 0..49

  test("default limit returns the last defaultLimit items", () => {
    const { slice, total } = sliceFromTail(items, makeParams({}), { defaultLimit: 10, maxLimit: 100 })
    expect(slice).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49])
    expect(total).toBe(50)
  })

  test("limit param takes the last N items in original order", () => {
    const { slice } = sliceFromTail(items, makeParams({ limit: "5" }), { defaultLimit: 10, maxLimit: 100 })
    expect(slice).toEqual([45, 46, 47, 48, 49])
  })

  test("offset counts back from the end, so offset=5,limit=5 is items 40..44", () => {
    const { slice } = sliceFromTail(items, makeParams({ limit: "5", offset: "5" }), { defaultLimit: 10, maxLimit: 100 })
    expect(slice).toEqual([40, 41, 42, 43, 44])
  })

  test("limit is clamped to maxLimit", () => {
    const { slice } = sliceFromTail(items, makeParams({ limit: "9999" }), { defaultLimit: 10, maxLimit: 20 })
    expect(slice.length).toBe(20)
    expect(slice[slice.length - 1]).toBe(49)
  })

  test("non-numeric limit falls back to defaultLimit", () => {
    const { slice } = sliceFromTail(items, makeParams({ limit: "abc" }), { defaultLimit: 5, maxLimit: 100 })
    expect(slice.length).toBe(5)
  })

  test("negative or zero limit falls back to defaultLimit", () => {
    const zeroResult = sliceFromTail(items, makeParams({ limit: "0" }), { defaultLimit: 7, maxLimit: 100 })
    expect(zeroResult.slice.length).toBe(7)
    const negResult = sliceFromTail(items, makeParams({ limit: "-5" }), { defaultLimit: 7, maxLimit: 100 })
    expect(negResult.slice.length).toBe(7)
  })

  test("negative offset is treated as 0", () => {
    const { slice } = sliceFromTail(items, makeParams({ limit: "3", offset: "-1" }), { defaultLimit: 10, maxLimit: 100 })
    expect(slice).toEqual([47, 48, 49])
  })

  test("offset larger than list returns empty slice, but reports full total", () => {
    const { slice, total } = sliceFromTail(items, makeParams({ limit: "5", offset: "100" }), { defaultLimit: 10, maxLimit: 100 })
    expect(slice).toEqual([])
    expect(total).toBe(50)
  })

  test("empty input returns empty slice", () => {
    const { slice, total } = sliceFromTail<number>([], makeParams({ limit: "5" }), { defaultLimit: 10, maxLimit: 100 })
    expect(slice).toEqual([])
    expect(total).toBe(0)
  })

  test("items shorter than limit returns everything", () => {
    const short = [1, 2, 3]
    const { slice, total } = sliceFromTail(short, makeParams({ limit: "100" }), { defaultLimit: 10, maxLimit: 1000 })
    expect(slice).toEqual([1, 2, 3])
    expect(total).toBe(3)
  })

  test("fractional limit is floored", () => {
    const { slice } = sliceFromTail(items, makeParams({ limit: "3.9" }), { defaultLimit: 10, maxLimit: 100 })
    expect(slice.length).toBe(3)
  })
})
