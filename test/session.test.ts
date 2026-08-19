import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { delay, probeRemote, waitForBind } from '../core/probe.ts'
import { MirbError } from '../core/errors.ts'
import { Session } from '../core/session.ts'
import { isProcessAlive } from '../core/state.ts'
import { Supervisor, isRetryable } from '../core/supervisor.ts'
import type { Forward, MirbEvent, SessionOptions } from '../core/types.ts'

/**
 * The whole runtime, exercised against `test/fixtures/fake-ssh.ts` — a script that parses the
 * `-L` flags it is given and really listens on those ports. Because mirb's readiness signal is
 * a TCP connect and never a line of ssh stderr, that fake is a faithful stand-in for ssh as
 * far as every state transition here is concerned, and none of this needs a server, a
 * network, or a key.
 */

const FAKE_SSH = join(import.meta.dir, 'fixtures/fake-ssh.ts')

beforeAll(() => {
  // The bit is what makes `Bun.spawn([path])` honour the shebang; a fresh checkout may not
  // carry it, and the failure it produces otherwise looks nothing like its cause.
  chmodSync(FAKE_SSH, 0o755)
})

/** Everything a test creates, torn down even when an expectation throws mid-flight. */
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mirb-session-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A port the OS just told us is free. Racy in principle, free in practice. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** A local listener under the test's control, standing in for whatever holds a port. */
function listener(opts: { port?: number; hangUp?: boolean; banner?: string } = {}) {
  return new Promise<{ port: number; close: () => void }>((resolve, reject) => {
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
      if (opts.banner) socket.write(opts.banner)
      if (opts.hangUp) socket.end()
    })
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const close = () => {
        for (const socket of sockets) socket.destroy()
        server.close()
      }
      cleanups.push(close)
      resolve({ port, close })
    })
  })
}

function forward(port: number, over: Partial<Forward> = {}): Forward {
  return {
    localPort: port,
    bindAddress: '127.0.0.1',
    remoteHost: 'localhost',
    remotePort: 8080,
    source: String(port),
    ...over
  }
}

interface Harness {
  options: SessionOptions
  /** One JSON line per fake-ssh invocation: the exact spawn count, not an inference. */
  attempts: () => { attempt: number; mode: string; pid: number; argv: string[] }[]
}

/**
 * A one-line `sh` shim that exports the fixture's environment and then `exec`s it.
 *
 * The indirection is not decoration: `Bun.spawn` inherits the environment the *process*
 * started with, not later writes to `process.env`, so a test cannot script the fake by
 * setting variables in its own process. `exec` keeps the pid the fake's own, which matters
 * because several tests here kill it by pid.
 */
