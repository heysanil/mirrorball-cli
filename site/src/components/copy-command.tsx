'use client'

import { useEffect, useState } from 'react'

/**
 * The install line. One job: get the command onto the clipboard.
 *
 * Falls back to a plain selectable line if the clipboard is unavailable — over http,
 * or where the permission is denied — rather than showing a button that does nothing.
 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const [canCopy, setCanCopy] = useState(false)

  useEffect(() => {
    setCanCopy(typeof navigator !== 'undefined' && !!navigator.clipboard)
  }, [])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="cmd">
      <span className="cmd-prompt" aria-hidden>$</span>
      <code className="cmd-text">{command}</code>
      {canCopy && (
        <button type="button" className="cmd-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  )
}
