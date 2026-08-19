import { defineCommand, option } from '@bunli/core'
import { z } from 'zod'
import { MirbError } from '../core/errors.ts'
import { shortId } from '../core/ids.ts'
import { isProcessAlive, sessionLogPath } from '../core/state.ts'
import { formatTarget } from '../core/target.ts'
import { envelope, fail, findSessions, tailLines } from './shared.ts'

/**
 * `mirb logs <id>` — what the supervisor has been saying.
 *
 * The log is plain text, one record per line, and that is what this prints: an agent
 * piping it into `grep` wants the same bytes a human does. Only an explicit `--format`
 * turns it into a structured envelope, because that is the one case where the caller has
 * said out loud that they want to parse it.
 */

const DEFAULT_LINES = 50
/** Fast enough to feel live, slow enough that following a quiet session costs nothing. */
const FOLLOW_POLL_MS = 200

export default defineCommand({
  name: 'logs' as const,
  description: 'Show the log of a background session',
  defaultFormat: 'json' as const,
  options: {
    follow: option(z.coerce.boolean().default(false), {
      short: 'f',
      description: 'Keep printing new lines until the session ends',
      argumentKind: 'flag'
    }),
    lines: option(z.coerce.number().int().min(1).default(DEFAULT_LINES), {
      short: 'n',
      description: 'How many lines of history to show'
    })
  },
  handler: async ({ flags, positional, signal, formatExplicit, output, env }) => {
    const startedAt = Date.now()

    try {
      const fragment = positional[0]
      // Reject rather than silently ignore. `mirb stop A B` reads as variadic to anyone
      // glancing at it, and quietly stopping only A while reporting success is the kind of
      // thing you discover much later, when B is still holding a port.
      if (positional.length > 1) {
        throw new MirbError(
          'USAGE',
          `expected one session, got ${positional.length}: ${positional.join(' ')}`,
          'Read one session log at a time.'
        )
      }

      if (fragment === undefined) {
        throw new MirbError(
          'USAGE',
          'no session given',
          'Name one by id prefix or host: mirb logs k3n8dq'
        )
      }

      const matches = await findSessions(fragment, env)
      // A host with two tunnels is a legitimate thing to `stop`; it is not a thing to tail.
      if (matches.length > 1) {
        throw new MirbError(
          'SESSION_NOT_FOUND',
          `'${fragment}' matches ${matches.length} sessions`,
          `Name one: ${matches.map((m) => `${shortId(m.id)} -> ${formatTarget(m.target)}`).join('; ')}`
        )
      }

      const rec = matches[0]!
      // The record carries the absolute path so nothing has to reconstruct the naming
      // convention; falling back to it only covers a record written by an older build.
      const file = rec.logFile || sessionLogPath(rec.id, env)

      const read = async (): Promise<string> => {
        const handle = Bun.file(file)
        return (await handle.exists()) ? handle.text() : ''
      }

      const history = tailLines(await read(), flags.lines)

      // `agent` alone is not enough: a pipe wants the raw log, and turning it into JSON
      // would break every `mirb logs x | grep` there will ever be.
      if (formatExplicit) {
        output(envelope('logs', { id: rec.id, logFile: file, lines: history }, startedAt))
        return
      }

      if (history.length > 0) process.stdout.write(`${history.join('\n')}\n`)
      if (!flags.follow) return

      // Byte offsets, not line counts: the supervisor appends, and re-reading the whole file
      // every 200ms would make following a long-lived session quadratic in its own log.
      let offset = Bun.file(file).size

      while (!signal.aborted && isProcessAlive(rec.pid)) {
        await Bun.sleep(FOLLOW_POLL_MS)

        const handle = Bun.file(file)
        const size = handle.size
        // Truncated or rotated out from under us: start again rather than print garbage.
        if (size < offset) offset = 0
        if (size <= offset) continue

        process.stdout.write(await handle.slice(offset, size).text())
        offset = size
      }
    } catch (err) {
      fail(err)
    }
  }
})
