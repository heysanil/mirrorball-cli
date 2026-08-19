import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSshArgs, resolveSshPath, spawnSsh } from '../core/ssh.ts'
import { MirbError, classifySshStderr } from '../core/errors.ts'
import type { Forward, SessionOptions, Target } from '../core/types.ts'

/** Defaults that keep each case's *differences* the only thing on screen. */
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

describe('buildSshArgs', () => {
  test('simple single forward', () => {
    expect(buildSshArgs(opts())).toMatchInlineSnapshot(`
      [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=10",
        "-L",
        "127.0.0.1:3000:localhost:3000",
        "example.com",
      ]
    `)
  })

  test('multiple forwards keep the order the user typed them', () => {
    const args = buildSshArgs(
      opts({
        target: target({ host: '10.0.0.7', user: 'deploy', port: 2222, raw: 'deploy@10.0.0.7:2222' }),
        forwards: [
          forward({ localPort: 3000, remotePort: 3000, source: '3000' }),
          forward({ localPort: 3010, remotePort: 3010, source: '3010' }),
          forward({ localPort: 8080, remotePort: 80, source: '8080:80' })
        ]
      })
    )
    expect(args).toMatchInlineSnapshot(`
      [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=10",
        "-L",
        "127.0.0.1:3000:localhost:3000",
        "-L",
        "127.0.0.1:3010:localhost:3010",
        "-L",
        "127.0.0.1:8080:localhost:80",
        "-p",
        "2222",
        "deploy@10.0.0.7",
      ]
    `)
  })

  test('bastion hop: forwards land on a third host from the remote end', () => {
    const args = buildSshArgs(
      opts({
        target: target({ host: 'bastion.corp', user: 'jane', raw: 'jane@bastion.corp' }),
        forwards: [
          forward({ localPort: 5432, remoteHost: 'db.internal', remotePort: 5432, source: '5432:db.internal:5432' }),
          forward({ localPort: 6379, remoteHost: 'cache.internal', remotePort: 6379, source: '6379:cache.internal:6379' })
        ]
      })
    )
    expect(args).toMatchInlineSnapshot(`
      [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=10",
        "-L",
        "127.0.0.1:5432:db.internal:5432",
        "-L",
        "127.0.0.1:6379:cache.internal:6379",
        "jane@bastion.corp",
      ]
    `)
  })

  test('batch mode adds BatchMode=yes and nothing else', () => {
    expect(buildSshArgs(opts({ batch: true }))).toMatchInlineSnapshot(`
      [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "BatchMode=yes",
        "-L",
        "127.0.0.1:3000:localhost:3000",
        "example.com",
      ]
    `)

    const diff = buildSshArgs(opts({ batch: true })).filter((a) => !buildSshArgs(opts()).includes(a))
    expect(diff).toEqual(['BatchMode=yes'])
  })

  test('identity + jump + extra -o options', () => {
    const args = buildSshArgs(
      opts({
        target: target({ host: 'prod-1', user: 'ubuntu', port: 22, raw: 'ubuntu@prod-1:22' }),
        forwards: [forward({ localPort: 9000, bindAddress: '0.0.0.0', remotePort: 9000, source: '9000' })],
        identity: '~/.ssh/id_ed25519',
        jump: 'jump@bastion.corp:2222',
        sshOptions: ['StrictHostKeyChecking=accept-new', 'IdentitiesOnly=yes'],
        timeout: 5
      })
    )
    expect(args).toMatchInlineSnapshot(`
      [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=5",
        "-L",
        "0.0.0.0:9000:localhost:9000",
        "-p",
        "22",
        "-i",
        "~/.ssh/id_ed25519",
        "-J",
        "jump@bastion.corp:2222",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "IdentitiesOnly=yes",
        "ubuntu@prod-1",
      ]
    `)
  })

  test('IPv6 literals are bracketed on both halves of -L', () => {
    const args = buildSshArgs(
      opts({
        forwards: [
          forward({ localPort: 8080, bindAddress: '::1', remoteHost: 'fe80::1', remotePort: 80, source: '8080' })
        ]
      })
    )
    expect(args).toContain('[::1]:8080:[fe80::1]:80')
  })

  test('an already-bracketed address is not double-bracketed', () => {
    const args = buildSshArgs(
      opts({ forwards: [forward({ remoteHost: '[::1]', remotePort: 80, localPort: 80 })] })
    )
    expect(args).toContain('127.0.0.1:80:[::1]:80')
  })

  test('ExitOnForwardFailure is always present and always precedes user options', () => {
    const args = buildSshArgs(opts({ sshOptions: ['ExitOnForwardFailure=no'] }))
    expect(args.indexOf('ExitOnForwardFailure=yes')).toBeGreaterThan(-1)
    expect(args.indexOf('ExitOnForwardFailure=yes')).toBeLessThan(args.indexOf('ExitOnForwardFailure=no'))
  })

  test('the target is always the final argument', () => {
    const args = buildSshArgs(opts({ sshOptions: ['LogLevel=ERROR'], jump: 'b', identity: 'k' }))
    expect(args.at(-1)).toBe('example.com')
  })

  test('user is only prefixed when the target carries one', () => {
    expect(buildSshArgs(opts()).at(-1)).toBe('example.com')
    expect(buildSshArgs(opts({ target: target({ user: 'root' }) })).at(-1)).toBe('root@example.com')
  })

  test('ConnectTimeout is clamped to an integer ssh will accept', () => {
    expect(buildSshArgs(opts({ timeout: 7.6 }))).toContain('ConnectTimeout=8')
    expect(buildSshArgs(opts({ timeout: 0 }))).toContain('ConnectTimeout=1')
    expect(buildSshArgs(opts({ timeout: -5 }))).toContain('ConnectTimeout=1')
  })

  test('is pure: repeated calls do not accumulate state', () => {
    const o = opts()
    expect(buildSshArgs(o)).toEqual(buildSshArgs(o))
    expect(o.forwards).toHaveLength(1)
  })
})

