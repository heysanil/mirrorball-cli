# `npm/` — the npm publish tree

Everything in this directory except this file is **generated**. Do not hand-edit it; edit
[`scripts/build-npm-packages.ts`](../scripts/build-npm-packages.ts) and regenerate.

```
bun scripts/build-npm-packages.ts --help
```

## Why this exists

mirrorball is distributed as a compiled Bun binary. npm has no way to say "ship a different
binary per platform" in one package, and the alternatives are all worse:

- a `postinstall` script that downloads a binary — breaks behind proxies, in offline installs,
  with `--ignore-scripts` (which many companies mandate), and leaves nothing for a lockfile
  to pin;
- one fat package containing all five binaries — a ~300 MB download to use ~60 MB of it.

So mirrorball uses the pattern esbuild, turbo, swc, biome and Rollup all landed on
independently: **one package per platform, plus a root package that dispatches.**

## Layout

```
npm/
├── README.md                  ← this file, the only checked-in thing here
├── mirb/                      ← the package users install
│   ├── package.json           ← bin (mirb + mirrorball) + optionalDependencies on all five below
│   ├── bin/mirb               ← Node shim (generated; see "The shim")
│   ├── README.md              ← copied from the repo root
│   └── LICENSE                ← copied from the repo root
├── mirb-cli-darwin-arm64/
│   ├── package.json           ← os: ["darwin"], cpu: ["arm64"]
│   └── bin/mirb               ← the compiled binary, mode 0755
├── mirb-cli-darwin-x64/
├── mirb-cli-linux-arm64/
├── mirb-cli-linux-x64/
└── mirb-cli-windows-x64/
    ├── package.json           ← os: ["win32"], cpu: ["x64"]
    └── bin/mirb.exe
```

The generated package directories are build output, not source. `.gitignore` covers
`npm/*/bin/`; if you would rather not track the generated `package.json` files either,
add `npm/mirb-cli/` and `npm/mirb-*/` to it. This file is the only thing here worth committing.

### Naming

Package names use **bunli's** target triple (`mirb-cli-windows-x64`), matching
`bunli.config.ts` `build.targets` and the GitHub Release asset names. The `os` field inside
uses **npm's** name for the same platform (`win32`). The two vocabularies disagree; the
generator's `PLATFORMS` table is the single place that translates, and the shim's dispatch
table is generated from it so the two cannot drift apart.

The package name is `mirb`, the command, not `mirrorball`, the project — the published
package is the thing you type. The long name is not lost: the root package's `bin` declares
both, so an install leaves `mirrorball` on your PATH beside `mirb`.

### How the dispatch works

1. `npm i mirb` installs the root package and tries all five `optionalDependencies`.
2. npm refuses to install a package whose `os`/`cpu` do not match the machine, and an
   optional dependency that will not install is skipped **silently**. Four of the five
   vanish; one lands in `node_modules/`.
3. npm links `node_modules/.bin/mirb` — and `node_modules/.bin/mirrorball`, the alias — to
   the root package's `bin/mirb` shim. One file, two names.
4. The shim maps `${process.platform}-${process.arch}` to a package name, resolves it, and
   hands the process over to the real binary.

The platform packages deliberately declare **no `bin`**. Five packages all claiming the name
`mirb` would race for the same `node_modules/.bin/mirb` symlink. They set
`preferUnplugged: true` instead, because Yarn PnP keeps packages zipped by default and you
cannot exec a zip entry. The executable bit is set explicitly by the generator, since npm
only guarantees it for files named in `bin`.

### The shim

`mirb/bin/mirb` is plain CommonJS with no dependencies, so it runs on any Node ≥ 18.

- On POSIX with Node ≥ 22.15 it calls `process.execve` and **replaces itself** with the real
  binary. That matters more here than for a typical build tool: mirrorball holds sockets open
  in the foreground, so Ctrl-C, job control (`^Z`, `bg`, `fg`) and the exit code should reach
  it without a Node process in the middle reinterpreting them. `process.execve` is
  experimental and prints a warning on first use, which the shim suppresses — a warning on
  every invocation of a CLI is not acceptable.
- Otherwise it falls back to `spawnSync` with `stdio: 'inherit'`, forwarding the exit code
  and translating a signal death into `128 + signum` the way a shell reports it.

The shim's error messages always **name the platform and the missing package**. A missing
platform package is the single most common failure of this pattern — usually from
`--omit=optional`, a lockfile built on a different OS, or [npm/cli#4828] — and every one of
those causes looks identical from the outside. `.github/workflows/ci.yml` asserts the message
still names them.

[npm/cli#4828]: https://github.com/npm/cli/issues/4828

## Regenerating

Two sources for the binaries:

```bash
# From a local build — what you want when iterating on the packaging itself.
bunx bunli build --targets all
bun scripts/build-npm-packages.ts --source dist

# From a published GitHub Release — what CI does. Downloads the tagged assets and verifies
# them against the release's checksums.txt, so npm ships the exact bytes that were released
# rather than a second, separately-compiled build.
bun scripts/build-npm-packages.ts --source release --version 1.2.3 --repo heysanil/mirrorball-cli
```

`--source auto` (the default) uses `dist/` when it holds a build for every target and
downloads otherwise. `--dry-run` prints the plan and writes nothing.

`bunli.config.ts` must keep `build.compress: false`. With compression on, `bunli build` tars
each per-target directory and deletes it; both this generator and the release workflow then find
an archive where they expected a binary.

## Publishing

`.github/workflows/release.yml` does this on a `v*.*.*` tag. Manually, the order matters:

```bash
for pkg in npm/mirb-*/; do (cd "$pkg" && npm publish --access public --provenance); done
(cd npm/mirb && npm publish --access public --provenance)
```

Platform packages **first**. The root package pins them by exact version, so publishing it
first opens a window where `npm i mirb` resolves a root package whose optional dependencies
404 — which npm reports as a warning, not an error, leaving the user with a shim and nothing
to dispatch to.

## Not to be confused with

The repo's own `package.json` is the *development* manifest: its `bin` points both names at
`mirb.ts` and it exists so `bun run` and `bunli` work. It is never published. The package on
npm is `npm/mirb-cli/`, generated here, and its `bin` points at the shim.
