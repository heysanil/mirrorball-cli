import { defineConfig } from 'fumapress'
import { fumadocsMdx } from 'fumapress/adapters/mdx'
import { metaSchema, pageSchema } from 'fumapress/adapters/mdx/schema'
import { defineDocs } from 'fumadocs-mdx/macro'
import { createDocsLayoutPage } from 'fumapress/layouts/docs'
import { createHomeLayout } from 'fumapress/layouts/home'
import defaultMdxComponents, { createRelativeLink } from 'fumadocs-ui/mdx'

import { flexsearchPlugin } from 'fumapress/plugins/flexsearch'
import { linkValidationPlugin } from 'fumapress/plugins/link-validation'
import { llmsPlugin } from 'fumapress/plugins/llms.txt'
import { robotsPlugin } from 'fumapress/plugins/robots'
import { sitemapPlugin } from 'fumapress/plugins/sitemap'

import { Mermaid } from './src/components/mermaid'

const SITE_URL = 'https://mirb.dev'
const REPO = 'https://github.com/heysanil/mirrorball-cli'

const docs = defineDocs({
  // The docs live at the repo root, not under site/. They are read on GitHub as often
  // as they are read here, and every docs path in AGENTS.md points at them.
  //
  // Two consequences worth knowing: fumadocs globs every *.json under this directory
  // and validates it as a meta file, so nothing else may live here; and the dev
  // server does not watch outside its own root, so adding a page needs a restart.
  dir: '../docs',
  docs: {
    async: true,
    schema: pageSchema,
    lastModified: true,
    postprocess: {
      // The llms.txt plugin reads the processed markdown back out of here.
      includeProcessedMarkdown: true
    }
  },
  meta: { schema: metaSchema }
})

// `base` carries the content shape. Everything below is typed against it rather than
// against the fully-chained `config`, so nothing ends up referring to its own type.
// The forward reference here is in type position only, which is legal.
const DocsPage = createDocsLayoutPage<typeof base.$context>()
export const HomeLayout = createHomeLayout<typeof base.$context>()

const base = defineConfig({
  // Every route prerendered. The site is served from Cloudflare as static assets with
  // no Worker script behind it, and search ships as a prebuilt index rather than an API.
  mode: 'static',

  site: {
    name: 'mirrorball',
    baseUrl: import.meta.env.DEV ? 'http://localhost:3000' : SITE_URL,
    git: { user: 'heysanil', repo: 'mirrorball-cli', branch: 'main' }
  },

  content: docs.toFumadocsSource({ baseDir: 'docs' }),

  renderPage: (props) => <DocsPage {...props} />,

  meta: {
    root() {
      return (
        <>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
          {/* Archivo carries the display voice, IBM Plex Sans the prose, and JetBrains
              Mono every word the CLI actually prints. The mono also has to render the
              status glyphs inside 109 `console` code blocks, so its coverage matters
              more than its looks. */}
          <link
            rel="stylesheet"
            href="https://fonts.googleapis.com/css2?family=Archivo:wght@400..700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
          />
          <meta name="theme-color" content="#070d10" />
        </>
      )
    }
  },

  defaultLayoutProps: {
    nav: { title: 'mirrorball' },
    links: [
      { text: 'Docs', url: '/docs' },
      { text: 'GitHub', url: REPO }
    ]
  },

  // Explicit rather than `preset: "recommended"`: the preset also mounts RSS, and a
  // /rss.xml on a site with no blog is a route that exists only to confuse people.
  preset: false
})

// Adapters and plugins are attached through the chainable methods rather than as keys on
// the object above. `adapters` is one of the positions the config's shape is inferred
// from, so naming that shape inside the initializer makes it depend on itself (TS7022).
// Splitting the chain off `base` settles the shape first.
const config = base
  .adapters(
    fumadocsMdx<typeof base.$context>({
      async getMdxComponents(page) {
        return {
          // This map REPLACES the defaults rather than extending them, so the spread is
          // load-bearing: without it every Callout the admonition plugin emits resolves
          // to undefined and the page 500s.
          ...defaultMdxComponents,
          // Every internal link in docs/ is a relative path ending in .md, written to
          // resolve when read on GitHub. This maps them onto site URLs at render time,
          // so the content stays correct in both places with no rewrite pass.
          a: createRelativeLink(await this.getLoader(), page),
          // What remarkMdxMermaid rewrites ```mermaid fences into.
          Mermaid
        }
      }
    })
  )
  .plugins(
  flexsearchPlugin(),
  sitemapPlugin(),
  robotsPlugin(),
  llmsPlugin(),
  // ~130 relative links and 68 anchors are resolved at render time. This is what
  // stops a broken one from reaching production.
  linkValidationPlugin()
)

export default config
