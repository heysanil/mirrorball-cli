import type { ForwardStatus, SessionStatus } from '../core/types.ts'

/**
 * The one place in mirb that knows what an escape sequence looks like.
 *
 * Everything visual — colour, glyphs, and the single word mirb uses for each state —
 * resolves through a `Theme`. Nothing else in the codebase hardcodes an escape
 * sequence or invents its own vocabulary, so `mirb ls` and the live display can never
 * drift into describing the same state with different words.
 */

export type ColorLevel = 'none' | 'ansi256' | 'truecolor'

export type Paint = (text: string) => string

/**
 * Chosen to stay legible on both light and dark backgrounds: mid-tone, desaturated
 * enough not to shimmer, and distinguishable in the common forms of colour blindness
 * (green/red never carry meaning alone — every state also has its own glyph and word).
 */
export const PALETTE = {
  /** mirb's own name and anything structural. */
  identity: '#5eead4',
  /** A forward that is genuinely usable. */
  ready: '#4ade80',
  /** In flight, or up-but-degraded. Never "broken". */
  warn: '#fbbf24',
  /** mirb could not do the thing. */
  fail: '#f87171',
  /** Secondary text: timers, pids, hints. */
  muted: '#6b7280'
} as const

export interface Symbols {
  ready: string
  connecting: string
  refused: string
  failed: string
  pending: string
  /** Data flows remote -> local, so the arrow points at the local port. */
  arrow: string
  /** Header glyph, between `mirb` and the target. */
  link: string
  /** Separator in the footer. */
  dot: string
  ellipsis: string
  /**
   * The non-loopback bind warning. Deliberately louder than any status glyph: it is the
   * one thing on screen that is about the user's exposure rather than their tunnel.
   */
  alert: string
}

/**
 * `refused` is a hollow ring against `ready`'s filled one: the tunnel exists, there is
 * nothing on the far end of it. That relationship is the product in one glyph.
 */
const UNICODE_SYMBOLS: Symbols = {
  ready: '●',
  connecting: '◐',
  refused: '○',
  failed: '✕',
  pending: '·',
  arrow: '←',
  link: '⇄',
  dot: '·',
  ellipsis: '…',
  alert: '▲'
}

/** Several of these are wider than one column; all measurement goes through `Bun.stringWidth`. */
const ASCII_SYMBOLS: Symbols = {
  ready: '*',
  connecting: 'o',
  refused: '!',
  failed: 'x',
  pending: '.',
  arrow: '<-',
  link: '<->',
  dot: '-',
  ellipsis: '...',
  // Two characters, because a single '!' is already the ASCII glyph for 'refused' and the
  // security banner must never be mistaken for a status row.
  alert: '!!'
}

export interface StatusStyle {
  symbol: string
  label: string
  paint: Paint
}

/** The canonical word for each forward state. Exported so no caller invents a synonym. */
export const FORWARD_LABELS: Record<ForwardStatus, string> = {
  pending: 'pending',
  bound: 'bound',
  ready: 'ready',
  refused: 'refused',
  failed: 'failed'
}

export const SESSION_LABELS: Record<SessionStatus, string> = {
  starting: 'starting',
  connecting: 'connecting',
  ready: 'ready',
  degraded: 'degraded',
  reconnecting: 'reconnecting',
  stopped: 'stopped',
  failed: 'failed'
}

/**
 * `bound` means two different things depending on whether probing is on.
 *
 * When probing is on (the default), it is a waypoint: the socket is up and a probe is in
 * flight, so
 * "probing" is the honest word. With `--no-probe` it is the terminal state and there is
 * nothing to probe — calling that "probing" forever would be a lie the user can see.
 */
export function forwardLabel(status: ForwardStatus, probe = true): string {
  if (status === 'bound' && probe) return 'probing'
  return FORWARD_LABELS[status]
}

