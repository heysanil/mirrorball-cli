#!/usr/bin/env bun
/**
 * Generates the npm publish tree for mirb.
 *
 * mirb ships as a compiled Bun binary, and npm has no first-class way to ship one binary
 * per platform. The established workaround (esbuild, turbo, swc, biome) is: publish one
 * tiny package per platform carrying just that platform's binary, tagged with `os`/`cpu`
 * so npm silently skips the four that don't apply; then publish a root package that lists
 * all five as *optional* dependencies and whose `bin` is a Node shim that dispatches to
 * whichever one actually landed on disk.
 *
 * Nothing here is invented: the shape below is the same one `npm i esbuild` produces.
 * See npm/README.md for the layout and the reasoning behind each field.
 *
 * Usage:
 *   bun scripts/build-npm-packages.ts                       # auto: prefer ./dist, else download
 *   bun scripts/build-npm-packages.ts --source dist         # read ./dist from `bunli build`
 *   bun scripts/build-npm-packages.ts --source release \
 *     --version 1.2.3 --repo owner/mirb                      # download the tagged GitHub assets
 */

import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** One publish target. The two naming systems here disagree on purpose, so both are spelled out. */
interface PlatformSpec {
  /**
   * Bunli's target triple. Also the suffix bunli-releaser puts in asset names, and
   * (deliberately) the suffix of the npm package name, so `mirb-windows-x64` matches
   * `--targets windows-x64` and not npm's `win32`.
   */
  target: string
  /** npm `os` field. 'win32' — npm inherited Node's name for it, bunli did not. */
  npmOs: string
  /** npm `cpu` field. */
  npmCpu: string
  /** `${process.platform}-${process.arch}` as the shim will compute it at runtime. */
  runtimeKey: string
  exeSuffix: '' | '.exe'
}

/**
 * Kept in lockstep with bunli.config.ts `build.targets`. Adding a platform means adding it
 * in both places; the shim's dispatch table is generated from this one, so it cannot drift.
 */
const PLATFORMS: PlatformSpec[] = [
  { target: 'darwin-arm64', npmOs: 'darwin', npmCpu: 'arm64', runtimeKey: 'darwin-arm64', exeSuffix: '' },
  { target: 'darwin-x64', npmOs: 'darwin', npmCpu: 'x64', runtimeKey: 'darwin-x64', exeSuffix: '' },
  { target: 'linux-arm64', npmOs: 'linux', npmCpu: 'arm64', runtimeKey: 'linux-arm64', exeSuffix: '' },
  { target: 'linux-x64', npmOs: 'linux', npmCpu: 'x64', runtimeKey: 'linux-x64', exeSuffix: '' },
  { target: 'windows-x64', npmOs: 'win32', npmCpu: 'x64', runtimeKey: 'win32-x64', exeSuffix: '.exe' }
]

interface RootPackageJson {
  name: string
  version: string
  description?: string
  license?: string
  homepage?: string
  keywords?: string[]
  repository?: string | { type?: string; url?: string }
  bin?: string | Record<string, string>
}

interface Options {
  version: string
  source: 'dist' | 'release' | 'auto'
  distDir: string
  outDir: string
  repo: string | undefined
  dryRun: boolean
}

/**
 * Hand-rolled rather than routed through @bunli/core: this is a release-plumbing script,
 * not a user-facing command, and it must stay runnable from a bare `bun scripts/...`.
 */
function parseArgs(argv: string[]): Partial<Options> & { help: boolean } {
  const out: Partial<Options> & { help: boolean } = { help: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      return value
    }

    switch (arg) {
      case '--help':
      case '-h':
        out.help = true
        break
      case '--version':
        out.version = next()
        break
      case '--source': {
        const value = next()
        if (value !== 'dist' && value !== 'release' && value !== 'auto') {
          throw new Error(`--source must be dist, release or auto (got '${value}')`)
        }
        out.source = value
        break
      }
      case '--dist':
        out.distDir = next()
        break
      case '--out':
        out.outDir = next()
        break
      case '--repo':
        out.repo = next()
        break
      case '--dry-run':
        out.dryRun = true
        break
      default:
        throw new Error(`unknown flag '${arg}'`)
    }
  }

  return out
}

