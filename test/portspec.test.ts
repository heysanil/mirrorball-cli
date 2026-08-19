import { describe, expect, test } from 'bun:test'
import { MirbError } from '../core/errors.ts'
import {
  DEFAULT_BIND_ADDRESS,
  MAX_RANGE_PORTS,
  parsePortSpec,
  parsePortSpecs
} from '../core/portspec.ts'

const opts = { bindAddress: '127.0.0.1' }

/** Assert that `fn` throws a MirbError, and hand it back for message assertions. */
function rejected(fn: () => unknown): MirbError {
  try {
    fn()
  } catch (err) {
    if (err instanceof MirbError) return err
    throw err
  }
  throw new Error('expected a MirbError, but nothing was thrown')
}

/** Compact view of a forward, for readable expectations. */
function shape(spec: string, o = opts) {
  return parsePortSpec(spec, o).map((f) => `${f.bindAddress}:${f.localPort}->${f.remoteHost}:${f.remotePort}`)
}

describe('accepted forms', () => {
  test('a bare port forwards to the same port', () => {
    expect(parsePortSpec('3000', opts)).toEqual([
      { localPort: 3000, bindAddress: '127.0.0.1', remoteHost: 'localhost', remotePort: 3000, source: '3000' }
    ])
  })

  test('LOCAL:REMOTE remaps the port on the ssh host', () => {
    expect(shape('8080:80')).toEqual(['127.0.0.1:8080->localhost:80'])
  })

  test('LOCAL:HOST:REMOTE reaches a third host', () => {
    expect(parsePortSpec('8080:db.internal:5432', opts)).toEqual([
      {
        localPort: 8080,
        bindAddress: '127.0.0.1',
        remoteHost: 'db.internal',
        remotePort: 5432,
        source: '8080:db.internal:5432'
      }
    ])
  })

  test('a single range expands to same-port forwards', () => {
    expect(shape('3000-3005')).toEqual([
      '127.0.0.1:3000->localhost:3000',
      '127.0.0.1:3001->localhost:3001',
      '127.0.0.1:3002->localhost:3002',
      '127.0.0.1:3003->localhost:3003',
      '127.0.0.1:3004->localhost:3004',
      '127.0.0.1:3005->localhost:3005'
    ])
  })

  test('paired ranges are zipped in order', () => {
    expect(shape('8000-8005:9000-9005')).toEqual([
      '127.0.0.1:8000->localhost:9000',
      '127.0.0.1:8001->localhost:9001',
      '127.0.0.1:8002->localhost:9002',
      '127.0.0.1:8003->localhost:9003',
      '127.0.0.1:8004->localhost:9004',
      '127.0.0.1:8005->localhost:9005'
    ])
  })

  test('paired ranges work with an explicit host', () => {
    expect(shape('8000-8002:db.internal:9000-9002')).toEqual([
      '127.0.0.1:8000->db.internal:9000',
      '127.0.0.1:8001->db.internal:9001',
      '127.0.0.1:8002->db.internal:9002'
    ])
  })

  test('a one-port range is just that port', () => {
    expect(shape('3000-3000')).toEqual(['127.0.0.1:3000->localhost:3000'])
  })

  test('every forward records the spec that produced it', () => {
    const forwards = parsePortSpec('8000-8002:9000-9002', opts)
    expect(forwards.map((f) => f.source)).toEqual(['8000-8002:9000-9002', '8000-8002:9000-9002', '8000-8002:9000-9002'])
  })

  test('surrounding whitespace is trimmed out of the recorded source', () => {
    const forwards = parsePortSpec('  3000  ', opts)
    expect(forwards[0]!.source).toBe('3000')
    expect(forwards[0]!.localPort).toBe(3000)
  })

  test('the bind address is applied to every forward', () => {
    const forwards = parsePortSpec('3000-3002', { bindAddress: '0.0.0.0' })
    expect(forwards.every((f) => f.bindAddress === '0.0.0.0')).toBe(true)
  })

  test('an empty bind address falls back to loopback', () => {
    expect(parsePortSpec('3000', { bindAddress: '' })[0]!.bindAddress).toBe(DEFAULT_BIND_ADDRESS)
    expect(DEFAULT_BIND_ADDRESS).toBe('127.0.0.1')
  })
})

