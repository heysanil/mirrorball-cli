import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stateDir, type PlatformEnv } from '@bunli/utils'
import { z } from 'zod'
import { MirbError } from './errors.ts'
import type { EnvLike } from './config.ts'
import type { SessionRecord } from './types.ts'

/** Compile-time proof that a zod schema still matches the shared contract. */
type AssertExtends<A extends B, B> = A

const portSchema = z.number().int().min(1).max(65535)

const targetSchema = z.object({
  host: z.string().min(1),
  user: z.string().optional(),
  port: portSchema.optional(),
  raw: z.string()
})

const forwardStateSchema = z.object({
  localPort: portSchema,
  bindAddress: z.string(),
  remoteHost: z.string(),
  remotePort: portSchema,
  source: z.string(),
  status: z.enum(['pending', 'bound', 'ready', 'refused', 'failed']),
  detail: z.string().optional()
})

const sessionStatusSchema = z.enum([
  'starting',
  'connecting',
  'ready',
  'degraded',
  'reconnecting',
  'stopped',
  'failed'
])

/**
 * Not strict: a record written by a newer mirb may carry fields this build has never
 * heard of, and refusing to list those sessions would be worse than ignoring the extras.
 */
const sessionRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  pid: z.number().int().positive(),
  status: sessionStatusSchema,
  target: targetSchema,
  forwards: z.array(forwardStateSchema),
  startedAt: z.string(),
  stoppedAt: z.string().optional(),
  reconnects: z.number().int().nonnegative(),
  logFile: z.string(),
  sshArgv: z.array(z.string())
})

type _RecordMatchesContract = AssertExtends<z.infer<typeof sessionRecordSchema>, SessionRecord>

export interface StateDirs {
  /** Root under which sessions/ and logs/ live. */
  root: string
  sessions: string
  logs: string
}

function platformEnv(env: EnvLike): PlatformEnv {
  return { platform: process.platform, env, homedir: homedir() }
}

/**
 * Where background session state lives.
 *
 * `$MIRB_STATE_DIR` replaces the XDG root wholesale. Tests rely on it; so does anyone
 * running two isolated mirb instances on one machine.
 */
export function stateDirs(env: EnvLike = process.env): StateDirs {
  const override = env.MIRB_STATE_DIR?.trim()
  const root = override && override.length > 0 ? override : stateDir('mirb', platformEnv(env))
  return { root, sessions: join(root, 'sessions'), logs: join(root, 'logs') }
}

/** Create the directories mirb writes into. Safe to call concurrently and repeatedly. */
export async function ensureStateDirs(env: EnvLike = process.env): Promise<StateDirs> {
  const dirs = stateDirs(env)
  await mkdir(dirs.sessions, { recursive: true })
  await mkdir(dirs.logs, { recursive: true })
  return dirs
}

/**
 * Session ids come from `newSessionId()`, but they also come from argv. Anything that
 * could climb out of the state directory is rejected outright rather than sanitised —
 * there is no legitimate `mirb stop ../../..`.
 */
const ID_PATTERN = /^[a-z0-9_]{1,64}$/

function isSafeId(id: string): boolean {
  return ID_PATTERN.test(id)
}

function sessionFilePath(dirs: StateDirs, id: string): string {
  return join(dirs.sessions, `${id}.json`)
}

/** Absolute path of a session's log file. The supervisor tees ssh's output here. */
export function sessionLogPath(id: string, env: EnvLike = process.env): string {
  if (!isSafeId(id)) {
    throw new MirbError('INTERNAL', `refusing to build a log path for invalid session id '${id}'`)
  }
  return join(stateDirs(env).logs, `${id}.log`)
}

/**
 * Write via a sibling temp file and rename.
 *
 * rename(2) is atomic within a filesystem, so a reader never observes a half-written
 * record — `mirb ls` racing a supervisor's status update is a routine event, not an
 * exotic one. Durability across a power cut is explicitly *not* a goal here (no fsync):
 * a session record outliving the process that it describes is worthless anyway.
 */
async function writeAtomic(dir: string, target: string, contents: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`)
  try {
    await Bun.write(tmp, contents)
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw new MirbError(
      'INTERNAL',
      `could not write ${target}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Persist a session record.
 *
 * Validated on the way *out* as well as on the way in: a record that would be skipped
 * by `listSessions()` should never reach the disk in the first place, and finding that
 * out at the write site points at the bug instead of at a mystery missing session.
 */
export async function saveSession(rec: SessionRecord, env: EnvLike = process.env): Promise<void> {
  if (!isSafeId(rec.id)) {
    throw new MirbError('INTERNAL', `invalid session id '${rec.id}'`)
  }

  const parsed = sessionRecordSchema.safeParse(rec)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first ? first.path.join('.') : ''
    throw new MirbError(
      'INTERNAL',
      `refusing to persist an invalid session record${where ? ` (${where}: ${first?.message})` : ''}`
    )
  }

  const dirs = stateDirs(env)
  await writeAtomic(dirs.sessions, sessionFilePath(dirs, rec.id), JSON.stringify(rec, null, 2))
}

/**
 * Read one session record.
 *
 * Absent -> null, so callers can decide whether that is an error. Present but corrupt
 * throws: when the user named a specific session, quietly reporting "not found" for a
 * file that plainly exists would send them looking in the wrong place.
 */
