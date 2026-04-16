import { describe, test, expect } from "bun:test"
import {
  createPauseState,
  requestPause,
  requestResume,
  awaitResume,
  isPauseRequested,
} from "../pause-service"

describe("PauseService", () => {
  test("createPauseState returns clean state", () => {
    const state = createPauseState()
    expect(state.requested).toBe(false)
    expect(state.status).toBe("none")
    expect(state.requestedAt).toBeNull()
    expect(state.pausedAt).toBeNull()
  })

  test("requestPause sets requested state", () => {
    const state = createPauseState()
    requestPause(state)
    expect(state.requested).toBe(true)
    expect(state.status).toBe("requested")
    expect(state.requestedAt).toBeGreaterThan(0)
  })

  test("isPauseRequested reflects current state", () => {
    const state = createPauseState()
    expect(isPauseRequested(state)).toBe(false)
    requestPause(state)
    expect(isPauseRequested(state)).toBe(true)
  })

  test("requestResume resets state", () => {
    const state = createPauseState()
    requestPause(state)
    requestResume(state)
    expect(state.requested).toBe(false)
    expect(state.status).toBe("none")
    expect(state.requestedAt).toBeNull()
    expect(state.pausedAt).toBeNull()
  })

  test("awaitResume blocks until resume is called", async () => {
    const state = createPauseState()
    requestPause(state)

    let resumed = false
    const promise = awaitResume(state).then(() => { resumed = true })

    expect(state.status).toBe("paused")
    expect(state.pausedAt).toBeGreaterThan(0)
    expect(resumed).toBe(false)

    requestResume(state)
    await promise

    expect(resumed).toBe(true)
    expect(state.status).toBe("none")
  })

  test("awaitResume resolves immediately if signal is already aborted", async () => {
    const state = createPauseState()
    requestPause(state)

    const controller = new AbortController()
    controller.abort()

    await awaitResume(state, controller.signal)
    expect(state.status).toBe("none")
  })

  test("awaitResume resolves when signal is aborted", async () => {
    const state = createPauseState()
    requestPause(state)

    const controller = new AbortController()
    const promise = awaitResume(state, controller.signal)

    expect(state.status).toBe("paused")

    controller.abort()
    await promise

    expect(state.status).toBe("none")
  })

  test("requestResume without prior awaitResume is safe", () => {
    const state = createPauseState()
    requestPause(state)
    // Resume without anyone awaiting — should not throw
    expect(() => requestResume(state)).not.toThrow()
  })

  test("double requestPause is idempotent", () => {
    const state = createPauseState()
    requestPause(state)
    const firstAt = state.requestedAt
    requestPause(state)
    expect(state.requested).toBe(true)
    // requestedAt may differ (updated), but state is still valid
    expect(state.status).toBe("requested")
  })
})
