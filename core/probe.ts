import net from 'node:net'
import type { Forward } from './types.ts'

/**
 * Ground truth for "is this tunnel actually usable?".
 *
 * Everything here is a real TCP connection to the *local* end of a forward. mirb never
 * infers readiness from `ssh -v` stderr, because that text is not an interface: it changes
 * between OpenSSH releases, it can be localised, and `debug1: Local forwarding listening`
 * is printed around — not exactly at — the moment the listener starts accepting. A connect
 * that succeeds is the only signal that means precisely what it says.
 *
 * The two functions here are the two halves of the three-state model:
 * `waitForBind` decides `pending -> bound`, `probeRemote` decides `bound -> ready|refused`.
 */

/** Fast enough that a local bind feels instantaneous, slow enough not to spin a core. */
const BIND_POLL_INTERVAL_MS = 50

/**
 * A connect to a loopback port either completes or is refused within a round trip. This
 * cap only exists so a pathological case (a firewall dropping SYNs to a local port) can't
 * swallow the entire bind budget in a single attempt.
 */
const CONNECT_ATTEMPT_TIMEOUT_MS = 1_000

const DEFAULT_PROBE_TIMEOUT_MS = 3_000

/**
 * How long a probe connection must survive to count as `ready`. See `probeRemote` for why
 * this is a duration and not an event.
 */
/**
 * How long a socket must stay open before we call the forward `ready`.
 *
 * MEASURED, not guessed: refusal latency — the time from our local connect to ssh closing
 * the socket after a channel-open failure — is ~3x the round-trip time to the remote.
 * Six runs over two very different paths agreed, and fixed overhead was sub-millisecond:
 *     loopback   (RTT 0.098ms) -> 0.32-0.85 ms
 *     github.com (RTT 32.9ms)  -> 103-105 ms
 *
 * So this constant is really an RTT budget: we misreport a dead service as `ready` once
 * 3 x RTT exceeds it. At the old value of 250ms that boundary was ~83ms RTT — inside
 * US coast-to-coast, but failing on every single probe for a transatlantic hop, and worse
 * through a -J bastion chain where it compounds per hop.
 *
 * 750ms covers RTT up to ~250ms, which is essentially everywhere terrestrial. We buy the
 * margin because the failure is asymmetric: exceeding the budget reports a DEAD service as
 * healthy, which is the dangerous direction. The opposite error would merely be annoying.
 *
 * Lowering this is a deliberate act — test/probe.test.ts pins it.
 */
const DEFAULT_PROBE_SETTLE_MS = 750

/**
 * Turn an ssh bind address into one we can connect *to*.
 *
 * `*` and `0.0.0.0` mean "every interface" on the listening side; there is no connecting
 * to them, so we take the loopback that every one of those listeners also covers. Same
 * story for `::`. (`core/ports.ts` needs the mirror image of this mapping for its bind
 * probe; the two are deliberately separate because they answer opposite questions.)
 */
function connectHost(bindAddress: string): string {
  if (!bindAddress || bindAddress === '*' || bindAddress === '0.0.0.0' || bindAddress === 'localhost') {
    return '127.0.0.1'
  }
  if (bindAddress === '::' || bindAddress === '[::]') return '::1'
  return bindAddress.replace(/^\[|\]$/g, '')
}

/**
 * A sleep that wakes early when the session is torn down.
 *
 * It lives in this module rather than a utility one because probing is the lowest layer of
 * the runtime; the supervisor's backoff wait imports it from here so that a Ctrl-C during a
 * 30-second backoff is instant instead of eventually.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** One connect attempt. Resolves true only if the socket actually reached ESTABLISHED. */
function tryConnect(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ port, host })

    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Destroy rather than end: this connection exists only to ask a question, and a
      // half-open close would leave the forward holding a channel we are done with.
      socket.destroy()
      resolve(ok)
    }

    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

export interface WaitForBindOptions {
  /** Total budget across all attempts. */
  timeoutMs: number
  /** Aborting resolves `false` immediately; it is a cancellation, not a verdict. */
  signal?: AbortSignal
  intervalMs?: number
}

