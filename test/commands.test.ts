import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import net from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnvLike } from '../core/config.ts'
import { saveSession } from '../core/state.ts'
import { EXIT, type MirbEvent, type SessionRecord } from '../core/types.ts'

/**
 * End-to-end tests for the command layer.
 *
 * These drive the real CLI as a subprocess — argv parsing, ssh spawn, readiness probe, state
 * files, exit code — with `$MIRB_SSH` pointed at the fake-ssh harness and `$MIRB_STATE_DIR` at
 * a temp directory. Nothing here talks to a network or to a real ssh binary, and nothing
 * touches the developer's own sessions.
 *
 * They are the slowest tests in the suite, so they stay few and assert on the things only an
 * end-to-end test can see: that the ports are genuinely connectable, that a backgrounded
 * session outlives the process that started it, and that exit codes survive the trip through
 * bunli's error handling.
 */

const CLI = new URL('../mirb.ts', import.meta.url).pathname
const FAKE_SSH = new URL('./fixtures/fake-ssh.ts', import.meta.url).pathname
const ROOT = new URL('..', import.meta.url).pathname

/** A backgrounded session start includes a real bind and a real probe; 5s is not enough. */
const SLOW = 20_000

let dir = ''
let env: Record<string, string> = {}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mirb-cmd-'))
  env = {
    ...(process.env as Record<string, string>),
    MIRB_STATE_DIR: join(dir, 'state'),
    // Named, not created: most tests want the no-config path, and the ones that don't write it.
    MIRB_CONFIG: join(dir, 'config.toml'),
    MIRB_SSH: FAKE_SSH
  }
})

afterEach(async () => {
  // A leaked supervisor would outlive the whole suite — it is detached by design.
  await mirb(['stop', '--all']).catch(() => {})
  await rm(dir, { recursive: true, force: true })
})

interface Run {
  code: number
  stdout: string
  stderr: string
}

/** Run the CLI to completion. */
async function mirb(args: string[], extra: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: ROOT,
    env: { ...env, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore'
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ])
  return { code: await proc.exited, stdout, stderr }
}

/** The `{ok, data, meta}` envelope every machine-mode command writes. */
function envelopeOf(stdout: string): { ok: boolean; data: Record<string, unknown> } {
  return JSON.parse(stdout) as { ok: boolean; data: Record<string, unknown> }
}

/** Ask the OS for a port rather than hoping one is free. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** Ground truth, the same signal mirb itself uses: does the local port accept a connection? */
function connects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(2_000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

interface Streaming {
  proc: Bun.Subprocess
  events: MirbEvent[]
  lines: string[]
  /** Resolves on `session.ready`, rejects if the process exits before that. */
  ready: Promise<void>
  drained: Promise<void>
}

/**
 * Start a foreground session and collect its NDJSON as it arrives.
 *
 * Parsing every line as it is read — rather than slurping the whole stream at the end — is
 * the point: `up` is designed never to exit on its own, so a test that waited for stdout to
 * close would wait forever.
 */
function stream(args: string[], extra: Record<string, string> = {}): Streaming {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: ROOT,
    env: { ...env, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore'
  })

  const events: MirbEvent[] = []
  const lines: string[] = []
  let onReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    onReady = resolve
  })

  const drained = (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim().length === 0) continue
        lines.push(line)
        const event = JSON.parse(line) as MirbEvent
        events.push(event)
        if (event.event === 'session.ready') onReady()
      }
    }
  })()

  return { proc, events, lines, ready, drained }
}

/** Fail loudly with whatever mirb said, instead of timing out silently. */
async function awaitReady(session: Streaming): Promise<void> {
  await Promise.race([
    session.ready,
    session.proc.exited.then(async (code) => {
      throw new Error(
        `mirb exited ${code} before session.ready\n${session.lines.join('\n')}\n${await new Response(session.proc.stderr as ReadableStream).text()}`
      )
    })
  ])
}

