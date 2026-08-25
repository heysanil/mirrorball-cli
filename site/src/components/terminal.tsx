'use client'

import { useEffect, useState } from 'react'
import { Arrow, Glyph, Link2 } from './glyph'
import type { ForwardState } from '../lib/states'

interface Row {
  local: number
  remote: number
  /** Where this forward ends up once probing settles. */
  settles: Extract<ForwardState, 'ready' | 'refused'>
  /** ms after mount that the probe resolves. */
  at: number
}

const ROWS: Row[] = [
  { local: 3000, remote: 3000, settles: 'ready', at: 1500 },
  { local: 3010, remote: 3010, settles: 'ready', at: 1850 },
  { local: 8080, remote: 8080, settles: 'refused', at: 2700 }
]

const PROBE_AT = [420, 620, 820]

const LABEL: Record<ForwardState, string> = {
  pending: 'pending',
  // `bound` reads as "probing" while a probe is in flight: it is a waypoint, not a
  // verdict. The CLI makes the same substitution.
  probing: 'probing',
  ready: 'ready',
  refused: 'refused',
  failed: 'failed'
}

/**
 * The hero: `mirb 10.0.0.7 3000 3010 8080`, playing out once on load.
 *
 * This is not a decorative animation. It is the product's actual state machine, and it
 * shows the thing the page is selling: three ports forwarded from one short command.
 * That the third one reports `refused` is a real detail, not the headline.
 *
 * With reduced motion requested, it renders the settled frame directly. The argument
 * survives without the motion; only the reveal is lost.
 */
export function Terminal() {
  const [states, setStates] = useState<ForwardState[]>(() => ROWS.map(() => 'pending'))
  const [uptime, setUptime] = useState(0)
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (reduce) {
      setStates(ROWS.map((r) => r.settles))
      setUptime(6)
      setSettled(true)
      return
    }

    const timers: ReturnType<typeof setTimeout>[] = []
    const set = (i: number, next: ForwardState) =>
      setStates((prev) => prev.map((s, j) => (j === i ? next : s)))

    ROWS.forEach((row, i) => {
      timers.push(setTimeout(() => set(i, 'probing'), PROBE_AT[i] ?? 500))
      timers.push(setTimeout(() => set(i, row.settles), row.at))
    })
    timers.push(setTimeout(() => setSettled(true), Math.max(...ROWS.map((r) => r.at))))

    const tick = setInterval(() => setUptime((s) => s + 1), 1000)

    return () => {
      timers.forEach(clearTimeout)
      clearInterval(tick)
    }
  }, [])

  const degraded = settled && states.includes('refused')

  return (
    <div className="term" role="img" aria-label="mirb forwarding three ports; two are ready and one is refused">
      <div className="term-chrome" aria-hidden>
        <span className="term-dot" />
        <span className="term-dot" />
        <span className="term-dot" />
      </div>

      <div className="term-body">
        <div className="term-head">
          <span className="term-brand">mirb</span>
          <span className="term-link"><Link2 /></span>
          <span className="term-target">10.0.0.7</span>
          <span className="term-uptime">{settled ? `up ${uptime}s` : 'starting'}</span>
        </div>

        <div className="term-rows">
          {ROWS.map((row, i) => {
            const state = states[i] ?? 'pending'
            return (
              <div className="term-row" key={row.local} data-state={state}>
                <span className="term-glyph"><Glyph state={state} /></span>
                <span className="term-port">localhost:{row.local}</span>
                <span className="term-arrow"><Arrow /></span>
                <span className="term-port term-port-remote">localhost:{row.remote}</span>
                <span className="term-status">{LABEL[state]}</span>
              </div>
            )
          })}
        </div>

        <div className="term-foot">
          ssh 19421 <span className="term-sep">·</span> reconnects 0 <span className="term-sep">·</span> ^C to stop
        </div>
      </div>

      <p className="term-caption">
        {degraded ? (
          <>
            Three forwards from <strong>one command</strong>. Each row says whether the far
            end actually answered — here the third service is not running yet.
          </>
        ) : (
          <>Binding the local ports, then probing the far end of each one…</>
        )}
      </p>
    </div>
  )
}
