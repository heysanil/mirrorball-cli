import { customAlphabet } from 'nanoid'

/** Lowercase alphanumeric only: these get typed, pasted, and grepped. */
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 13 chars is ample for the handful of sessions one machine ever has open at once. */
const nano = customAlphabet(alphabet, 13)

export function newSessionId(): string {
  return `mb_${nano()}`
}

/**
 * Resolve a user-typed fragment to exactly one id, git-short-hash style.
 * Full ids are never something anyone should have to type.
 *
 * Returns the match, or null when nothing matches. Throws when ambiguous, because
 * silently picking one of several sessions to kill would be unforgivable.
 */
export function resolveIdPrefix(fragment: string, ids: string[]): string | null {
  if (ids.includes(fragment)) return fragment

  const bare = fragment.startsWith('mb_') ? fragment.slice(3) : fragment
  const matches = ids.filter((id) => id === fragment || id.slice(3).startsWith(bare))

  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new Error(`'${fragment}' is ambiguous: matches ${matches.join(', ')}`)
  }
  return null
}

/** What `mirb ls` shows. Short enough to scan, long enough to stay unique in practice. */
export function shortId(id: string): string {
  return id.startsWith('mb_') ? id.slice(3, 9) : id.slice(0, 6)
}
