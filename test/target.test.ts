import { describe, expect, test } from 'bun:test'
import { formatTarget, parseTarget, targetToSshArg } from '../core/target.ts'
import { MirbError } from '../core/errors.ts'
import { EXIT } from '../core/types.ts'

/** Every rejection is the same shape: a USAGE MirbError that exits 2. */
function expectUsage(raw: string): MirbError {
  let caught: unknown
  try {
    parseTarget(raw)
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(MirbError)
  const err = caught as MirbError
  expect(err.code).toBe('USAGE')
  expect(err.exitCode).toBe(EXIT.USAGE)
  return err
}

describe('parseTarget: hosts and aliases', () => {
  test('bare host', () => {
    expect(parseTarget('example.com')).toEqual({ host: 'example.com', raw: 'example.com' })
  })

  test('user@host', () => {
    expect(parseTarget('deploy@example.com')).toEqual({
      host: 'example.com',
      user: 'deploy',
      raw: 'deploy@example.com'
    })
  })

  test('user@host:port', () => {
    expect(parseTarget('deploy@example.com:2222')).toEqual({
      host: 'example.com',
      user: 'deploy',
      port: 2222,
      raw: 'deploy@example.com:2222'
    })
  })

  test('host:port without a user', () => {
    expect(parseTarget('example.com:2222')).toEqual({
      host: 'example.com',
      port: 2222,
      raw: 'example.com:2222'
    })
  })

  test('ssh_config aliases pass through untouched — mirrorball never resolves them', () => {
    // None of these are resolvable names. That is the point: they are Host aliases,
    // and deciding what they mean belongs to ssh.
    for (const alias of ['myserver', 'prod', 'prod-db', 'my_server', 'bastion1', 'a', 'staging.internal', 'gw.corp.']) {
      expect(parseTarget(alias)).toEqual({ host: alias, raw: alias })
    }
  })

  test('alias with a user and port', () => {
    expect(parseTarget('root@myserver:22')).toEqual({
      host: 'myserver',
      user: 'root',
      port: 22,
      raw: 'root@myserver:22'
    })
  })

  test("splits on the last '@', like ssh does", () => {
    expect(parseTarget('user@realm@myserver')).toEqual({
      host: 'myserver',
      user: 'user@realm',
      raw: 'user@realm@myserver'
    })
  })
})

describe('parseTarget: IPv4', () => {
  test('bare address', () => {
    expect(parseTarget('10.0.0.7')).toEqual({ host: '10.0.0.7', raw: '10.0.0.7' })
  })

  test('user and port', () => {
    expect(parseTarget('deploy@10.0.0.7:2222')).toEqual({
      host: '10.0.0.7',
      user: 'deploy',
      port: 2222,
      raw: 'deploy@10.0.0.7:2222'
    })
  })
})

describe('parseTarget: IPv6', () => {
  test('bracketed literal', () => {
    expect(parseTarget('[::1]')).toEqual({ host: '::1', raw: '[::1]' })
  })

  test('bracketed literal with a port', () => {
    expect(parseTarget('[::1]:8080')).toEqual({ host: '::1', port: 8080, raw: '[::1]:8080' })
  })

  test('user, bracketed literal, and port', () => {
    expect(parseTarget('user@[2001:db8::1]:22')).toEqual({
      host: '2001:db8::1',
      user: 'user',
      port: 22,
      raw: 'user@[2001:db8::1]:22'
    })
  })

  test('unbracketed literal: two or more colons cannot be host:port', () => {
    expect(parseTarget('::1')).toEqual({ host: '::1', raw: '::1' })
    expect(parseTarget('2001:db8::1')).toEqual({ host: '2001:db8::1', raw: '2001:db8::1' })
    expect(parseTarget('fe80::1%en0')).toEqual({ host: 'fe80::1%en0', raw: 'fe80::1%en0' })
  })

  test('unbracketed literal with a user', () => {
    expect(parseTarget('deploy@2001:db8::1')).toEqual({
      host: '2001:db8::1',
      user: 'deploy',
      raw: 'deploy@2001:db8::1'
    })
  })

  test('ssh:// with a bracketed literal', () => {
    expect(parseTarget('ssh://user@[2001:db8::1]:2222')).toEqual({
      host: '2001:db8::1',
      user: 'user',
      port: 2222,
      raw: 'ssh://user@[2001:db8::1]:2222'
    })
  })
})

describe('parseTarget: ssh:// URIs', () => {
  test('full form', () => {
    expect(parseTarget('ssh://deploy@example.com:2222')).toEqual({
      host: 'example.com',
      user: 'deploy',
      port: 2222,
      raw: 'ssh://deploy@example.com:2222'
    })
  })

  test('host only', () => {
    expect(parseTarget('ssh://example.com')).toEqual({ host: 'example.com', raw: 'ssh://example.com' })
  })

  test('user, no port', () => {
    expect(parseTarget('ssh://deploy@example.com')).toEqual({
      host: 'example.com',
      user: 'deploy',
      raw: 'ssh://deploy@example.com'
    })
  })

  test('a bare trailing slash is not a path', () => {
    expect(parseTarget('ssh://example.com:2222/')).toEqual({
      host: 'example.com',
      port: 2222,
      raw: 'ssh://example.com:2222/'
    })
  })

  test('scheme is case-insensitive', () => {
    expect(parseTarget('SSH://example.com')).toEqual({ host: 'example.com', raw: 'SSH://example.com' })
  })

  test('raw always keeps what the user actually typed', () => {
    expect(parseTarget('ssh://deploy@example.com:2222').raw).toBe('ssh://deploy@example.com:2222')
  })
})

describe('parseTarget: ports', () => {
  test('accepts the full legal range', () => {
    expect(parseTarget('host:1').port).toBe(1)
    expect(parseTarget('host:65535').port).toBe(65535)
    expect(parseTarget('host:22').port).toBe(22)
  })

  test('leading zeros are still a port', () => {
    expect(parseTarget('host:0022').port).toBe(22)
  })

  test('rejects out of range', () => {
    expectUsage('host:0')
    expectUsage('host:65536')
    expectUsage('host:99999')
    expectUsage('[::1]:0')
  })

  test('rejects non-numeric', () => {
    expectUsage('host:abc')
    expectUsage('host:22a')
    expectUsage('host:-1')
    expectUsage('host:2.2')
  })

  test('rejects an empty port', () => {
    expectUsage('host:')
    expectUsage('[::1]:')
  })
})

describe('parseTarget: rejections', () => {
  test('empty and whitespace-only', () => {
    expectUsage('')
    expectUsage('   ')
    expectUsage('\t')
  })

  test('whitespace anywhere in the target', () => {
    expectUsage('my host')
    expectUsage('host ')
    expectUsage(' host')
    expectUsage('user @host')
    expectUsage('host:22 22')
  })

  test('empty host', () => {
    expectUsage('user@')
    expectUsage(':2222')
    expectUsage('ssh://')
    expectUsage('[]')
    expectUsage('[]:22')
  })

  test('empty user', () => {
    expectUsage('@host')
  })

  test('non-ssh schemes', () => {
    expectUsage('http://example.com')
    expectUsage('https://example.com:8080')
    expectUsage('ftp://example.com')
  })

  test('ssh:// with a path — mirb forwards ports, not files', () => {
    expectUsage('ssh://example.com/var/log')
    expectUsage('ssh://deploy@example.com:2222/srv')
  })

  test('URI passwords', () => {
    const err = expectUsage('ssh://deploy:hunter2@example.com')
    expect(err.hint).toBeDefined()
    expectUsage('deploy:hunter2@example.com')
  })

  test('malformed brackets', () => {
    expectUsage('[::1')
    expectUsage('[::1]x')
    expectUsage('[::1]22')
  })

  test('every rejection carries a message naming the target', () => {
    expect(expectUsage('host:70000').message).toContain('host:70000')
  })
})

describe('formatTarget', () => {
  test('omits the parts that are undefined', () => {
    expect(formatTarget(parseTarget('example.com'))).toBe('example.com')
    expect(formatTarget(parseTarget('deploy@example.com'))).toBe('deploy@example.com')
    expect(formatTarget(parseTarget('example.com:2222'))).toBe('example.com:2222')
    expect(formatTarget(parseTarget('deploy@example.com:2222'))).toBe('deploy@example.com:2222')
  })

  test('normalizes an ssh:// URI to the short display form', () => {
    expect(formatTarget(parseTarget('ssh://deploy@example.com:2222'))).toBe('deploy@example.com:2222')
  })

  test('re-brackets IPv6 literals so the result is unambiguous', () => {
    expect(formatTarget(parseTarget('::1'))).toBe('[::1]')
    expect(formatTarget(parseTarget('[::1]:8080'))).toBe('[::1]:8080')
    expect(formatTarget(parseTarget('user@[2001:db8::1]:22'))).toBe('user@[2001:db8::1]:22')
  })
})

describe('round-tripping', () => {
  // formatTarget's output must always parse back to the same host/user/port. Users copy
  // these strings out of `mirb ls` and paste them straight back into `mirb`.
  const cases = [
    'example.com',
    'deploy@example.com',
    'example.com:2222',
    'deploy@example.com:2222',
    'myserver',
    'root@myserver:22',
    '10.0.0.7',
    'deploy@10.0.0.7:2222',
    '[::1]',
    '[::1]:8080',
    '::1',
    'user@[2001:db8::1]:22',
    'deploy@2001:db8::1',
    'ssh://deploy@example.com:2222',
    'ssh://example.com'
  ]

  for (const raw of cases) {
    test(`${raw} survives parse -> format -> parse`, () => {
      const once = parseTarget(raw)
      const display = formatTarget(once)
      const twice = parseTarget(display)
      expect({ host: twice.host, user: twice.user, port: twice.port }).toEqual({
        host: once.host,
        user: once.user,
        port: once.port
      })
      // Formatting is idempotent, which is what makes the display form canonical.
      expect(formatTarget(twice)).toBe(display)
    })
  }
})

describe('targetToSshArg', () => {
  test('host only', () => {
    expect(targetToSshArg(parseTarget('example.com'))).toBe('example.com')
    expect(targetToSshArg(parseTarget('myserver'))).toBe('myserver')
  })

  test('user@host', () => {
    expect(targetToSshArg(parseTarget('deploy@example.com'))).toBe('deploy@example.com')
  })

  test('the port never appears in the host argument — it travels as -p', () => {
    expect(targetToSshArg(parseTarget('deploy@example.com:2222'))).toBe('deploy@example.com')
    expect(targetToSshArg(parseTarget('example.com:2222'))).toBe('example.com')
    expect(targetToSshArg(parseTarget('ssh://deploy@example.com:2222'))).toBe('deploy@example.com')
  })

  test('IPv6 literals go to ssh unbracketed, for getaddrinfo', () => {
    expect(targetToSshArg(parseTarget('[::1]'))).toBe('::1')
    expect(targetToSshArg(parseTarget('[::1]:8080'))).toBe('::1')
    expect(targetToSshArg(parseTarget('user@[2001:db8::1]:22'))).toBe('user@2001:db8::1')
  })

  test('never contains whitespace or a scheme, whatever went in', () => {
    for (const raw of ['ssh://deploy@example.com:2222', '[::1]:8080', 'myserver', 'user@realm@myserver']) {
      const arg = targetToSshArg(parseTarget(raw))
      expect(arg).not.toContain('://')
      expect(arg).not.toMatch(/\s/)
      expect(arg.length).toBeGreaterThan(0)
    }
  })
})
