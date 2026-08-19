import { MirbError } from '../core/errors.ts'
import type { ForwardState, ForwardStatus } from '../core/types.ts'
import { forwardLabel, SESSION_LABELS } from './theme.ts'
import { exposedForwards, formatUptime, localLabel, remoteLabel, type LiveModel } from './live.ts'

/**
 * The fallback display: append-only lines, no ANSI, no cursor movement.
 *
 * Used whenever the live renderer cannot be: stdout redirected, a CI log, `--quiet`, a
 * backgrounded supervisor writing to its log file. Everything here is designed to survive
 * being read six hours later out of a file, which rules out cursor tricks, colour, and
 * any line whose meaning depends on the line above it.
 *
 * It writes to **stderr** by default, and that is the whole point of the mode: it runs
 * precisely when something is capturing stdout, so progress chatter must not land there.
 * The invariant that pays for itself is `mirb host 3000 > out.txt` — progress still on the
 * terminal, `out.txt` still clean.
 */

interface WritableLike {
  write(chunk: string): unknown
}

export interface StaticOptions {
  /** Defaults to stderr. See the note above before changing this at a call site. */
  stream?: WritableLike
  /** Leading tag on every line, so mirb's output is greppable out of an interleaved log. */
  prefix?: string
  /** ISO-8601 stamps. Worth it in a log file, noise on a terminal. */
  timestamps?: boolean
  now?: () => Date
}

export interface StaticReporter {
  /** The one-line header: what is being forwarded, and where. */
  start(model: LiveModel): void
  /** Emits a line per forward whose state actually changed, plus the session roll-up. */
  update(model: LiveModel): void
  note(text: string): void
  error(err: unknown): void
  stop(model?: LiveModel): void
}

/** ASCII, always: this text ends up in files read by tools that assume a byte is a column. */
const ARROW = '<-'

function describe(f: ForwardState, probe: boolean): string {
  const detail = f.detail ? ` (${f.detail})` : ''
  return `${localLabel(f)} ${ARROW} ${remoteLabel(f)} ${forwardLabel(f.status, probe)}${detail}`
}

/** "2 ready, 1 refused" — the counts, in the same words the live display uses. */
function tally(forwards: ForwardState[], probe: boolean): string {
  const counts = new Map<ForwardStatus, number>()
  for (const f of forwards) counts.set(f.status, (counts.get(f.status) ?? 0) + 1)

  const parts: string[] = []
  for (const [status, n] of counts) parts.push(`${n} ${forwardLabel(status, probe)}`)
  return parts.join(', ')
}

class Reporter implements StaticReporter {
  private readonly stream: WritableLike
  private readonly prefix: string
  private readonly timestamps: boolean
  private readonly now: () => Date

  private readonly seen = new Map<number, ForwardStatus>()
  private lastStatus: string | undefined
  private started = false

  constructor(opts: StaticOptions) {
    this.stream = opts.stream ?? process.stderr
    this.prefix = opts.prefix ?? 'mirb'
    this.timestamps = opts.timestamps ?? false
    this.now = opts.now ?? (() => new Date())
  }

  start(model: LiveModel): void {
    if (this.started) return
    this.started = true

    const n = model.forwards.length
    this.line(`${model.target}: ${n} forward${n === 1 ? '' : 's'}`)
    for (const f of model.forwards) {
      this.line(`  ${localLabel(f)} ${ARROW} ${remoteLabel(f)}`)
    }

    // The live display carries this as a persistent banner. Here there is no banner and
    // no colour to lean on, so it has to be a line that says the word "warning" — this
    // mode is exactly where an unattended run publishes a service and nobody notices.
    const exposed = exposedForwards(model.forwards)
    if (exposed.length > 0) {
      this.line(
        `warning: exposed on ${exposed.map(localLabel).join(', ')} - reachable from your network`
      )
    }
  }

  update(model: LiveModel): void {
    this.start(model)
    const probe = model.probe ?? true

    // Only transitions are printed. A poll loop that re-reported every forward every
    // second would bury the one line that mattered under a thousand that did not.
    for (const f of model.forwards) {
      if (this.seen.get(f.localPort) === f.status) continue
      this.seen.set(f.localPort, f.status)
      if (f.status === 'pending') continue
      this.line(describe(f, probe))
    }

    const summary = `session ${SESSION_LABELS[model.status]} (${tally(model.forwards, probe)})`
    if (summary !== this.lastStatus) {
      this.lastStatus = summary
      this.line(summary)
    }

    if (model.note) this.note(model.note)
  }

  note(text: string): void {
    this.line(text)
  }

  /**
   * Errors go here in every mode, including the machine ones — an `MirbError` carries a
   * hint, and a hint that is never printed is worse than not having written it.
   */
  error(err: unknown): void {
    if (err instanceof MirbError) {
      this.line(`error: ${err.message}`)
      if (err.hint) this.line(`hint: ${err.hint}`)
      return
    }
    this.line(`error: ${err instanceof Error ? err.message : String(err)}`)
  }

  stop(model?: LiveModel): void {
    if (!model) {
      this.line('stopped')
      return
    }
    this.line(`stopped after ${formatUptime(this.now().getTime() - model.startedAt)}`)
  }

  /**
   * The single exit for every line, so "this renderer emits no ANSI and no partial
   * lines" holds by construction rather than by everyone remembering.
   *
   * Stripping is not paranoia about mirb's own strings: `detail` comes from ssh's stderr
   * and from the user's config, and these lines end up in log files that someone later
   * `cat`s straight into a terminal. Newlines collapse for the same reason — one record
   * per line is what makes the log greppable.
   */
  private line(text: string): void {
    const stamp = this.timestamps ? `${this.now().toISOString()} ` : ''
    const clean = Bun.stripANSI(text).replace(/[\r\n]+/g, ' ').trimEnd()
    try {
      this.stream.write(`${stamp}${this.prefix}: ${clean}\n`)
    } catch {
      // A closed pipe is not a reason to tear down a working tunnel.
    }
  }
}

export function createStaticReporter(opts: StaticOptions = {}): StaticReporter {
  return new Reporter(opts)
}