describe('IPv6 hosts', () => {
  test('a bracketed literal parses as one field and keeps its brackets for ssh', () => {
    expect(parsePortSpec('8080:[::1]:5432', opts)).toEqual([
      {
        localPort: 8080,
        bindAddress: '127.0.0.1',
        remoteHost: '[::1]',
        remotePort: 5432,
        source: '8080:[::1]:5432'
      }
    ])
  })

  test('a full-length literal survives intact', () => {
    expect(parsePortSpec('8080:[2001:db8::8a2e:370:7334]:443', opts)[0]!.remoteHost).toBe(
      '[2001:db8::8a2e:370:7334]'
    )
  })

  test('ranges still work alongside a bracketed host', () => {
    expect(shape('8000-8001:[fe80::1]:9000-9001')).toEqual([
      '127.0.0.1:8000->[fe80::1]:9000',
      '127.0.0.1:8001->[fe80::1]:9001'
    ])
  })

  test('an unbracketed literal is rejected with a hint about brackets', () => {
    const err = rejected(() => parsePortSpec('8080:::1:5432', opts))
    expect(err.code).toBe('USAGE')
    expect(err.hint).toContain('bracketed')
  })

  test('an unclosed bracket is reported', () => {
    expect(rejected(() => parsePortSpec('8080:[::1:5432', opts)).message).toContain("unbalanced '['")
  })

  test('a stray closing bracket is reported', () => {
    expect(rejected(() => parsePortSpec('8080:[::1]]:5432', opts)).message).toContain("unbalanced ']'")
  })

  test('brackets around a name are rejected', () => {
    expect(rejected(() => parsePortSpec('8080:[example.com]:5432', opts)).message).toContain(
      'is not an IPv6 address'
    )
  })

  test('empty brackets are rejected', () => {
    expect(rejected(() => parsePortSpec('8080:[]:5432', opts)).message).toContain('empty bracketed host')
  })

  test('a trailing bracket outside a literal is rejected', () => {
    expect(rejected(() => parsePortSpec('8080:host]:5432', opts)).message).toContain("unbalanced ']'")
  })

  test('a balanced bracket in the middle of a host is rejected', () => {
    expect(rejected(() => parsePortSpec('8080:a[::1]:5432', opts)).message).toContain('malformed bracketed host')
  })

  test('trailing junk after a literal is rejected', () => {
    expect(rejected(() => parsePortSpec('8080:[::1]x:5432', opts)).message).toContain('malformed bracketed host')
  })
})

