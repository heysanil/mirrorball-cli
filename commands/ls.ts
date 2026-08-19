import { defineCommand, option } from '@bunli/core'
import { z } from 'zod'
import { shortId } from '../core/ids.ts'
import { listSessions, pruneDead } from '../core/state.ts'
import { formatTarget } from '../core/target.ts'
import type { SessionRecord } from '../core/types.ts'
import { formatUptime, padVisible, truncateVisible, visibleWidth } from '../ui/live.ts'
import { createTheme, type Theme } from '../ui/theme.ts'
import { envelope, fail, forwardsSummary, isMachine } from './shared.ts'

/**
 * `mirb ls` — what is forwarding right now.
 *
 * It reads files and nothing else: there is no daemon to ask, so this keeps working when
 * everything else has gone wrong, which is exactly when people run it.
 */

/** Between columns. Two spaces reads as a table; one reads as a run-on. */
const GUTTER = '  '
const INDENT = '  '

interface Row {
  id: string
  name: string
  host: string
  forwards: string
  uptime: string
  status: string
  paint: (text: string) => string
}

function toRow(rec: SessionRecord, theme: Theme, now: number): Row {
  const style = theme.session[rec.status]
  const started = Date.parse(rec.startedAt)
  return {
    id: shortId(rec.id),
    name: rec.name ?? '-',
    host: formatTarget(rec.target),
    forwards: forwardsSummary(rec, theme.symbols.arrow),
    uptime: Number.isFinite(started) ? formatUptime(now - started) : '-',
    status: `${style.symbol} ${style.label}`,
    paint: style.paint
  }
}

/**
 * Lay the rows out by hand rather than through a table helper.
 *
 * Widths are measured with `Bun.stringWidth`, because a CJK hostname is two cells per glyph
 * and `.length` would leave the status column ragged for exactly the people least able to
 * report it. The forwards column is the one that gives way when the terminal is narrow: it
 * is the longest and the most guessable.
 */
function render(rows: Row[], theme: Theme, width: number): string {
  const headers = ['ID', 'NAME', 'HOST', 'FORWARDS', 'UP', 'STATUS'] as const
  const keys = ['id', 'name', 'host', 'forwards', 'uptime', 'status'] as const

  const widths = keys.map((key, i) =>
    Math.max(visibleWidth(headers[i] ?? ''), ...rows.map((r) => visibleWidth(r[key])))
  )

  const natural = INDENT.length + widths.reduce((a, b) => a + b, 0) + GUTTER.length * (widths.length - 1)
  const overflow = natural - Math.max(20, width)
  if (overflow > 0) {
    // Shrink the forwards column first, never below something still readable.
    const forwardsIndex = 3
    widths[forwardsIndex] = Math.max(8, (widths[forwardsIndex] ?? 0) - overflow)
  }

  /** `padVisible` measures with `Bun.stringWidth`, which does not count escapes — so a
   * painted cell pads to the same column as a plain one. */
  const cell = (text: string, i: number, paint?: (t: string) => string): string => {
    const w = widths[i] ?? 0
    const clipped = truncateVisible(text, w, theme.symbols.ellipsis)
    return padVisible(paint ? paint(clipped) : clipped, w)
  }

  const lines = [
    `${INDENT}${headers.map((h, i) => cell(h, i, theme.muted)).join(GUTTER)}`.trimEnd()
  ]

  for (const row of rows) {
    const cells = keys.map((key, i) =>
      cell(row[key], i, key === 'status' ? row.paint : key === 'id' ? theme.bold : undefined)
    )
    lines.push(`${INDENT}${cells.join(GUTTER)}`.trimEnd())
  }

  return lines.join('\n')
}

export default defineCommand({
  name: 'ls' as const,
  description: 'List background forwarding sessions',
  defaultFormat: 'json' as const,
  options: {
    json: option(z.coerce.boolean().default(false), {
      description: 'Force JSON output',
      argumentKind: 'flag'
    }),
    prune: option(z.coerce.boolean().default(false), {
      description: 'Also report the stale records that were cleaned up',
      argumentKind: 'flag'
    })
  },
  handler: async ({ flags, agent, formatExplicit, output, env, terminal }) => {
    const startedAt = Date.now()

    try {
      // Always, not only under --prune: a record whose supervisor is gone describes a tunnel
      // that no longer exists, and listing it would send someone to a port nothing is on.
      const pruned = await pruneDead(env)
      const sessions = await listSessions(env)

      if (isMachine({ agent, formatExplicit }, flags.json)) {
        output(
          envelope(
            'ls',
            {
              sessions: sessions.map((rec) => ({
                id: rec.id,
                name: rec.name,
                pid: rec.pid,
                status: rec.status,
                target: formatTarget(rec.target),
                forwards: rec.forwards,
                startedAt: rec.startedAt,
                reconnects: rec.reconnects,
                logFile: rec.logFile,
                // Verbose for a listing, but it is the one thing that answers "what did mirb
                // actually run?" without opening a file, and only a program ever sees it.
                sshArgv: rec.sshArgv
              })),
              pruned
            },
            startedAt
          )
        )
        return
      }

      const theme = createTheme({ env, terminal })

      if (flags.prune && pruned.length > 0) {
        process.stdout.write(`${INDENT}${theme.muted(`cleaned up ${pruned.length} stale record${pruned.length === 1 ? '' : 's'}`)}\n`)
      }

      if (sessions.length === 0) {
        process.stdout.write(
          `${INDENT}${theme.muted('no background sessions')}\n` +
            `${INDENT}${theme.muted('start one with: mirb --background <host> <port>')}\n`
        )
        return
      }

      const rows = sessions.map((rec) => toRow(rec, theme, startedAt))
      process.stdout.write(`${render(rows, theme, terminal.width)}\n`)
    } catch (err) {
      fail(err)
    }
  }
})
