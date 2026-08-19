import type { MirbErrorCode } from './types.ts'
import { EXIT } from './types.ts'

/**
 * Every failure users can hit is one of these. Carrying a code (not just a message)
 * is what lets --json consumers branch, and what keeps exit codes honest.
 */
export class MirbError extends Error {
  readonly code: MirbErrorCode
  /** One line telling the user what to actually do about it. */
  readonly hint?: string

  constructor(code: MirbErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'MirbError'
    this.code = code
    this.hint = hint
  }

  get exitCode(): number {
    switch (this.code) {
      case 'USAGE':
      case 'CONFIG':
        return EXIT.USAGE
      case 'PORT_IN_USE':
      case 'PORT_PRIVILEGED':
        return EXIT.PORT_CONFLICT
      case 'SSH_AUTH':
      case 'SSH_CONNECT':
      case 'NO_SSH':
        return EXIT.SSH
      case 'REMOTE_REFUSED':
        return EXIT.REMOTE_REFUSED
      default:
        return EXIT.GENERIC
    }
  }

  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint }
  }
}

/**
 * Map ssh's stderr onto a typed error.
 *
 * Classification is load-bearing, not a convenience: ssh exits 255 for EVERY failure it
 * owns — bind conflict, auth, DNS, refused, malformed -L, privileged port — and reserves
 * other codes for relaying a remote command's exit status. With `-N` there is no remote
 * command, so 255 is the only failure code we will ever see. Verified against
 * OpenSSH_10.2p1. There is no shortcut via exit codes; this function is the only thing
 * standing between a user and "ssh failed, good luck".
 *
 * Readiness is never inferred from stderr (see docs/explanation/design-decisions.md) —
 * this only explains a failure that already happened.
 *
 * ORDER IS LOad-BEARING. The generic branches contain substrings that also appear inside
 * the specific ones, so a specific branch placed after its generic counterpart is dead
 * code that never fires:
 *   "bind [::1]:1023: Permission denied"  contains "permission denied"
 *   "open failed: connect failed: Connection refused" contains "connection refused"
 * Both cases are covered by tests using those exact strings; do not reorder without them.
 */
export interface ClassifyOptions {
  /**
   * Set when classifying why the ssh PROCESS died.
   *
   * `channel N: open failed` is non-fatal — ssh logs it and keeps running — so it can never
   * be the reason for an exit. But stderr is cumulative: a probe that failed hours earlier
   * leaves that line in the tail, and it would otherwise win over the real cause and report
   * a connection timeout as REMOTE_REFUSED with "nothing is listening".
   */
  processExited?: boolean
}

export function classifySshStderr(stderr: string, opts: ClassifyOptions = {}): MirbError {
  const s = stderr.toLowerCase()

  // ── 1. Local bind/listen failures ───────────────────────────────────────────
  // Must precede the generic auth/connect branches. ssh reports these as a trio:
  //   bind [127.0.0.1]:45981: Address already in use
  //   channel_setup_fwd_listener_tcpip: cannot listen to port: 45981
  //   Could not request local forwarding.
  const isBindFailure =
    s.includes('cannot listen to port') ||
    s.includes('could not request local forwarding') ||
    /^bind \[/m.test(s)

  if (isBindFailure) {
    const port = stderr.match(/cannot listen to port:\s*(\d+)/)?.[1]
    const where = port ? `port ${port}` : 'a local port'

    // A privileged port (<1024) fails with "Permission denied" on the *bind* line, which
    // has nothing to do with SSH authentication.
    if (s.includes('permission denied')) {
      return new MirbError(
        'PORT_PRIVILEGED',
        `not permitted to bind ${where}`,
        'Ports below 1024 need elevated privileges. Use a higher local port, e.g. 8080:80.'
      )
    }
    return new MirbError(
      'PORT_IN_USE',
      `could not bind ${where}: already in use`,
      'Something else is listening there. Free it, pick another local port, or pass --auto-port.'
    )
  }

  // ── 2. Channel open failures — the remote side refused ──────────────────────
  // Match on "open failed:" plus the reason token ONLY. Verified against OpenSSH_10.2p1:
  // the channel number varies with how many channels the session has opened, and the text
  // after the reason is the REMOTE's errno string, which differs by platform
  // (macOS: "nodename nor servname provided, or not known"; Linux differs). Anchoring on
  // either would make this flaky across machines.
  // This line is non-fatal — ssh stays alive — so it is a per-forward signal, not session death.
  if (!opts.processExited && (/channel \d+: open failed/.test(s) || s.includes('open failed:'))) {
    if (s.includes('administratively prohibited')) {
      return new MirbError(
        'REMOTE_REFUSED',
        'the remote host refused to open the forward',
        'sshd may have AllowTcpForwarding disabled, or a policy is blocking it.'
      )
    }
    return new MirbError(
      'REMOTE_REFUSED',
      'nothing is listening on the remote side',
      'The tunnel is fine — the service on the remote host is not accepting connections.'
    )
  }

  // ── 3. Authentication and host identity ─────────────────────────────────────
  if (s.includes('too many authentication failures')) {
    return new MirbError('SSH_AUTH', 'too many authentication failures', 'Try -i <key> to offer a single identity.')
  }
  if (s.includes('host key verification failed')) {
    return new MirbError('SSH_AUTH', 'host key verification failed', 'Reconcile ~/.ssh/known_hosts, then retry.')
  }
  if (s.includes('permission denied')) {
    return new MirbError('SSH_AUTH', 'ssh authentication failed', 'Check your key or agent: ssh -v <host>')
  }

  // ── 4. Reaching the host at all ─────────────────────────────────────────────
  if (s.includes('could not resolve hostname')) {
    return new MirbError('SSH_CONNECT', 'could not resolve hostname', 'Check the host name or your DNS.')
  }
  if (s.includes('connection refused')) {
    return new MirbError('SSH_CONNECT', 'connection refused by the remote host', 'Is sshd running and reachable on that port?')
  }
  if (s.includes('connection timed out') || s.includes('operation timed out')) {
    return new MirbError('SSH_CONNECT', 'connection timed out', 'Check network reachability, or raise --timeout.')
  }

  // ── 5. Fallback: surface ssh's own last word rather than inventing one ──────
  const firstRealLine = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('debug'))
    .pop()

  return new MirbError('SSH_CONNECT', firstRealLine || 'ssh exited unexpectedly')
}
