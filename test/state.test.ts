import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnvLike } from '../core/config.ts'
import { MirbError } from '../core/errors.ts'
import {
  ensureStateDirs,
  isProcessAlive,
  listSessions,
  pruneDead,
  readSession,
  removeSession,
  saveSession,
  sessionLogPath,
  stateDirs,
  isOurSupervisor
} from '../core/state.ts'
import type { SessionRecord } from '../core/types.ts'

/** No process can hold this: it is above every platform's pid_max. */
const DEAD_PID = 2_147_483_646

let dir = ''
let env: EnvLike = {}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mirb-state-'))
  env = { MIRB_STATE_DIR: dir }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * A stand-in supervisor.
 *
 * `isOurSupervisor` deliberately checks the process COMMAND LINE, not just the pid, because
 * `mirb stop` escalates to SIGKILL and a recycled pid would otherwise get a stranger's process
 * killed. So a test that wants a session to read as live has to look like a supervisor —
 * using the test runner's own pid no longer qualifies, and should not.
 */
function spawnFakeSupervisor(id: string): { pid: number; kill: () => void } {
  const proc = Bun.spawn(
    ['bun', '-e', 'setTimeout(() => {}, 60_000)', '__supervise', `/tmp/${id}.json`],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  )
  return { pid: proc.pid, kill: () => proc.kill() }
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const id = overrides.id ?? 'mb_abc0123456789'
  return {
    id,
    name: 'web',
    pid: process.pid,
    status: 'ready',
    target: { host: '10.0.0.7', user: 'deploy', port: 22, raw: 'deploy@10.0.0.7' },
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
    startedAt: '2026-08-19T10:00:00.000Z',
    reconnects: 0,
    logFile: join(dir, 'logs', `${id}.log`),
    sshArgv: ['ssh', '-N', '-L', '127.0.0.1:3000:localhost:3000', 'deploy@10.0.0.7'],
    ...overrides
  }
}

/** Bypasses saveSession so tests can plant exactly the garbage they mean to plant. */
async function plant(name: string, contents: string): Promise<void> {
  const dirs = stateDirs(env)
  await mkdir(dirs.sessions, { recursive: true })
  await Bun.write(join(dirs.sessions, name), contents)
}

describe('stateDirs', () => {
  test('$MIRB_STATE_DIR replaces the XDG root', () => {
    expect(stateDirs({ MIRB_STATE_DIR: '/custom' })).toEqual({
      root: '/custom',
      sessions: '/custom/sessions',
      logs: '/custom/logs'
    })
  })

  test('falls back to the XDG state directory', () => {
    expect(stateDirs({ XDG_STATE_HOME: '/xdg' }).root).toBe(join('/xdg', 'mirb'))
  })

  test('reads process.env when no env is passed', () => {
    const previous = process.env.MIRB_STATE_DIR
    process.env.MIRB_STATE_DIR = dir
    try {
      expect(stateDirs().sessions).toBe(join(dir, 'sessions'))
    } finally {
      if (previous === undefined) delete process.env.MIRB_STATE_DIR
      else process.env.MIRB_STATE_DIR = previous
    }
  })

  test('ensureStateDirs creates both directories and is idempotent', async () => {
    await ensureStateDirs(env)
    await ensureStateDirs(env)
    expect((await readdir(dir)).sort()).toEqual(['logs', 'sessions'])
  })
})

describe('sessionLogPath', () => {
  test('lives beside the other logs', () => {
    expect(sessionLogPath('mb_abc123', env)).toBe(join(dir, 'logs', 'mb_abc123.log'))
  })

  test('refuses an id that would escape the state directory', () => {
    expect(() => sessionLogPath('../../etc/passwd', env)).toThrow(MirbError)
  })
})

