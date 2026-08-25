# mirb.dev

The mirrorball documentation site: a [Fumapress](https://press.fumadocs.dev) app that renders
the docs at the repo root, plus a landing page.

```sh
bun install
bun run dev        # http://localhost:3000
bun run build      # static output in dist/public
bun run check:docs # links, anchors, and raw HTML in ../docs
```

Bun installs; Node runs. fumapress declares `engines.node >= 24` and ships a
`#!/usr/bin/env node` bin, so `bun run build` hands off to Node via the shebang.
`.node-version` pins the runtime.

## Two things that will catch you out

**The content is `../docs`, outside this Vite root.** Two consequences. Node's resolution
walk from a page never reaches `site/node_modules`, so bare imports the MDX compiler injects
have nothing to resolve against — `resolveContentImports()` in `vite.config.ts` re-anchors
them. And the dev server does not watch outside its root, so **adding a docs page needs a
restart**; editing an existing one hot-reloads fine.

That first one is invisible here: the CLI's own `bun install` leaves a `react` in the repo
root that satisfies the import by accident. To reproduce a CI environment, move the root
`node_modules` aside and build.

**The build writes a deploy redirect that has to be removed.** `waku/adapters/cloudflare`
always emits a serverless entry and points `.wrangler/deploy/config.json` at its generated
config, which `wrangler deploy` prefers over `wrangler.jsonc` — it says so, "Using redirected
Wrangler configuration". That entry does not boot on workerd, and a failed Worker takes the
static assets down with it. `scripts/strip-server-deploy.mjs` deletes the redirect after every
build. It runs as part of `bun run build`; do not deploy without it.

## Deploying

Pushes to `main` build and deploy through Cloudflare Workers Builds (root directory `site`).
`bunx wrangler deploy` from here is the manual fallback. The `mirb.dev` custom domain is
attached to the Worker out of band, not declared in `wrangler.jsonc` — see the comments in
that file.

`mirb.dev/install.sh` is `../scripts/install.sh`, copied into `public/` at build time by
`scripts/sync-installers.mjs`. Edit the original, never the copy.
