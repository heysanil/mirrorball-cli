import { classifySshStderr, MirbError } from './errors.ts'
import { newSessionId } from './ids.ts'
import { preflight } from './ports.ts'
import { probeRemote, waitForBind } from './probe.ts'
import { buildSshArgs, spawnSsh, type SshProcess } from './ssh.ts'
import type {
  Forward,
  ForwardState,
  MirbEvent,
  SessionOptions,
  SessionStatus
} from './types.ts'

/**
 * One ssh process and the forwards it carries.
 *
 * A Session is deliberately single-use: it starts, it runs, it exits, and that is the whole
 * lifecycle. Reconnection lives one layer up in `core/supervisor.ts`, because "the tunnel
 * died and we chose to try again" is a policy decision, and a session that could silently
 * resurrect itself would make `exited` mean nothing.
 */

type EventName = MirbEvent['event']
type EventPayload<N extends EventName> = Extract<MirbEvent, { event: N }>

export type Unsubscribe = () => void

/**
 * A listener that throws is a bug in the consumer, not a reason to drop a tunnel. We
 * isolate it rather than letting it unwind the supervisor's loop.
 */
function callSafely(cb: (e: MirbEvent) => void, event: MirbEvent): void {
  try {
    cb(event)
  } catch {
    // Intentionally swallowed: see above.
  }
}

/**
 * A minimal typed event bus over the `MirbEvent` union.
 *
 * node:events would work, but it types callbacks as `(...args: any[])`, and the whole point
 * of `MirbEvent` is that a `--json` consumer and the TUI see exactly the same shapes.
 */
export class MirbEmitter {
  private readonly byName = new Map<EventName, Set<(e: MirbEvent) => void>>()
  private readonly anyListeners = new Set<(e: MirbEvent) => void>()

  on<N extends EventName>(event: N, cb: (e: EventPayload<N>) => void): Unsubscribe {
    const fn = cb as (e: MirbEvent) => void
    let set = this.byName.get(event)
    if (!set) {
      set = new Set()
      this.byName.set(event, set)
    }
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }

  /** Every event, in emission order. This is what NDJSON output and the log file consume. */
  onAny(cb: (e: MirbEvent) => void): Unsubscribe {
    this.anyListeners.add(cb)
    return () => {
      this.anyListeners.delete(cb)
    }
  }

  emit(event: MirbEvent): void {
    // Snapshot both sets: a listener that unsubscribes itself is normal, and mutating a
    // Set mid-iteration is how that turns into a skipped listener.
    for (const cb of [...(this.byName.get(event.event) ?? [])]) callSafely(cb, event)
    for (const cb of [...this.anyListeners]) callSafely(cb, event)
  }
}

export interface SessionRuntimeOptions {
  /** Reuse an existing id, so every reconnect attempt reports under one session. */
  id?: string
  /** Ctrl-C and shutdown. Aborting is equivalent to calling `stop()`. */
  signal?: AbortSignal
  /**
   * Shift a busy local port instead of failing. Only ever true on a first attempt: a
   * reconnect that quietly moved to a different port would break every tab the user has open.
   */
  autoPort?: boolean
  /** How long the local sockets get to start accepting. */
  bindTimeoutMs?: number
  probeTimeoutMs?: number
  probeSettleMs?: number
  /** Grace between SIGTERM and SIGKILL when stopping. */
  killGraceMs?: number
}

export interface SessionExit {
  /**
   * ssh's exit status when ssh actually ran, otherwise mirb's own exit code for the failure
   * that stopped it from running (a busy port, say).
   */
  code: number
  reason: string
  /** True when `stop()` or an abort caused this, so the supervisor knows not to retry. */
  requested: boolean
  /** Absent only on a requested stop. */
  error?: MirbError
}

/** ssh binds after authentication, which is unbounded; the connect timeout is not the budget. */
const BIND_TIMEOUT_SLACK_S = 10
const MIN_BIND_TIMEOUT_MS = 10_000
/** How often to re-scan ssh's stderr for channel failures that arrive after startup. */
const LATE_FAILURE_POLL_MS = 2_000
const DEFAULT_KILL_GRACE_MS = 2_000

/** Not a user-facing failure: the supervisor recognises it and declines to retry. */
const STOPPED_EARLY = 'session was stopped before it became ready'

function nowIso(): string {
  return new Date().toISOString()
}

