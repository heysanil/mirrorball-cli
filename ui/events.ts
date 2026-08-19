import { writeSync } from 'node:fs'
import type { MirbEvent } from '../core/types.ts'

/**
 * NDJSON: one compact JSON object per line, on stdout, flushed the instant it is written.
 *
 * This is the streaming half of machine mode. A consumer runs `mirb host 3000 | jq -c` and
 * reacts to `forward.ready` *as it happens* — which only works if the write actually
 * reaches the pipe, so every write goes through `writeSync` rather than a buffered stream.
 * A stream that batches until exit is not a stream; it is a report, delivered late, by a
 * process whose entire job is to keep running.
 *
 * Stdout is machine output and nothing else. Anything a human is meant to read — progress,
 * warnings, errors, hints — goes to stderr via `ui/static.ts`. There is no exception to
 * this, because the exception is exactly what makes a consumer's `JSON.parse` fail at
 * 3am on the one line that explains why.
 */

/** The same events, minus the timestamp, which this module fills in. */
type StripTs<T> = T extends { ts: string } ? Omit<T, 'ts'> : never
export type MirbEventInput = StripTs<MirbEvent>

export interface EventStream {
  emit(event: MirbEvent | MirbEventInput): void
  /** Stops further writes. Nothing is buffered, so there is nothing to flush. */
  close(): void
}

export interface EventStreamOptions {
  /** File descriptor to write to. 1 (stdout) unless a test says otherwise. */
  fd?: number
  now?: () => Date
}

/** A pipe with a slow reader returns EAGAIN; this bounds how long we are willing to block. */
const EAGAIN_RETRY_MS = 1
const EAGAIN_MAX_RETRIES = 200

/**
 * Serialise one event. Exported because it is the whole format: no indentation (a line is
 * a record), and `JSON.stringify` escapes any newline inside a message, so a single
 * hostile hostname cannot split one event into two.
 */
export function eventLine(event: MirbEvent): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * Write every byte, or give up quietly.
 *
 * `writeSync` can return a short count, so it is looped. EPIPE means the consumer closed
 * the pipe — a `| head -1` is a normal way to use this, not a crash — so the stream simply
 * goes dead rather than taking mirb's tunnel down with it.
 */
function writeAll(fd: number, text: string): boolean {
  const buf = Buffer.from(text, 'utf8')
  let offset = 0
  let retries = 0

  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset, buf.length - offset)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EAGAIN') {
        if (retries++ >= EAGAIN_MAX_RETRIES) return false
        Bun.sleepSync(EAGAIN_RETRY_MS)
        continue
      }
      // EPIPE, EBADF, a closed fd: all mean the same thing to us.
      return false
    }
  }

  return true
}

class Stream implements EventStream {
  private readonly fd: number
  private readonly now: () => Date
  private dead = false

  constructor(opts: EventStreamOptions) {
    this.fd = opts.fd ?? 1
    this.now = opts.now ?? (() => new Date())
  }

  emit(event: MirbEvent | MirbEventInput): void {
    if (this.dead) return

    // `ts` is filled here rather than at the call site so every event in a run is stamped
    // by the same clock, in the same format, whether or not the caller remembered.
    const stamped = ('ts' in event ? event : { ...event, ts: this.now().toISOString() }) as MirbEvent

    if (!writeAll(this.fd, eventLine(stamped))) this.dead = true
  }

  close(): void {
    this.dead = true
  }
}

export function createEventStream(opts: EventStreamOptions = {}): EventStream {
  return new Stream(opts)
}

let shared: EventStream | undefined

/** The process-wide stdout stream. Lazily created so tests can avoid it entirely. */
export function events(): EventStream {
  shared ??= createEventStream()
  return shared
}

export function emitEvent(event: MirbEvent | MirbEventInput): void {
  events().emit(event)
}
