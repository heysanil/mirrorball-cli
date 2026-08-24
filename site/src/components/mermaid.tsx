'use client'

import { useEffect, useId, useRef, useState } from 'react'

/**
 * Renders a ```mermaid fence, which `remarkMdxMermaid` has rewritten into <Mermaid />.
 *
 * The whole site is prerendered, so there is no server-side render of a diagram: the
 * chart only exists after mermaid runs in the browser. Until it does we show the diagram
 * source, so a reader with the JS still in flight — or blocked entirely — gets readable
 * text rather than a blank gap where an explanation used to be.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '')
  const container = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    // Mermaid bakes the theme into the SVG at render time rather than reading CSS
    // variables, so a theme change means re-rendering, not restyling.
    const isDark = () => document.documentElement.classList.contains('dark')

    async function render() {
      const { default: mermaid } = await import('mermaid')
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: isDark() ? 'dark' : 'default',
        fontFamily: 'var(--font-mono, ui-monospace, monospace)'
      })
      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, chart.trim())
        if (!cancelled) setSvg(svg)
      } catch {
        // A diagram that fails to parse must not take the page down with it —
        // leaving svg null falls through to the source-text rendering below.
        if (!cancelled) setSvg(null)
      }
    }

    void render()

    const observer = new MutationObserver(() => void render())
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    })

    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [chart, id])

  if (svg === null) {
    return (
      <pre className="fd-mermaid-fallback overflow-x-auto rounded-lg border border-fd-border bg-fd-secondary/40 p-4 text-sm">
        <code>{chart.trim()}</code>
      </pre>
    )
  }

  return (
    <div
      ref={container}
      role="img"
      className="fd-mermaid my-6 flex justify-center overflow-x-auto [&>svg]:h-auto [&>svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
