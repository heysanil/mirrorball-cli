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

export default defineConfig({
  plugins: [
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
