import { writeSync } from 'node:fs'
import { isExposedAddress } from '../core/bind.ts'
import type { ForwardState, SessionStatus } from '../core/types.ts'
import { forwardLabel, type Theme } from './theme.ts'

/**
 * The live status display: a hand-written renderer, no dependency.
 *
 * The whole thing is arithmetic. Paint N lines, and on every update move the cursor up
 * exactly N and paint them again. That only survives contact with a real terminal if two
 * invariants hold, and both are enforced here rather than hoped for:
 *
 * 1. **No line ever wraps.** A wrapped line occupies two rows, the cursor-up count is
 *    then wrong by one, and every subsequent frame eats a line of the user's scrollback.
 *    So every line is truncated to the frame width, and width is measured with
 *    `Bun.stringWidth` — `.length` counts a CJK hostname at half its true width and an
 *    escape sequence as visible text, and either mistake wraps the line.
 * 2. **The cursor comes back.** It is hidden for the duration and restored on the way out
 *    of every exit path there is: `stop()`, an abort, a throw, process exit. A tool that
 *    leaves a terminal with no cursor is remembered for it.
 */

const ESC = '\u001b'
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const CLEAR_LINE = `${ESC}[2K`
const FULL_RESET = `${ESC}[0m`
const COLUMN_ONE = '\r'

/** Indents. The header sits one column left of the rows so it reads as a title, not an item. */
const HEADER_INDENT = '  '
const ROW_INDENT = '   '

/**
 * The frame never stretches to fill a wide terminal — a status block spanning 200 columns
 * is harder to read than one spanning 60, because the eye has to travel to find the answer.
 */
const PREFERRED_FRAME_WIDTH = 60

/** Minimum breathing room between the remote address and the right-aligned status word. */
const MIN_GAP = 4

/** Everything the display needs to draw one frame. A snapshot, never a mutable handle. */
export interface LiveModel {
  /** What the user typed, or the resolved host. Shown next to mirb's name. */
  target: string
  forwards: ForwardState[]
  status: SessionStatus
  /** `Date.now()` at session start, for the uptime counter. */
  startedAt: number
  /** pid of ssh, not of mirb. Shown so the user can find it in `ps`. */
  sshPid?: number
  reconnects: number
  /** Whether probing is on; decides whether `bound` reads as "probing" or "bound". */
  probe?: boolean
  /** One line of transient context, e.g. "reconnecting in 4s (attempt 2)". */
  note?: string
}

export interface LiveDisplay {
  update(model: LiveModel): void
  /** Repaint with a new note, keeping the last model. */
  note(text: string): void
  /** Restore the terminal and leave the final frame on screen. Idempotent. */
  stop(final?: { note?: string }): void
}

interface WritableLike {
  write(chunk: string): unknown
  columns?: number
  rows?: number
  /** Present on real stdio. The only way to restore the cursor from an `exit` handler. */
  fd?: number
}

export interface LiveOptions {
  theme: Theme
  /**
   * Defaults to stdout. Live mode only ever runs when stdout is an interactive TTY, so
   * there is no capture to pollute — and keeping it on stdout means a user who sends
   * stderr to a log file still sees their tunnels.
   */
  stream?: WritableLike
  /** Cancels the display without the caller having to remember to. */
  signal?: AbortSignal
  width?: () => number
  height?: () => number
  now?: () => number
}

/* ------------------------------------------------------------------ text measuring */

/**
 * Visible width, ignoring anything already painted.
 *
 * `Bun.stringWidth` does not count ANSI escapes by default and knows that a CJK glyph
 * occupies two cells, which is exactly the pair of facts the column maths needs.
 */
export function visibleWidth(text: string): number {
  return Bun.stringWidth(text)
}

interface Chunk {
  ansi: boolean
  value: string
}

