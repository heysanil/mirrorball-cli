import { MirbError } from './errors.ts'

/**
 * Is this bind address reachable from anywhere other than this machine?
 *
 * This is a SECURITY predicate, not a presentation one, which is why it lives in `core/`
 * and everything else — the CLI gate, the live view's warning banner, the JSON event —
 * delegates to it. Two copies of this rule would eventually disagree, and the direction
 * they disagree in is "silently publish an internal service".
 *
 * Verified against OpenSSH_10.2p1, reaching the forward from a second machine on the LAN:
 *   -L 0.0.0.0:PORT:...  -> bound *:PORT, REACHABLE from 192.168.x.x
 *   -L PORT:...          -> loopback only, NOT reachable
 * Note this happens with no `GatewayPorts` setting involved: contrary to a common belief,
 * GatewayPorts governs `-L` as well as `-R`, and an explicit `0.0.0.0`/`*` bypasses it
 * entirely. So the bind address is the ONLY thing standing between a user and exposure.
 */
/** A dotted-quad in 127.0.0.0/8, and nothing that merely looks like one. */
const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isLoopbackAddress(address: string): boolean {
  const a = address.trim().toLowerCase()

  // Empty means "mirb's default", which is loopback.
  if (a === '' || a === 'localhost') return true
  if (a === '::1' || a === '[::1]') return true

  // Deliberately a full-literal match, never a prefix test. `startsWith('127.')` would
  // accept the HOSTNAME `127.evil.com`, which resolves to whatever its owner chooses —
  // so a forward would publish to the network with no --expose and no warning. This
  // predicate is the only thing standing between a user and exposure (an explicit bind
  // address bypasses GatewayPorts entirely), so it fails CLOSED: anything not provably
  // a loopback literal is treated as exposed.
  const m = IPV4_LOOPBACK.exec(a)
  if (!m) return false
  return m.slice(1).every((oct) => Number(oct) <= 255)
}

/** The inverse, named for what it means rather than what it tests. */
export function isExposedAddress(address: string): boolean {
  return !isLoopbackAddress(address)
}

/**
 * Refuse a non-loopback bind unless the user said so in as many words.
 *
 * Deliberately an error and not a confirmation prompt: mirb must behave identically for a
 * human and for an agent, and a prompt on a non-interactive path is worse than useless
 * here — bunli treats a cancelled prompt as a *graceful* exit 0, so a script would read
 * success and carry on. An explicit flag is unambiguous in both worlds.
 */
export function assertExposureAllowed(address: string, expose: boolean): void {
  if (expose || isLoopbackAddress(address)) return

  throw new MirbError(
    'USAGE',
    `--bind ${address} would publish these forwards beyond this machine`,
    'Anyone who can reach this host on the network could use the tunnel. Pass --expose to confirm.'
  )
}

/** What bare `--expose` means: every interface. */
export const EXPOSED_BIND_ADDRESS = '0.0.0.0'

/**
 * Resolve a user-supplied bind address to the literal mirb will actually use everywhere.
 *
 * `localhost` is the dangerous one and the reason this exists. It is a *name*, so ssh hands
 * it to getaddrinfo() and binds one socket per returned family — the same two-socket
 * behaviour you get by omitting the bind address entirely. That is precisely the case
 * `ExitOnForwardFailure` cannot protect you from: if IPv4 is occupied and IPv6 is not, the
 * IPv6 bind succeeds, ssh does not exit, and you get a live tunnel on ::1 while 127.0.0.1
 * belongs to somebody else. Verified against OpenSSH_10.2p1.
 *
 * It also makes mirb disagree with itself: the pre-flight check and the readiness probe both
 * resolve `localhost` themselves, and on a host where it prefers ::1 they can pick a
 * different socket than ssh bound — so the forward binds and never reports ready.
 *
 * Collapsing it to a literal fixes both at once, and `--bind localhost` keeps meaning what
 * anyone typing it intends. Brackets are stripped because they are ssh's spelling for a
 * colon-delimited spec, not an address.
 */
export function normalizeBindAddress(address: string): string {
  const a = address.trim()
  if (a === '' || a.toLowerCase() === 'localhost') return '127.0.0.1'
  if (a === '*') return EXPOSED_BIND_ADDRESS
  return a.startsWith('[') && a.endsWith(']') ? a.slice(1, -1) : a
}

/**
 * ssh options that create listeners mirrorball does not know about.
 *
 * These are refused in `--ssh-option` rather than passed through. mirb's promise is that the
 * forwards it reports are the forwards that exist, and that nothing binds beyond loopback
 * without `--expose`. A `LocalForward`/`DynamicForward` smuggled through `-o` breaks both at
 * once: OpenSSH creates the listener (verified: `ssh -G -o 'LocalForward=0.0.0.0:49000 …'`
 * yields `localforward [0.0.0.0]:49000 …`), while the port appears in no mirb state, no event,
 * and no `mirb ls` row — so it cannot even be found again to be stopped.
 *
 * `ClearAllForwardings` is refused for the mirror-image reason: it would silently delete the
 * forwards the user actually asked for, leaving mirb reporting a tunnel that carries nothing.
 */
const FORWARDING_KEYWORDS = new Set([
  'localforward',
  'remoteforward',
  'dynamicforward',
  'clearallforwardings'
])

/**
 * Reject `-o` options that would create or destroy forwards behind mirb's back.
 *
 * Everything else is passed straight through — the point of mirrorball is that your ssh setup keeps
 * working — but forwarding itself is the one thing mirb must remain the sole author of.
 */
export function assertSshOptionsSafe(options: readonly string[]): void {
  for (const opt of options) {
    const keyword = sshOptionKeyword(opt)
    if (FORWARDING_KEYWORDS.has(keyword)) {
      throw new MirbError(
        'USAGE',
        `-o ${keyword} is not allowed`,
        'mirrorball owns forwarding so it can report it honestly. Use port arguments instead, e.g. mirb <host> 49000:db.internal:5432.'
      )
    }
  }
}

/**
 * The keyword from an `-o` argument, in either spelling ssh accepts.
 *
 * ssh takes both `LocalForward=9999 localhost:9999` and `LocalForward 9999 localhost:9999`,
 * and an earlier version of this check only split on `=`. The whitespace form therefore
 * passed straight through and created a listener mirrorball knew nothing about — the exact
 * thing the keyword list exists to prevent. Verified against OpenSSH_10.2p1: `ssh -G -o
 * "LocalForward 49000 localhost:5432"` resolves to a real `localforward` entry.
 *
 * Matching the leading identifier covers both, and anything without one cannot name a
 * keyword at all.
 */
function sshOptionKeyword(option: string): string {
  return /^\s*([A-Za-z]+)/.exec(option)?.[1]?.toLowerCase() ?? ''
}
