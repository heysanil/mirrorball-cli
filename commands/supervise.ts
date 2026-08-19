import { defineCommand } from '@bunli/core'
import { appendFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { EnvLike } from '../core/config.ts'
import { MirbError } from '../core/errors.ts'
import { asMirbError } from '../core/session.ts'
import { ensureStateDirs, removeSession, saveSession, stateDirs } from '../core/state.ts'
import { Supervisor } from '../core/supervisor.ts'
import { formatTarget } from '../core/target.ts'
import { EXIT, type SessionOptions, type SessionRecord } from '../core/types.ts'
import type { LiveModel } from '../ui/live.ts'
import { createStaticReporter } from '../ui/static.ts'
import { fail } from './shared.ts'

/**
 * The detached process that owns a backgrounded session.
 *
 * It is mirb itself, re-executed — see docs/explanation/design-decisions.md. One supervisor
 * per session, started by the session and exiting with it: there is no daemon to enable, no
 * broker to garbage-collect, and no way for a supervisor from one release to end up talking
 * to a CLI from another.
 *
 * Everything it knows arrives in a *plan* file. The session record cannot carry it: a
 * `SessionRecord` describes a session that is already running (it has a pid), while a plan
 * describes one that has not started yet. They are written by different processes, at
 * different times, and conflating them would mean the parent inventing a pid.
 */

/** Compile-time proof that the schema below still matches what `up` writes. */
type AssertExtends<A extends B, B> = A

/** Everything the child needs that it cannot re-derive from argv. */
export interface SessionPlan {
  /** Chosen by the parent, so it can print the id before the child has written anything. */
  id: string
  name?: string
  logFile: string
  /** Max reconnect attempts; undefined is unlimited, 0 disables reconnection. */
  retry?: number
  /** `--auto-port`. Only the first attempt may shift a port; the supervisor enforces that. */
  autoPort?: boolean
  probeSettleMs?: number
  options: SessionOptions
}

const portSchema = z.number().int().min(1).max(65535)

const planSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  logFile: z.string().min(1),
  retry: z.number().int().nonnegative().optional(),
  autoPort: z.boolean().optional(),
  probeSettleMs: z.number().int().min(1).optional(),
  options: z.object({
    target: z.object({
      host: z.string().min(1),
      user: z.string().optional(),
      port: portSchema.optional(),
      raw: z.string()
    }),
    forwards: z
      .array(
        z.object({
          localPort: portSchema,
          bindAddress: z.string(),
          remoteHost: z.string(),
          remotePort: portSchema,
          source: z.string()
        })
      )
      .min(1),
    name: z.string().optional(),
    timeout: z.number().int().positive(),
    probe: z.boolean(),
    retry: z.number().int().nonnegative().optional(),
    sshOptions: z.array(z.string()),
    identity: z.string().optional(),
    jump: z.string().optional(),
    sshPath: z.string().min(1),
    batch: z.boolean()
  })
})

type _PlanMatchesContract = AssertExtends<z.infer<typeof planSchema>, SessionPlan>

/**
 * Plans live beside `sessions/` rather than in it.
 *
 * `listSessions()` and `pruneDead()` walk every `*.json` under `sessions/`, and a plan is
 * not a session — dropping one in there would have `mirb ls` racing to delete the file the
 * child has not read yet.
 */
export function planPath(id: string, env: EnvLike = process.env): string {
  return join(stateDirs(env).root, 'pending', `${id}.json`)
}

export async function writePlan(plan: SessionPlan, env: EnvLike = process.env): Promise<string> {
  const path = planPath(plan.id, env)
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(plan, null, 2))
  return path
}

/**
 * `__supervise` is directly runnable, so its argument is user input like any other and is
 * validated like any other. A TypeError six frames deep in a process with no stderr is the
 * single worst way this could fail.
 */
async function readPlan(path: string): Promise<SessionPlan> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new MirbError('INTERNAL', `no session plan at ${path}`)
  }

  let raw: unknown
  try {
    raw = await file.json()
  } catch {
    throw new MirbError('INTERNAL', `session plan ${path} is not valid JSON`)
  }

  const parsed = planSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first ? first.path.join('.') : ''
    throw new MirbError(
      'INTERNAL',
      `session plan ${path} is not a valid plan${where ? ` (${where}: ${first?.message})` : ''}`
    )
  }

  return parsed.data
}

