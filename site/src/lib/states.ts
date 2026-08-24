/**
 * The forward states, and the one word mirb uses for each.
 *
 * Kept in step with core/types.ts and ui/theme.ts in the CLI. `bound` renders as
 * "probing" while a probe is in flight, which is what the CLI shows by default —
 * see forwardLabel() in ui/theme.ts.
 */
export type ForwardState = 'pending' | 'probing' | 'ready' | 'refused' | 'failed'

export interface StateNote {
  state: ForwardState
  label: string
  meaning: string
  fixer: string
}

export const STATE_NOTES: StateNote[] = [
  {
    state: 'probing',
    label: 'bound',
    meaning: 'The local socket accepts connections. A probe is on its way to the far end.',
    fixer: 'Wait a moment'
  },
  {
    state: 'ready',
    label: 'ready',
    meaning: 'A probe reached the remote service. Traffic you send will arrive.',
    fixer: 'Nothing to do'
  },
  {
    state: 'refused',
    label: 'refused',
    meaning: 'The tunnel is healthy. Nothing is listening on the remote port.',
    fixer: 'Start your app'
  },
  {
    state: 'failed',
    label: 'failed',
    meaning: 'The forward was never established — a bind conflict, auth, or an unreachable host.',
    fixer: 'Fix your ssh'
  }
]