describe('save and read', () => {
  test('round-trips a record', async () => {
    const rec = record()
    await saveSession(rec, env)
    expect(await readSession(rec.id, env)).toEqual(rec)
  })

  test('an absent session is null, not an error', async () => {
    expect(await readSession('mb_nothinghere', env)).toBeNull()
  })

  test('a traversal id is null, never a path lookup', async () => {
    expect(await readSession('../../etc/passwd', env)).toBeNull()
  })

  test('a corrupt record throws rather than pretending it is missing', async () => {
    await plant('mb_broken1.json', '{ "id": "mb_broken1", ')
    await expect(readSession('mb_broken1', env)).rejects.toThrow(MirbError)
  })

  test('a well-formed but wrong record throws', async () => {
    await plant('mb_wrong01.json', JSON.stringify({ id: 'mb_wrong01', pid: 'not-a-pid' }))
    await expect(readSession('mb_wrong01', env)).rejects.toThrow(/not a valid session/)
  })

  test('refuses to persist a record that could not be read back', async () => {
    const bad = { ...record(), pid: -1 }
    await expect(saveSession(bad, env)).rejects.toThrow(MirbError)
  })

  test('overwriting replaces the record in place', async () => {
    const rec = record()
    await saveSession(rec, env)
    await saveSession({ ...rec, status: 'degraded', reconnects: 3 }, env)

    const read = await readSession(rec.id, env)
    expect(read?.status).toBe('degraded')
    expect(read?.reconnects).toBe(3)
    expect(await readdir(stateDirs(env).sessions)).toEqual([`${rec.id}.json`])
  })
})

describe('atomic writes', () => {
  test('leaves no temp files behind', async () => {
    await saveSession(record(), env)
    const entries = await readdir(stateDirs(env).sessions)
    expect(entries).toEqual(['mb_abc0123456789.json'])
  })

  test('a concurrent reader never observes a half-written record', async () => {
    const rec = record({
      // A payload big enough that a naive truncate-then-write would be caught mid-flight.
      sshArgv: Array.from({ length: 4000 }, (_, i) => `-o SomeOption${i}=yes`)
    })
    await saveSession(rec, env)

    const writes = (async () => {
      for (let i = 0; i < 40; i++) await saveSession({ ...rec, reconnects: i }, env)
    })()

    const reads = (async () => {
      for (let i = 0; i < 40; i++) {
        const read = await readSession(rec.id, env)
        expect(read).not.toBeNull()
        expect(read?.sshArgv.length).toBe(4000)
      }
    })()

    await Promise.all([writes, reads])
  })

  test('a failed write does not clobber the previous record', async () => {
    const rec = record()
    await saveSession(rec, env)
    // Session ids are validated before anything touches the disk.
    await expect(saveSession({ ...rec, id: 'fw/../evil' }, env)).rejects.toThrow(MirbError)
    expect((await readSession(rec.id, env))?.status).toBe('ready')
  })
})

describe('listSessions', () => {
  test('is empty when nothing has ever run', async () => {
    expect(await listSessions(env)).toEqual([])
  })

  test('skips unparseable files instead of failing the listing', async () => {
    await saveSession(record({ id: 'mb_good00000001' }), env)
    await plant('mb_garbage1.json', 'not json at all')
    await plant('mb_partial1.json', '{"id":"mb_partial1","pid":')
    await plant('mb_schema001.json', JSON.stringify({ id: 'mb_schema001', status: 'nope' }))

    const sessions = await listSessions(env)
    expect(sessions.map((s) => s.id)).toEqual(['mb_good00000001'])
  })

  test('ignores files that are not session records', async () => {
    await saveSession(record({ id: 'mb_good00000001' }), env)
    await plant('README.txt', 'hello')

    expect((await listSessions(env)).map((s) => s.id)).toEqual(['mb_good00000001'])
  })

  test('keeps a live session at its recorded status', async () => {
    const sup = spawnFakeSupervisor('mb_alive0000001')
    await saveSession(record({ id: 'mb_alive0000001', pid: sup.pid }), env)
    expect((await listSessions(env))[0]?.status).toBe('ready')
    sup.kill()
  })

  test('marks a session whose supervisor is gone as stopped', async () => {
    await saveSession(record({ id: 'mb_dead00000001', pid: DEAD_PID }), env)
    expect((await listSessions(env))[0]?.status).toBe('stopped')
  })

  test('does not rewrite a dead session that already failed', async () => {
    await saveSession(record({ id: 'mb_failed000001', pid: DEAD_PID, status: 'failed' }), env)
    expect((await listSessions(env))[0]?.status).toBe('failed')
  })

  test('reconciliation is in-memory only', async () => {
    const rec = record({ id: 'mb_dead00000002', pid: DEAD_PID })
    await saveSession(rec, env)
    await listSessions(env)

    const onDisk = await Bun.file(join(stateDirs(env).sessions, `${rec.id}.json`)).json()
    expect(onDisk.status).toBe('ready')
  })

  test('returns the newest session first', async () => {
    await saveSession(record({ id: 'mb_old000000001', startedAt: '2026-01-01T00:00:00.000Z' }), env)
    await saveSession(record({ id: 'mb_new000000001', startedAt: '2026-08-19T00:00:00.000Z' }), env)

    expect((await listSessions(env)).map((s) => s.id)).toEqual([
      'mb_new000000001',
      'mb_old000000001'
    ])
  })
})