describe('port boundaries', () => {
  test('1 is valid', () => {
    expect(parsePortSpec('1', opts)[0]!.localPort).toBe(1)
  })

  test('65535 is valid on both sides', () => {
    expect(shape('65535:65535')).toEqual(['127.0.0.1:65535->localhost:65535'])
  })

  test('0 is rejected, naming the value', () => {
    const err = rejected(() => parsePortSpec('0', opts))
    expect(err.code).toBe('USAGE')
    expect(err.message).toContain('port 0')
    expect(err.message).toContain('1-65535')
    expect(err.hint).toContain('any free port')
  })

  test('65536 is rejected, naming the value', () => {
    expect(rejected(() => parsePortSpec('65536', opts)).message).toContain('port 65536')
  })

  test('an out-of-range remote port is rejected too', () => {
    expect(rejected(() => parsePortSpec('8080:70000', opts)).message).toContain('port 70000')
  })

  test('an out-of-range port inside a range is rejected', () => {
    expect(rejected(() => parsePortSpec('65530-65540', opts)).message).toContain('port 65540')
  })

  test('an absurdly large number is rejected rather than truncated', () => {
    expect(rejected(() => parsePortSpec('999999999999999999999', opts)).code).toBe('USAGE')
  })

  test('non-numeric ports are rejected', () => {
    expect(rejected(() => parsePortSpec('abc', opts)).message).toContain("'abc'")
    expect(rejected(() => parsePortSpec('30 00', opts)).code).toBe('USAGE')
    expect(rejected(() => parsePortSpec('3000.5', opts)).code).toBe('USAGE')
    expect(rejected(() => parsePortSpec('0x1f', opts)).code).toBe('USAGE')
    expect(rejected(() => parsePortSpec('+3000', opts)).code).toBe('USAGE')
  })

  test('a host in the local slot points the user at --bind', () => {
    const err = rejected(() => parsePortSpec('localhost:8080', opts))
    expect(err.message).toContain("'localhost'")
    expect(err.hint).toContain('--bind')
  })
})

describe('the range cap', () => {
  test('the cap is exported and is 256', () => {
    expect(MAX_RANGE_PORTS).toBe(256)
  })

  test('a range of exactly the cap is accepted', () => {
    const forwards = parsePortSpec(`1000-${1000 + MAX_RANGE_PORTS - 1}`, opts)
    expect(forwards).toHaveLength(MAX_RANGE_PORTS)
    expect(forwards.at(-1)!.localPort).toBe(1000 + MAX_RANGE_PORTS - 1)
  })

  test('one port past the cap is rejected', () => {
    const err = rejected(() => parsePortSpec(`1000-${1000 + MAX_RANGE_PORTS}`, opts))
    expect(err.code).toBe('USAGE')
    expect(err.message).toContain(`spans ${MAX_RANGE_PORTS + 1} ports`)
    expect(err.message).toContain(`at most ${MAX_RANGE_PORTS}`)
  })

  test('1-65535 fails fast instead of expanding', () => {
    const err = rejected(() => parsePortSpec('1-65535', opts))
    expect(err.message).toContain('spans 65535 ports')
  })

  test('the cap applies to the remote side as well', () => {
    expect(rejected(() => parsePortSpec('1000-1005:1-65535', opts)).message).toContain('spans 65535 ports')
  })
})

describe('malformed ranges', () => {
  test('paired ranges of unequal length are rejected explicitly', () => {
    const err = rejected(() => parsePortSpec('8000-8005:9000-9002', opts))
    expect(err.code).toBe('USAGE')
    expect(err.message).toContain('8000-8005 spans 6 ports but 9000-9002 spans 3')
    expect(err.hint).toContain('same length')
  })

  test('a range paired with a single port is rejected', () => {
    expect(rejected(() => parsePortSpec('8000-8005:9000', opts)).message).toContain(
      '8000-8005 spans 6 ports but 9000 spans 1'
    )
  })

  test('a single port paired with a range is rejected', () => {
    expect(rejected(() => parsePortSpec('8000:9000-9005', opts)).message).toContain(
      '8000 spans 1 ports but 9000-9005 spans 6'
    )
  })

  test('a descending range is rejected', () => {
    const err = rejected(() => parsePortSpec('3005-3000', opts))
    expect(err.message).toContain('ends before it starts')
    expect(err.hint).toContain('low-to-high')
  })

  test('a dangling dash is rejected', () => {
    expect(rejected(() => parsePortSpec('3000-', opts)).message).toContain('not a valid port range')
    expect(rejected(() => parsePortSpec('8080:-80', opts)).message).toContain('not a valid port range')
  })

  test('three-part ranges are rejected', () => {
    expect(rejected(() => parsePortSpec('3000-3005-3010', opts)).message).toContain('not a valid port range')
  })
})

