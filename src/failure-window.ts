/**
 * Fixed-size rolling window of recent LLM call outcomes.
 *
 * Replaces a consecutive-failure counter: the old `consecutiveLlmFailures = 0`
 * on every success could not distinguish "healthy provider" from "flaky
 * provider returning 1-in-5 successes." A window-based count trips the
 * breaker when failure *density* crosses a threshold, regardless of how the
 * failures interleave with successes. See KNOWN_LIMITATIONS §22b.
 */

export type LlmOutcome = "ok" | "fail"

export class FailureWindow {
  private readonly buf: LlmOutcome[] = []
  constructor(public readonly size: number) {
    if (!Number.isFinite(size) || size < 1) {
      throw new Error(`FailureWindow size must be a positive finite number, got ${size}`)
    }
  }

  record(ok: boolean): void {
    this.buf.push(ok ? "ok" : "fail")
    if (this.buf.length > this.size) this.buf.shift()
  }

  failures(): number {
    let n = 0
    for (const o of this.buf) if (o === "fail") n++
    return n
  }

  length(): number {
    return this.buf.length
  }

  clear(): void {
    this.buf.length = 0
  }

  snapshot(): readonly LlmOutcome[] {
    return this.buf.slice()
  }
}