describe('mirb up', () => {
  test(
    'brings a forward up and the local port really accepts connections',
    async () => {
      const port = await freePort()
      const session = stream(['example.test', String(port)])

      await awaitReady(session)
      expect(await connects(port)).toBe(true)

      session.proc.kill('SIGTERM')
      const code = await session.proc.exited
      await session.drained

      const names = session.events.map((e) => e.event)
      expect(names).toContain('session.start')
      expect(names).toContain('forward.bound')
      // The probe reached the fake remote, so this is `ready` and not merely `bound`.
      expect(names).toContain('forward.ready')
      expect(names).toContain('session.ready')
      expect(names[names.length - 1]).toBe('session.exit')
      // A stop the user asked for, however it was spelled.
      expect(code).toBe(EXIT.SIGINT)
    },
    SLOW
  )

  test(
    '--json writes nothing to stdout that is not a parseable event',
    async () => {
      const port = await freePort()
      const session = stream(['--json', 'example.test', String(port)])

      await awaitReady(session)
      session.proc.kill('SIGTERM')
      await session.proc.exited
      await session.drained

      for (const line of session.lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>
        expect(typeof parsed.event).toBe('string')
        expect(typeof parsed.ts).toBe('string')
      }

      const start = session.events.find((e) => e.event === 'session.start')
      expect(start).toBeDefined()
      if (start?.event !== 'session.start') throw new Error('unreachable')
      expect(start.target.host).toBe('example.test')
      expect(start.forwards[0]?.localPort).toBe(port)
      expect(start.id).toMatch(/^mb_[a-z0-9]{13}$/)
    },
    SLOW
  )

  test('a first argument that is neither a profile nor a port list lists the profiles', async () => {
    await Bun.write(
      env.MIRB_CONFIG!,
      '[profiles.web]\nhost = "example.test"\nports = [3000]\n\n[profiles.db]\nhost = "db.internal"\nports = 5432\n'
    )

    const run = await mirb(['nope'])

    expect(run.code).toBe(EXIT.USAGE)
    expect(run.stderr).toContain("'nope' is not a known profile")
    expect(run.stderr).toContain('web')
    expect(run.stderr).toContain('db')
    // Machine mode or not, stdout stays clean when there is no data to put on it.
    expect(run.stdout).toBe('')
  })
})

describe('mirb --background', () => {
  test(
    'starts, appears in ls, and is stopped by an id prefix',
    async () => {
      const port = await freePort()

      const started = await mirb(['--background', '--no-probe', 'example.test', String(port)])
      expect(started.code).toBe(EXIT.OK)

      const up = envelopeOf(started.stdout)
      expect(up.ok).toBe(true)
      const id = up.data.id as string
      expect(id).toMatch(/^mb_[a-z0-9]{13}$/)
      // The whole promise of --background: the ports are usable the moment it prints.
      expect(await connects(port)).toBe(true)

      const listed = await mirb(['ls'])
      expect(listed.code).toBe(EXIT.OK)
      const sessions = envelopeOf(listed.stdout).data.sessions as SessionRecord[]
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.id).toBe(id)
      expect(sessions[0]?.forwards[0]?.localPort).toBe(port)

      const stopped = await mirb(['stop', id.slice(3, 9)])
      expect(stopped.code).toBe(EXIT.OK)
      expect((envelopeOf(stopped.stdout).data.stopped as unknown[]).length).toBe(1)

      const after = await mirb(['ls'])
      expect(envelopeOf(after.stdout).data.sessions).toEqual([])
      // The supervisor is gone, so nothing is holding the port any more.
      expect(await connects(port)).toBe(false)
    },
    SLOW
  )

  test(
    '--auto-port shifts a busy port in the child, not only in the foreground',
    async () => {
      // Regression: flags reach the detached supervisor only if they are in the plan file,
      // and a flag that silently does nothing when backgrounded is invisible from inside.
      const squatter = net.createServer()
      const busy = await new Promise<number>((resolve, reject) => {
        squatter.once('error', reject)
        squatter.listen(0, '127.0.0.1', () => {
          const address = squatter.address()
          resolve(typeof address === 'object' && address !== null ? address.port : 0)
        })
      })

      try {
        const run = await mirb(['--background', '--no-probe', '--auto-port', 'example.test', String(busy)])
        expect(run.code).toBe(EXIT.OK)

        const forwards = envelopeOf(run.stdout).data.forwards as Array<{ localPort: number }>
        expect(forwards[0]?.localPort).toBeGreaterThan(busy)
      } finally {
        squatter.close()
      }
    },
    SLOW
  )

  test(
    'a supervisor that never comes up reports its reason and leaves no session behind',
    async () => {
      const port = await freePort()
      const run = await mirb(['--background', 'example.test', String(port)], {
        FAKE_SSH_MODE: 'auth-fail'
      })

      // The child's stderr is closed, so this reason can only have come back through the log.
      expect(run.code).toBe(EXIT.SSH)
      expect(run.stderr).toContain('authentication failed')

      const listed = await mirb(['ls'])
      expect(envelopeOf(listed.stdout).data.sessions).toEqual([])
    },
    SLOW
  )
})

