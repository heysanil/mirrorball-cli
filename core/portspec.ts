import { MirbError } from './errors.ts'
import type { Forward } from './types.ts'

/**
 * Ports run 1-65535. Zero is excluded on purpose: to the kernel it means "pick any free
 * port", and mirb would then have nothing honest to print in the ready line.
 */
const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * Upper bound on how many forwards a single range may expand to.
 *
 * Each forward becomes its own `-L` argument and its own listening socket, so
 * `mirb host 1-65535` is never a real request — it is a typo or a port scan. Failing
 * immediately with a countable number beats spawning an ssh with 65k arguments and
 * watching the kernel refuse the 1024th bind.
 */
export const MAX_RANGE_PORTS = 256
/** Ceiling across ALL specs in one invocation, not per range. */
export const MAX_TOTAL_FORWARDS = 256

/** Loopback, so a forward is never accidentally published to the local network. */
export const DEFAULT_BIND_ADDRESS = '127.0.0.1'

/** The overwhelmingly common case: the service lives on the ssh host itself. */
const DEFAULT_REMOTE_HOST = 'localhost'

export interface PortSpecOptions {
  /** Address every forward binds on this machine. Comes from `--bind`. */
  bindAddress: string
}

const GRAMMAR_HINT =
  'Write PORT, LOCAL:REMOTE, or LOCAL:HOST:REMOTE — e.g. 3000, 8080:80, 8080:db.internal:5432.'
const IPV6_HINT = 'IPv6 literals must be bracketed: 8080:[::1]:5432.'
const RANGE_HINT = 'A range is START-END, e.g. 3000-3005.'
const RANGE_ORDER_HINT = 'Write ranges low-to-high, e.g. 3000-3005.'

/**
 * Parse one port argument into the forwards it stands for.
 *
 * The grammar is deliberately a strict subset of ssh's own `-L` grammar:
 *
 *   3000                  -> localhost:3000  <- remote localhost:3000
 *   8080:80               -> localhost:8080  <- remote localhost:80
 *   8080:db.internal:5432 -> localhost:8080  <- db.internal:5432, reached from the ssh host
 *   3000-3005             -> six same-port forwards
 *   8000-8005:9000-9005   -> paired ranges, zipped in order
 *
 * ssh also allows a leading bind address (`[bind:]port:host:hostport`), which makes
 * `0.0.0.0:8080:80` and `8080:db:5432` impossible to tell apart without resolving the
 * middle field. mirb refuses that ambiguity: the bind address lives on `--bind`, and the
 * first field is always a port.
 */
export function parsePortSpec(spec: string, opts: PortSpecOptions): Forward[] {
  const source = spec.trim()
  if (source.length === 0) {
    throw new MirbError('USAGE', 'empty port specification', GRAMMAR_HINT)
  }

  const fields = splitFields(source)
  if (fields.length > 3) {
    throw new MirbError(
      'USAGE',
      `'${source}' has ${fields.length} colon-separated parts; expected at most 3`,
      source.includes('::') ? IPV6_HINT : GRAMMAR_HINT
    )
  }

  const localText = (fields[0] ?? '').trim()
  const hostText = fields.length === 3 ? fields[1] : undefined
  const remoteText = fields.length === 1 ? localText : (fields[fields.length - 1] ?? '').trim()

  const remoteHost = hostText === undefined ? DEFAULT_REMOTE_HOST : parseHost(hostText, source)

  const localPorts = parsePortRange(localText, source, 'local')
  // A bare `3000` means both sides, so reuse the parse rather than re-deriving it.
  const remotePorts = fields.length === 1 ? localPorts : parsePortRange(remoteText, source, 'remote')

  if (localPorts.length !== remotePorts.length) {
    throw new MirbError(
      'USAGE',
      `'${source}' pairs ranges of different sizes: ` +
        `${localText} spans ${localPorts.length} ports but ${remoteText} spans ${remotePorts.length}`,
      'Paired ranges are zipped in order, so both sides must be the same length.'
    )
  }

  const bindAddress = opts.bindAddress.trim() || DEFAULT_BIND_ADDRESS

  return localPorts.map((localPort, i) => ({
    localPort,
    bindAddress,
    remoteHost,
    remotePort: remotePorts[i]!,
    source
  }))
}

/**
 * Parse every port argument, in the order the user typed them.
 *
 * Duplicate local ports are rejected here rather than at bind time: `ExitOnForwardFailure`
 * would turn the second bind into an opaque ssh failure, and the user would have to work
 * out for themselves which two of their arguments collided.
 */
export function parsePortSpecs(specs: string[], opts: PortSpecOptions): Forward[] {
  if (specs.length === 0) {
    throw new MirbError('USAGE', 'no ports given', 'Name at least one port: mirb <host> 3000')
  }

  const forwards: Forward[] = []
  const claimedBy = new Map<number, string>()

  for (const spec of specs) {
    for (const forward of parsePortSpec(spec, opts)) {
      const prior = claimedBy.get(forward.localPort)
      if (prior !== undefined) {
        const message =
          prior === forward.source
            ? `'${forward.source}' is listed twice; local port ${forward.localPort} can only be bound once`
            : `local port ${forward.localPort} is claimed by both '${prior}' and '${forward.source}'`
        throw new MirbError('USAGE', message, 'Drop one of them, or move it to a free local port.')
      }
      claimedBy.set(forward.localPort, forward.source)
      forwards.push(forward)

      // The cap has to be GLOBAL, not per-range: `1000-1255 2000-2255` is two legal ranges
      // and 512 forwards, and 257 bare ports slip through a per-range check entirely. The
      // point of the limit is to bound the argv and the socket count mirb hands to ssh, and
      // neither cares how the user spelled it.
      if (forwards.length > MAX_TOTAL_FORWARDS) {
        throw new MirbError(
          'USAGE',
          `that is more than ${MAX_TOTAL_FORWARDS} forwards`,
          'mirb forwards at most 256 ports at once. Split them across separate sessions.'
        )
      }
    }
  }

  return forwards
}

