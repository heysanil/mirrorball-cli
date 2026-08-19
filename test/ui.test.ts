import { describe, expect, test } from 'bun:test'
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTheme,
  detectColorLevel,
  detectUnicode,
  forwardLabel,
  plainTheme,
  type ColorLevel
} from '../ui/theme.ts'
import {
  createLiveDisplay,
  exposedForwards,
  formatUptime,
  isExposed,
  layoutLine,
  padVisible,
  renderFrame,
  truncateVisible,
  visibleWidth,
  type LiveModel
} from '../ui/live.ts'
import { createStaticReporter } from '../ui/static.ts'
import { createEventStream, eventLine } from '../ui/events.ts'
import type { ForwardState, ForwardStatus, MirbEvent } from '../core/types.ts'

const ESC = '\x1b'

/** A terminal that says yes, so a test is only ever exercising the variable it names. */
const CAPABLE = { supportsColor: true }

function forward(overrides: Partial<ForwardState> = {}): ForwardState {
  return {
    localPort: 3000,
    bindAddress: '127.0.0.1',
    remoteHost: 'localhost',
    remotePort: 3000,
    source: '3000',
    status: 'ready',
    ...overrides
  }
}

function model(overrides: Partial<LiveModel> = {}): LiveModel {
  return {
    target: '10.0.0.7',
    forwards: [forward()],
    status: 'ready',
    startedAt: 0,
    sshPid: 48213,
    reconnects: 0,
    ...overrides
  }
}

interface Sink {
  write(chunk: string): boolean
  columns?: number
  rows?: number
  readonly text: string
  readonly chunks: string[]
}

function sink(columns = 80, rows = 24): Sink {
  const chunks: string[] = []
  return {
    chunks,
    columns,
    rows,
    write(chunk: string) {
      chunks.push(chunk)
      return true
    },
    get text() {
      return chunks.join('')
    }
  }
}

/* --------------------------------------------------------------------------- theme */

describe('colour detection', () => {
  test('NO_COLOR wins over every other signal, including FORCE_COLOR', () => {
    expect(detectColorLevel({ NO_COLOR: '1' }, CAPABLE)).toBe('none')
    expect(detectColorLevel({ NO_COLOR: '0' }, CAPABLE)).toBe('none')
    expect(detectColorLevel({ NO_COLOR: '1', FORCE_COLOR: '3' }, CAPABLE)).toBe('none')
    expect(detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }, CAPABLE)).toBe('none')
  })

  test('an empty NO_COLOR is not a request: the spec says presence with a value', () => {
    expect(detectColorLevel({ NO_COLOR: '', COLORTERM: 'truecolor' }, CAPABLE)).toBe('truecolor')
  })

  test('COLORTERM is what separates 24-bit from 256', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, CAPABLE)).toBe('truecolor')
    expect(detectColorLevel({ COLORTERM: '24bit' }, CAPABLE)).toBe('truecolor')
    expect(detectColorLevel({ TERM: 'xterm-256color' }, CAPABLE)).toBe('ansi256')
    expect(detectColorLevel({}, CAPABLE)).toBe('ansi256')
  })

  test('a terminal that says it is dumb is believed', () => {
    expect(detectColorLevel({ TERM: 'dumb' }, CAPABLE)).toBe('none')
    expect(detectColorLevel({ TERM: 'dumb', COLORTERM: 'truecolor' }, CAPABLE)).toBe('none')
  })

  test('no colour support means no colour', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, { supportsColor: false })).toBe('none')
  })

  test('FORCE_COLOR overrides a destination that cannot do colour', () => {
    const off = { supportsColor: false }
    expect(detectColorLevel({ FORCE_COLOR: '1' }, off)).toBe('ansi256')
    expect(detectColorLevel({ FORCE_COLOR: '3' }, off)).toBe('truecolor')
    expect(detectColorLevel({ FORCE_COLOR: '0' }, CAPABLE)).toBe('none')
    expect(detectColorLevel({ FORCE_COLOR: 'false' }, CAPABLE)).toBe('none')
  })
})

