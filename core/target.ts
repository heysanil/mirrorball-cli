import type { Target } from './types.ts'
import { MirbError } from './errors.ts'

/**
 * Parsing, formatting, and ssh-argv rendering for a connection target.
 *
 * The governing rule: mirrorball does not know what a valid host is, and must not pretend to.
 * `myserver` may be an ssh_config `Host` alias, a /etc/hosts entry, a name a
 * ProxyCommand invents, or a CNAME that only resolves on the VPN. Resolving it is ssh's
 * job — that is the entire reason mirb shells out instead of speaking SSH itself. So we
 * reject only what could not possibly survive the trip to ssh (empty parts, embedded
 * whitespace, ports outside 1..65535) and pass everything else through untouched.
 */

/** `ssh://` is the only scheme that means anything here; the rest are paste accidents. */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i

/**
 * The shortest legal IPv6 literal (`::`) already has two colons, and no `host:port`
 * form can ever have more than one. That asymmetry is the whole disambiguation: it lets
 * us accept an unbracketed `2001:db8::1` without ever misreading `example.com:22`.
 */
function looksLikeBareIpv6(s: string): boolean {
  return (s.match(/:/g)?.length ?? 0) >= 2
}

function parsePort(text: string, raw: string): number {
  if (text.length === 0) {
    throw new MirbError('USAGE', `target '${raw}' ends in ':' with no port`, 'Write user@host:2222, or drop the colon to use ssh_config.')
  }
  // Deliberately not parseInt: '22abc' and '2 2' must fail loudly rather than becoming 22.
  if (!/^\d+$/.test(text)) {
    throw new MirbError('USAGE', `'${text}' is not a port number in target '${raw}'`)
  }
  const port = Number(text)
  if (port < 1 || port > 65535) {
    throw new MirbError('USAGE', `port ${port} is out of range in target '${raw}'`, 'Ports run 1..65535.')
  }
  return port
}

/**
 * Parse an ssh destination: `host`, `user@host`, `user@host:2222`,
 * `ssh://user@host:2222`, `[::1]`, `user@[2001:db8::1]:22`, or a bare ssh_config alias.
 */
export function parseTarget(raw: string): Target {
  if (raw.trim().length === 0) {
    throw new MirbError('USAGE', 'empty target', 'Pass a host, an ssh_config alias, or user@host.')
  }
  if (/\s/.test(raw)) {
    throw new MirbError('USAGE', `target '${raw}' contains whitespace`, 'A target is one word: user@host:2222.')
  }

  let rest = raw

  const scheme = SCHEME_RE.exec(rest)
  if (scheme) {
    const name = scheme[1]!.toLowerCase()
    if (name !== 'ssh') {
      throw new MirbError('USAGE', `unsupported scheme '${name}://' in target '${raw}'`, 'mirb tunnels over ssh; use ssh:// or a bare host.')
    }
    rest = rest.slice(scheme[0].length)
    // An ssh URI may carry a path (scp/sftp use it for a remote directory). It means
    // nothing for a port forward, and dropping it silently would hide a real mistake.
    const slash = rest.indexOf('/')
    if (slash !== -1) {
      if (slash + 1 < rest.length) {
        throw new MirbError('USAGE', `target '${raw}' has a path; mirb forwards ports, not files`)
      }
      rest = rest.slice(0, slash)
    }
  }

  let user: string | undefined
  // ssh splits the destination on the *last* '@' (strrchr), so `user@realm@host` logins
  // land the same way here as they would if the string went straight to ssh.
  const at = rest.lastIndexOf('@')
  if (at !== -1) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
    if (user.length === 0) {
      throw new MirbError('USAGE', `target '${raw}' has an empty user`)
    }
    // A ':' in the userinfo is a URL password. ssh has no such concept, and a colon is
    // not legal in a POSIX username either, so this is unambiguously a mistake.
    if (user.includes(':')) {
      throw new MirbError('USAGE', `target '${raw}' carries a password`, 'ssh authenticates with keys or an agent, never a URI password.')
    }
  }

  let host: string
  let portText: string | undefined

  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close === -1) {
      throw new MirbError('USAGE', `target '${raw}' has an unclosed '['`, 'Bracket IPv6 literals fully: [::1]:2222.')
    }
    host = rest.slice(1, close)
    const tail = rest.slice(close + 1)
    if (tail.length > 0) {
      if (!tail.startsWith(':')) {
        throw new MirbError('USAGE', `unexpected '${tail}' after ']' in target '${raw}'`)
      }
      portText = tail.slice(1)
    }
  } else if (looksLikeBareIpv6(rest)) {
    host = rest
  } else {
    const colon = rest.indexOf(':')
    if (colon === -1) {
      host = rest
    } else {
      host = rest.slice(0, colon)
      portText = rest.slice(colon + 1)
    }
  }

  if (host.length === 0) {
    throw new MirbError('USAGE', `target '${raw}' has an empty host`, 'Pass a host, an ssh_config alias, or user@host.')
  }

  const target: Target = { host, raw }
  if (user !== undefined) target.user = user
  if (portText !== undefined) target.port = parsePort(portText, raw)
  return target
}

/**
 * The display form, and the one form that parses back to the same Target.
 *
 * IPv6 literals are re-bracketed here even without a port: `[::1]` reads as an address,
 * whereas `::1:2222` reads as nothing at all. Everything mirb prints goes through this,
 * so users can copy a line out of `mirb ls` and paste it straight back in.
 */
export function formatTarget(t: Target): string {
  const host = t.host.includes(':') ? `[${t.host}]` : t.host
  const authority = t.user !== undefined ? `${t.user}@${host}` : host
  return t.port !== undefined ? `${authority}:${t.port}` : authority
}

/**
 * The single destination argument for ssh's argv.
 *
 * The port is deliberately absent: it travels as `-p`. `user@host:2222` on ssh's command
 * line would be read as a *hostname* containing a colon, which fails to resolve — the
 * colon-port form is a mirb/scp convention, not an ssh one. IPv6 literals stay
 * unbracketed because ssh hands the bare string to getaddrinfo.
 */
export function targetToSshArg(t: Target): string {
  return t.user !== undefined ? `${t.user}@${t.host}` : t.host
}