/**
 * Poll until the local end of a forward accepts a connection.
 *
 * This is *the* readiness signal for `pending -> bound`. ssh binds its listeners after
 * authentication and (with several `-L` flags) not necessarily all at once, so polling —
 * rather than waiting a fixed time and hoping — is what makes `mirb` report a usable tunnel
 * the instant it is usable.
 *
 * Returns false on timeout or abort. It never throws: the caller already knows which
 * forward it asked about and can say something far more useful than a socket error could.
 */
export async function waitForBind(
  port: number,
  host: string,
  opts: WaitForBindOptions
): Promise<boolean> {
  const interval = opts.intervalMs ?? BIND_POLL_INTERVAL_MS
  const target = connectHost(host)
  const deadline = Date.now() + opts.timeoutMs

  for (;;) {
    if (opts.signal?.aborted) return false
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false

    if (await tryConnect(port, target, Math.min(CONNECT_ATTEMPT_TIMEOUT_MS, remaining))) return true
    if (opts.signal?.aborted) return false

    await delay(Math.min(interval, deadline - Date.now()), opts.signal)
  }
}

export interface ProbeOptions {
  /** Hard ceiling for the whole probe. */
  timeoutMs?: number
  /** How long the connection must stay open before we call it `ready`. */
  settleMs?: number
  signal?: AbortSignal
}

/**
 * Decide `ready` vs `refused` by opening exactly one connection through the tunnel.
 *
 * The heuristic, stated honestly: ssh accepts on the local port *before* it knows whether
 * the remote service exists. Only after the local accept does it ask the far sshd to open
 * a channel; if nothing is listening there, sshd answers with a channel-open failure and
 * ssh closes the local socket having sent nothing. So a connection that is closed promptly
 * and silently means `refused`, and one that is still open after `settleMs` means `ready`.
 * Inbound bytes (a banner from SSH, SMTP, Postgres, Redis…) settle it early and positively.
 *
 * Where this is wrong, and we accept it:
 * - A remote service that accepts and then immediately hangs up unprompted — a bare TCP
 *   health check, an IP allow-list rejecting us — reads as `refused`. Arguably that *is*
 *   the more useful answer, but it is not the same thing as "nothing is listening".
 * - On a link slow enough that the channel-open failure takes longer than `settleMs`, the
 *   first report is `ready` and reality arrives a moment later. `settleMs` trades the
 *   startup latency of every healthy forward against accuracy on a very slow hop.
 * - A middlebox that completes the handshake on the service's behalf reads as `ready`.
 *
 * The cost is one throwaway connection per forward, which is why `--no-probe` exists
 * (`SessionOptions.probe`) and not unconditional: some services log or bill for it.
 */
export function probeRemote(forward: Forward, opts: ProbeOptions = {}): Promise<'ready' | 'refused'> {
  const settleMs = opts.settleMs ?? DEFAULT_PROBE_SETTLE_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  // An already-cancelled probe must not open a connection it will never look at.
  if (opts.signal?.aborted) return Promise.resolve('refused')

  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ port: forward.localPort, host: connectHost(forward.bindAddress) })

    let settleTimer: ReturnType<typeof setTimeout> | undefined

    const done = (verdict: 'ready' | 'refused') => {
      if (settled) return
      settled = true
      clearTimeout(overall)
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve(verdict)
    }

    // A cancelled probe has no verdict. 'refused' is the conservative answer, and callers
    // that abort are expected to discard the result rather than report it as fact.
    const onAbort = () => done('refused')

    const overall = setTimeout(() => done('refused'), timeoutMs)

    socket.once('connect', () => {
      settleTimer = setTimeout(() => done('ready'), settleMs)
    })
    socket.once('data', () => done('ready'))
    // 'close' covers the graceful FIN ssh sends after a channel-open failure; 'error'
    // covers the RST some stacks send instead. Both mean the same thing here.
    socket.once('close', () => done('refused'))
    socket.once('error', () => done('refused'))

    opts.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
