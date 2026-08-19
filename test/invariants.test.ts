import { describe, expect, test } from 'bun:test'
import { buildSshArgs } from '../core/ssh.ts'
import type { Forward, SessionOptions, Target } from '../core/types.ts'

/**
 * Cross-cutting properties that are SECURITY guarantees rather than unit behaviour.
 *
 * Each of these looks like an arbitrary implementation detail when read in isolation —
 * argument ordering, a colon count — which is exactly why they need tests that say out
 * loud what they protect. All three were established by measuring real OpenSSH_10.2p1.
 */

function target(over: Partial<Target> = {}): Target {
  return { host: 'example.com', raw: 'example.com', ...over }
}

function forward(over: Partial<Forward> = {}): Forward {
  return {
    localPort: 3000,
    bindAddress: '127.0.0.1',
    remoteHost: 'localhost',
    remotePort: 3000,
    source: '3000',
    ...over
  }
}

function opts(over: Partial<SessionOptions> = {}): SessionOptions {
  return {
    target: target(),
    forwards: [forward()],
    timeout: 10,
    probe: true,
    sshOptions: [],
    sshPath: '/usr/bin/ssh',
    batch: false,
    ...over
  }
}

/** Pull out the value of every `-L` in an argv. */
function forwardSpecs(argv: string[]): string[] {
  return argv.flatMap((a, i) => (a === '-L' && argv[i + 1] !== undefined ? [argv[i + 1]!] : []))
}

/** Split on ':' but treat a bracketed IPv6 literal as one field. */
function fields(spec: string): string[] {
  return spec.match(/(\[[^\]]*\]|[^:]*)/g)?.filter((p) => p !== '') ?? []
}

describe('every -L carries an explicit bind address', () => {
  /**
   * THE dual-stack guarantee. A bare `-L PORT:host:port` makes ssh bind BOTH 127.0.0.1
   * and ::1. If a squatter holds only IPv4, the IPv6 bind still succeeds, so
   * ExitOnForwardFailure never fires and the user gets a tunnel live on ::1 while
   * 127.0.0.1 belongs to somebody else — silently, with no diagnostics. Measured on
   * OpenSSH_10.2p1. An explicit bind address binds exactly one socket and restores
   * ExitOnForwardFailure's meaning, which is the only reason mirb can promise honesty here.
   */
  test.each([
    ['default loopback', opts()],
    ['ipv6 bind', opts({ forwards: [forward({ bindAddress: '::1' })] })],
    ['wildcard bind', opts({ forwards: [forward({ bindAddress: '0.0.0.0' })] })],
    ['bastion hop', opts({ forwards: [forward({ remoteHost: 'db.internal', remotePort: 5432 })] })],
    ['ipv6 remote', opts({ forwards: [forward({ remoteHost: '::1' })] })],
    [
      'many forwards',
      opts({ forwards: [forward(), forward({ localPort: 3010 }), forward({ localPort: 8080 })] })
    ]
  ])('%s', (_name, o) => {
    const specs = forwardSpecs(buildSshArgs(o))
    expect(specs.length).toBe(o.forwards.length)
    for (const spec of specs) {
      expect(fields(spec)).toHaveLength(4)
    }
  })

  test('IPv6 literals are bracketed on both halves, so ssh can parse the spec', () => {
    const specs = forwardSpecs(
      buildSshArgs(opts({ forwards: [forward({ bindAddress: '::1', remoteHost: '2001:db8::1' })] }))
    )
    // Unbracketed, ssh rejects this outright: "Bad local forwarding specification".
    expect(specs[0]).toBe('[::1]:3000:[2001:db8::1]:3000')
  })
})

describe('user -o options cannot disable mirb’s safety properties', () => {
  /**
   * ssh uses the FIRST value it obtains for a keyword, so mirb's own options are emitted
   * before the user's. Verified against real ssh in both directions:
   *   -o ExitOnForwardFailure=yes then =no  -> yes
   *   -o ExitOnForwardFailure=no  then =yes -> no
   * That makes the argument order a security property, not a style choice.
   */
  test('mirb’s ExitOnForwardFailure precedes any user override', () => {
    const argv = buildSshArgs(opts({ sshOptions: ['ExitOnForwardFailure=no'] }))
    const ours = argv.indexOf('ExitOnForwardFailure=yes')
    const theirs = argv.indexOf('ExitOnForwardFailure=no')

    expect(ours).toBeGreaterThan(-1)
    expect(theirs).toBeGreaterThan(-1)
    expect(ours).toBeLessThan(theirs) // first wins => ours wins
  })

  test('every mirb option precedes every user option', () => {
    const argv = buildSshArgs(opts({ sshOptions: ['StrictHostKeyChecking=no', 'Compression=yes'] }))
    const lastOurs = argv.indexOf('ConnectTimeout=10')
    const firstTheirs = argv.indexOf('StrictHostKeyChecking=no')
    expect(lastOurs).toBeLessThan(firstTheirs)
  })

  test('ExitOnForwardFailure is present unconditionally', () => {
    for (const o of [opts(), opts({ batch: true }), opts({ sshOptions: ['Foo=bar'] })]) {
      expect(buildSshArgs(o)).toContain('ExitOnForwardFailure=yes')
    }
  })
})