/** ForwardState carries status back to the caller; ssh only ever needs the Forward half. */
export function toForward(f: ForwardState): Forward {
  return {
    localPort: f.localPort,
    bindAddress: f.bindAddress,
    remoteHost: f.remoteHost,
    remotePort: f.remotePort,
    source: f.source
  }
}

/**
 * Everything mirb throws should already be an MirbError; this is the seam where a stray
 * runtime error (an unexpected ENOENT, a bug) still arrives with a code attached rather
 * than as an unhandled rejection.
 */
export function asMirbError(err: unknown): MirbError {
  if (err instanceof MirbError) return err
  return new MirbError('INTERNAL', err instanceof Error ? err.message : String(err))
}

export class Session {
  readonly id: string
  readonly options: SessionOptions
  /**
   * Resolves exactly once, for every way a session can end — including a failure during
   * `start()`, so a supervisor can await this without also having to catch.
   */
  readonly exited: Promise<SessionExit>

  private readonly events = new MirbEmitter()
  /** Aborted on exit; cancels in-flight bind waits and probes. */
  private readonly control = new AbortController()
  private readonly bindTimeoutMs: number
  private readonly probeTimeoutMs: number | undefined
  private readonly probeSettleMs: number | undefined
  private readonly killGraceMs: number
  private readonly autoPort: boolean
  private readonly detachSignal: Unsubscribe
  private readonly resolveExit: (exit: SessionExit) => void

  private _forwards: ForwardState[]
  private _status: SessionStatus = 'starting'
  private _sshArgv: string[] = []
  private proc: SshProcess | null = null
  private started = false
  /** True once `session.start` has been emitted, so exits are never announced out of order. */
  private announced = false
  private stopping = false
  private ended = false
  /**
   * Set the instant ssh's process resolves, before any awaiting code runs. Readiness is
   * decided against this rather than against which promise won a race — see awaitBind.
   */
  private processExited = false
  /**
   * Set when ssh logs a channel-open failure that our socket probes did not catch.
   *
   * It cannot be expressed as a forward status: the `channel N:` number is not a port, so we
   * know one of the forwards is lying but not which. It must therefore live outside the
   * per-forward state AND survive the status recompute in `start()` — an earlier version set
   * `_status` directly and was silently overwritten one line later.
   */
  private channelFailureSeen = false
  /** Set the moment mirb decides the session has failed, so the exit record agrees with it. */
  private failure: MirbError | undefined
  private lateFailureTimer: ReturnType<typeof setInterval> | undefined

  constructor(options: SessionOptions, runtime: SessionRuntimeOptions = {}) {
    this.options = options
    this.id = runtime.id ?? newSessionId()
    this._forwards = options.forwards.map((f) => ({ ...f, status: 'pending' }))
    this.autoPort = runtime.autoPort ?? false
    this.bindTimeoutMs =
      runtime.bindTimeoutMs ??
      Math.max(MIN_BIND_TIMEOUT_MS, (options.timeout + BIND_TIMEOUT_SLACK_S) * 1000)
    this.probeTimeoutMs = runtime.probeTimeoutMs
    this.probeSettleMs = runtime.probeSettleMs
    this.killGraceMs = runtime.killGraceMs ?? DEFAULT_KILL_GRACE_MS

    let resolve!: (exit: SessionExit) => void
    this.exited = new Promise<SessionExit>((r) => {
      resolve = r
    })
    this.resolveExit = resolve

    const signal = runtime.signal
    if (signal) {
      const onAbort = () => void this.stop()
      signal.addEventListener('abort', onAbort)
      // Long-lived signals (one per mirb process) outlive individual sessions, so the
      // supervisor's tenth reconnect must not leave nine dead listeners attached.
      this.detachSignal = () => signal.removeEventListener('abort', onAbort)
      if (signal.aborted) onAbort()
    } else {
      this.detachSignal = () => {}
    }
  }

  get status(): SessionStatus {
    return this._status
  }

  /** Snapshots: callers hold these across awaits, and shared mutable state would lie. */
  get forwards(): ForwardState[] {
    return this._forwards.map((f) => ({ ...f }))
  }

  /** The pid of ssh itself. `mirb ls` reports the supervisor's pid instead, deliberately. */
  get sshPid(): number | undefined {
    return this.proc?.pid
  }

  /** The exact argv handed to ssh, for `mirb logs` and bug reports. */
  get sshArgv(): string[] {
    return this._sshArgv
  }

  on<N extends EventName>(event: N, cb: (e: EventPayload<N>) => void): Unsubscribe {
    return this.events.on(event, cb)
  }

