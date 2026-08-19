import { defineCommand, option } from '@bunli/core'
import { z } from 'zod'
import type { EnvLike } from '../core/config.ts'
import { MirbError } from '../core/errors.ts'
import { shortId } from '../core/ids.ts'
import { isOurSupervisor, isProcessAlive, listSessions, removeSession } from '../core/state.ts'
import { formatTarget } from '../core/target.ts'
import type { SessionRecord } from '../core/types.ts'
import { createTheme } from '../ui/theme.ts'
import { envelope, fail, findSessions, isMachine } from './shared.ts'

/**
 * `mirb stop` — end a background session and forget it.
 *
 * The only interesting decision here is refusing to guess. An ambiguous id prefix stops
 * nothing and lists the candidates instead: quietly picking one of several sessions to kill
 * is the kind of thing a tool gets remembered for.
 */

/** How long a supervisor gets to tear its tunnel down before SIGKILL. */
const TERM_GRACE_MS = 3_000
/** After SIGKILL there is nothing left to wait for; this only covers reaping. */
const KILL_GRACE_MS = 1_000
const POLL_MS = 25

type Outcome = 'stopped' | 'killed' | 'already-gone'

async function waitForExit(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await Bun.sleep(POLL_MS)
  }
  return !isProcessAlive(pid)
}

/**
 * SIGTERM, wait, SIGKILL.
 *
 * SIGTERM is what a supervisor is built to handle — it closes the ssh connection, writes a
 * final record, and leaves. SIGKILL exists only because a wedged supervisor still holding
 * the user's local ports is a worse outcome than an ungraceful exit; the record is removed
 * either way, because a record whose process is gone describes nothing.
 */
async function terminate(rec: SessionRecord, env: EnvLike): Promise<Outcome> {
  // Ownership, not just existence: pids are recycled, and the next two lines send SIGTERM
  // and then SIGKILL. Signalling a stranger's process because a stale record happened to
  // name its pid is the one failure here that cannot be undone.
  if (!isOurSupervisor(rec.pid, rec.id)) {
    await removeSession(rec.id, env)
    return 'already-gone'
  }

  try {
    process.kill(rec.pid, 'SIGTERM')
  } catch {
    // It exited between the liveness check and the signal. That is the outcome we wanted.
  }

  let outcome: Outcome = 'stopped'
  if (!(await waitForExit(rec.pid, TERM_GRACE_MS))) {
    try {
      process.kill(rec.pid, 'SIGKILL')
      outcome = 'killed'
    } catch {
      // Nothing left to kill.
    }
    await waitForExit(rec.pid, KILL_GRACE_MS)
  }

  await removeSession(rec.id, env)
  return outcome
}

export default defineCommand({
  name: 'stop' as const,
  description: 'Stop a background forwarding session',
  defaultFormat: 'json' as const,
  options: {
    all: option(z.coerce.boolean().default(false), {
      description: 'Stop every background session',
      argumentKind: 'flag'
    }),
    json: option(z.coerce.boolean().default(false), {
      description: 'Force JSON output',
      argumentKind: 'flag'
    })
  },
  handler: async ({ flags, positional, agent, formatExplicit, output, env, terminal }) => {
    const startedAt = Date.now()
    const machine = isMachine({ agent, formatExplicit }, flags.json)

    try {
      const fragment = positional[0]
      // Reject rather than silently ignore. `mirb stop A B` reads as variadic to anyone
      // glancing at it, and quietly stopping only A while reporting success is the kind of
      // thing you discover much later, when B is still holding a port.
      if (positional.length > 1) {
        throw new MirbError(
          'USAGE',
          `expected one session, got ${positional.length}: ${positional.join(' ')}`,
          'Stop them one at a time, or use --all.'
        )
      }


      if (!flags.all && fragment === undefined) {
        throw new MirbError(
          'USAGE',
          'no session given',
          'Name one by id prefix or host — mirb stop k3n8dq — or stop them all with --all.'
        )
      }

      const targets = flags.all ? await listSessions(env) : await findSessions(fragment!, env)

      const stopped: Array<{ id: string; name?: string; target: string; outcome: Outcome }> = []
      for (const rec of targets) {
        stopped.push({
          id: rec.id,
          name: rec.name,
          target: formatTarget(rec.target),
          outcome: await terminate(rec, env)
        })
      }

      if (machine) {
        output(envelope('stop', { stopped }, startedAt))
        return
      }

      const theme = createTheme({ env, terminal })
      if (stopped.length === 0) {
        process.stdout.write(`  ${theme.muted('no background sessions')}\n`)
        return
      }

      for (const s of stopped) {
        const label = s.outcome === 'already-gone' ? 'removed (already gone)' : s.outcome
        process.stdout.write(`  ${theme.bold(shortId(s.id))}  ${s.target}  ${theme.muted(label)}\n`)
      }
    } catch (err) {
      fail(err)
    }
  }
})