const HELP = `bun scripts/build-npm-packages.ts [options]

  --version <x.y.z>   Version to stamp on every package. Default: package.json version.
  --source <mode>     dist | release | auto (default). 'auto' uses ./dist when it holds a
                      build for every target, otherwise downloads the tagged release assets.
  --dist <dir>        Where 'bunli build' put its output. Default: ./dist
  --out <dir>         Where to write the publish tree. Default: ./npm
  --repo <owner/name> Repo to download release assets from. Default: $GITHUB_REPOSITORY,
                      else the repository field in package.json.
  --dry-run           Print the plan; write nothing.
`

/** `git+https://github.com/o/r.git`, `github:o/r`, `o/r` — all mean the same thing here. */
function parseRepoField(repository: RootPackageJson['repository']): string | undefined {
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (!raw) return undefined
  const match = /(?:github\.com[:/]|^github:)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(raw.trim())
  return match?.[1]
}

/** The long-form alias published alongside the primary command. */
const ALIAS_BIN_NAME = 'mirrorball'

/**
 * The npm package name, which is NOT the command name.
 *
 * npm rejected `mirb` as "too similar to existing packages" (mitt, mime, micro, mri, sirv,
 * idb, nib) — a registry-side check on new names that has nothing to do with availability.
 * So the package is `mirb-cli` while the command it installs stays `mirb`. That split is
 * ordinary on npm: create-react-app, @angular/cli and vite-node all do it.
 *
 * Everything the user types is the bin name; everything npm resolves is this.
 */
function derivePkgName(pkg: RootPackageJson): string {
  return pkg.name
}

/** npm links whatever key `bin` uses, so the shim and the binaries must all agree on it. */
function deriveBinName(pkg: RootPackageJson): string {
  if (typeof pkg.bin === 'string') return pkg.name
  const keys = Object.keys(pkg.bin ?? {})
  return keys[0] ?? pkg.name
}

/**
 * The shim, as it will be written to the root package's `bin/`.
 *
 * Written in ES5-ish CommonJS with string concatenation instead of template literals:
 * it has to run on whatever Node the user happens to have, and keeping backticks out of
 * the source means this template needs no escaping to survive a round trip through here.
 */
const SHIM_TEMPLATE = `#!/usr/bin/env node
// Generated by scripts/build-npm-packages.ts. Do not edit; edit the generator.
'use strict'

var fs = require('fs')
var os = require('os')
var path = require('path')

// process.platform + '-' + process.arch -> the package that carries that binary.
var PLATFORM_PACKAGES = __PLATFORM_PACKAGES__
var BIN_NAME = __BIN_NAME__

function fail(lines) {
  process.stderr.write(lines.join('\\n') + '\\n')
  process.exit(1)
}

var key = process.platform + '-' + process.arch
var pkgName = PLATFORM_PACKAGES[key]

// Naming the platform is the whole point of this message: the two failures below are
// indistinguishable to a user staring at "command not found", and they have different fixes.
if (!pkgName) {
  fail([
    BIN_NAME + ': no prebuilt binary for this platform (' + key + ').',
    'Supported: ' + Object.keys(PLATFORM_PACKAGES).sort().join(', ') + '.',
    'Build from source instead: bun install && bun run build'
  ])
}

var binPath = null
try {
  // Resolving package.json rather than the binary itself: it is the one path that is
  // guaranteed resolvable no matter how the installer laid node_modules out.
  binPath = path.join(path.dirname(require.resolve(pkgName + '/package.json')), 'bin', BIN_NAME + (process.platform === 'win32' ? '.exe' : ''))
} catch (err) {
  fail([
    BIN_NAME + ': the platform package "' + pkgName + '" for ' + key + ' is not installed.',
    'It is an optional dependency, so a failed or skipped optional install is silent.',
    'Try:  npm install ' + pkgName,
    'Or reinstall cleanly: rm -rf node_modules package-lock.json && npm install',
    'If you installed with --no-optional / --omit=optional, that is the cause.'
  ])
}

if (!fs.existsSync(binPath)) {
  fail([
    BIN_NAME + ': the platform package "' + pkgName + '" for ' + key + ' resolved, but its binary is missing.',
    'Expected: ' + binPath,
    'Reinstall cleanly: rm -rf node_modules package-lock.json && npm install'
  ])
}

var args = process.argv.slice(2)

// Replacing this process is strictly better than wrapping it: mirb holds sockets open in
// the foreground, so job control, Ctrl-C and the exit code should reach it unmediated.
// execve landed in Node 22.15/23.11, is POSIX-only, and warns unless we muzzle it.
if (typeof process.execve === 'function' && process.platform !== 'win32') {
  var emitWarning = process.emitWarning
  try {
    process.emitWarning = function () {}
    // argv is passed whole, argv[0] included: Node does not prepend it for us.
    process.execve(binPath, [binPath].concat(args), process.env)
  } catch (err) {
    // Fall through to spawnSync.
  } finally {
    process.emitWarning = emitWarning
  }
}

var result = require('child_process').spawnSync(binPath, args, { stdio: 'inherit' })

if (result.error) {
  fail([BIN_NAME + ': failed to run ' + binPath, String(result.error && result.error.message)])
}

// A child killed by a signal has no exit status. Report it the way a shell would rather
// than flattening every signal death into 1.
if (result.signal) {
  var signum = os.constants.signals[result.signal]
  process.exit(typeof signum === 'number' ? 128 + signum : 1)
}

process.exit(result.status === null ? 1 : result.status)
`