describe('isProcessAlive', () => {
  test('our own pid is alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  test('an impossible pid is dead', () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false)
  })

  test('pid 1 is alive even though we may not signal it', () => {
    // Reaching EPERM rather than ESRCH is the whole point: alive, just not ours.
    expect(isProcessAlive(1)).toBe(true)
  })

  test('nonsense pids are dead, and never signal a process group', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
  })
})

describe('removeSession', () => {
  test('removes the record and its log, and reports it existed', async () => {
    const rec = record()
    await ensureStateDirs(env)
    await saveSession(rec, env)
    await Bun.write(sessionLogPath(rec.id, env), 'some ssh output\n')

    expect(await removeSession(rec.id, env)).toBe(true)
    expect(await readSession(rec.id, env)).toBeNull()
    expect(await Bun.file(sessionLogPath(rec.id, env)).exists()).toBe(false)
  })

  test('removing something that is not there is not an error', async () => {
    expect(await removeSession('mb_nothinghere', env)).toBe(false)
  })

  test('refuses a traversal id', async () => {
    expect(await removeSession('../../etc/passwd', env)).toBe(false)
  })
})

describe('pruneDead', () => {
  test('cleans dead sessions and leaves live ones alone', async () => {
    const sup = spawnFakeSupervisor('mb_alive0000001')
    await saveSession(record({ id: 'mb_alive0000001', pid: sup.pid }), env)
    await saveSession(record({ id: 'mb_dead00000001', pid: DEAD_PID }), env)
    await saveSession(record({ id: 'mb_dead00000002', pid: DEAD_PID }), env)

    const removed = await pruneDead(env)
    expect(removed.sort()).toEqual(['mb_dead00000001', 'mb_dead00000002'])
    expect((await listSessions(env)).map((s) => s.id)).toEqual(['mb_alive0000001'])
    sup.kill()
  })

  test('sweeps files that no longer parse', async () => {
    await plant('mb_garbage1.json', 'not json at all')
    expect(await pruneDead(env)).toEqual(['mb_garbage1'])
    expect(await readdir(stateDirs(env).sessions)).toEqual([])
  })

  test('takes the log file with it', async () => {
    const rec = record({ id: 'mb_dead00000001', pid: DEAD_PID })
    await ensureStateDirs(env)
    await saveSession(rec, env)
    await Bun.write(sessionLogPath(rec.id, env), 'output\n')

    await pruneDead(env)
    expect(await Bun.file(sessionLogPath(rec.id, env)).exists()).toBe(false)
  })

  test('is a no-op on an untouched state directory', async () => {
    expect(await pruneDead(env)).toEqual([])
  })
})

describe('isOurSupervisor', () => {
  /**
   * `mirb stop` escalates to SIGKILL, so "is this pid alive" is not a sufficient basis for it.
   * Pids get recycled; on a long-lived machine a stale record can name a process that now
   * belongs to something else entirely, and signalling it is not recoverable.
   */
  test('a live process that is not our supervisor is not ours', () => {
    expect(isOurSupervisor(process.pid, 'mb_alive0000001')).toBe(false)
  })

  test('a real supervisor for this id is ours', async () => {
    const sup = spawnFakeSupervisor('mb_owned000001')
    await Bun.sleep(150) // let the process appear in the process table
    expect(isOurSupervisor(sup.pid, 'mb_owned000001')).toBe(true)
    sup.kill()
  })

  test('a supervisor for a DIFFERENT session is not ours', async () => {
    const sup = spawnFakeSupervisor('mb_other000001')
    await Bun.sleep(150)
    expect(isOurSupervisor(sup.pid, 'mb_owned000001')).toBe(false)
    sup.kill()
  })

  test('a dead pid is never ours', () => {
    expect(isOurSupervisor(2_147_483_600, 'mb_alive0000001')).toBe(false)
  })
})