/** CSI sequences, matched only at the current position so text can never be mistaken for one. */
const CSI = /\u001b\[[0-9;:?]*[ -\/]*[@-~]/y

/** Splits a painted string into escape runs and printable runs. */
function chunks(text: string): Chunk[] {
  const out: Chunk[] = []
  let i = 0
  let plain = ''

  while (i < text.length) {
    if (text[i] === ESC) {
      CSI.lastIndex = i
      const m = CSI.exec(text)
      if (m) {
        if (plain) {
          out.push({ ansi: false, value: plain })
          plain = ''
        }
        out.push({ ansi: true, value: m[0] })
        i = CSI.lastIndex
        continue
      }
    }
    plain += text[i]
    i += 1
  }

  if (plain) out.push({ ansi: false, value: plain })
  return out
}

/**
 * Graphemes, not code points: a combining accent or a ZWJ emoji is one cell group, and
 * cutting inside one produces a glyph the terminal renders at a width nobody predicted.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Truncate to a visible width, preserving the escape sequences along the way.
 *
 * Escapes are copied through without consuming width, so a string that arrives already
 * painted truncates in the same place its plain equivalent would. A full reset is appended
 * when the cut lands inside a painted run — otherwise the colour bleeds across the rest of
 * the terminal line.
 */
export function truncateVisible(text: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return ''
  if (visibleWidth(text) <= max) return text

  const cut = Math.max(0, max - visibleWidth(ellipsis))
  let used = 0
  let out = ''
  let painted = false

  outer: for (const chunk of chunks(text)) {
    if (chunk.ansi) {
      out += chunk.value
      painted = true
      continue
    }
    for (const { segment } of segmenter.segment(chunk.value)) {
      const w = visibleWidth(segment)
      if (used + w > cut) break outer
      out += segment
      used += w
    }
  }

  return `${out}${ellipsis}${painted ? FULL_RESET : ''}`
}

/** Pad on the right to a visible width. A no-op when the text is already wider. */
export function padVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

/**
 * Left content, right content, one line, at most `width` visible columns.
 *
 * When the two cannot both fit, the left side gives way — the status word on the right is
 * the answer to the question the user is asking, so it is the last thing to go.
 */
export function layoutLine(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right)
  if (rightWidth === 0) return truncateVisible(left, width)

  // Not enough room to keep both halves legible: drop the right rather than shave it down
  // to an ambiguous stub.
  if (width < rightWidth + 4) return truncateVisible(left, width)

  const leftWidth = visibleWidth(left)
  if (leftWidth + 1 + rightWidth > width) {
    return `${truncateVisible(left, width - rightWidth - 1)} ${right}`
  }

  return left + ' '.repeat(width - leftWidth - rightWidth) + right
}

/* ---------------------------------------------------------------------- formatting */

/**
 * Uptime at the resolution a human cares about: seconds while you are waiting for it to
 * come up, minutes once it has, hours once you have forgotten it is running.
 */