/** A directory that looks like a PATH entry, with executables we control. */
let binDir: string
let realSsh: string
let fakeSsh: string

beforeAll(async () => {
  binDir = mkdtempSync(join(tmpdir(), 'mirb-ssh-'))
  realSsh = join(binDir, 'ssh')
  fakeSsh = join(binDir, 'other-ssh')
  for (const [path, body] of [
    [realSsh, '#!/bin/sh\nexit 0\n'],
    [fakeSsh, '#!/bin/sh\nexit 0\n']
  ] as const) {
    await Bun.write(path, body)
    chmodSync(path, 0o755)
  }
})

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true })
})

describe('resolveSshPath', () => {
  test('$MIRB_SSH wins over PATH', () => {
    expect(resolveSshPath({ PATH: binDir, MIRB_SSH: fakeSsh })).toBe(fakeSsh)
  })

  test('falls back to the ssh on PATH when unset', () => {
    expect(resolveSshPath({ PATH: binDir })).toBe(realSsh)
  })

  test('an empty $MIRB_SSH is treated as unset', () => {
    expect(resolveSshPath({ PATH: binDir, MIRB_SSH: '   ' })).toBe(realSsh)
  })

  test('$MIRB_SSH pointing at nothing fails loudly, not at spawn time', () => {
    let thrown: unknown
    try {
      resolveSshPath({ PATH: binDir, MIRB_SSH: join(binDir, 'not-here') })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MirbError)
    expect((thrown as MirbError).code).toBe('NO_SSH')
    expect((thrown as MirbError).message).toContain('not-here')
  })

  test('$MIRB_SSH pointing at a non-executable file is rejected', () => {
    expect(() => resolveSshPath({ PATH: binDir, MIRB_SSH: import.meta.path })).toThrow(MirbError)
  })

  test('no ssh anywhere throws NO_SSH', () => {
    let thrown: unknown
    try {
      resolveSshPath({ PATH: join(binDir, 'empty') })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MirbError)
    expect((thrown as MirbError).code).toBe('NO_SSH')
  })

  test('an env with no PATH at all does not silently borrow the ambient one', () => {
    expect(() => resolveSshPath({})).toThrow(MirbError)
  })
})

/** Writes an executable stand-in for ssh and returns SessionOptions pointing at it. */
async function fakeSshOpts(script: string, over: Partial<SessionOptions> = {}): Promise<SessionOptions> {
  const path = join(binDir, `stub-${Math.random().toString(36).slice(2)}`)
  await Bun.write(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
  return opts({ sshPath: path, batch: true, ...over })
}

describe('spawnSsh', () => {
  test('exposes a pid and resolves with the exit status', async () => {
    const proc = spawnSsh(await fakeSshOpts('exit 7'))
    expect(proc.pid).toBeGreaterThan(0)
    expect(await proc.exited).toBe(7)
  })

  test('stderr is captured and classifiable once exited resolves', async () => {
    const proc = spawnSsh(await fakeSshOpts('echo "Permission denied (publickey)." 1>&2; exit 255'))
    expect(await proc.exited).toBe(255)
    expect(proc.stderr).toContain('Permission denied')
    expect(classifySshStderr(proc.stderr).code).toBe('SSH_AUTH')
  })

  test('argv reaches ssh exactly as buildSshArgs produced it', async () => {
    const o = await fakeSshOpts('for a in "$@"; do echo "$a" 1>&2; done', {
      forwards: [forward({ localPort: 1234, remotePort: 4321 })],
      sshOptions: ['LogLevel=ERROR']
    })
    const proc = spawnSsh(o)
    await proc.exited
    expect(proc.stderr.trimEnd().split('\n')).toEqual(buildSshArgs(o))
  })

  test('stderr is a ring buffer: the tail survives, the head is dropped', async () => {
    // 200 KiB of output against a 64 KiB cap, ending in the line that actually matters.
    const proc = spawnSsh(
      await fakeSshOpts(
        'i=0; while [ $i -lt 2000 ]; do printf "%0100dnoise\\n" $i 1>&2; i=$((i+1)); done; echo "kex_exchange_identification: read: Connection reset" 1>&2; exit 255'
      )
    )
    await proc.exited
    expect(proc.stderr.length).toBeLessThanOrEqual(64 * 1024)
    expect(proc.stderr).toContain('kex_exchange_identification')
    expect(proc.stderr).not.toContain('0000000000noise')
  })

  test('kill() terminates the process and surfaces the signal in the exit status', async () => {
    const proc = spawnSsh(await fakeSshOpts('sleep 30'))
    proc.kill()
    expect(await proc.exited).toBe(143) // 128 + SIGTERM
  })

  test('a missing binary rejects rather than hanging', async () => {
    expect(() => spawnSsh(opts({ sshPath: join(binDir, 'definitely-not-here'), batch: true }))).toThrow()
  })
})