/**
 * Synchronous appends, deliberately.
 *
 * The supervisor calls `process.exit()` on every one of its exit paths, and anything a
 * buffered stream had not flushed by then is simply lost — which would silently drop the
 * one line explaining why a background session died, the line the parent is at that moment
 * waiting to read.
 */
function logSink(file: string): { write(chunk: string): void } {
  return {
    write(chunk: string) {
      try {
        appendFileSync(file, chunk)
      } catch {
        // A log we cannot write is not a reason to drop a working tunnel.
      }
    }
  }
}

export default defineCommand({
  name: '__supervise' as const,
  description: 'Internal: run a backgrounded session (not for direct use)',
  handler: async ({ positional, env, signal }) => {
    // Closing the terminal that launched mirb must not take the tunnel with it. Node's
    // default action for SIGHUP is to terminate; installing any listener replaces it, and a
    // no-op is exactly the behaviour we want.
    process.on('SIGHUP', () => {})

    const path = positional[0]
    if (path === undefined) {
      fail(new MirbError('USAGE', '__supervise needs the path to a session plan'))
    }

    let plan: SessionPlan
    try {
      plan = await readPlan(path)
      await ensureStateDirs(env)
      // The plan has been read; leaving it behind would be litter nothing ever collects.
      await rm(path, { force: true })
    } catch (err) {
      fail(err)
    }

    const log = logSink(plan.logFile)
    const reporter = createStaticReporter({ stream: log, timestamps: true })
    const startedAt = new Date()
    const supervisor = new Supervisor(plan.options, {
      id: plan.id,
      retry: plan.retry,
      signal,
      session: { autoPort: plan.autoPort ?? false, probeSettleMs: plan.probeSettleMs }
    })

    const model = (): LiveModel => ({
      target: formatTarget(plan.options.target),
      forwards: supervisor.forwards,
      status: supervisor.status,
      startedAt: startedAt.getTime(),
      sshPid: supervisor.sshPid,
      reconnects: supervisor.reconnects,
      probe: plan.options.probe
    })

    const record = (): SessionRecord => ({
      id: plan.id,
      name: plan.name,
      // The supervisor's pid, not ssh's: this is the process that owns the session, the one
      // `mirb stop` signals, and the one whose liveness decides whether a record is stale.
      pid: process.pid,
      status: supervisor.status,
      target: plan.options.target,
      forwards: supervisor.forwards,
      startedAt: startedAt.toISOString(),
      reconnects: supervisor.reconnects,
      logFile: plan.logFile,
      sshArgv: supervisor.sshArgv
    })

    /**
     * Persists are chained rather than fired in parallel: two `saveSession` calls race to
     * rename over the same path, and the loser would leave the older status on disk — which
     * `mirb ls` would then report forever.
     */
    let persisting: Promise<void> = Promise.resolve()
    const persist = (): Promise<void> => {
      persisting = persisting.then(() => saveSession(record(), env)).catch(() => {})
      return persisting
    }

    supervisor.on('session.reconnecting', (e) => {
      reporter.note(`reconnecting in ${Math.round(e.delayMs / 1000)}s (attempt ${e.attempt})`)
    })
    supervisor.onAny(() => {
      reporter.update(model())
      void persist()
    })

    const leave = async (code: number): Promise<never> => {
      await persisting
      process.exit(code)
    }

    try {
      await supervisor.start()
    } catch (err) {
      const error = asMirbError(err)
      reporter.error(error)
      // The record is deliberately left behind on failure: the parent is polling for it,
      // and `pruneDead()` sweeps it the next time anyone runs `mirb ls`.
      await persist()
      await leave(error.exitCode)
    }

    await persist()

    const exit = await supervisor.finished
    if (exit.error) {
      reporter.error(exit.error)
      await persist()
      await leave(exit.error.exitCode)
    }

    reporter.stop(model())
    await persisting
    // A session that ended when it was asked to has nothing left to say, so it takes its
    // record and its log with it.
    await removeSession(plan.id, env)
    process.exit(EXIT.OK)
  }
})