export function formatUptime(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** `localhost:3000` — the string people actually paste into a browser. */
export function localLabel(f: Pick<ForwardState, 'bindAddress' | 'localPort'>): string {
  const a = f.bindAddress
  const host =
    a === '' || a === '127.0.0.1' || a === '::1' || a === 'localhost'
      ? 'localhost'
      : a === '*'
        ? '0.0.0.0'
        : a
  return `${host}:${f.localPort}`
}

export function remoteLabel(f: Pick<ForwardState, 'remoteHost' | 'remotePort'>): string {
  return `${f.remoteHost}:${f.remotePort}`
}

/**
 * Does this forward listen anywhere other than this machine?
 *
 * `-L 0.0.0.0:5432:...` publishes an internal database to every device on the network,
 * and ssh says nothing about it: GatewayPorts governs what *sshd* will relay, not what
 * the local end binds, so there is no warning from anywhere else in the stack. The
 * banner this drives is the only thing between a user and an accident, which is why the
 * test is a whitelist of loopback spellings rather than a blacklist of dangerous ones —
 * an address nobody thought of has to come out on the loud side.
 */
export function isExposed(f: Pick<ForwardState, 'bindAddress'>): boolean {
  // Delegates to core so the security rule has exactly one definition. Presentation
  // must never get its own opinion about what counts as exposed.
  return isExposedAddress(f.bindAddress)
}

/** Every forward reachable from off-box, in the order the user wrote them. */
export function exposedForwards(forwards: ForwardState[]): ForwardState[] {
  return forwards.filter(isExposed)
}

/* ------------------------------------------------------------------------ rendering */

/**
 * Build the frame. Pure: same model, same theme, same width, same lines — which is what
 * makes the layout testable without a terminal, and the reason the renderer below only has
 * to worry about cursor arithmetic.
 *
 * Every returned line is at most `width` visible columns and contains no newline.
 */
export function renderFrame(
  model: LiveModel,
  theme: Theme,
  width: number,
  now = Date.now()
): string[] {
  const rows = model.forwards.map((f) => ({
    style: theme.forward[f.status],
    label: forwardLabel(f.status, model.probe ?? true),
    local: localLabel(f),
    remote: remoteLabel(f),
    exposed: isExposed(f)
  }))

  const localCol = Math.max(0, ...rows.map((r) => visibleWidth(r.local)))
  const remoteCol = Math.max(0, ...rows.map((r) => visibleWidth(r.remote)))
  const statusCol = Math.max(0, ...rows.map((r) => visibleWidth(r.label)))
  const symbolCol = Math.max(1, ...rows.map((r) => visibleWidth(r.style.symbol)))
  const arrow = theme.symbols.arrow

  const natural =
    ROW_INDENT.length +
    symbolCol +
    2 +
    localCol +
    3 +
    visibleWidth(arrow) +
    2 +
    remoteCol +
    MIN_GAP +
    statusCol

  // Never wider than the terminal, whatever the content wants. Below about 24 columns the
  // result stops being a table and becomes a list of truncated strings — which is still the
  // right answer, because the alternative is a line that wraps, and one wrapped line makes
  // every subsequent cursor-up count wrong by one for the rest of the session.
  const frameWidth = Math.max(1, Math.min(width, Math.max(natural, PREFERRED_FRAME_WIDTH)))

  const lines: string[] = []

  const uptime = `up ${formatUptime(now - model.startedAt)}`
  const title = `${HEADER_INDENT}${theme.identity('mirb')} ${theme.muted(theme.symbols.link)} ${theme.bold(model.target)}`
  lines.push(layoutLine(title, theme.muted(uptime), frameWidth))

  // Persistent, not a one-shot notice: the whole risk of a non-loopback bind is that it
  // is invisible, and a warning that scrolls away is invisible after ten seconds. It sits
  // above the forwards because it is a fact about the session, not about one row.
  const exposed = rows.filter((r) => r.exposed)
  if (exposed.length > 0) {
    const dash = theme.unicode ? ' — ' : ' - '
    const where = exposed.map((r) => r.local).join(', ')
    const banner = `${theme.symbols.alert}  exposed on ${where}${dash}reachable from your network`
    lines.push(truncateVisible(`${HEADER_INDENT}${theme.alert(banner)}`, frameWidth))
  }

  lines.push('')

  for (const row of rows) {
    const left =
      ROW_INDENT +
      padVisible(row.style.paint(row.style.symbol), symbolCol) +
      '  ' +
      padVisible(row.exposed ? theme.alert(row.local) : row.local, localCol) +
      '   ' +
      theme.muted(arrow) +
      '  ' +
      padVisible(theme.muted(row.remote), remoteCol)
    lines.push(layoutLine(left, row.style.paint(row.label), frameWidth))
  }

  lines.push('')

  if (model.note) {
    lines.push(truncateVisible(`${ROW_INDENT}${theme.warn(model.note)}`, frameWidth))
  }

  const parts: string[] = []
  if (model.sshPid !== undefined) parts.push(`ssh ${model.sshPid}`)
  parts.push(`reconnects ${model.reconnects}`)
  if (model.status !== 'stopped' && model.status !== 'failed') parts.push('^C to stop')

  lines.push(
    truncateVisible(`${ROW_INDENT}${theme.muted(parts.join(` ${theme.symbols.dot} `))}`, frameWidth)
  )

  return lines
}

/* --------------------------------------------------------------------- the renderer */

class Renderer implements LiveDisplay {
  private readonly theme: Theme
  private readonly stream: WritableLike
  private readonly widthOf: () => number
  private readonly heightOf: () => number
  private readonly now: () => number
  private readonly signal?: AbortSignal

  private painted = 0
  private model: LiveModel | undefined
  private hidden = false
  private stopped = false

  private readonly onResize = () => this.paint()
  private readonly onAbort = () => this.stop()
  private readonly onExit = () => this.restoreCursor()

  constructor(opts: LiveOptions) {
    this.theme = opts.theme
    this.stream = opts.stream ?? process.stdout
    this.widthOf = opts.width ?? (() => this.stream.columns ?? 80)
    this.heightOf = opts.height ?? (() => this.stream.rows ?? 24)
    this.now = opts.now ?? Date.now
    this.signal = opts.signal
  }

  update(model: LiveModel): void {
    this.model = model
    this.paint()
  }

  note(text: string): void {
    if (!this.model) return
    this.update({ ...this.model, note: text })
  }

  stop(final?: { note?: string }): void {
    if (this.stopped) return

    if (final?.note !== undefined && this.model) {
      this.model = { ...this.model, note: final.note }
      this.paint()
    }

    this.stopped = true
    this.teardown()
    this.restoreCursor()
  }

  private paint(): void {
    if (this.stopped || !this.model) return

    const width = Math.max(1, this.widthOf())
    let frame = renderFrame(this.model, this.theme, width, this.now())

    // A frame taller than the window scrolls, and scrolled lines cannot be reached by
    // moving the cursor up. Dropping forwards from the display is ugly; a display that
    // walks up the screen eating scrollback is worse.
    const maxLines = Math.max(3, this.heightOf() - 1)
    if (frame.length > maxLines) {
      const dropped = frame.length - (maxLines - 1)
      frame = [
        ...frame.slice(0, maxLines - 1),
        truncateVisible(`${ROW_INDENT}${this.theme.muted(`+${dropped} more`)}`, width)
      ]
    }

    let out = ''
    if (!this.hidden) {
      out += HIDE_CURSOR
      this.hidden = true
      this.arm()
    }
    if (this.painted > 0) out += `${ESC}[${this.painted}A`

    for (const line of frame) out += `${COLUMN_ONE}${CLEAR_LINE}${line}\n`

    // The previous frame was taller: blank what is left over, then come back to the bottom
    // of the new frame so the next cursor-up count stays honest.
    const leftover = this.painted - frame.length
    if (leftover > 0) {
      for (let i = 0; i < leftover; i++) out += `${COLUMN_ONE}${CLEAR_LINE}\n`
      out += `${ESC}[${leftover}A`
    }

    this.painted = frame.length
    this.stream.write(out)
  }

  private arm(): void {
    process.on('SIGWINCH', this.onResize)
    process.once('exit', this.onExit)
    this.signal?.addEventListener('abort', this.onAbort, { once: true })

    // Adding a signal listener suppresses the default terminate, so mirb would silently stop
    // responding to ^C. Attaching only where a handler already exists leaves the process's
    // shutdown semantics exactly as the caller set them up.
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      if (process.listenerCount(sig) > 0) process.once(sig, this.onExit)
    }
  }

  private teardown(): void {
    process.off('SIGWINCH', this.onResize)
    process.off('exit', this.onExit)
    process.off('SIGINT', this.onExit)
    process.off('SIGTERM', this.onExit)
    this.signal?.removeEventListener('abort', this.onAbort)
  }

  /**
   * Safe to call from an `exit` handler, and safe to call twice — which it will be, on the
   * path where `stop()` follows a signal.
   *
   * It prefers `writeSync` on the descriptor. By the time `exit` fires the event loop is
   * gone, so anything a stream defers is silently dropped — and the one situation where
   * this matters most, a crash, is exactly the one that takes the deferred path. A user
   * left typing at an invisible cursor after mirb died is the bug they will remember.
   */
  private restoreCursor(): void {
    if (!this.hidden) return
    this.hidden = false

    const fd = this.stream.fd
    if (typeof fd === 'number') {
      try {
        writeSync(fd, SHOW_CURSOR)
        return
      } catch {
        // Fall through: a deferred write still beats a hidden cursor.
      }
    }

    try {
      this.stream.write(SHOW_CURSOR)
    } catch {
      // A closed stdout cannot be un-hidden; there is nothing useful left to do about it.
    }
  }
}

export function createLiveDisplay(opts: LiveOptions): LiveDisplay {
  return new Renderer(opts)
}
