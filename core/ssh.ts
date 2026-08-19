import type { Forward, SessionOptions } from './types.ts'
import { targetToSshArg } from './target.ts'
import { MirbError } from './errors.ts'

/**
 * Everything that turns mirb's intent into an actual `ssh` process.
 *
 * `buildSshArgs` is deliberately pure and I/O-free: argv is the one place where a
 * one-character mistake silently produces a half-working tunnel, so it has to be
 * snapshot-testable without a network, a host, or a binary.
 */

/** ssh drops the connection after 3 missed 15s keepalives, so a dead link surfaces in ~45s. */
const SERVER_ALIVE_INTERVAL = 15
const SERVER_ALIVE_COUNT_MAX = 3

/**
 * Only the tail of stderr is worth keeping: `classifySshStderr` matches on the failure,
 * which is always the last thing ssh says. Capping also stops a chatty `-o LogLevel=DEBUG3`
 * session from growing an unbounded string in a long-lived supervisor.
 */
const STDERR_CAP_BYTES = 64 * 1024

/**
 * A ProxyCommand/ProxyJump helper can inherit ssh's stderr and outlive it, holding the pipe
 * open. We wait this long for a clean drain, then report the exit anyway.
 */
const STDERR_DRAIN_GRACE_MS = 250

/** The handle `spawnSsh` returns. Deliberately smaller than Bun's Subprocess. */
export interface SshProcess {
  /** OS pid of the ssh process itself (not of the mirb supervisor). */
  readonly pid: number
  /**
   * Resolves with ssh's exit status (128+signal when killed), *after* stderr has been
   * drained — so `classifySshStderr(proc.stderr)` is meaningful the moment this settles.
   */
  readonly exited: Promise<number>
  /**
   * True the instant the OS process is gone, without waiting for stderr to drain.
   * Readiness checks must use this rather than racing `exited`, which lags deliberately.
   */
  readonly hasExited: boolean
  /** Everything ssh has written to stderr so far, truncated to the last 64 KiB. */
  readonly stderr: string
  kill(signal?: NodeJS.Signals | number): void
}

/**
 * ssh needs `[::1]` rather than `::1` inside a `-L` spec, since the spec is colon-delimited.
 * Applied to both halves: a bind address can be an IPv6 literal too.
 */
function bracketIfIpv6(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** `-L bind:localPort:remoteHost:remotePort` — always with an explicit bind address. */
function forwardSpec(f: Forward): string {
  return `${bracketIfIpv6(f.bindAddress)}:${f.localPort}:${bracketIfIpv6(f.remoteHost)}:${f.remotePort}`
}

/**
 * Build the argv for ssh, excluding the binary itself (that is `opts.sshPath`).
 *
 * The order is fixed and covered by snapshot tests. ssh does not care about order, but a
 * stable one makes `mirb logs` diffable and makes an accidental reordering show up as a
 * failing test rather than as a mystery in the field.
 *
 * Two flags are load-bearing rather than cosmetic:
 * - `ExitOnForwardFailure=yes`: without it ssh keeps running when one of several `-L` binds
 *   fails, leaving a half-working tunnel that exits 0. mirb's whole promise depends on a
 *   failed bind being a failed session.
 * - `-N -T`: no remote command, no pty. mirrorball is a forwarder, never a shell.
 *
 * `BatchMode` is conditional on purpose: forcing it always would break passphrase and 2FA
 * prompts in the foreground, which is the common interactive case.
 */
export function buildSshArgs(opts: SessionOptions): string[] {
  const args: string[] = ['-N', '-T']

  args.push('-o', 'ExitOnForwardFailure=yes')
  args.push('-o', `ServerAliveInterval=${SERVER_ALIVE_INTERVAL}`)
  args.push('-o', `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`)
  // ssh parses ConnectTimeout as an integer number of seconds; a fractional or zero value
  // is rejected outright, so clamp rather than hand ssh something it will refuse.
  args.push('-o', `ConnectTimeout=${Math.max(1, Math.round(opts.timeout))}`)

  if (opts.batch) args.push('-o', 'BatchMode=yes')

  for (const f of opts.forwards) args.push('-L', forwardSpec(f))

  if (opts.target.port !== undefined) args.push('-p', String(opts.target.port))
  if (opts.identity) args.push('-i', opts.identity)
  if (opts.jump) args.push('-J', opts.jump)

  // User `-o`s come last, which means mirb's own values win: ssh uses the *first* value it
  // obtains for a keyword. That is deliberate — ExitOnForwardFailure is not negotiable, and
  // a user who silently disabled it would get back exactly the half-working tunnel mirb
  // exists to prevent. Their options still override everything in ssh_config.
  for (const o of opts.sshOptions) args.push('-o', o)

  args.push(opts.target.user ? `${opts.target.user}@${opts.target.host}` : opts.target.host)

  return args
}

/**
 * Find the ssh binary.
 *
 * `$MIRB_SSH` comes first: it is both a user affordance (a newer OpenSSH from Homebrew,
 * say) and the seam the integration tests use to substitute a fake ssh. It is resolved
 * through the same executability check as a PATH lookup so a stale override fails loudly
 * here instead of as a confusing spawn error later.
 *
 * `env` is a parameter rather than a read of `process.env` so the lookup is testable; its
 * PATH is honoured exactly, with no fallback to the ambient one.
 */
export function resolveSshPath(env: Record<string, string | undefined>): string {
  const override = env.MIRB_SSH?.trim()
  const path = env.PATH ?? ''

  if (override) {
    const resolved = Bun.which(override, { PATH: path })
    if (resolved) return resolved
    throw new MirbError(
      'NO_SSH',
      `$MIRB_SSH points at '${override}', which is not an executable`,
      'Unset MIRB_SSH to use the ssh on your PATH.'
    )
  }

  const found = Bun.which('ssh', { PATH: path })
  if (found) return found

  throw new MirbError(
    'NO_SSH',
    'no ssh binary found on PATH',
    'Install OpenSSH, or point mirb at one with MIRB_SSH=/path/to/ssh.'
  )
}

/** Keeps the last N bytes of a byte stream as text, decoded incrementally. */
class StderrTail {
  private text = ''
  private readonly decoder = new TextDecoder()

  constructor(private readonly cap: number) {}

  push(chunk: Uint8Array): void {
    // stream:true so a multi-byte sequence split across chunks does not decode to U+FFFD.
    this.text += this.decoder.decode(chunk, { stream: true })
    if (this.text.length > this.cap) this.text = this.text.slice(-this.cap)
  }

  get value(): string {
    return this.text
  }
}

/**
 * Spawn ssh with the argv from `buildSshArgs`.
 *
 * stdio is asymmetric on purpose:
 * - stdin is inherited in the foreground so ssh can prompt for a passphrase, a 2FA code or
 *   a host-key confirmation. In batch mode nothing can be answered, so it is closed off.
 * - stdout is ignored; `-N` produces none.
 * - stderr is always piped. It is never used to detect readiness (that is a TCP probe
 *   against the local port), only to *explain* a failure that already happened — which is
 *   exactly the case in backgrounded sessions, so it stays piped there too.
 */
export function spawnSsh(opts: SessionOptions): SshProcess {
  const args = buildSshArgs(opts)

  const proc = Bun.spawn([opts.sshPath, ...args], {
    stdio: [opts.batch ? 'ignore' : 'inherit', 'ignore', 'pipe']
  })

  const tail = new StderrTail(STDERR_CAP_BYTES)
  const drained = (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) tail.push(chunk)
  })().catch(() => {
    // A closed/aborted pipe is not itself a failure; whatever we captured still explains it.
  })

  const exited = proc.exited.then(async (code) => {
    await Promise.race([drained, Bun.sleep(STDERR_DRAIN_GRACE_MS)])
    return code
  })

  // `exited` deliberately waits for stderr to drain so classification has the full text.
  // Readiness must NOT wait for that: during those milliseconds the OS process is already
  // gone, and a squatter holding the port would answer a bind probe and be reported as
  // `forward.bound` for a listener ssh never owned. So expose the raw signal too.
  let hasExited = false
  void proc.exited.then(() => {
    hasExited = true
  })

  return {
    pid: proc.pid,
    exited,
    get hasExited() {
      return hasExited
    },
    get stderr() {
      return tail.value
    },
    kill(signal?: NodeJS.Signals | number) {
      proc.kill(signal)
    }
  }
}