export interface Theme {
  readonly level: ColorLevel
  readonly unicode: boolean
  readonly symbols: Symbols
  /**
   * Keyed by the full `ForwardStatus` union rather than by loose names, so adding a
   * state to the contract fails the build here instead of rendering as a blank column.
   */
  readonly forward: Record<ForwardStatus, StatusStyle>
  readonly session: Record<SessionStatus, StatusStyle>
  readonly identity: Paint
  readonly ok: Paint
  readonly warn: Paint
  readonly bad: Paint
  readonly muted: Paint
  readonly bold: Paint
  readonly dim: Paint
  /**
   * A security warning, not a status. Reserved for the one case mirb has: a forward bound
   * to something other than loopback, which publishes a service to the whole network.
   *
   * Bold amber rather than red, and for the same reason `refused` is amber — red is the
   * colour of "mirb failed". Nothing has failed here; the user is about to be surprised.
   * With colour off the alert survives as its glyph and its wording, which is why the
   * banner never leans on the colour alone.
   */
  readonly alert: Paint
}

export interface ThemeOptions {
  env?: Record<string, string | undefined>
  /** Bunli's `TerminalInfo`; only `supportsColor` is read. */
  terminal?: { supportsColor?: boolean }
  /** Skip detection. Used by tests and by an explicit user flag. */
  level?: ColorLevel
  unicode?: boolean
}

/** Reset the foreground only: a full SGR reset would also cancel an enclosing bold. */
const FG_RESET = '\u001b[39m'
/** SGR 22 clears bold *and* dim, which is exactly the pair it is used to close. */
const WEIGHT_RESET = '\u001b[22m'

const identity: Paint = (text) => text

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

/**
 * How much colour this destination can take.
 *
 * The order encodes who gets to overrule whom: an explicit `NO_COLOR` beats everything
 * (it is a promise a user made to their whole toolchain), then an explicit `FORCE_COLOR`
 * beats detection, then the detected capability. `TERM=dumb` is the one detection that
 * can veto a positive `supportsColor`, because a terminal that says it is dumb means it.
 */
export function detectColorLevel(
  env: Record<string, string | undefined> = process.env,
  terminal?: { supportsColor?: boolean }
): ColorLevel {
  // no-color.org: any value, including "0", counts — presence is the signal.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none'

  const forceRaw = env.FORCE_COLOR
  const forced = forceRaw !== undefined && truthy(forceRaw)
  if (forceRaw !== undefined && !forced) return 'none'
  if (forceRaw === '3') return 'truecolor'

  if (!forced) {
    const supported = terminal?.supportsColor ?? process.stdout.isTTY === true
    if (!supported) return 'none'
    if (env.TERM === 'dumb') return 'none'
  }

  const colorterm = env.COLORTERM?.toLowerCase() ?? ''
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return 'truecolor'
  if (forceRaw === '2' || forceRaw === '1') return 'ansi256'

  // 256 colours is the safe floor for anything that claims colour at all; the palette
  // quantises to it without any of the five hues collapsing into a neighbour.
  return 'ansi256'
}

/**
 * Can this terminal render the box-drawing and geometric glyphs?
 *
 * The locale is the only portable signal available before anything is drawn — there is
 * no way to ask a terminal whether it will render `●` without printing it and measuring
 * the cursor, which is far too invasive for a status display. An unset locale is treated
 * as not-UTF-8: mojibake in a status line is worse than plain ASCII in a status line.
 */
export function detectUnicode(env: Record<string, string | undefined> = process.env): boolean {
  if (truthy(env.MIRB_ASCII)) return false

  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG
  if (!locale) return false
  return /utf-?8/i.test(locale)
}

/**
 * `Bun.color` returns null for anything it cannot parse, and its 'ansi' mode is 24-bit.
 * A null result degrades to no-op rather than throwing: a mistyped hex should cost the
 * colour, never the output.
 */
