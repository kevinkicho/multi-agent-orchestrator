export type PauseStatus = "none" | "requested" | "paused"

export type PauseState = {
  requested: boolean
  requestedAt: number | null
  pausedAt: number | null
  status: PauseStatus
  /** @internal — resolves the awaitResume() promise */
  _resumeResolve?: () => void
}

export function createPauseState(): PauseState {
  return {
    requested: false,
    requestedAt: null,
    pausedAt: null,
    status: "none",
  }
}

export function requestPause(state: PauseState): void {
  state.requested = true
  state.requestedAt = Date.now()
  state.status = "requested"
}

export function requestResume(state: PauseState): void {
  state.requested = false
  state.status = "none"
  state.pausedAt = null
  state.requestedAt = null
  if (state._resumeResolve) {
    state._resumeResolve()
    state._resumeResolve = undefined
  }
}

/** Blocks until resume is called or the signal is aborted.
 *  Called by the supervisor after CYCLE_DONE when pause is requested. */
export function awaitResume(state: PauseState, signal?: AbortSignal): Promise<void> {
  state.status = "paused"
  state.pausedAt = Date.now()

  if (signal?.aborted) {
    state.status = "none"
    return Promise.resolve()
  }

  return new Promise<void>((resolve) => {
    state._resumeResolve = () => {
      cleanup()
      resolve()
    }

    const onAbort = () => {
      state._resumeResolve = undefined
      state.status = "none"
      cleanup()
      resolve()
    }

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort)
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function isPauseRequested(state: PauseState): boolean {
  return state.requested
}