describe('mirb stop', () => {
  test('an ambiguous id prefix stops nothing and names the candidates', async () => {
    // A live pid, so nothing here depends on how a dead record is reconciled — and one that
    // is not the test runner's, in case this ever regresses into actually signalling.
    const bystander = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30000)'], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore'
    })

    const record = (id: string): SessionRecord => ({
      id,
      pid: bystander.pid,
      status: 'ready',
      target: { host: 'example.test', raw: 'example.test' },
      forwards: [
        {
          localPort: 3000,
          bindAddress: '127.0.0.1',
          remoteHost: 'localhost',
          remotePort: 3000,
          source: '3000',
          status: 'ready'
        }
      ],
      startedAt: new Date().toISOString(),
      reconnects: 0,
      logFile: join(dir, 'state', 'logs', `${id}.log`),
      sshArgv: ['-N', 'example.test']
    })

    const stateEnv: EnvLike = { MIRB_STATE_DIR: env.MIRB_STATE_DIR }
    await saveSession(record('mb_ambig00000a'), stateEnv)
    await saveSession(record('mb_ambig00000b'), stateEnv)

    try {
      const run = await mirb(['stop', 'ambig'])

      expect(run.code).toBe(EXIT.GENERIC)
      expect(run.stderr).toContain('matches 2 sessions')
      expect(run.stderr).toContain('ambig0')
      // Refusing to choose means refusing to kill: both records are still there.
      const listed = await mirb(['ls'])
      expect((envelopeOf(listed.stdout).data.sessions as unknown[]).length).toBe(2)
    } finally {
      bystander.kill()
    }
  })
})

describe('normalizeArgv', () => {
  /**
   * `mirb.ts` is an entry point: importing it runs the CLI. So the import has to choose what
   * that run does, and `--help` is the one argv that prints and returns without touching
   * argv, the filesystem, or a network. stdout is muted for the duration so the help text
   * does not land in the middle of the test output.
   */
  async function loadNormalizeArgv(): Promise<(argv: string[]) => string[]> {
    const argv = process.argv
    const write = process.stdout.write
    const log = console.log

    process.argv = [argv[0] ?? 'bun', argv[1] ?? 'mirb.ts', '--help']
    process.stdout.write = (() => true) as typeof process.stdout.write
    console.log = () => {}

    try {
      return (await import('../mirb.ts')).normalizeArgv
    } finally {
      console.log = log
      process.stdout.write = write
      process.argv = argv
    }
  }

  test('routes argv to the right command', async () => {
    const normalizeArgv = await loadNormalizeArgv()

    // A reserved word in position zero is a command and stays one.
    expect(normalizeArgv(['ls'])).toEqual(['ls'])
    // Anything else is a target, and targets belong to `up`.
    expect(normalizeArgv(['10.0.0.7', '3000'])).toEqual(['up', '10.0.0.7', '3000'])
    // Nothing but flags: bunli's own globals get to handle it.
    expect(normalizeArgv(['--help'])).toEqual(['--help'])
    // Only position zero is consulted, so this forwards to a host literally named 'ls'.
    expect(normalizeArgv(['up', 'ls', '3000'])).toEqual(['up', 'ls', '3000'])
  })
})

/**
 * The one code path that no test running from source can exercise for real: how a
 * backgrounded mirb re-executes itself.
 *
 * This shipped broken. `superviseArgv` gated on `existsSync(Bun.main)`, which is *true*
 * inside a compiled binary — Bun shims `node:fs` so the embedded `/$bunfs/root/mirb`
 * resolves from within the process — so the compiled build spawned
 * `mirb /$bunfs/root/mirb __supervise <plan>`, `normalizeArgv` read the bunfs path as a
 * target, and every `--background` start died with "the background supervisor exited
 * before the tunnel came up". From source it worked perfectly.
 */
describe('superviseArgv', () => {
  test('a compiled binary takes the command directly, source passes its entry along', async () => {
    const { superviseArgv } = await import('../commands/up.ts')

    // Compiled: the executable *is* mirb. Its entry is unreadable to a child process, so
    // handing it over would spawn something that cannot start.
    expect(superviseArgv('/plan.json', '/$bunfs/root/mirb', '/usr/local/bin/mirb')).toEqual([
      '/usr/local/bin/mirb',
      '__supervise',
      '/plan.json'
    ])
    expect(superviseArgv('/plan.json', 'B:\\~BUN\\root\\mirb.exe', 'C:\\mirb.exe')).toEqual([
      'C:\\mirb.exe',
      '__supervise',
      '/plan.json'
    ])

    // From source: `process.execPath` is bun, which needs to be told what to run.
    const entry = new URL('../mirb.ts', import.meta.url).pathname
    expect(superviseArgv('/plan.json', entry, '/opt/bun')).toEqual([
      '/opt/bun',
      entry,
      '__supervise',
      '/plan.json'
    ])
  })
})
