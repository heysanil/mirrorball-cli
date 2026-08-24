// Removes the deploy redirect waku/adapters/cloudflare writes during postBuild.
//
// The adapter always builds a serverless entry and points .wrangler/deploy/config.json at
// dist/server/wrangler.json. `wrangler deploy` follows that redirect in preference to the
// wrangler.jsonc in this directory — it says so explicitly: "Using redirected Wrangler
// configuration". mirb.dev ships as static assets with no Worker (see wrangler.jsonc), so
// the redirect has to go, or the deploy silently uses the wrong config.
//
// Deleting the file rather than editing it keeps one source of truth: if a future adapter
// version stops writing it, this is a no-op instead of a conflicting second config.

import { rm, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const redirect = resolve(root, '.wrangler', 'deploy', 'config.json')

try {
  await access(redirect)
  await rm(redirect)
  console.log('strip-server-deploy: removed .wrangler/deploy/config.json')
} catch {
  console.log('strip-server-deploy: no deploy redirect to remove')
}
