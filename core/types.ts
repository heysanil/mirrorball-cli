/**
 * The shared contract every module in mirb agrees on.
 *
 * Modules depend on these types, not on each other's internals. If you find yourself
 * importing a concrete module to get at a type, add the type here instead.
 */

/** A single local -> remote forward, fully resolved and ready to hand to ssh. */
export interface Forward {
  /** Port bound on this machine. */
  localPort: number
  /** Address bound on this machine. Defaults to 127.0.0.1. */
  bindAddress: string
  /**
   * Host the remote sshd connects onward to, from *its* point of view.
   * 'localhost' for the common case; a third host for bastion hops.
   */
  remoteHost: string
  /** Port on remoteHost. */
  remotePort: number
  /** The argument the user typed that produced this forward, for error messages. */
  source: string
}

/** Lifecycle of one forward. The three-state readiness model is the point of mirb. */
export type ForwardStatus =
  | 'pending'    // not yet attempted
  | 'bound'      // local socket accepts connections; tunnel believed up
  | 'ready'      // probe reached the remote service
  | 'refused'    // tunnel up, but remote service refused the probe
  | 'failed'     // could not bind or forward at all

export interface ForwardState extends Forward {
  status: ForwardStatus
  /** Populated when status is 'failed' or 'refused'. */
  detail?: string
}

/** Where to connect, and how. Everything here maps onto ssh argv. */
export interface Target {
  /** Host or ssh_config alias, exactly as ssh should receive it. */
  host: string
  /** Optional user. undefined means "let ssh decide". */
  user?: string
  /** Optional port. undefined means "let ssh decide" (config Port, else 22). */
  port?: number
  /** The original string the user typed. */
  raw: string
}

export type SessionStatus =
  | 'starting'
  | 'connecting'
  | 'ready'
  | 'degraded'      // up, but at least one forward is refused/failed
  | 'reconnecting'
  | 'stopped'
  | 'failed'

/** Options that shape one forwarding session. */
export interface SessionOptions {
  target: Target
  forwards: Forward[]
  /** Human label, for `mirb ls`. */
  name?: string
  /** ssh ConnectTimeout, seconds. */
  timeout: number
  /** Probe the remote service after binding. */
  probe: boolean
  /**
   * How long a probed socket must stay open before the forward counts as `ready`, in ms.
   * Undefined uses the default. Raise it on high-latency links: refusal costs ~3x RTT, so
   * past roughly 250ms RTT a dead service can still read as healthy.
   */
  probeSettleMs?: number
  /** Max reconnect attempts. undefined = unlimited, 0 = never retry. */
  retry?: number
  /** Extra `-o key=value` passed straight through to ssh. */
  sshOptions: string[]
  /** `-i` identity file. */
  identity?: string
  /** `-J` jump host. */
  jump?: string
  /** Path to the ssh binary. Injectable for tests via $MIRB_SSH. */
  sshPath: string
  /** Force BatchMode (no interactive prompts). Implied by background/non-TTY. */
  batch: boolean
}

/** Persisted record of a background session. Written atomically, zod-validated on read. */
export interface SessionRecord {
  /** `mb_` + 13-char lowercase alphanumeric nanoid. */
  id: string
  name?: string
  /** pid of the mirb supervisor, not of ssh. */
  pid: number
  status: SessionStatus
  target: Target
  forwards: ForwardState[]
  /** ISO-8601. */
  startedAt: string
  /** ISO-8601, set when the supervisor stops. */
  stoppedAt?: string
  reconnects: number
  /** Absolute path to this session's log file. */
  logFile: string
  /** The exact argv handed to ssh, for `mirb logs` and debugging. */
  sshArgv: string[]
}

/** Streaming NDJSON events emitted in machine mode. */
export type MirbEvent =
  | { event: 'session.start'; ts: string; id: string; target: Target; forwards: Forward[] }
  | { event: 'forward.bound'; ts: string; localPort: number }
  | { event: 'forward.ready'; ts: string; localPort: number }
  | { event: 'forward.error'; ts: string; localPort: number; code: MirbErrorCode; message: string }
  | { event: 'session.ready'; ts: string; id: string; ready: number; total: number }
  | { event: 'session.reconnecting'; ts: string; attempt: number; delayMs: number }
  | { event: 'session.exit'; ts: string; id: string; code: number; reason: string }

export type MirbErrorCode =
  | 'USAGE'            // bad arguments
  | 'PORT_IN_USE'      // local port already bound
  | 'PORT_PRIVILEGED'  // local port < 1024 without permission
  | 'SSH_AUTH'         // permission denied / host key
  | 'SSH_CONNECT'      // dns / refused / timeout
  | 'REMOTE_REFUSED'   // tunnel fine, remote service is not listening
  | 'NO_SSH'           // ssh binary not found
  | 'SESSION_NOT_FOUND'
  | 'CONFIG'           // malformed config.toml
  | 'INTERNAL'

/** Process exit codes. Stable, documented in docs/reference/exit-codes.md. */
export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  SSH: 3,
  PORT_CONFLICT: 4,
  REMOTE_REFUSED: 5,
  SIGINT: 130
} as const

/** A named profile from config.toml. */
export interface Profile {
  host: string
  ports: (string | number)[]
  name?: string
  identity?: string
  jump?: string
  bind?: string
}

export interface MirbConfig {
  profiles: Record<string, Profile>
}