/** One forwarding listener OpenSSH intends to create, as reported by `ssh -G`. */
export interface ConfiguredForwarding {
  kind: 'localforward' | 'dynamicforward' | 'remoteforward'
  bindAddress: string
  raw: string
}

/**
 * Ask ssh what forwarding it will set up from configuration, before we spawn it.
 *
 * `--ssh-option` is refused for forwarding keywords, but `~/.ssh/config` can carry a
 * `LocalForward`/`DynamicForward` under a `Host` or `Match` block, and ssh will honour it.
 * That listener would exist, could bind anywhere, and would appear in no mirb state, no event
 * and no `mirb ls` row — so it could not be found again to stop it. Since the whole claim of
 * this tool is that what it reports is what exists, we have to look.
 *
 * `ssh -G` resolves the full effective configuration and prints it without connecting, so
 * this costs a local subprocess and no network. We deliberately pass everything EXCEPT our
 * own `-L` flags, so anything reported here came from configuration rather than from us.
 *
 * Best-effort by design: if ssh is missing, slow, or speaks an unexpected dialect we return
 * nothing rather than blocking a legitimate session on a diagnostic.
 */
export async function inspectConfiguredForwardings(
  opts: SessionOptions
): Promise<ConfiguredForwarding[]> {
  const args = ['-G']
  if (opts.target.port !== undefined) args.push('-p', String(opts.target.port))
  if (opts.identity) args.push('-i', opts.identity)
  if (opts.jump) args.push('-J', opts.jump)
  for (const o of opts.sshOptions) args.push('-o', o)
  args.push(targetToSshArg(opts.target))

  try {
    const proc = Bun.spawn([opts.sshPath, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    const text = await new Response(proc.stdout).text()
    await proc.exited

    const found: ConfiguredForwarding[] = []
    for (const line of text.split('\n')) {
      const m = /^(localforward|dynamicforward|remoteforward)\s+(\S+)/i.exec(line.trim())
      if (!m) continue
      const spec = m[2] ?? ''
      // `-G` prints addresses bracketed: "[0.0.0.0]:49000". A bare "49000" means loopback.
      const bind = /^\[([^\]]*)\]:/.exec(spec)?.[1] ?? '127.0.0.1'
      found.push({
        kind: m[1]!.toLowerCase() as ConfiguredForwarding['kind'],
        bindAddress: bind,
        raw: line.trim()
      })
    }
    return found
  } catch {
    return []
  }
}
