import { BackoffTracker, type BackoffOptions } from './backoff.ts'
import { MirbError } from './errors.ts'
import { newSessionId } from './ids.ts'
import { delay } from './probe.ts'
import {
  MirbEmitter,
  Session,
  toForward,
  type SessionExit,
  type SessionRuntimeOptions,
  type Unsubscribe
} from './session.ts'
import type { ForwardState, MirbErrorCode, MirbEvent, SessionOptions, SessionStatus } from './types.ts'

/**
 * Keeps one logical session alive across ssh processes.
 *
 * A laptop lid closes, a VPN reconnects, a wifi network changes — ssh exits, and without
 * this layer every one of those turns into a dead tunnel the user finds out about from a
 * failing request. The supervisor spawns a fresh `Session` behind the same id and ports, so
 * from the outside the forward simply keeps working.
 *
 * The discipline it holds to is knowing when *not* to retry. Reconnecting forever on a wrong
 * password would lock an account out; reconnecting on a typo'd hostname would hide the typo.
 * So retries are reserved for failures that a later attempt could plausibly survive.
 */

type EventName = MirbEvent['event']
type EventPayload<N extends EventName> = Extract<MirbEvent, { event: N }>

/**
 * Which failures are worth another attempt.
 *
 * `SSH_CONNECT` is the retryable one by design — it is also the bucket `classifySshStderr`
 * falls back to for anything it doesn't recognise, which is the right default for an ssh
 * that died mid-session for unclear reasons. `PORT_IN_USE` is retryable because the usual
 * cause on a reconnect is our own dying ssh not having released the socket yet.
 *
 * Everything else is a standing condition: a bad key, a missing binary, a privileged port
 * and a malformed config will all fail identically in thirty seconds' time.
 */
export function isRetryable(code: MirbErrorCode): boolean {
  switch (code) {
    case 'SSH_CONNECT':
    case 'PORT_IN_USE':
    case 'REMOTE_REFUSED':
      return true
    default:
      return false
  }
}

export interface SupervisorOptions {
  /**
   * Max reconnect attempts. `undefined` inherits `SessionOptions.retry`, which is itself
   * unlimited when unset; `0` disables reconnection entirely.
   */
  retry?: number
  backoff?: BackoffOptions & { resetAfterMs?: number }
  /** Ctrl-C. Aborting stops the supervisor for good; it never counts as a reconnect. */
  signal?: AbortSignal
  id?: string
  /** Timeouts and probe tuning handed to every session. */
  session?: Omit<SessionRuntimeOptions, 'id' | 'signal'>
}

function nowIso(): string {
  return new Date().toISOString()
}

export class Supervisor {
  readonly id: string
  /** Resolves when the supervisor has given up or been stopped — never before. */
  readonly finished: Promise<SessionExit>

  private readonly events = new MirbEmitter()
  private readonly control = new AbortController()
  private readonly backoff: BackoffTracker
  private readonly retry: number | undefined
  private readonly runtime: Omit<SessionRuntimeOptions, 'id' | 'signal'>
  private readonly detachSignal: Unsubscribe
  private readonly resolveFinished: (exit: SessionExit) => void

  private base: SessionOptions
  private current: Session | null = null
  private forwardEvents: Unsubscribe = () => {}
  private lastForwards: ForwardState[]
  private lastArgv: string[] = []
  private _status: SessionStatus = 'starting'
  private _reconnects = 0
  private started = false
  private stopRequested = false
  private settled = false
  /** The supervise loop, so `stop()` can wait for it to unwind rather than racing it. */
  private loop: Promise<void> = Promise.resolve()

  constructor(options: SessionOptions, supervisor: SupervisorOptions = {}) {
    this.base = options
    this.id = supervisor.id ?? newSessionId()
    this.retry = supervisor.retry ?? options.retry
    this.runtime = supervisor.session ?? {}
    this.backoff = new BackoffTracker(supervisor.backoff ?? {})
    this.lastForwards = options.forwards.map((f) => ({ ...f, status: 'pending' }))

    let resolve!: (exit: SessionExit) => void
    this.finished = new Promise<SessionExit>((r) => {
      resolve = r
    })
    this.resolveFinished = resolve

    const signal = supervisor.signal
    if (signal) {
      const onAbort = () => void this.stop()
      signal.addEventListener('abort', onAbort)
      this.detachSignal = () => signal.removeEventListener('abort', onAbort)
    } else {
      this.detachSignal = () => {}
    }

    if (signal?.aborted) this.stopRequested = true
  }

