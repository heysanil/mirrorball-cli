import type { OutputEnvelope } from '@bunli/core'
import type { EnvLike } from '../core/config.ts'
import { MirbError } from '../core/errors.ts'
import { resolveIdPrefix, shortId } from '../core/ids.ts'
import { asMirbError } from '../core/session.ts'
import { listSessions } from '../core/state.ts'
import { formatTarget } from '../core/target.ts'
import type { SessionRecord } from '../core/types.ts'
import { createStaticReporter } from '../ui/static.ts'

/**
 * The decisions every mirb command has to make identically.
 *
 * They live together because the alternative is five copies that drift, and a failure that
 * exits 1 in `stop` but 4 in `up` is indistinguishable from a bug in the tunnel itself.
 * Nothing here knows about ssh; this is presentation and argument resolution only.
 */

/** The two fields of bunli's handler context that decide human-vs-machine output. */
export interface OutputContext {
  /** bunli sets this when stdout is not a TTY. */
  agent: boolean
  /** Whether the user typed --format. */
  formatExplicit: boolean
}

/**
 * Is anything human reading stdout?
 *
 * Three signals that all mean the same thing: an explicit `--json`, an explicit `--format`,
 * or a stdout that is not a terminal. The last is what makes `mirb host 3000 | jq` produce
 * machine output without anyone having to remember a flag.
 */
export function isMachine(ctx: OutputContext, json = false): boolean {
  return json || ctx.formatExplicit || ctx.agent
}

/**
 * bunli's `output()` serialises whatever it is handed; the `{ok, data, meta}` envelope is
 * ours to build, and building it in one place is what keeps every command's JSON the same
 * shape.
 */
export function envelope<T>(command: string, data: T, startedAt?: number): OutputEnvelope<T> {
  return {
    ok: true,
    data,
    meta: startedAt === undefined ? { command } : { command, durationMs: Date.now() - startedAt }
  }
}

/**
 * Report a failure the way mirb promises to — typed message, its hint, and the documented
 * exit code — then leave.
 *
 * It exits rather than rethrowing because bunli's own catch collapses every handler error
 * to exit 1, and the exit code is part of mirb's interface (docs/reference/exit-codes.md).
 * Errors always go to stderr, including in machine mode: stdout carries data or nothing.
 */
export function fail(err: unknown): never {
  const error = asMirbError(err)
  createStaticReporter().error(error)
  process.exit(error.exitCode)
}

/** `3000 <- 3000, 8080 <- 80` — enough to recognise a session without reading its record. */
export function forwardsSummary(rec: SessionRecord, arrow = '<-'): string {
  return rec.forwards.map((f) => `${f.localPort} ${arrow} ${f.remotePort}`).join(', ')
}

/** One line per session, for the candidate lists an ambiguous argument produces. */
function describe(rec: SessionRecord): string {
  const name = rec.name ? ` (${rec.name})` : ''
  return `${shortId(rec.id)}${name} -> ${formatTarget(rec.target)}`
}

/**
 * Mirror of `resolveIdPrefix`'s matching rule, used only to *name* the candidates when it
 * refuses to choose. The rule itself lives in core/ids.ts and this must not diverge from it.
 */
function prefixMatches(fragment: string, sessions: SessionRecord[]): SessionRecord[] {
  const bare = fragment.startsWith('mb_') ? fragment.slice(3) : fragment
  return sessions.filter((s) => s.id === fragment || s.id.slice(3).startsWith(bare))
}

/**
 * Resolve what the user typed to the sessions they meant.
 *
 * An id prefix resolves to exactly one session or to nothing — an ambiguous one is an
 * error listing the candidates, never a guess, because the operation on the other end of
 * this is `stop`. A host or a name is different: naming a host is a deliberate statement
 * about *which host*, so two tunnels to the same host both match and both are acted on.
 */
export async function findSessions(
  fragment: string,
  env: EnvLike = process.env
): Promise<SessionRecord[]> {
  const sessions = await listSessions(env)

  if (sessions.length === 0) {
    throw new MirbError(
      'SESSION_NOT_FOUND',
      'there are no background sessions',
      'Start one with: mirb --background <host> <port>'
    )
  }

  let id: string | null = null
  try {
    id = resolveIdPrefix(fragment, sessions.map((s) => s.id))
  } catch {
    const candidates = prefixMatches(fragment, sessions)
    throw new MirbError(
      'SESSION_NOT_FOUND',
      `'${fragment}' matches ${candidates.length} sessions`,
      `Be more specific: ${candidates.map(describe).join('; ')}`
    )
  }

  if (id !== null) {
    const found = sessions.find((s) => s.id === id)
    if (found) return [found]
  }

  const byLabel = sessions.filter(
    (s) => s.name === fragment || s.target.host === fragment || s.target.raw === fragment
  )
  if (byLabel.length > 0) return byLabel

  throw new MirbError(
    'SESSION_NOT_FOUND',
    `no session matches '${fragment}'`,
    `Known sessions: ${sessions.map(describe).join('; ')}`
  )
}

/**
 * The last `count` lines of a blob of text.
 *
 * Trailing blank lines are dropped rather than counted: a log file ends in a newline, and
 * `--lines 1` returning an empty string would look like an empty log.
 */
export function tailLines(text: string, count: number): string[] {
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return count >= lines.length ? lines : lines.slice(lines.length - count)
}