  onAny(cb: (e: MirbEvent) => void): Unsubscribe {
    return this.events.onAny(cb)
  }

  /**
   * Bring the tunnel up, resolving once every forward has been classified.
   *
   * The order — preflight, spawn, wait for binds, probe — is the order in which failures
   * get cheaper to explain. A busy local port is caught before ssh sees a packet; an auth
   * failure is caught before we wait out a bind timeout; a dead remote service is caught
   * only after there is a working tunnel to blame it against.
   *
   * Throws an MirbError if the session never became usable. A session that came up with some
   * forwards refused resolves normally with status `degraded`: the tunnel works, and telling
   * the user that by exiting would throw away the forwards that are fine.
   */
  async start(): Promise<void> {
    if (this.started) throw new MirbError('INTERNAL', 'session has already been started')
    this.started = true
    if (this.ended) throw new MirbError('INTERNAL', 'session was stopped before it started')

    try {
      // Preflight happens before `session.start` is emitted so the event carries the ports
      // mirb will really use, not the ones the user asked for and autoPort then shifted.
      const resolved = await preflight(this._forwards.map(toForward), { autoPort: this.autoPort })

      // Preflight is the first thing here that awaits, so a Ctrl-C or a supervisor shutdown
      // can land while it runs. At that point `proc` is still null, so `stop()` sees nothing
      // to kill and finishes immediately — and if we then spawned ssh anyway, that child
      // would belong to a session already marked ended, so nothing would ever terminate it.
      // It would hold the port until the machine rebooted. Re-check before spawning.
      if (this.stopping || this.ended || this.control.signal.aborted) {
        throw new MirbError('INTERNAL', STOPPED_EARLY)
      }

      this._forwards = resolved.map((f) => ({ ...f, status: 'pending' }))

      const spawnOptions: SessionOptions = { ...this.options, forwards: resolved }
      this._sshArgv = buildSshArgs(spawnOptions)

      this.emit({
        event: 'session.start',
        ts: nowIso(),
        id: this.id,
        target: this.options.target,
        forwards: resolved
      })
      this.announced = true

      this._status = 'connecting'
      const proc = this.spawn(spawnOptions)
      this.proc = proc
      // Attached before anything awaits, so an exit at any point below has already been
      // recorded (with its stderr classified) by the time we look at it.
      void proc.exited.then((code) => this.onProcessExit(code))

      const raced = await Promise.race([
        Promise.all(this._forwards.map((_f, i) => this.awaitBind(i))),
        proc.exited.then(() => 'exited' as const)
      ])

      // Order matters: an unexpected exit has already aborted `control`, so testing the
      // signal first would report every crash as "you stopped it".
      // `raced` is NOT a reliable verdict on its own. Promise.race attaches reactions in
      // array order, so the Promise.all entry wins any tie, and the `.then()` wrapper on
      // proc.exited puts it a microtask further behind. Against a squatted port the bind
      // poll also resolves in ~1ms versus ~90ms for ssh to exit. So consult the process
      // state directly rather than trusting which promise got there first.
      if (raced === 'exited' || this.processExited || this.proc?.hasExited === true) {
        const exit = await this.exited
        if (exit.requested) throw new MirbError('INTERNAL', STOPPED_EARLY)
        throw (
          exit.error ??
          new MirbError('SSH_CONNECT', `ssh exited with status ${exit.code} before the tunnel came up`)
        )
      }

      if (this.stopping) throw new MirbError('INTERNAL', STOPPED_EARLY)

      const stuck = this._forwards.find((f) => f.status !== 'bound')
      if (stuck) {
        throw new MirbError(
          'SSH_CONNECT',
          `timed out after ${this.bindTimeoutMs}ms waiting for local port ${stuck.localPort} to accept connections`,
          'Raise --timeout, or check the remote host permits TCP forwarding.'
        )
      }

      if (this.options.probe) await this.probeAll()
      this.watchForLateChannelFailures()

      const degraded =
        this.channelFailureSeen ||
        this._forwards.some((f) => f.status === 'refused' || f.status === 'failed')
      this._status = degraded ? 'degraded' : 'ready'

      this.emit({
        event: 'session.ready',
        ts: nowIso(),
        id: this.id,
        // 'bound' counts as usable: without --probe it is the strongest claim we can honestly
        // make, and overstating it as 'ready' is exactly the lie mirb exists to avoid.
        ready: this._forwards.filter((f) => f.status === 'ready' || f.status === 'bound').length,
        total: this._forwards.length
      })
    } catch (err) {
      const error = asMirbError(err)
      await this.failWith(error)
      throw error
    }
  }