describe('palette degradation', () => {
  const sequences: Record<ColorLevel, RegExp | null> = {
    truecolor: /\x1b\[38;2;\d+;\d+;\d+m/,
    ansi256: /\x1b\[38;5;\d+m/,
    none: null
  }

  for (const [level, pattern] of Object.entries(sequences) as [ColorLevel, RegExp | null][]) {
    test(`${level} emits the sequence family it promises`, () => {
      const theme = createTheme({ level, env: {} })
      const painted = theme.ok('ready')

      if (pattern === null) {
        expect(painted).toBe('ready')
        expect(painted).not.toContain(ESC)
      } else {
        expect(painted).toMatch(pattern)
        expect(Bun.stripANSI(painted)).toBe('ready')
      }
    })
  }

  test('paint never changes how wide a string is', () => {
    const theme = createTheme({ level: 'truecolor', env: {} })
    for (const text of ['ready', 'localhost:3000', '日本語', '']) {
      expect(visibleWidth(theme.warn(text))).toBe(visibleWidth(text))
    }
  })

  test('bold and colour nest without cancelling each other', () => {
    const theme = createTheme({ level: 'truecolor', env: {} })
    // The alert style is bold(warn(...)); if the resets were full SGR resets the amber
    // would be dropped the moment the weight closed.
    const alert = theme.alert('exposed')
    expect(alert).toContain('\x1b[1m')
    expect(alert).toMatch(/\x1b\[38;2;/)
    expect(Bun.stripANSI(alert)).toBe('exposed')
  })
})

describe('symbol fallback', () => {
  test('UTF-8 in any of the locale variables enables the glyphs', () => {
    expect(detectUnicode({ LANG: 'en_US.UTF-8' })).toBe(true)
    expect(detectUnicode({ LC_ALL: 'en_GB.utf8' })).toBe(true)
    expect(detectUnicode({ LC_CTYPE: 'C.UTF-8' })).toBe(true)
  })

  test('a non-UTF-8 or absent locale falls back to ASCII', () => {
    expect(detectUnicode({ LANG: 'C' })).toBe(false)
    expect(detectUnicode({ LANG: 'en_US.ISO-8859-1' })).toBe(false)
    expect(detectUnicode({})).toBe(false)
  })

  test('LC_ALL outranks LANG, the way every other tool treats them', () => {
    expect(detectUnicode({ LC_ALL: 'C', LANG: 'en_US.UTF-8' })).toBe(false)
  })

  test('the ASCII set is actually ASCII', () => {
    const theme = createTheme({ level: 'none', unicode: false })
    for (const symbol of Object.values(theme.symbols)) {
      expect(symbol.length).toBeGreaterThan(0)
      for (const ch of symbol) expect(ch.charCodeAt(0)).toBeLessThan(128)
    }
  })

  test('a frame rendered ASCII carries no non-ASCII byte at all', () => {
    const theme = createTheme({ level: 'none', unicode: false })
    const lines = renderFrame(
      model({ forwards: [forward({ bindAddress: '0.0.0.0', status: 'refused' })] }),
      theme,
      80,
      0
    )
    for (const line of lines) {
      for (const ch of line) expect(ch.charCodeAt(0)).toBeLessThan(128)
    }
  })
})

describe('the refused/failed distinction', () => {
  // The reason mirb exists over `ssh -L`: refused means the tunnel is perfect and the
  // user's service is down. If it renders like a failure, the feature is invisible.
  test('refused and failed differ in glyph and in colour', () => {
    const theme = createTheme({ level: 'truecolor', unicode: true, env: {} })
    const refused = theme.forward.refused
    const failed = theme.forward.failed

    expect(refused.symbol).not.toBe(failed.symbol)
    expect(refused.paint('x')).not.toBe(failed.paint('x'))
    expect(refused.label).toBe('refused')
    expect(failed.label).toBe('failed')
  })

  test('they stay distinguishable with colour off', () => {
    const theme = plainTheme(true)
    expect(theme.forward.refused.symbol).not.toBe(theme.forward.failed.symbol)
    expect(theme.forward.refused.label).not.toBe(theme.forward.failed.label)
  })

  test('bound reads as probing only when there is a probe to wait for', () => {
    expect(forwardLabel('bound', true)).toBe('probing')
    expect(forwardLabel('bound', false)).toBe('bound')
  })
})

/* -------------------------------------------------------------------- measurement */

describe('width-aware text', () => {
  test('visibleWidth counts columns, not code units', () => {
    expect(visibleWidth('日本語')).toBe(6)
    expect(visibleWidth(`${ESC}[31mred${ESC}[0m`)).toBe(3)
  })

  test('padVisible pads a painted string to its visible width', () => {
    const painted = `${ESC}[31mred${ESC}[0m`
    expect(visibleWidth(padVisible(painted, 10))).toBe(10)
    expect(visibleWidth(padVisible('日本語', 10))).toBe(10)
    // Already wider than the target: never truncates, that is a separate decision.
    expect(padVisible('日本語', 2)).toBe('日本語')
  })

  test('truncateVisible cuts to columns and closes the styling it cut into', () => {
    expect(truncateVisible('abcdefgh', 4)).toBe('abc…')
    expect(visibleWidth(truncateVisible('abcdefgh', 4))).toBe(4)
    expect(truncateVisible('abc', 10)).toBe('abc')

    const painted = `${ESC}[31mabcdefgh${ESC}[0m`
    const cut = truncateVisible(painted, 4)
    expect(visibleWidth(cut)).toBe(4)
    expect(Bun.stripANSI(cut)).toBe('abc…')
    // Colour must not leak past the cut.
    expect(cut.endsWith(`${ESC}[0m`)).toBe(true)
  })

  test('truncateVisible never splits a double-width glyph across the boundary', () => {
    // Budget 3 leaves room for the ellipsis plus one CJK cell pair... which does not fit,
    // so only what fully fits is kept.
    for (const max of [1, 2, 3, 4, 5, 6, 7]) {
      expect(visibleWidth(truncateVisible('日本語です', max))).toBeLessThanOrEqual(max)
    }
  })

  test('layoutLine produces exactly the requested width when both halves fit', () => {
    const line = layoutLine('left', 'right', 40)
    expect(visibleWidth(line)).toBe(40)
    expect(line.startsWith('left')).toBe(true)
    expect(line.endsWith('right')).toBe(true)
  })

  test('formatUptime shows two units at most', () => {
    expect(formatUptime(12_000)).toBe('12s')
    expect(formatUptime(252_000)).toBe('4m 12s')
    expect(formatUptime(3_840_000)).toBe('1h 4m')
    expect(formatUptime(-5)).toBe('0s')
  })
})

/* ------------------------------------------------------------------------ layout */

const rowsOf = (lines: string[], arrow: string) => lines.filter((l) => l.includes(arrow))

describe('frame layout', () => {
  const three = model({
    forwards: [
      forward({ localPort: 3000, remoteHost: '10.0.0.7', remotePort: 3000, status: 'ready' }),
      forward({ localPort: 8080, remoteHost: '10.0.0.7', remotePort: 8080, status: 'bound' }),
      forward({ localPort: 5432, remoteHost: 'db.internal', remotePort: 5432, status: 'refused' })
    ],
    startedAt: 0
  })

  test('every row ends at the same column', () => {
    const theme = plainTheme(true)
    const lines = renderFrame(three, theme, 80, 252_000)
    const rows = rowsOf(lines, theme.symbols.arrow)

    expect(rows).toHaveLength(3)
    const widths = new Set(rows.map(visibleWidth))
    expect(widths.size).toBe(1)
  })

  test('a wide-character hostname does not skew the columns', () => {
    const theme = plainTheme(true)
    const wide = model({
      forwards: [
        forward({ localPort: 3000, remoteHost: '日本語.example', remotePort: 3000 }),
        forward({ localPort: 8080, remoteHost: 'ascii.example', remotePort: 8080, status: 'bound' })
      ]
    })

    const rows = rowsOf(renderFrame(wide, theme, 100, 0), theme.symbols.arrow)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(visibleWidth)).size).toBe(1)

    // And the status word is still the last thing on the line, not pushed off it.
    for (const row of rows) expect(row.trimEnd()).toBe(row)
  })

  test('colour changes bytes and nothing else', () => {
    // The strongest statement of the layout contract: strip the escapes from a painted
    // frame and you have the plain frame, character for character.
    const painted = renderFrame(three, createTheme({ level: 'truecolor', unicode: true, env: {} }), 80, 0)
    const plain = renderFrame(three, plainTheme(true), 80, 0)
    expect(painted.map((l) => Bun.stripANSI(l))).toEqual(plain)
  })

  test('no line ever exceeds the terminal width', () => {
    // Wrapping is what breaks the cursor-up arithmetic, so this is not a cosmetic bound.
    const long = model({
      target: 'a-very-long-hostname.internal.example.com',
      forwards: [
        forward({ localPort: 3000, remoteHost: 'another-long-hostname.internal.example.com' }),
        forward({ localPort: 5432, remoteHost: 'db.internal', status: 'refused', bindAddress: '0.0.0.0' })
      ]
    })

    for (const theme of [plainTheme(true), createTheme({ level: 'truecolor', unicode: true, env: {} })]) {
      for (const width of [10, 20, 24, 30, 40, 60, 80, 200]) {
        for (const line of renderFrame(long, theme, width, 0)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width)
          expect(line).not.toContain('\n')
        }
      }
    }
  })

  test('the frame does not stretch across a very wide terminal', () => {
    const theme = plainTheme(true)
    const widths = renderFrame(three, theme, 200, 0).map(visibleWidth)
    expect(Math.max(...widths)).toBeLessThanOrEqual(80)
  })

  test('the header carries the target and the uptime', () => {
    const theme = plainTheme(true)
    const head = renderFrame(three, theme, 80, 252_000)[0]!
    expect(head).toContain('mirb')
    expect(head).toContain('10.0.0.7')
    expect(head).toContain('up 4m 12s')
  })

  test('the footer carries the ssh pid, the reconnect count and the way out', () => {
    const theme = plainTheme(true)
    const lines = renderFrame(model({ reconnects: 2 }), theme, 80, 0)
    const footer = lines.at(-1)!
    expect(footer).toContain('ssh 48213')
    expect(footer).toContain('reconnects 2')
    expect(footer).toContain('^C to stop')
  })
})

