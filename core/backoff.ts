export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  /** Fraction of the delay to jitter by, 0..1. */
  jitter?: number
}

/**
 * Exponential backoff with jitter for reconnect attempts.
 *
 * `attempt` is 1-based. Jitter is applied symmetrically so a fleet of mirrorball instances
 * reconnecting after a network blip doesn't stampede the same sshd.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 1000, maxMs = 30_000, jitter = 0.2 } = opts
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs)
  if (jitter <= 0) return Math.round(exponential)
  const delta = exponential * jitter
  return Math.round(exponential - delta + Math.random() * delta * 2)
}

/**
 * Tracks reconnect attempts, resetting once a connection has proven itself stable.
 * Without the reset, a session that flaps once an hour would eventually wait 30s
 * to recover from a blip it could have ridden out instantly.
 */
export class BackoffTracker {
  private attempt = 0
  private lastSuccessAt = 0

  constructor(
    private readonly opts: BackoffOptions & { resetAfterMs?: number } = {}
  ) {}

  /** Call when a connection has been established. */
  markConnected(now: number): void {
    this.lastSuccessAt = now
  }

  /** Call when the connection drops. Returns how long to wait before retrying. */
  nextDelay(now: number): number {
    const { resetAfterMs = 60_000 } = this.opts
    if (this.lastSuccessAt > 0 && now - this.lastSuccessAt >= resetAfterMs) {
      this.attempt = 0
    }
    this.attempt += 1
    return backoffDelay(this.attempt, this.opts)
  }

  get attempts(): number {
    return this.attempt
  }
}