function renderShim(binName: string, pkgName: string): string {
  const table: Record<string, string> = {}
  // Package names, not the bin name: the shim resolves these through node's module lookup.
  for (const p of PLATFORMS) table[p.runtimeKey] = `${pkgName}-${p.target}`

  return SHIM_TEMPLATE.replace('__PLATFORM_PACKAGES__', JSON.stringify(table, null, 2)).replaceAll(
    '__BIN_NAME__',
    JSON.stringify(binName)
  )
}

/**
 * Locate the compiled binary bunli produced for one target.
 *
 * bunli names the executable after the *entry file* (mirb.ts -> `mirb`), and only creates
 * per-target subdirectories when more than one target was built. Rather than encode either
 * rule, take the single executable that is there — the same tactic bunli-releaser uses.
 */
async function findBuiltBinary(distDir: string, target: string): Promise<string> {
  const dir = join(distDir, target)

  let entries: string[]
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.endsWith('.map'))
      .map((e) => join(dir, e.name))
  } catch {
    // The per-target directory is required, never the flat `dist/<name>` a single-target
    // build leaves behind: that shape would happily hand the same darwin binary to all five
    // packages. Say so, and name the likeliest cause.
    if (await Bun.file(`${dir}.tar.gz`).exists()) {
      throw new Error(`${dir}.tar.gz found instead of ${dir}/ — set build.compress = false in bunli.config.ts`)
    }
    throw new Error(`no build output for ${target}: ${dir} does not exist`)
  }

  if (entries.length !== 1) {
    throw new Error(
      `expected exactly one executable in ${dir} for ${target}, found ${entries.length}` +
        (entries.length > 0 ? `: ${entries.map((p) => basename(p)).join(', ')}` : '')
    )
  }
  return entries[0]!
}