/* -------------------------------------------------------------------- exposure */

describe('non-loopback binds', () => {
  test('loopback in all its spellings is not exposure', () => {
    for (const bindAddress of ['', '127.0.0.1', 'localhost', '::1', '127.0.1.1']) {
      expect(isExposed({ bindAddress })).toBe(false)
    }
  })

  test('anything else is', () => {
    for (const bindAddress of ['0.0.0.0', '*', '::', '192.168.1.5', 'en0.local']) {
      expect(isExposed({ bindAddress })).toBe(true)
    }
  })

  test('the live frame carries a persistent banner naming the address', () => {
    const theme = plainTheme(true)
    const exposed = model({
      forwards: [forward({ bindAddress: '0.0.0.0', localPort: 8080, remotePort: 8080 })]
    })
    const lines = renderFrame(exposed, theme, 80, 0)
    const banner = lines.find((l) => l.includes('exposed'))

    expect(banner).toBeDefined()
    expect(banner).toContain('0.0.0.0:8080')
    expect(banner).toContain(theme.symbols.alert)
    // Directly under the title, where it cannot be mistaken for a row.
    expect(lines.indexOf(banner!)).toBe(1)
  })

  test('a loopback-only session says nothing about exposure', () => {
    const lines = renderFrame(model(), plainTheme(true), 80, 0)
    expect(lines.some((l) => l.includes('exposed'))).toBe(false)
  })

  test('exposedForwards keeps the user order', () => {
    const forwards = [
      forward({ localPort: 1, bindAddress: '127.0.0.1' }),
      forward({ localPort: 2, bindAddress: '0.0.0.0' }),
      forward({ localPort: 3, bindAddress: '192.168.1.5' })
    ]
    expect(exposedForwards(forwards).map((f) => f.localPort)).toEqual([2, 3])
  })
})