export async function readSession(
  id: string,
  env: EnvLike = process.env
): Promise<SessionRecord | null> {
  if (!isSafeId(id)) return null

  const dirs = stateDirs(env)
  const path = sessionFilePath(dirs, id)
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  let raw: unknown
  try {
    raw = await file.json()
  } catch {
    throw new MirbError(
      'INTERNAL',
      `session record ${path} is corrupt`,
      'Remove it, or run `mirb ls --prune` to clean up stale records.'
    )
  }

  const parsed = sessionRecordSchema.safeParse(raw)
  if (!parsed.success) {
    throw new MirbError(
      'INTERNAL',
      `session record ${path} is not a valid session`,
      'Remove it, or run `mirb ls --prune` to clean up stale records.'
    )
  }

  return parsed.data
}

/**
 * Does this pid still exist?
 *
 * Signal 0 performs the permission and existence checks without delivering anything.
 * EPERM means the process is alive but owned by someone else — treating that as dead
 * would make mirb cheerfully "prune" a running supervisor.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Is this pid still *our* supervisor, rather than some process that inherited the number?
 *
 * `kill(pid, 0)` proves only that the number is in use. Pids are recycled, and everything
 * built on top of this is destructive: `mirb stop` sends SIGTERM and then SIGKILL to whatever
 * `pid` names. On a machine that has been up a while, a stale record plus a wrapped pid
 * counter is enough to kill an unrelated process of the user's.
 *
 * So we check ownership as well as existence. The supervisor is always spawned as
 * `<exe> __supervise <plan-file>` and the plan file path contains the session id, so the
 * command line is proof. `ps` is used rather than /proc for portability; if it is missing or
 * unreadable we fall back to the liveness answer rather than refusing to manage the session.
 */
export function isOurSupervisor(pid: number, id: string): boolean {
  if (!isProcessAlive(pid)) return false
  try {
    const out = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='])
    if (!out.success) return false
    const cmd = new TextDecoder().decode(out.stdout)
    if (cmd.trim().length === 0) return false
    return cmd.includes('__supervise') && cmd.includes(id)
  } catch {
    return true // ps unavailable: do not escalate a diagnostic into a refusal
  }
}

/** A record whose supervisor is gone is reported as stopped, whatever it last wrote. */
function reconcile(rec: SessionRecord): SessionRecord {
  // Existence, not ownership, on purpose. This path only decides what `mirb ls` displays,
  // and a false negative here would silently hide a session that is genuinely running —
  // worse than showing a stale one. The stricter `isOurSupervisor` guards `stop`, where
  // being wrong means signalling a stranger's process.
  if (isProcessAlive(rec.pid)) return rec
  if (rec.status === 'stopped' || rec.status === 'failed') return rec
  return { ...rec, status: 'stopped' }
}

async function sessionFiles(dirs: StateDirs): Promise<string[]> {
  try {
    const entries = await readdir(dirs.sessions)
    return entries.filter((name) => name.endsWith('.json')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * Every session mirb knows about, newest first.
 *
 * One unreadable file must never take down the listing: `mirb ls` is the command people
 * reach for *because* something has gone wrong, and it has to keep working when the
 * state directory is in a bad way. Bad files are skipped silently here and cleaned up
 * by `pruneDead()`.
 */
export async function listSessions(env: EnvLike = process.env): Promise<SessionRecord[]> {
  const dirs = stateDirs(env)
  const out: SessionRecord[] = []

  for (const name of await sessionFiles(dirs)) {
    let raw: unknown
    try {
      raw = await Bun.file(join(dirs.sessions, name)).json()
    } catch {
      continue
    }
    const parsed = sessionRecordSchema.safeParse(raw)
    if (!parsed.success) continue
    out.push(reconcile(parsed.data))
  }

  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
}

/**
 * Delete a session's record and its log. Returns whether a record was actually there.
 *
 * The log goes with the record because the record is the only thing that knows where
 * the log is; orphaning it would leak disk that nothing can ever find again.
 */
export async function removeSession(id: string, env: EnvLike = process.env): Promise<boolean> {
  if (!isSafeId(id)) return false

  const dirs = stateDirs(env)
  const path = sessionFilePath(dirs, id)
  const existed = await Bun.file(path).exists()

  await rm(path, { force: true })
  await rm(join(dirs.logs, `${id}.log`), { force: true })

  return existed
}

/**
 * Clean up records whose supervisor is gone, plus any file that no longer parses.
 *
 * Returns the ids removed so `mirb ls --prune` can say what it did. Unparseable files
 * are swept too: an atomic writer never leaves one behind, so anything corrupt is
 * debris from a crash or an older build and is safe to drop.
 */
export async function pruneDead(env: EnvLike = process.env): Promise<string[]> {
  const dirs = stateDirs(env)
  const removed: string[] = []

  for (const name of await sessionFiles(dirs)) {
    const id = name.slice(0, -'.json'.length)
    const path = join(dirs.sessions, name)

    let alive = false
    try {
      const parsed = sessionRecordSchema.safeParse(await Bun.file(path).json())
      alive = parsed.success && isProcessAlive(parsed.data.pid)
    } catch {
      alive = false
    }

    if (alive) continue

    await rm(path, { force: true })
    if (isSafeId(id)) await rm(join(dirs.logs, `${id}.log`), { force: true })
    removed.push(id)
  }

  return removed
}