function launcher(env: Record<string, string>): string {
  const path = join(tempDir(), 'ssh')
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
  const exports = Object.entries(env)
    .map(([key, value]) => `${key}=${quote(value)}\nexport ${key}`)
    .join('\n')

  writeFileSync(path, `#!/bin/sh\n${exports}\nexec ${quote(FAKE_SSH)} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

async function harness(
  mode: string,
  over: Partial<SessionOptions> = {},
  env: Record<string, string> = {}
): Promise<Harness> {
  const state = tempDir()
  const port = await freePort()

  return {
    options: {
      target: { host: 'fake.invalid', raw: 'fake.invalid' },
      forwards: [forward(port)],
      timeout: 5,
      probe: true,
      sshOptions: [],
      sshPath: launcher({ FAKE_SSH_MODE: mode, FAKE_SSH_STATE: state, ...env }),
      // Batch keeps stdin closed, so a fake spawned from the test runner never inherits a TTY.
      batch: true,
      ...over
    },
    attempts: () => {
      try {
        return readFileSync(join(state, 'attempts.log'), 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    }
  }
}

/** Poll until `predicate` holds. Cheaper and far less flaky than sleeping a guessed amount. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error(`condition never became true within ${timeoutMs}ms`)
}

function collect(source: { onAny(cb: (e: MirbEvent) => void): () => void }): MirbEvent[] {
  const events: MirbEvent[] = []
  source.onAny((e) => events.push(e))
  return events
}

const names = (events: MirbEvent[]) => events.map((e) => e.event)

describe('waitForBind', () => {
  test('a port nobody binds is never reported as bound', async () => {
    const port = await freePort()
    expect(await waitForBind(port, '127.0.0.1', { timeoutMs: 200 })).toBe(false)
  })

  test('reports the bind as soon as the listener appears, not when it was asked for', async () => {
    const port = await freePort()
    setTimeout(() => void listener({ port }), 120)

    const started = Date.now()
    expect(await waitForBind(port, '127.0.0.1', { timeoutMs: 3_000 })).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('* and 0.0.0.0 are probed on loopback rather than connected to literally', async () => {
    const bound = await listener()
    expect(await waitForBind(bound.port, '0.0.0.0', { timeoutMs: 1_000 })).toBe(true)
    expect(await waitForBind(bound.port, '*', { timeoutMs: 1_000 })).toBe(true)
  })

  test('an abort is a cancellation, not a verdict, and returns immediately', async () => {
    const port = await freePort()
    const started = Date.now()
    expect(await waitForBind(port, '127.0.0.1', { timeoutMs: 5_000, signal: AbortSignal.abort() })).toBe(false)
    expect(Date.now() - started).toBeLessThan(200)
  })
})

describe('probeRemote', () => {
  test('a connection that stays open is ready', async () => {
    const bound = await listener()
    expect(await probeRemote(forward(bound.port), { settleMs: 100 })).toBe('ready')
  })

  test('a connection closed promptly with no data is refused', async () => {
    const bound = await listener({ hangUp: true })
    expect(await probeRemote(forward(bound.port), { settleMs: 500 })).toBe('refused')
  })

  test('a banner settles it early: readiness does not have to wait out settleMs', async () => {
    const bound = await listener({ banner: 'SSH-2.0-OpenSSH_9.6\r\n' })
    const started = Date.now()
    expect(await probeRemote(forward(bound.port), { settleMs: 2_000 })).toBe('ready')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('nothing listening at all is refused rather than hanging', async () => {
    const port = await freePort()
    expect(await probeRemote(forward(port), { settleMs: 500, timeoutMs: 1_000 })).toBe('refused')
  })
})

describe('Session', () => {
  test('happy path: pending -> bound -> ready, and the session reports ready', async () => {
    const { options } = await harness('ok')
    const session = new Session(options, { probeSettleMs: 100 })
    cleanups.push(() => session.stop())
    const events = collect(session)

    await session.start()

    expect(session.status).toBe('ready')
    expect(session.forwards[0]?.status).toBe('ready')
    expect(session.sshPid).toBeGreaterThan(0)
    expect(names(events)).toEqual(['session.start', 'forward.bound', 'forward.ready', 'session.ready'])

    const ready = events.find((e) => e.event === 'session.ready')
    expect(ready).toMatchObject({ id: session.id, ready: 1, total: 1 })
  })

  test('without --probe a forward stops at bound, which is all mirb actually knows', async () => {
    const { options } = await harness('refused', { probe: false })
    const session = new Session(options)
    cleanups.push(() => session.stop())

    await session.start()

    expect(session.forwards[0]?.status).toBe('bound')
    expect(session.status).toBe('ready')
  })

  test('a tunnel to a dead remote service is degraded, not failed', async () => {
    const { options } = await harness('refused')
    const session = new Session(options, { probeSettleMs: 150 })
    cleanups.push(() => session.stop())
    const events = collect(session)

    await session.start()

    expect(session.status).toBe('degraded')
    expect(session.forwards[0]?.status).toBe('refused')
    expect(events.find((e) => e.event === 'forward.error')).toMatchObject({ code: 'REMOTE_REFUSED' })
    // Still up: the local port keeps accepting, which is what makes 'refused' a useful answer.
    expect(session.sshPid).toBeGreaterThan(0)
  })

  test('an auth failure surfaces as SSH_AUTH, classified from stderr', async () => {
    const { options, attempts } = await harness('auth-fail')
    const session = new Session(options)

    const error = await session.start().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MirbError)
    expect((error as MirbError).code).toBe('SSH_AUTH')
    expect(session.status).toBe('failed')
    expect((await session.exited).requested).toBe(false)
    expect(attempts()).toHaveLength(1)
  })

  test('a bind that never happens times out and takes the ssh process with it', async () => {
    const { options } = await harness('hang')
    const session = new Session(options, { bindTimeoutMs: 300 })

    const error = await session.start().catch((e: unknown) => e)
    const pid = session.sshPid

    expect(error).toBeInstanceOf(MirbError)
    expect((error as MirbError).code).toBe('SSH_CONNECT')
    expect((error as MirbError).message).toContain('waiting for local port')
    // No orphan: a wedged ssh still holding the user's port is the worst possible leftover.
    expect(pid).toBeGreaterThan(0)
    await until(() => !isProcessAlive(pid ?? 0), 3_000)
  })

  test('a busy local port fails before ssh is ever spawned', async () => {
    const { options, attempts } = await harness('ok')
    const busy = await listener({ port: options.forwards[0]?.localPort })
    expect(busy.port).toBe(options.forwards[0]!.localPort)

    const session = new Session(options)
    const error = await session.start().catch((e: unknown) => e)

    expect((error as MirbError).code).toBe('PORT_IN_USE')
    expect(attempts()).toHaveLength(0)
    expect(session.sshPid).toBeUndefined()
  })

  test('stop() is clean: exit is requested, ssh is gone, the port is released', async () => {
    const { options } = await harness('ok')
    const session = new Session(options, { probeSettleMs: 100 })
    const events = collect(session)

    await session.start()
    const pid = session.sshPid!

    await session.stop()

    const exit = await session.exited
    expect(exit.requested).toBe(true)
    expect(exit.error).toBeUndefined()
    expect(session.status).toBe('stopped')
    expect(isProcessAlive(pid)).toBe(false)
    expect(names(events).at(-1)).toBe('session.exit')
    expect(await waitForBind(options.forwards[0]!.localPort, '127.0.0.1', { timeoutMs: 300 })).toBe(false)
  })

  test('an ssh that ignores SIGTERM is escalated to SIGKILL rather than orphaned', async () => {
    const { options } = await harness('ignore-term')
    const session = new Session(options, { probeSettleMs: 60, killGraceMs: 150 })

    await session.start()
    const pid = session.sshPid!

    const started = Date.now()
    await session.stop()

    expect(isProcessAlive(pid)).toBe(false)
    expect((await session.exited).code).toBe(137) // 128 + SIGKILL
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })

  test('stop() is idempotent and safe before the session ever started', async () => {
    const { options, attempts } = await harness('ok')
    const session = new Session(options)

    await session.stop()
    await session.stop()

    expect((await session.exited).requested).toBe(true)
    expect(attempts()).toHaveLength(0)
    await expect(session.start()).rejects.toThrow(MirbError)
  })

  test('aborting the signal stops the session, the way Ctrl-C does', async () => {
    const { options } = await harness('ok')
    const controller = new AbortController()
    const session = new Session(options, { signal: controller.signal, probeSettleMs: 100 })

    await session.start()
    const pid = session.sshPid!

    controller.abort()
    const exit = await session.exited

    expect(exit.requested).toBe(true)
    await until(() => !isProcessAlive(pid), 3_000)
  })
})

describe('isRetryable', () => {
  test('only failures a later attempt could survive', () => {
    expect(isRetryable('SSH_CONNECT')).toBe(true)
    expect(isRetryable('PORT_IN_USE')).toBe(true)
    expect(isRetryable('SSH_AUTH')).toBe(false)
    expect(isRetryable('USAGE')).toBe(false)
    expect(isRetryable('NO_SSH')).toBe(false)
    expect(isRetryable('PORT_PRIVILEGED')).toBe(false)
  })
})

describe('Supervisor', () => {
  /** Backoff is real but tiny here; the arithmetic is BackoffTracker's own test to prove. */
  const fastBackoff = { baseMs: 20, jitter: 0 }

  test('a killed ssh triggers exactly one reconnect and the tunnel comes back', async () => {
    const { options, attempts } = await harness('ok')
    const supervisor = new Supervisor(options, {
      retry: 5,
      backoff: fastBackoff,
      session: { probeSettleMs: 80 }
    })
    cleanups.push(() => supervisor.stop())
    const events = collect(supervisor)

    await supervisor.start()
    expect(supervisor.status).toBe('ready')
    const firstPid = supervisor.sshPid!

    process.kill(firstPid, 'SIGKILL')

    await until(() => supervisor.status === 'ready' && supervisor.reconnects === 1)

    expect(attempts()).toHaveLength(2)
    expect(supervisor.sshPid).not.toBe(firstPid)
    expect(supervisor.forwards[0]?.status).toBe('ready')
    expect(events.filter((e) => e.event === 'session.reconnecting')).toMatchObject([
      { attempt: 1, delayMs: 20 }
    ])
    // Same id and same local port across the reconnect: clients must not have to care.
    expect(supervisor.forwards[0]?.localPort).toBe(options.forwards[0]?.localPort)
  })

  test('backoff grows across successive drops', async () => {
    const { options } = await harness('ok')
    const supervisor = new Supervisor(options, {
      retry: 5,
      backoff: fastBackoff,
      session: { probeSettleMs: 60 }
    })
    cleanups.push(() => supervisor.stop())
    const events = collect(supervisor)

    await supervisor.start()
    process.kill(supervisor.sshPid!, 'SIGKILL')
    await until(() => supervisor.status === 'ready' && supervisor.reconnects === 1)
    process.kill(supervisor.sshPid!, 'SIGKILL')
    await until(() => supervisor.status === 'ready' && supervisor.reconnects === 2)

    expect(events.filter((e) => e.event === 'session.reconnecting').map((e) => e.delayMs)).toEqual([20, 40])
  })

  test('an auth failure on reconnect stops everything: a wrong key never gets retried', async () => {
    const { options, attempts } = await harness('ok,auth-fail')
    const supervisor = new Supervisor(options, {
      retry: 10,
      backoff: fastBackoff,
      session: { probeSettleMs: 60 }
    })
    cleanups.push(() => supervisor.stop())

    await supervisor.start()
    process.kill(supervisor.sshPid!, 'SIGKILL')

    const exit = await supervisor.finished

    expect(exit.error?.code).toBe('SSH_AUTH')
    expect(supervisor.status).toBe('failed')
    expect(supervisor.reconnects).toBe(1)

    // And it stays stopped: the budget said ten, the classification said one.
    await delay(200)
    expect(attempts()).toHaveLength(2)
  })

  test('retry: 0 means the first drop is the last', async () => {
    const { options, attempts } = await harness('ok', { probe: false })
    const supervisor = new Supervisor(options, { retry: 0, backoff: fastBackoff })
    cleanups.push(() => supervisor.stop())

    await supervisor.start()
    process.kill(supervisor.sshPid!, 'SIGKILL')

    const exit = await supervisor.finished
    expect(exit.requested).toBe(false)
    expect(supervisor.status).toBe('failed')
    expect(supervisor.reconnects).toBe(0)

    await delay(200)
    expect(attempts()).toHaveLength(1)
  })

  test('an explicit stop() is never retried, and leaves no ssh behind', async () => {
    const { options, attempts } = await harness('ok')
    const supervisor = new Supervisor(options, {
      retry: 10,
      backoff: fastBackoff,
      session: { probeSettleMs: 60 }
    })

    await supervisor.start()
    const pid = supervisor.sshPid!

    await supervisor.stop()

    expect(supervisor.status).toBe('stopped')
    expect((await supervisor.finished).requested).toBe(true)
    expect(isProcessAlive(pid)).toBe(false)

    await delay(200)
    expect(attempts()).toHaveLength(1)
    expect(supervisor.reconnects).toBe(0)
  })

  test('the first connection is not retried: its real error is what the user needs', async () => {
    const { options, attempts } = await harness('connect-fail')
    const supervisor = new Supervisor(options, { retry: 10, backoff: fastBackoff })
    cleanups.push(() => supervisor.stop())

    const error = await supervisor.start().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MirbError)
    expect((error as MirbError).code).toBe('SSH_CONNECT')
    expect(supervisor.status).toBe('failed')

    await delay(200)
    expect(attempts()).toHaveLength(1)
  })

  test('events from every attempt reach one stream under one id', async () => {
    const { options } = await harness('ok')
    const supervisor = new Supervisor(options, {
      retry: 5,
      backoff: fastBackoff,
      session: { probeSettleMs: 60 }
    })
    cleanups.push(() => supervisor.stop())
    const events = collect(supervisor)

    await supervisor.start()
    process.kill(supervisor.sshPid!, 'SIGKILL')
    await until(() => supervisor.reconnects === 1 && supervisor.status === 'ready')

    expect(names(events)).toEqual([
      'session.start',
      'forward.bound',
      'forward.ready',
      'session.ready',
      'session.exit',
      'session.reconnecting',
      'session.start',
      'forward.bound',
      'forward.ready',
      'session.ready'
    ])
    for (const event of events) {
      if ('id' in event) expect(event.id).toBe(supervisor.id)
    }
  })
})