/* ------------------------------------------------------------------ live renderer */

describe('the live renderer', () => {
  test('hides the cursor on the first frame and restores it on stop', () => {
    const out = sink()
    const display = createLiveDisplay({ theme: plainTheme(true), stream: out, now: () => 0 })

    display.update(model())
    expect(out.text).toContain('\x1b[?25l')
    expect(out.text).not.toContain('\x1b[?25h')

    display.stop()
    expect(out.text).toContain('\x1b[?25h')
    // And the frame is still on screen: no clear, no alternate buffer.
    expect(out.text).not.toContain('\x1b[2J')
  })

  test('stop is idempotent, so a finally block can always call it', () => {
    const out = sink()
    const display = createLiveDisplay({ theme: plainTheme(true), stream: out, now: () => 0 })
    display.update(model())
    display.stop()
    const after = out.text
    display.stop()
    display.stop()
    expect(out.text).toBe(after)
  })

  test('an abort restores the cursor without the caller doing anything', () => {
    const out = sink()
    const controller = new AbortController()
    const display = createLiveDisplay({
      theme: plainTheme(true),
      stream: out,
      signal: controller.signal,
      now: () => 0
    })

    display.update(model())
    controller.abort()
    expect(out.text).toContain('\x1b[?25h')

    // And it has genuinely stopped: a later update writes nothing.
    const after = out.text
    display.update(model())
    expect(out.text).toBe(after)
  })

  test('a display that never painted leaves the terminal alone', () => {
    const out = sink()
    createLiveDisplay({ theme: plainTheme(true), stream: out }).stop()
    expect(out.text).toBe('')
  })

  test('the second frame moves up by exactly the number of lines it painted', () => {
    const out = sink()
    const display = createLiveDisplay({ theme: plainTheme(true), stream: out, now: () => 0 })

    display.update(model())
    const first = out.text
    const painted = first.split('\n').length - 1
    expect(painted).toBeGreaterThan(0)

    out.chunks.length = 0
    display.update(model({ status: 'degraded' }))
    expect(out.text).toContain(`\x1b[${painted}A`)

    display.stop()
  })

  test('a shrinking frame clears the rows it no longer occupies', () => {
    const out = sink()
    const display = createLiveDisplay({ theme: plainTheme(true), stream: out, now: () => 0 })

    display.update(model({ forwards: [forward({ localPort: 1 }), forward({ localPort: 2 })] }))
    out.chunks.length = 0
    display.update(model({ forwards: [forward({ localPort: 1 })] }))

    // One row fewer: the leftover line is cleared and the cursor comes back down to the
    // end of the new frame, or the next cursor-up count would be wrong forever after.
    expect(out.text).toContain('\x1b[2K')
    expect(out.text).toContain('\x1b[1A')

    display.stop()
  })

  test('a resize repaints', () => {
    const out = sink(80)
    const display = createLiveDisplay({ theme: plainTheme(true), stream: out, now: () => 0 })
    display.update(model())

    out.chunks.length = 0
    out.columns = 40
    process.emit('SIGWINCH')

    expect(out.text.length).toBeGreaterThan(0)
    for (const line of Bun.stripANSI(out.text).split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    }

    display.stop()
  })

  test('the cursor comes back even when the process dies of an uncaught throw', async () => {
    // The one restore path that cannot be reached in-process: by the time `exit` fires the
    // event loop is gone, so this is the case a stream write would silently drop. Run it for
    // real rather than simulating it, because "for real" is the only thing being claimed.
    const dir = mkdtempSync(join(tmpdir(), 'mirb-crash-'))
    const script = join(dir, 'crash.ts')
    const live = new URL('../ui/live.ts', import.meta.url).pathname
    const theme = new URL('../ui/theme.ts', import.meta.url).pathname

    writeFileSync(
      script,
      [
        `import { createLiveDisplay } from ${JSON.stringify(live)}`,
        `import { plainTheme } from ${JSON.stringify(theme)}`,
        'const display = createLiveDisplay({ theme: plainTheme(true), stream: process.stdout })',
        "display.update({ target: 'h', forwards: [], status: 'ready', startedAt: Date.now(), reconnects: 0 })",
        "throw new Error('boom')"
      ].join('\n')
    )

    const proc = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited

    expect(code).not.toBe(0)
    expect(out).toContain('\x1b[?25l')
    expect(out.endsWith('\x1b[?25h')).toBe(true)
  })

  test('no frame line wraps at the stream width', () => {
    const out = sink(32)
    const display = createLiveDisplay({ theme: plainTheme(true), stream: out, now: () => 0 })
    display.update(
      model({
        target: 'quite-a-long-hostname.example.com',
        forwards: [forward({ remoteHost: 'another-long-name.example.com' })]
      })
    )

    for (const line of Bun.stripANSI(out.text).split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(32)
    }

    display.stop()
  })
})

