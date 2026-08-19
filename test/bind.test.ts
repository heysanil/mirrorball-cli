import { describe, expect, test } from 'bun:test'
import {
  assertExposureAllowed,
  isExposedAddress,
  isLoopbackAddress,
  normalizeBindAddress
} from '../core/bind.ts'
import { MirbError } from '../core/errors.ts'

/**
 * The bind address is the only thing preventing a forward from being reachable by the
 * whole network — GatewayPorts does not save you, because an explicit 0.0.0.0 bypasses it.
 * So "is this loopback" has to be exactly right, including the shapes people actually type.
 */
describe('isLoopbackAddress', () => {
  test.each([
    [''],            // mirb's default
    ['localhost'],
    ['LOCALHOST'],   // case
    [' 127.0.0.1 '], // stray whitespace from a config file
    ['127.0.0.1'],
    ['127.1.2.3'],   // the whole 127/8 block is loopback
    ['::1'],
    ['[::1]']
  ])('%p is loopback', (addr) => {
    expect(isLoopbackAddress(addr)).toBe(true)
    expect(isExposedAddress(addr)).toBe(false)
  })

  test.each([
    ['0.0.0.0'],
    ['*'],
    ['::'],
    ['192.168.1.10'],
    ['10.0.0.7'],
    ['0.0.0.0.0'],       // malformed: must NOT be treated as loopback
    ['127x.0.0.1'],      // lookalike
    ['127.evil.com'],    // FAIL-OPEN GUARD: a hostname that starts with "127." and
                         // resolves to whatever its owner wants. A prefix test accepts
                         // this and silently publishes the forward.
    ['127.0.0.1.evil.com'],
    ['127.0.0.1:8080'],  // not a bare address
    ['127.0.0.256'],     // octet out of range
    ['127.1'],           // short form: ambiguous, so refused rather than guessed
    ['127.'],
    ['127.0.0.1x'],
    ['2001:db8::1']
  ])('%p is exposed', (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false)
    expect(isExposedAddress(addr)).toBe(true)
  })
})

describe('assertExposureAllowed', () => {
  test('loopback binds need no acknowledgement', () => {
    expect(() => assertExposureAllowed('127.0.0.1', false)).not.toThrow()
  })

  test('a non-loopback bind without --expose is refused', () => {
    expect(() => assertExposureAllowed('0.0.0.0', false)).toThrow(MirbError)
  })

  test('the refusal explains the risk and names the remedy', () => {
    try {
      assertExposureAllowed('0.0.0.0', false)
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as MirbError
      expect(err.code).toBe('USAGE')
      expect(err.message).toContain('0.0.0.0')
      expect(err.hint).toContain('--expose')
    }
  })

  test('--expose is what makes exposure possible, and it must be explicit', () => {
    expect(() => assertExposureAllowed('0.0.0.0', true)).not.toThrow()
  })
})

describe('normalizeBindAddress', () => {
  /**
   * `localhost` is a NAME: ssh hands it to getaddrinfo() and binds one socket per family,
   * which is the two-socket behaviour explicit bind addresses exist to prevent. If IPv4 is
   * occupied and IPv6 is not, the IPv6 bind succeeds, ExitOnForwardFailure never fires, and
   * the user gets a tunnel on ::1 while 127.0.0.1 belongs to someone else.
   */
  test.each([
    ['localhost', '127.0.0.1'],
    ['LOCALHOST', '127.0.0.1'],
    ['  localhost  ', '127.0.0.1'],
    ['', '127.0.0.1'],
    ['*', '0.0.0.0'],
    ['[::1]', '::1'],          // brackets are ssh's spelling, not an address
    ['[2001:db8::1]', '2001:db8::1'],
    ['::1', '::1'],
    ['127.0.0.1', '127.0.0.1'],
    ['0.0.0.0', '0.0.0.0'],
    ['192.168.1.10', '192.168.1.10']
  ])('%p -> %p', (input, expected) => {
    expect(normalizeBindAddress(input)).toBe(expected)
  })

  test('normalizing never turns an exposed address into a loopback one', () => {
    for (const a of ['0.0.0.0', '*', '::', '192.168.1.10', '127.evil.com']) {
      expect(isLoopbackAddress(normalizeBindAddress(a))).toBe(false)
    }
  })
})
