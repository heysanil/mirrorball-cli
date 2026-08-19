import { describe, expect, test } from 'bun:test'
import { classifySshStderr, MirbError } from '../core/errors.ts'
import { EXIT, type MirbErrorCode } from '../core/types.ts'

/**
 * These strings are VERBATIM captures from OpenSSH_10.2p1, not invented fixtures.
 * ssh exits 255 for every failure it owns, so this classifier is the only thing that
 * distinguishes "your port is taken" from "your password is wrong" from "your service
 * is down". Treat it as a contract, not a convenience.
 */
describe('classifySshStderr', () => {
  describe('local bind failures', () => {
    const conflict = [
      'bind [127.0.0.1]:45981: Address already in use',
      'channel_setup_fwd_listener_tcpip: cannot listen to port: 45981',
      'Could not request local forwarding.'
    ].join('\n')

    test('port conflict maps to PORT_IN_USE, not SSH_CONNECT', () => {
      const err = classifySshStderr(conflict)
      expect(err.code).toBe('PORT_IN_USE')
      expect(err.exitCode).toBe(EXIT.PORT_CONFLICT)
    })

    test('names the offending port when ssh reports it', () => {
      expect(classifySshStderr(conflict).message).toContain('45981')
    })

    /**
     * REGRESSION GUARD. This string contains "permission denied", so if the generic auth
     * branch is ever moved above the bind branch it silently becomes SSH_AUTH/exit 3.
     * The bug is invisible without this exact input.
     */
    test('privileged bind is PORT_PRIVILEGED, not SSH_AUTH', () => {
      const err = classifySshStderr(
        [
          'bind [::1]:1023: Permission denied',
          'channel_setup_fwd_listener_tcpip: cannot listen to port: 1023',
          'Could not request local forwarding.'
        ].join('\n')
      )
      expect(err.code).toBe('PORT_PRIVILEGED')
      expect(err.exitCode).toBe(EXIT.PORT_CONFLICT)
    })
  })

  describe('remote channel failures', () => {
    /**
     * REGRESSION GUARD. Contains "connection refused", which the generic connect branch
     * also matches. Order matters or REMOTE_REFUSED becomes unreachable.
     */
    test('dead remote service is REMOTE_REFUSED, not SSH_CONNECT', () => {
      const err = classifySshStderr('channel 3: open failed: connect failed: Connection refused')
      expect(err.code).toBe('REMOTE_REFUSED')
      expect(err.exitCode).toBe(EXIT.REMOTE_REFUSED)
    })

    test('forwarding disabled by the server is REMOTE_REFUSED', () => {
      const err = classifySshStderr('channel 2: open failed: administratively prohibited: open failed')
      expect(err.code).toBe('REMOTE_REFUSED')
      expect(err.hint).toMatch(/AllowTcpForwarding/i)
    })

    /** The channel number varies with session history; never anchor on it. */
    test.each([0, 2, 3, 17])('matches regardless of channel number (%i)', (n) => {
      expect(classifySshStderr(`channel ${n}: open failed: connect failed: Connection refused`).code)
        .toBe('REMOTE_REFUSED')
    })

    /** The tail is the REMOTE's errno text and differs by platform. */
    test('matches despite platform-specific trailing text', () => {
      const macos = 'channel 2: open failed: connect failed: nodename nor servname provided, or not known'
      expect(classifySshStderr(macos).code).toBe('REMOTE_REFUSED')
    })
  })

  describe('authentication and reachability', () => {
    const cases: Array<[string, MirbErrorCode]> = [
      ['sanil@127.0.0.1: Permission denied (publickey,password,keyboard-interactive).', 'SSH_AUTH'],
      ['Host key verification failed.', 'SSH_AUTH'],
      ['Received disconnect from 10.0.0.7 port 22:2: Too many authentication failures', 'SSH_AUTH'],
      ['ssh: Could not resolve hostname nope.invalid: nodename nor servname provided', 'SSH_CONNECT'],
      ['ssh: connect to host 10.0.0.7 port 22: Connection refused', 'SSH_CONNECT'],
      ['ssh: connect to host 10.0.0.7 port 22: Operation timed out', 'SSH_CONNECT']
    ]
    test.each(cases)('%s -> %s', (stderr, code) => {
      expect(classifySshStderr(stderr).code).toBe(code)
    })

    test('auth failures exit 3, distinct from port conflicts', () => {
      expect(classifySshStderr('Host key verification failed.').exitCode).toBe(EXIT.SSH)
    })
  })

  describe('fallback', () => {
    test('surfaces ssh’s own last real line rather than inventing one', () => {
      const err = classifySshStderr('debug1: noise\ndebug1: more noise\nSomething unprecedented happened')
      expect(err.message).toBe('Something unprecedented happened')
    })

    test('ignores debug chatter entirely', () => {
      expect(classifySshStderr('debug1: a\ndebug2: b').message).toBe('ssh exited unexpectedly')
    })

    test('always returns an MirbError', () => {
      expect(classifySshStderr('')).toBeInstanceOf(MirbError)
    })
  })
})