/* ---------------------------------------------------------------- static reporter */

describe('the static reporter', () => {
  test('emits no ANSI, even when the state it renders carries some', () => {
    const out = sink()
    const reporter = createStaticReporter({ stream: out })

    reporter.start(model())
    reporter.update(
      model({
        forwards: [forward({ status: 'refused', detail: `${ESC}[31mconnection refused${ESC}[0m` })]
      })
    )
    reporter.note(`${ESC}[1mreconnecting${ESC}[0m`)

    expect(out.text).not.toContain(ESC)
    expect(out.text).toContain('connection refused')
  })

  test('one record per line: no embedded newlines survive', () => {
    const out = sink()
    const reporter = createStaticReporter({ stream: out })
    reporter.note('first line\nsecond line\r\nthird')

    const lines = out.text.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('first line second line third')
  })

  test('only transitions are reported', () => {
    const out = sink()
    const reporter = createStaticReporter({ stream: out })
    const bound = model({ forwards: [forward({ status: 'bound' })], status: 'connecting' })

    reporter.update(bound)
    out.chunks.length = 0

    reporter.update(bound)
    reporter.update(bound)
    expect(out.text).toBe('')

    reporter.update(model({ forwards: [forward({ status: 'ready' })], status: 'ready' }))
    expect(out.text).toContain('ready')
  })

  test('the exposure warning survives the mode with no colour and no banner', () => {
    const out = sink()
    createStaticReporter({ stream: out }).start(
      model({ forwards: [forward({ bindAddress: '0.0.0.0', localPort: 8080 })] })
    )

    expect(out.text).toContain('warning')
    expect(out.text).toContain('0.0.0.0:8080')
  })

  test('every line is prefixed and greppable', () => {
    const out = sink()
    const reporter = createStaticReporter({ stream: out, prefix: 'mirb' })
    reporter.start(model())
    reporter.update(model())

    for (const line of out.text.split('\n').filter((l) => l.length > 0)) {
      expect(line.startsWith('mirb: ')).toBe(true)
    }
  })

  test('timestamps are ISO-8601 when asked for', () => {
    const out = sink()
    const at = new Date('2026-08-19T12:00:00.000Z')
    createStaticReporter({ stream: out, timestamps: true, now: () => at }).note('hello')
    expect(out.text.startsWith('2026-08-19T12:00:00.000Z mirb: hello')).toBe(true)
  })

  test('defaults to stderr, because stdout is being captured whenever this mode runs', () => {
    const original = process.stderr.write.bind(process.stderr)
    const seen: string[] = []
    // A narrow spy, restored in the finally below.
    process.stderr.write = ((chunk: string) => {
      seen.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      createStaticReporter().note('to stderr')
    } finally {
      process.stderr.write = original
    }
    expect(seen.join('')).toContain('to stderr')
  })
})

/* -------------------------------------------------------------------------- events */

describe('the NDJSON event stream', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirb-ui-'))

  /** Writes through a real descriptor, which is the only way to exercise the sync write. */
  function collect(emit: (stream: ReturnType<typeof createEventStream>) => void): string {
    const path = join(dir, `events-${Math.random().toString(36).slice(2)}.ndjson`)
    const fd = openSync(path, 'w')
    try {
      emit(createEventStream({ fd, now: () => new Date('2026-08-19T12:00:00.000Z') }))
    } finally {
      closeSync(fd)
    }
    return readFileSync(path, 'utf8')
  }

  test('every line is one parseable JSON object', () => {
    const raw = collect((stream) => {
      stream.emit({ event: 'forward.bound', localPort: 3000 })
      stream.emit({ event: 'forward.ready', localPort: 3000 })
      stream.emit({ event: 'session.ready', id: 'mb_abc123', ready: 1, total: 1 })
    })

    const lines = raw.split('\n')
    expect(lines.at(-1)).toBe('')

    const parsed = lines.slice(0, -1).map((l) => JSON.parse(l) as MirbEvent)
    expect(parsed).toHaveLength(3)
    expect(parsed.map((e) => e.event)).toEqual(['forward.bound', 'forward.ready', 'session.ready'])
  })

  test('timestamps are filled in and are ISO-8601', () => {
    const raw = collect((stream) => stream.emit({ event: 'forward.bound', localPort: 3000 }))
    const parsed = JSON.parse(raw.trim()) as { ts: string }

    expect(parsed.ts).toBe('2026-08-19T12:00:00.000Z')
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts)
  })

  test('a timestamp the caller supplied is left alone', () => {
    const ts = '2020-01-01T00:00:00.000Z'
    const raw = collect((stream) => stream.emit({ event: 'forward.bound', ts, localPort: 3000 }))
    expect((JSON.parse(raw.trim()) as { ts: string }).ts).toBe(ts)
  })

  test('a hostile hostname cannot split one event across two lines', () => {
    const raw = collect((stream) =>
      stream.emit({
        event: 'forward.error',
        localPort: 3000,
        code: 'SSH_CONNECT',
        message: 'line one\nline two\r\n{"event":"forged"}'
      })
    )

    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    expect((JSON.parse(lines[0]!) as { message: string }).message).toContain('line two')
  })

  test('the format is compact: no indentation, one trailing newline', () => {
    const line = eventLine({ event: 'forward.bound', ts: '2026-08-19T12:00:00.000Z', localPort: 3000 })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(line).not.toContain('  ')
  })

  test('a closed stream stops writing rather than throwing', () => {
    const path = join(dir, 'closed.ndjson')
    const fd = openSync(path, 'w')
    const stream = createEventStream({ fd })
    stream.emit({ event: 'forward.bound', localPort: 3000 })
    closeSync(fd)

    // The consumer went away mid-session; a broken pipe must never take a tunnel down.
    expect(() => stream.emit({ event: 'forward.ready', localPort: 3000 })).not.toThrow()
    expect(() => stream.emit({ event: 'forward.ready', localPort: 3000 })).not.toThrow()

    expect(readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)).toHaveLength(1)
  })

  test('close() stops the stream', () => {
    const raw = collect((stream) => {
      stream.emit({ event: 'forward.bound', localPort: 3000 })
      stream.close()
      stream.emit({ event: 'forward.ready', localPort: 3000 })
    })
    expect(raw.split('\n').filter((l) => l.length > 0)).toHaveLength(1)
  })
})