/** Asset names are fixed by bunli-releaser: `<bin>-<version>-<os>-<arch>.{tar.gz,zip}`. */
function assetName(binName: string, version: string, p: PlatformSpec): string {
  const base = `${binName}-${version}-${p.target}`
  return p.exeSuffix === '.exe' ? `${base}.zip` : `${base}.tar.gz`
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function run(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed (exit ${code})\n${stderr}`)
}

/**
 * Pull every binary out of the GitHub release for this version.
 *
 * Verifying against the release's own checksums.txt is cheap and closes the gap between
 * "the bytes we released" and "the bytes we published to npm" — the whole reason to prefer
 * this path over rebuilding.
 */
async function fetchFromRelease(
  repo: string,
  binName: string,
  version: string
): Promise<Map<string, string>> {
  // Overridable so the download path can be exercised against a local mirror in tests,
  // and so a fork publishing from a proxy is not forced to patch this script.
  const origin = Bun.env.MIRB_RELEASE_BASE_URL ?? `https://github.com/${repo}/releases/download`
  const base = `${origin}/v${version}`
  const staging = await mkdtemp(join(tmpdir(), 'mirb-npm-'))

  const checksums = new Map<string, string>()
  try {
    const text = new TextDecoder().decode(await download(`${base}/checksums.txt`))
    for (const line of text.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 2) checksums.set(parts[parts.length - 1]!, parts[0]!)
    }
  } catch (err) {
    console.warn(`  ! checksums.txt unavailable, skipping verification (${(err as Error).message})`)
  }

  const found = new Map<string, string>()

  for (const p of PLATFORMS) {
    const name = assetName(binName, version, p)
    console.log(`  downloading ${name}`)
    const bytes = await download(`${base}/${name}`)

    const expected = checksums.get(name)
    if (expected) {
      const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
      if (actual !== expected) {
        throw new Error(`checksum mismatch for ${name}\n  expected ${expected}\n  actual   ${actual}`)
      }
    }

    const archivePath = join(staging, name)
    await Bun.write(archivePath, bytes)

    const unpacked = join(staging, p.target)
    await mkdir(unpacked, { recursive: true })

    if (name.endsWith('.zip')) {
      // GNU tar cannot read zip; bsdtar can. unzip is present on both CI runners.
      const unzip = Bun.which('unzip')
      await run(unzip ? [unzip, '-q', '-o', archivePath, '-d', unpacked] : ['tar', '-xf', archivePath, '-C', unpacked])
    } else {
      await run(['tar', '-xzf', archivePath, '-C', unpacked])
    }

    found.set(p.target, join(unpacked, `${binName}${p.exeSuffix}`))
  }

  return found
}

async function collectBinaries(opts: Options, binName: string): Promise<Map<string, string>> {
  const distUsable = await (async () => {
    for (const p of PLATFORMS) {
      try {
        await findBuiltBinary(opts.distDir, p.target)
      } catch {
        return false
      }
    }
    return true
  })()

  const source = opts.source === 'auto' ? (distUsable ? 'dist' : 'release') : opts.source

  if (source === 'dist') {
    if (!distUsable) {
      throw new Error(
        `${opts.distDir} does not contain a binary for every target.\n` +
          `Run: bunx bunli build --targets all   (or pass --source release)`
      )
    }
    console.log(`Reading binaries from ${opts.distDir}`)
    const found = new Map<string, string>()
    for (const p of PLATFORMS) found.set(p.target, await findBuiltBinary(opts.distDir, p.target))
    return found
  }

  if (!opts.repo) {
    throw new Error('--source release needs a repo: pass --repo owner/name or set $GITHUB_REPOSITORY')
  }
  console.log(`Downloading binaries from ${opts.repo}@v${opts.version}`)
  return fetchFromRelease(opts.repo, binName, opts.version)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, JSON.stringify(value, null, 2) + '\n')
}

