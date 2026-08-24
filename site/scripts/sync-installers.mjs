// Copies the installers into the site's public dir so they are served at
// https://mirb.dev/install.sh and /install.ps1.
//
// A copy, not a second source of truth: ../scripts/install.sh remains the only
// place either script is edited. Runs on predev and prebuild so a change to the
// installer can never ship a stale copy to the site.

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = resolve(here, '..', '..', 'scripts')
const to = resolve(here, '..', 'public')

const FILES = ['install.sh', 'install.ps1']

await mkdir(to, { recursive: true })

for (const name of FILES) {
  await copyFile(join(from, name), join(to, name))
  console.log(`sync-installers: scripts/${name} -> site/public/${name}`)
}