/* ------------------------------------------------------------- contract coverage */

test('every forward status has a symbol, a label and a paint', () => {
  const theme = createTheme({ level: 'truecolor', unicode: true, env: {} })
  const statuses: ForwardStatus[] = ['pending', 'bound', 'ready', 'refused', 'failed']

  for (const status of statuses) {
    const style = theme.forward[status]
    expect(style.symbol.length).toBeGreaterThan(0)
    expect(style.label.length).toBeGreaterThan(0)
    expect(Bun.stripANSI(style.paint('x'))).toBe('x')
  }
})

/* ------------------------------------------------------- replayed onto a screen */

/**
 * A terminal, reduced to the four operations the live renderer actually uses.
 *
 * Asserting on escape sequences proves the renderer emitted *something*. Replaying them
 * proves the arithmetic is right: an off-by-one in a cursor-up count leaves a duplicated
 * or orphaned line on this screen, exactly as it would on a real one.
 */
class Screen {
  rows: string[] = ['']
  private row = 0
  private col = 0

  write(chunk: string): void {
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]!

      if (ch === ESC) {
        const rest = chunk.slice(i)
        const up = /^\x1b\[(\d+)A/.exec(rest)
        if (up) {
          this.row = Math.max(0, this.row - Number(up[1]))
          i += up[0].length
          continue
        }
        const clear = /^\x1b\[2K/.exec(rest)
        if (clear) {
          this.rows[this.row] = ''
          i += clear[0].length
          continue
        }
        // Cursor visibility and colour move nothing.
        const other = /^\x1b\[[0-9;:?]*[ -\/]*[@-~]/.exec(rest)
        if (other) {
          i += other[0].length
          continue
        }
      }

      if (ch === '\r') {
        this.col = 0
        i += 1
        continue
      }

      if (ch === '\n') {
        this.row += 1
        this.col = 0
        while (this.rows.length <= this.row) this.rows.push('')
        i += 1
        continue
      }

      const line = this.rows[this.row] ?? ''
      this.rows[this.row] =
        line.padEnd(this.col, ' ').slice(0, this.col) + ch + line.slice(this.col + 1)
      this.col += 1
      i += 1
    }
  }

  /** What a user would see: a terminal shows no trailing blank rows. */
  get visible(): string[] {
    const out = [...this.rows]
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    return out
  }
}

function trimTrailingBlanks(lines: string[]): string[] {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

describe('the live renderer, replayed onto a terminal', () => {
  const theme = plainTheme(true)

  test('the screen holds exactly the latest frame, after every update', () => {
    const screen = new Screen()
    const stream = {
      columns: 80,
      rows: 40,
      write(chunk: string) {
        screen.write(chunk)
        return true
      }
    }
    const display = createLiveDisplay({ theme, stream, now: () => 0 })

    const states: LiveModel[] = [
      model({
        status: 'connecting',
        forwards: [
          forward({ localPort: 3000, status: 'pending' }),
          forward({ localPort: 8080, status: 'pending' })
        ]
      }),
      model({
        status: 'connecting',
        forwards: [
          forward({ localPort: 3000, status: 'bound' }),
          forward({ localPort: 8080, status: 'pending' })
        ]
      }),
      model({
        status: 'degraded',
        forwards: [
          forward({ localPort: 3000, status: 'ready' }),
          forward({ localPort: 8080, status: 'refused', remoteHost: 'db.internal' })
        ]
      }),
      // Fewer forwards than the frame before it: the tail has to be cleared, not left behind.
      model({ status: 'ready', forwards: [forward({ localPort: 3000 })] }),
      // A note grows the frame again, in the middle of the layout rather than at the end.
      model({
        status: 'reconnecting',
        forwards: [forward({ localPort: 3000 })],
        note: 'reconnecting in 4s (attempt 2)'
      })
    ]

    for (const state of states) {
      display.update(state)
      expect(screen.visible).toEqual(trimTrailingBlanks(renderFrame(state, theme, 80, 0)))
    }

    display.stop()
    // Whatever mirb prints next must land below the frame, not on top of it.
    expect(screen.visible).toEqual(trimTrailingBlanks(renderFrame(states.at(-1)!, theme, 80, 0)))
  })

  test('a frame taller than the window is cut, because scrolled lines cannot be reached', () => {
    const screen = new Screen()
    const stream = {
      columns: 80,
      rows: 10,
      write(chunk: string) {
        screen.write(chunk)
        return true
      }
    }
    const display = createLiveDisplay({ theme, stream, now: () => 0 })

    display.update(
      model({
        forwards: Array.from({ length: 30 }, (_, i) => forward({ localPort: 3000 + i }))
      })
    )

    expect(screen.visible.length).toBeLessThanOrEqual(9)
    // And the user is told the display is not the whole truth.
    expect(screen.visible.at(-1)).toContain('more')

    display.stop()
  })
})

describe('colour survives a hostile environment', () => {
  /**
   * REGRESSION GUARD - this shipped, and only CI caught it.
   *
   * `Bun.color(hex, 'ansi')` re-decides colour support from the environment and returns ""
   * when it disapproves, which silently overrode the level the theme had already resolved.
   * Locally everything looked right; on a runner with no TTY and TERM=dumb, an explicit
   * `level: 'truecolor'` produced no colour at all - and so would
   * `FORCE_COLOR=3 mirb ... | less -R`.
   *
   * The whole point of resolving a level is that it is then authoritative. These assertions
   * pass an environment that would fail Bun's own detection, so a regression to the bare
   * 'ansi' format fails here rather than months later in someone's pipeline.
   */
  const HOSTILE = { CI: 'true', TERM: 'dumb' }

  test('an explicit truecolor level still emits 24-bit sequences', () => {
    const theme = createTheme({ level: 'truecolor', unicode: true, env: HOSTILE })
    expect(theme.ok('x')).toContain('38;2;')
    expect(theme.ok('x')).not.toBe('x')
  })

  test('an explicit 256 level still emits indexed sequences', () => {
    const theme = createTheme({ level: 'ansi256', unicode: true, env: HOSTILE })
    expect(theme.ok('x')).toContain('38;5;')
  })

  test('refused and failed stay distinct where Bun would have dropped colour', () => {
    const theme = createTheme({ level: 'truecolor', unicode: true, env: HOSTILE })
    expect(theme.forward.refused.paint('x')).not.toBe(theme.forward.failed.paint('x'))
  })

  test('level none is still honoured - this is not a licence to always colour', () => {
    const theme = createTheme({ level: 'none', unicode: true, env: HOSTILE })
    expect(theme.ok('x')).toBe('x')
  })

  test('NO_COLOR is still respected when no level is forced', () => {
    const theme = createTheme({ env: { ...HOSTILE, NO_COLOR: '1' }, unicode: true })
    expect(theme.ok('x')).toBe('x')
  })
})