async function main(): Promise<void> {
  const root = resolve(dirname(import.meta.dir))
  const parsed = parseArgs(Bun.argv.slice(2))

  if (parsed.help) {
    console.log(HELP)
    return
  }

  const pkg = (await Bun.file(join(root, 'package.json')).json()) as RootPackageJson
  const binName = deriveBinName(pkg)
  const pkgName = derivePkgName(pkg)

  const opts: Options = {
    version: parsed.version ?? pkg.version,
    source: parsed.source ?? 'auto',
    distDir: resolve(root, parsed.distDir ?? 'dist'),
    outDir: resolve(root, parsed.outDir ?? 'npm'),
    repo: parsed.repo ?? Bun.env.GITHUB_REPOSITORY ?? parseRepoField(pkg.repository),
    dryRun: parsed.dryRun ?? false
  }

  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(opts.version)) {
    throw new Error(`--version must look like x.y.z (got '${opts.version}')`)
  }

  console.log(`Building npm packages for ${binName}@${opts.version}`)

  if (opts.dryRun) {
    console.log(`  source:  ${opts.source}${opts.source === 'release' ? ` (${opts.repo ?? 'no repo'})` : ''}`)
    console.log(`  out:     ${opts.outDir}`)
    for (const p of PLATFORMS) console.log(`  package: ${pkgName}-${p.target}  (os=${p.npmOs} cpu=${p.npmCpu})`)
    console.log(`  package: ${pkgName}  (root, ${PLATFORMS.length} optionalDependencies)`)
    return
  }

  const binaries = await collectBinaries(opts, binName)

  const repoField = opts.repo ? { type: 'git', url: `git+https://github.com/${opts.repo}.git` } : undefined
  const optionalDependencies: Record<string, string> = {}

  for (const p of PLATFORMS) {
    const platformPkg = `${pkgName}-${p.target}`
    const dir = join(opts.outDir, platformPkg)
    await rm(dir, { recursive: true, force: true })
    await mkdir(join(dir, 'bin'), { recursive: true })

    const src = binaries.get(p.target)
    if (!src) throw new Error(`no binary collected for ${p.target}`)

    const dest = join(dir, 'bin', `${binName}${p.exeSuffix}`)
    await Bun.write(dest, Bun.file(src))
    // npm only guarantees the executable bit for files named in `bin`, and these packages
    // deliberately declare none. Set it here so it survives into the published tarball.
    await chmod(dest, 0o755)

    await writeJson(join(dir, 'package.json'), {
      name: platformPkg,
      version: opts.version,
      description: `The ${p.target} binary for ${binName}.`,
      // These two are the entire mechanism: npm refuses to install a package whose os/cpu
      // do not match, which is what makes four of these five silently vanish.
      os: [p.npmOs],
      cpu: [p.npmCpu],
      // No `bin` on purpose. Five packages all claiming the name `mirb` would race to own
      // the same node_modules/.bin symlink; the root package's shim owns that name.
      // Yarn PnP keeps packages zipped unless told otherwise, and you cannot exec a zip entry.
      preferUnplugged: true,
      engines: { node: '>=18' },
      ...(pkg.license ? { license: pkg.license } : {}),
      ...(repoField ? { repository: repoField } : {}),
      ...(pkg.homepage ? { homepage: pkg.homepage } : {})
    })

    optionalDependencies[platformPkg] = opts.version
    console.log(`  wrote ${platformPkg}`)
  }

  const rootDir = join(opts.outDir, pkgName)
  await rm(rootDir, { recursive: true, force: true })
  await mkdir(join(rootDir, 'bin'), { recursive: true })

  const shimPath = join(rootDir, 'bin', binName)
  await Bun.write(shimPath, renderShim(binName, pkgName))
  await chmod(shimPath, 0o755)

  await writeJson(join(rootDir, 'package.json'), {
    name: pkgName,
    version: opts.version,
    description: pkg.description,
    ...(pkg.keywords ? { keywords: pkg.keywords } : {}),
    ...(pkg.license ? { license: pkg.license } : {}),
    ...(repoField ? { repository: repoField } : {}),
    ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
    // Both names point at the same shim: `mirb` is what you type, `mirrorball` is what
    // people remember the project by. npm links each key, so this costs nothing but a
    // second symlink and saves the "command not found" that the long name would otherwise
    // give someone who installed from npm rather than the curl installer.
    bin: { [binName]: `bin/${binName}`, [ALIAS_BIN_NAME]: `bin/${binName}` },
    files: ['bin'],
    engines: { node: '>=18' },
    // Exact pins, not ranges: a root package must never dispatch to a binary from a
    // different build than the one it was published alongside.
    optionalDependencies
  })

  const readme = Bun.file(join(root, 'README.md'))
  await Bun.write(
    join(rootDir, 'README.md'),
    (await readme.exists())
      ? await readme.text()
      : `# ${binName}\n\n${pkg.description ?? ''}\n\nInstall: \`npm i -g ${binName}\`\n`
  )

  const license = Bun.file(join(root, 'LICENSE'))
  if (await license.exists()) await Bun.write(join(rootDir, 'LICENSE'), await license.text())

  console.log(`  wrote ${pkgName} (root)`)
  console.log(`\nPublish with:\n  for d in ${opts.outDir}/${pkgName}-*/; do (cd "$d" && npm publish --access public --provenance); done\n  (cd ${opts.outDir}/${pkgName} && npm publish --access public --provenance)`)
}

main().catch((err: unknown) => {
  console.error(`build-npm-packages: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