/**
 * Split on `:` while treating a bracketed IPv6 literal as one field.
 *
 * Splitting naively would shred `[::1]` into empty fields and produce an error message
 * about "5 colon-separated parts" for a perfectly ordinary address.
 */
function splitFields(spec: string): string[] {
  const fields: string[] = []
  let current = ''
  let depth = 0

  for (const ch of spec) {
    if (ch === '[') {
      depth += 1
      current += ch
    } else if (ch === ']') {
      depth -= 1
      if (depth < 0) {
        throw new MirbError('USAGE', `unbalanced ']' in '${spec}'`, IPV6_HINT)
      }
      current += ch
    } else if (ch === ':' && depth === 0) {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }

  if (depth > 0) {
    throw new MirbError('USAGE', `unbalanced '[' in '${spec}'`, IPV6_HINT)
  }
  fields.push(current)
  return fields
}

/**
 * Validate the middle field.
 *
 * IPv6 literals keep their brackets: that is the form OpenSSH's `-L` grammar requires,
 * and stripping them would silently produce `8080:::1:5432` downstream.
 */
function parseHost(text: string, spec: string): string {
  const host = text.trim()

  if (host.length === 0) {
    throw new MirbError('USAGE', `'${spec}' has an empty host field`, GRAMMAR_HINT)
  }
  if (/\s/.test(host)) {
    throw new MirbError('USAGE', `host '${host}' in '${spec}' contains whitespace`, GRAMMAR_HINT)
  }

  if (host.startsWith('[')) {
    if (!host.endsWith(']')) {
      throw new MirbError('USAGE', `malformed bracketed host '${host}' in '${spec}'`, IPV6_HINT)
    }
    const inner = host.slice(1, -1)
    if (inner.length === 0) {
      throw new MirbError('USAGE', `empty bracketed host in '${spec}'`, IPV6_HINT)
    }
    if (!inner.includes(':')) {
      throw new MirbError(
        'USAGE',
        `'${host}' in '${spec}' is bracketed but is not an IPv6 address`,
        'Brackets are only for IPv6 literals; write host names without them.'
      )
    }
    // `[[::1]]` would otherwise sail through — it starts with '[', ends with ']', and its
    // inner text contains a colon — and become `-L 127.0.0.1:8080:[[::1]]:5432`, which ssh
    // rejects with "Bad local forwarding specification". A pure input error should be caught
    // as a usage error here, not surface later as an ssh failure the user has to decode.
    if (/[[\]]/.test(inner)) {
      throw new MirbError('USAGE', `malformed bracketed host '${host}' in '${spec}'`, IPV6_HINT)
    }
    // Hex groups, separators, an embedded IPv4 tail, and an optional zone id. Anything else
    // is not an address, whatever the brackets suggest.
    if (!/^[0-9a-fA-F:.]+(%[0-9a-zA-Z._-]+)?$/.test(inner)) {
      throw new MirbError('USAGE', `'${host}' in '${spec}' is not a valid IPv6 literal`, IPV6_HINT)
    }
    return host
  }

  if (host.endsWith(']')) {
    throw new MirbError('USAGE', `malformed bracketed host '${host}' in '${spec}'`, IPV6_HINT)
  }
  return host
}

/** Expand `3000` to [3000] and `3000-3005` to the six ports it names. */
function parsePortRange(text: string, spec: string, side: 'local' | 'remote'): number[] {
  const range = text.trim()
  if (range.length === 0) {
    throw new MirbError('USAGE', `'${spec}' has an empty ${side} port`, GRAMMAR_HINT)
  }

  const dash = range.indexOf('-')
  if (dash === -1) return [parsePort(range, spec, side)]

  const startText = range.slice(0, dash).trim()
  const endText = range.slice(dash + 1).trim()
  if (startText.length === 0 || endText.length === 0 || endText.includes('-')) {
    throw new MirbError('USAGE', `'${range}' in '${spec}' is not a valid port range`, RANGE_HINT)
  }

  const start = parsePort(startText, spec, side)
  const end = parsePort(endText, spec, side)
  if (end < start) {
    throw new MirbError(
      'USAGE',
      `range ${range} in '${spec}' ends before it starts (${start} > ${end})`,
      RANGE_ORDER_HINT
    )
  }

  // Count before allocating, so `1-65535` costs nothing to reject.
  const span = end - start + 1
  if (span > MAX_RANGE_PORTS) {
    throw new MirbError(
      'USAGE',
      `range ${range} in '${spec}' spans ${span} ports; mirb forwards at most ${MAX_RANGE_PORTS} at once`,
      'Narrow the range, or list the ports you actually need.'
    )
  }

  return Array.from({ length: span }, (_, i) => start + i)
}

function parsePort(text: string, spec: string, side: 'local' | 'remote'): number {
  if (!/^\d+$/.test(text)) {
    throw new MirbError(
      'USAGE',
      `'${text}' in '${spec}' is not a port number`,
      side === 'local'
        ? 'The first field is always a port. To change the bind address use --bind.'
        : GRAMMAR_HINT
    )
  }

  const port = Number(text)
  if (port < MIN_PORT || port > MAX_PORT) {
    throw new MirbError(
      'USAGE',
      `port ${port} in '${spec}' is out of range (${MIN_PORT}-${MAX_PORT})`,
      port === 0 ? 'Port 0 means "any free port", which mirb cannot report back.' : undefined
    )
  }
  return port
}