function painter(hex: string, level: ColorLevel): Paint {
  if (level === 'none') return identity

  // 'ansi-16m', never 'ansi'. `Bun.color(hex, 'ansi')` re-decides colour support from the
  // environment and returns "" when it disapproves — so it would silently override the
  // level we just resolved. That resolution is deliberate: it already honours NO_COLOR,
  // FORCE_COLOR, terminal.supportsColor and COLORTERM, in that order. Letting Bun overrule
  // it means `FORCE_COLOR=3 mirb … | less -R` comes out monochrome despite being asked for
  // colour, and it makes the renderer's output depend on where it runs rather than on what
  // it was told. Naming the format keeps `level` authoritative.
  const seq = Bun.color(hex, level === 'truecolor' ? 'ansi-16m' : 'ansi-256')
  if (!seq) return identity

  // Empty strings are common in padding maths; wrapping them would emit escapes that
  // measure as zero but still confuse anything diffing the frame.
  return (text) => (text === '' ? text : `${seq}${text}${FG_RESET}`)
}

function attr(code: string, level: ColorLevel): Paint {
  if (level === 'none') return identity
  return (text) => (text === '' ? text : `${code}${text}${WEIGHT_RESET}`)
}

export function createTheme(opts: ThemeOptions = {}): Theme {
  const env = opts.env ?? process.env
  const level = opts.level ?? detectColorLevel(env, opts.terminal)
  const unicode = opts.unicode ?? detectUnicode(env)
  const symbols = unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS

  const bold = attr('\u001b[1m', level)
  const ok = painter(PALETTE.ready, level)
  const warn = painter(PALETTE.warn, level)
  const bad = painter(PALETTE.fail, level)
  const muted = painter(PALETTE.muted, level)

  // `refused` is amber, not red, and that is the single most load-bearing colour choice
  // in mirb: red says "mirb failed you", amber says "mirb worked, your service is down".
  // Sending a user to debug their ssh config when the tunnel is perfect is the exact
  // failure this tool exists to prevent.
  const forward: Record<ForwardStatus, StatusStyle> = {
    pending: { symbol: symbols.pending, label: FORWARD_LABELS.pending, paint: muted },
    bound: { symbol: symbols.connecting, label: FORWARD_LABELS.bound, paint: warn },
    ready: { symbol: symbols.ready, label: FORWARD_LABELS.ready, paint: ok },
    refused: { symbol: symbols.refused, label: FORWARD_LABELS.refused, paint: warn },
    failed: { symbol: symbols.failed, label: FORWARD_LABELS.failed, paint: bad }
  }

  const session: Record<SessionStatus, StatusStyle> = {
    starting: { symbol: symbols.connecting, label: SESSION_LABELS.starting, paint: warn },
    connecting: { symbol: symbols.connecting, label: SESSION_LABELS.connecting, paint: warn },
    ready: { symbol: symbols.ready, label: SESSION_LABELS.ready, paint: ok },
    degraded: { symbol: symbols.refused, label: SESSION_LABELS.degraded, paint: warn },
    reconnecting: { symbol: symbols.connecting, label: SESSION_LABELS.reconnecting, paint: warn },
    stopped: { symbol: symbols.pending, label: SESSION_LABELS.stopped, paint: muted },
    failed: { symbol: symbols.failed, label: SESSION_LABELS.failed, paint: bad }
  }

  return {
    level,
    unicode,
    symbols,
    forward,
    session,
    identity: painter(PALETTE.identity, level),
    ok,
    warn,
    bad,
    muted,
    bold,
    dim: attr('\u001b[2m', level),
    // Composable because both resets are partial: SGR 39 closes the colour and SGR 22 the
    // weight, so neither undoes the other and the pair nests cleanly.
    alert: (text) => bold(warn(text))
  }
}

/** A theme that emits nothing but text. What `ui/static.ts` and every log file get. */
export function plainTheme(unicode = false): Theme {
  return createTheme({ level: 'none', unicode, env: {} })
}
