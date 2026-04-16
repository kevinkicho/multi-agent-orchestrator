/**
 * Shared in-memory event bus for cross-agent coordination.
 * Ring buffer of recent events + pattern-matched subscriptions.
 * No file I/O — purely runtime state.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BusEvent = {
  id: string
  type: string
  source: string
  agentName?: string
  projectId?: string
  timestamp: number
  data: Record<string, unknown>
}

export type BusPattern = {
  type?: string | RegExp
  source?: string
  agentName?: string
  projectId?: string
}

type Subscription = {
  id: string
  pattern: BusPattern
  handler: (event: BusEvent) => void
}

// ---------------------------------------------------------------------------
// EventBus class
// ---------------------------------------------------------------------------

export class EventBus {
  private buffer: BusEvent[] = []
  private maxBuffer: number
  private subscriptions = new Map<string, Subscription>()
  private anyListeners = new Set<(event: BusEvent) => void>()
  private subCounter = 0

  constructor(maxBuffer = 200) {
    this.maxBuffer = maxBuffer
  }

  /** Emit an event. Returns the full event with id and timestamp. */
  emit(partial: Omit<BusEvent, "id" | "timestamp">): BusEvent {
    const event: BusEvent = {
      ...partial,
      id: `bus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    }

    // Ring buffer
    this.buffer.push(event)
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift()
    }

    // Notify pattern-matched subscriptions
    for (const sub of this.subscriptions.values()) {
      if (this.matches(event, sub.pattern)) {
        try { sub.handler(event) } catch { /* subscriber errors don't propagate */ }
      }
    }

    // Notify raw listeners (for SSE streaming)
    for (const listener of this.anyListeners) {
      try { listener(event) } catch { /* ignore */ }
    }

    return event
  }

  /** Subscribe to events matching a pattern. Returns subscription ID. */
  on(pattern: BusPattern, handler: (event: BusEvent) => void): string {
    const id = `sub-${++this.subCounter}`
    this.subscriptions.set(id, { id, pattern, handler })
    return id
  }

  /** Unsubscribe by ID. */
  off(id: string): void {
    this.subscriptions.delete(id)
  }

  /** Listen to all events (for SSE streaming). Returns unsubscribe function. */
  onAny(handler: (event: BusEvent) => void): () => void {
    this.anyListeners.add(handler)
    return () => { this.anyListeners.delete(handler) }
  }

  /** Get recent events from the buffer, optionally filtered. */
  getRecent(filter?: BusPattern, limit = 50): BusEvent[] {
    let events = this.buffer
    if (filter) {
      events = events.filter(e => this.matches(e, filter))
    }
    // Return newest first, limited
    return events.slice(-limit).reverse()
  }

  /** Get events since a specific timestamp, optionally filtered. */
  getSince(since: number, filter?: BusPattern): BusEvent[] {
    let events = this.buffer.filter(e => e.timestamp > since)
    if (filter) {
      events = events.filter(e => this.matches(e, filter))
    }
    return events
  }

  /** Current buffer size. */
  get size(): number {
    return this.buffer.length
  }

  // -------------------------------------------------------------------------
  // Pattern matching
  // -------------------------------------------------------------------------

  private matches(event: BusEvent, pattern: BusPattern): boolean {
    if (pattern.type !== undefined) {
      if (pattern.type instanceof RegExp) {
        if (!pattern.type.test(event.type)) return false
      } else {
        if (event.type !== pattern.type) return false
      }
    }
    if (pattern.source !== undefined && event.source !== pattern.source) return false
    if (pattern.agentName !== undefined && event.agentName !== pattern.agentName) return false
    if (pattern.projectId !== undefined && event.projectId !== pattern.projectId) return false
    return true
  }
}