describe('malformed specs', () => {
  test('an empty spec is rejected', () => {
    expect(rejected(() => parsePortSpec('', opts)).message).toContain('empty port specification')
    expect(rejected(() => parsePortSpec('   ', opts)).message).toContain('empty port specification')
  })

  test('a missing remote port is rejected', () => {
    expect(rejected(() => parsePortSpec('8080:', opts)).message).toContain('empty remote port')
  })

  test('a missing local port is rejected', () => {
    expect(rejected(() => parsePortSpec(':80', opts)).message).toContain('empty local port')
  })

  test('an empty host field is rejected', () => {
    expect(rejected(() => parsePortSpec('8080::80', opts)).message).toContain('empty host field')
  })

  test('a host with whitespace is rejected', () => {
    expect(rejected(() => parsePortSpec('8080:my host:80', opts)).message).toContain('contains whitespace')
  })

  test('four fields are rejected with a count', () => {
    const err = rejected(() => parsePortSpec('8080:db:5432:6000', opts))
    expect(err.message).toContain('4 colon-separated parts')
    expect(err.hint).toBe(
      'Write PORT, LOCAL:REMOTE, or LOCAL:HOST:REMOTE — e.g. 3000, 8080:80, 8080:db.internal:5432.'
    )
  })

  test('every rejection is a USAGE MirbError with a nonempty message', () => {
    const bad = ['', '0', '65536', 'abc', '8080:', ':80', '8080::80', '3005-3000', '1-65535', '8080:db:1:2']
    for (const spec of bad) {
      const err = rejected(() => parsePortSpec(spec, opts))
      expect(err).toBeInstanceOf(MirbError)
      expect(err.code).toBe('USAGE')
      expect(err.exitCode).toBe(2)
      expect(err.message.length).toBeGreaterThan(0)
    }
  })
})

describe('parsePortSpecs', () => {
  test('flattens several specs in the order given', () => {
    const forwards = parsePortSpecs(['3000', '8080:80', '9000-9001'], opts)
    expect(forwards.map((f) => f.localPort)).toEqual([3000, 8080, 9000, 9001])
    expect(forwards.map((f) => f.source)).toEqual(['3000', '8080:80', '9000-9001', '9000-9001'])
  })

  test('rejects an empty list', () => {
    const err = rejected(() => parsePortSpecs([], opts))
    expect(err.code).toBe('USAGE')
    expect(err.message).toContain('no ports given')
  })

  test('rejects the same spec listed twice', () => {
    const err = rejected(() => parsePortSpecs(['3000', '3000'], opts))
    expect(err.message).toContain("'3000' is listed twice")
  })

  test('names both offending inputs on a collision', () => {
    const err = rejected(() => parsePortSpecs(['3000', '3000:5432'], opts))
    expect(err.code).toBe('USAGE')
    expect(err.message).toContain('3000')
    expect(err.message).toContain("'3000:5432'")
    expect(err.hint).toContain('free local port')
  })

  test('detects a collision between a range and a single port', () => {
    const err = rejected(() => parsePortSpecs(['3000-3005', '3002:80'], opts))
    expect(err.message).toContain('local port 3002')
    expect(err.message).toContain("'3000-3005'")
    expect(err.message).toContain("'3002:80'")
  })

  test('detects a collision between two overlapping ranges', () => {
    expect(rejected(() => parsePortSpecs(['3000-3005', '3005-3010'], opts)).message).toContain('local port 3005')
  })

  test('allows the same remote port reached on different local ports', () => {
    const forwards = parsePortSpecs(['5432:db-a:5432', '5433:db-b:5432'], opts)
    expect(forwards.map((f) => `${f.localPort}->${f.remoteHost}`)).toEqual(['5432->db-a', '5433->db-b'])
  })

  test('propagates a per-spec parse error unchanged', () => {
    expect(rejected(() => parsePortSpecs(['3000', 'nope'], opts)).message).toContain("'nope'")
  })
})