  /**
   * Stop ssh and resolve once it is gone.
   *
   * SIGTERM first, because ssh tears down its forwards and its control socket on it. SIGKILL
   * only after a grace period, and only because a wedged ssh holding the user's ports is a
   * worse outcome than an ungraceful exit.
   */
  async stop(): Promise<void> {
    if (this.ended) return
    this.stopping = true
    this.control.abort()

    if (!this.proc) {
      this.finish({ code: 0, reason: 'stopped', requested: true })
      return
    }

    await this.terminate()
    await this.exited
  }

  /**
   * `session.exit` is terminal on the event stream: nothing may follow it.
   *
   * Without this guard the ordering is genuinely wrong, not merely untidy. `probeAll()` can
   * still be in flight when the ssh process dies, so a `forward.ready` or `session.ready`
   * resolves *after* `finish()` has already emitted `session.exit`. A consumer that treats
   * the stream as a lifecycle — which is exactly what `--json` invites an agent to do —
   * would see a session come back to life after it ended, and could reasonably conclude the
   * ports were usable when the tunnel was gone.
   */
  private emit(event: MirbEvent): void {
    if (this.ended && event.event !== 'session.exit') return
    this.events.emit(event)
  }

  private spawn(options: SessionOptions): SshProcess {
    try {
      return spawnSsh(options)
    } catch (err) {
      // Bun.spawn throws synchronously for a missing or non-executable binary. resolveSshPath
      // normally catches this first; reaching here means the binary vanished between the two.
      throw new MirbError(
        'NO_SSH',
        `could not run '${options.sshPath}': ${err instanceof Error ? err.message : String(err)}`,
        'Check the ssh binary, or point mirb at another one with MIRB_SSH=/path/to/ssh.'
      )
    }
  }

  private async awaitBind(index: number): Promise<boolean> {
    const forward = this._forwards[index]
    if (!forward) return false

    const bound = await waitForBind(forward.localPort, forward.bindAddress, {
      timeoutMs: this.bindTimeoutMs,
      signal: this.control.signal
    })

    if (!bound) {
      // An abort is a teardown, not a verdict, so it must not be reported as a broken forward.
      if (!this.control.signal.aborted) {
        forward.status = 'failed'
        forward.detail = 'local port never started accepting connections'
        this.emit({
          event: 'forward.error',
          ts: nowIso(),
          localPort: forward.localPort,
          code: 'SSH_CONNECT',
          message: forward.detail
        })
      }
      return false
    }

    // A successful connect proves *something* is listening — not that ssh bound it. If ssh
    // has already exited, that something is whatever squatted the port, and announcing
    // `forward.bound` would put a lie on the event stream that agents are meant to trust.
    // Checked as state rather than by racing: timing arguments rot silently.
    if (this.processExited || this.proc?.hasExited === true) return false

    forward.status = 'bound'
    this.emit({ event: 'forward.bound', ts: nowIso(), localPort: forward.localPort })
    return true
  }

  private async probeAll(): Promise<void> {
    // Snapshot stderr before probing so we only consider channel failures our probes caused.
    const stderrBefore = this.proc?.stderr.length ?? 0

    await Promise.all(
      this._forwards.map(async (forward) => {
        if (forward.status !== 'bound') return

        const verdict = await probeRemote(forward, {
          timeoutMs: this.probeTimeoutMs,
          settleMs: this.probeSettleMs,
          signal: this.control.signal
        })

        if (this.control.signal.aborted) return

        if (verdict === 'ready') {
          forward.status = 'ready'
          this.emit({ event: 'forward.ready', ts: nowIso(), localPort: forward.localPort })
          return
        }

        forward.status = 'refused'
        forward.detail = `nothing is listening on ${forward.remoteHost}:${forward.remotePort} at the far end`
        this.emit({
          event: 'forward.error',
          ts: nowIso(),
          localPort: forward.localPort,
          code: 'REMOTE_REFUSED',
          message: forward.detail
        })
      })
    )

    this.reconcileWithChannelFailures(stderrBefore)
  }