  /**
   * While a session is live its status *is* the supervisor's status. The cached value only
   * takes over for the states no session can report about itself: waiting out a backoff,
   * and having stopped for good.
   */
  get status(): SessionStatus {
    if (this._status === 'reconnecting' || this._status === 'stopped' || this._status === 'failed') {
      return this._status
    }
    return this.current?.status ?? this._status
  }

  get forwards(): ForwardState[] {
    return this.current?.forwards ?? this.lastForwards
  }

  get sshPid(): number | undefined {
    return this.current?.sshPid
  }

  get sshArgv(): string[] {
    const argv = this.current?.sshArgv
    return argv && argv.length > 0 ? argv : this.lastArgv
  }

  /** How many times the tunnel has been rebuilt. Persisted into the session record. */
  get reconnects(): number {
    return this._reconnects
  }

  on<N extends EventName>(event: N, cb: (e: EventPayload<N>) => void): Unsubscribe {
    return this.events.on(event, cb)
  }

  onAny(cb: (e: MirbEvent) => void): Unsubscribe {
    return this.events.onAny(cb)
  }

  /**
   * Bring the tunnel up and start supervising it.
   *
   * Resolves once the first session is ready, and rejects if it never is. The first attempt
   * is deliberately not retried: the user is sitting there waiting, and a typo'd host or a
   * missing key should print its actual reason immediately instead of disappearing behind a
   * spinner for the length of a backoff schedule. Reconnection is for sessions that have
   * already proven the target works.
   */
  async start(): Promise<void> {
    if (this.started) throw new MirbError('INTERNAL', 'supervisor has already been started')
    this.started = true

    const first = this.newSession(true)
    this.current = first

    try {
      await first.start()
    } catch (err) {
      this.lastForwards = first.forwards
      this.lastArgv = first.sshArgv
      this._status = 'failed'
      this.settle(await first.exited)
      throw err
    }

    // Freeze the ports the first attempt actually took: a reconnect that moved to a
    // different local port would silently break every client already pointed at this one.
    this.base = { ...this.base, forwards: first.forwards.map(toForward) }
    this._status = first.status
    this.backoff.markConnected(Date.now())
    this.loop = this.supervise(first)
  }

  /**
   * Stop for good. Never retries, whatever the session's exit looks like, because a
   * requested stop is the one exit that carries no information about the connection.
   */
  async stop(): Promise<void> {
    this.stopRequested = true
    this.control.abort()

    await this.current?.stop().catch(() => {
      // The session is gone either way; a kill that raced its own exit is not an error.
    })
    await this.loop

    // A supervisor that already gave up keeps its 'failed' status: a stop() issued during
    // cleanup must not rewrite the record of why the tunnel died.
    if (!this.settled) {
      this._status = 'stopped'
      this.settle({ code: 0, reason: 'stopped', requested: true })
    }
  }

  private newSession(first: boolean): Session {
    const session = new Session(this.base, {
      ...this.runtime,
      id: this.id,
      signal: this.control.signal,
      autoPort: first ? (this.runtime.autoPort ?? false) : false
    })

    this.forwardEvents()
    this.forwardEvents = session.onAny((e) => this.events.emit(e))
    return session
  }

  private async supervise(initial: Session): Promise<void> {
    let session = initial

    for (;;) {
      const exit = await session.exited
      this.lastForwards = session.forwards
      this.lastArgv = session.sshArgv

      if (this.stopRequested || exit.requested) {
        this._status = 'stopped'
        this.settle(exit)
        return
      }

      if (!this.shouldRetry(exit.error)) {
        this._status = 'failed'
        this.settle(exit)
        return
      }

      const attempt = this._reconnects + 1
      const delayMs = this.backoff.nextDelay(Date.now())
      this._status = 'reconnecting'
      this.events.emit({ event: 'session.reconnecting', ts: nowIso(), attempt, delayMs })

      await delay(delayMs, this.control.signal)
      if (this.stopRequested) {
        this._status = 'stopped'
        this.settle(exit)
        return
      }

      this._reconnects = attempt
      const next = this.newSession(false)
      this.current = next

      try {
        await next.start()
        this._status = next.status
        this.backoff.markConnected(Date.now())
      } catch {
        // Nothing to handle here: a failed start still resolves `next.exited`, so the top of
        // the loop re-reads that failure and applies the same retry rules to it.
      }

      session = next
    }
  }

  private shouldRetry(error: MirbError | undefined): boolean {
    if (this.retry === 0) return false
    if (this.retry !== undefined && this._reconnects >= this.retry) return false
    if (error && !isRetryable(error.code)) return false
    return true
  }

  private settle(exit: SessionExit): void {
    if (this.settled) return
    this.settled = true
    this.forwardEvents()
    this.detachSignal()
    this.resolveFinished(exit)
  }
}
