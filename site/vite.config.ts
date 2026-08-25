import path from 'node:path'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import press from 'fumapress/vite'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import remarkDirective from 'remark-directive'
import {
  remarkDirectiveAdmonition,
  remarkMdxMermaid
} from 'fumadocs-core/mdx-plugins'
import { remarkStripPageTitle } from './src/mdx/remark-strip-page-title'

// docs/ is outside this Vite root, so Node's resolution walk from a content file goes
// docs/explanation -> docs -> <repo> and never enters site/node_modules. Every bare
// import the MDX compiler injects into a page — `react/jsx-runtime` above all — therefore
// fails to resolve.
//
// It builds anyway on a machine where the CLI's own `bun install` has left a
// <repo>/node_modules containing react as a transitive dependency, which is exactly the
// accident that let this reach CI. Re-anchor those imports to the site instead.
//
// `this.resolve` rather than a `resolve.alias`: react/jsx-runtime has a `react-server`
// export condition, and an alias to a concrete file path would resolve the browser build
// into the server environment and break RSC.
const CONTENT_DIR = path.resolve(import.meta.dirname, '..', 'docs')
const SITE_ANCHOR = path.resolve(import.meta.dirname, 'press.config.tsx')

function resolveContentImports() {
  return {
    name: 'mirb:resolve-content-imports',
    enforce: 'pre' as const,
    async resolveId(this: any, source: string, importer: string | undefined, options: unknown) {
      if (!importer || !importer.startsWith(CONTENT_DIR)) return null
      // Relative and absolute specifiers already resolve against the file itself.
      if (source.startsWith('.') || source.startsWith('/') || source.startsWith('\0')) return null
      return this.resolve(source, SITE_ANCHOR, options)
    }
  }
}

export default defineConfig({
  plugins: [
    resolveContentImports(),
    press(),
    fumadocsMdx({
      globalOptions: {
        mdxOptions: {
          // The function form is additive: `v` is Fumadocs' default plugin list
          // (shiki highlighting, GFM, heading ids, the structured data search reads).
          // Passing a plain array here — or setting `mdxOptions` on the collection
          // instead — REPLACES those defaults and silently guts the site.
          remarkPlugins: (v) => [
            remarkStripPageTitle,
            remarkDirective,
            remarkDirectiveAdmonition,
            remarkMdxMermaid,
            ...v
          ]
        }
      }
    }),
    tailwindcss()
  ],
  server: {
    fs: {
      // The content lives in ../docs, outside this Vite root. Without this the dev
      // server refuses to read it, and every page 500s.
      allow: ['..']
    }
  }
})