  /**
   * Guard the probe's dangerous failure direction.
   *
   * `probeRemote` reads its verdict off socket lifecycle, and refusal costs ~3 round trips.
   * On a link slow enough that 3xRTT exceeds the settle window, a DEAD service reports
   * `ready` — a false positive, which is far worse than a false negative for a tool whose
   * whole promise is that `ready` means usable.
   *
   * ssh does tell us, just not in time and not per-forward: it writes
   * `channel N: open failed: <reason>` when a channel cannot be opened. The channel number
   * is not a port, so we cannot attribute the line to a specific forward — but if any such
   * line appeared while we were probing and every forward came back `ready`, at least one
   * of those verdicts is wrong. Say so rather than reporting a confident lie.
   */
  private reconcileWithChannelFailures(stderrBefore: number): void {
    const during = (this.proc?.stderr ?? '').slice(stderrBefore)
    const failures = during.match(/channel \d+: open failed: ([^\n]*)/g)
    if (!failures?.length) return

    const suspect = this._forwards.filter((f) => f.status === 'ready')
    if (suspect.length === 0) return // the socket heuristic already caught it

    this.channelFailureSeen = true
    const reason = failures[0]!.replace(/^channel \d+: open failed: /, '').trim()
    for (const f of suspect) {
      f.detail = `ssh reported a channel failure while probing (${reason}); this forward may not be reachable`
    }
  }

  /**
   * Keep looking for channel failures after startup has reported.
   *
   * The evidence is often late: when the far side is filtered or blackholed rather than
   * actively refusing, the remote `connect()` stays pending, our socket stays open, the
   * settle timer wins, and `ready` is reported — and only later, when that connect finally
   * gives up, does ssh log `channel N: open failed`. A single scan at probe time therefore
   * runs before the proof exists, which is precisely the dangerous direction.
   *
   * So we keep watching for as long as the session lives. This cannot repair the initial
   * verdict, but it stops mirrorball continuing to insist a dead forward is `ready`.
   */
  private watchForLateChannelFailures(): void {
    let seen = this.proc?.stderr.length ?? 0
    const tick = setInterval(() => {
      if (this.ended) return clearInterval(tick)
      const stderr = this.proc?.stderr ?? ''
      // The tail is capped, so it can rotate under us; a shrink means restart from the end.
      if (stderr.length < seen) seen = stderr.length
      const fresh = stderr.slice(seen)
      seen = stderr.length
      if (!/channel \d+: open failed/.test(fresh)) return

      if (!this.channelFailureSeen) {
        this.channelFailureSeen = true
        this._status = 'degraded'
        this.emit({
          event: 'forward.error',
          ts: nowIso(),
          localPort: this._forwards[0]?.localPort ?? 0,
          code: 'REMOTE_REFUSED',
          message: 'ssh reported a channel failure after startup; a forward reported ready may not be reachable'
        })
      }
    }, LATE_FAILURE_POLL_MS)
    tick.unref?.()
    this.lateFailureTimer = tick
  }

  private async terminate(): Promise<void> {
    const proc = this.proc
    if (!proc) return

    proc.kill('SIGTERM')
    const killer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // Already gone between the timer firing and the signal landing.
      }
    }, this.killGraceMs)

    try {
      await proc.exited
    } finally {
      clearTimeout(killer)
    }
  }

  /** Record the failure first, then tear down: the exit record must name the real cause. */
  private async failWith(error: MirbError): Promise<void> {
    this.failure ??= error
    if (this.proc && !this.ended) await this.terminate()
    this.finish({ code: error.exitCode, reason: error.message, requested: false, error })
  }

  private onProcessExit(code: number): void {
    this.processExited = true
    // `failure` wins over stderr: when mirb gave up first (bind timeout, Ctrl-C during
    // startup) ssh's parting words describe the kill, not the reason for it.
    const error = this.failure ?? (this.stopping ? undefined : classifySshStderr(this.proc?.stderr ?? '', { processExited: true }))
    const requested = this.stopping && this.failure === undefined

    this.finish({
      code,
      requested,
      error,
      reason: requested ? 'stopped' : (error?.message ?? `ssh exited with status ${code}`)
    })
  }

  /** Idempotent: several paths race to end a session, and they must agree on one record. */
  private finish(exit: SessionExit): void {
    if (this.ended) return
    this.ended = true
    this._status = exit.requested ? 'stopped' : 'failed'
    this.control.abort()
    this.detachSignal()
    if (this.lateFailureTimer) clearInterval(this.lateFailureTimer)

    if (this.announced) {
      this.emit({ event: 'session.exit', ts: nowIso(), id: this.id, code: exit.code, reason: exit.reason })
    }
    this.resolveExit(exit)
  }
}
