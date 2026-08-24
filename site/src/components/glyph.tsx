import type { ForwardState } from '../lib/states'

/**
 * The status glyphs, drawn rather than typed.
 *
 * The CLI prints these as ● ◐ ○ ✕. Setting them as text would put the whole hero at
 * the mercy of whichever monospace font the visitor happens to resolve — U+25D0 in
 * particular is missing from plenty of them, and a tofu box in the one frame that
 * carries the argument is not a risk worth taking. As SVG they are also exactly the
 * same optical size, which text glyphs are not.
 *
 * `refused` is a hollow ring against `ready`'s filled one: the tunnel exists, there is
 * nothing on the far end of it. That relationship is the product in one glyph.
 */
export function Glyph({ state }: { state: ForwardState }) {
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true }

  if (state === 'pending') {
    return (
      <svg {...common} className="glyph glyph-pending">
        <circle cx="6" cy="6" r="1.5" fill="currentColor" />
      </svg>
    )
  }

  if (state === 'probing') {
    return (
      <svg {...common} className="glyph glyph-probing">
        <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 1.75 A4.25 4.25 0 0 0 6 10.25 Z" fill="currentColor" />
      </svg>
    )
  }

  if (state === 'ready') {
    return (
      <svg {...common} className="glyph glyph-ready">
        <circle cx="6" cy="6" r="4.25" fill="currentColor" />
      </svg>
    )
  }

  if (state === 'refused') {
    return (
      <svg {...common} className="glyph glyph-refused">
        <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    )
  }

  return (
    <svg {...common} className="glyph glyph-failed">
      <path
        d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Data flows remote -> local, so the arrow points at the local port. */
export function Arrow() {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden className="glyph">
      <path
        d="M13 6 H2 M5.5 2.5 L2 6 L5.5 9.5"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The header glyph, between `mirb` and the target. */
export function Link2() {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden className="glyph">
      <path
        d="M1 4 H13 M10 1.5 L13 4 M13 8 H1 M4 5.5 L1 8"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
