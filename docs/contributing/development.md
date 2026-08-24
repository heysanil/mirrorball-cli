---
title: Development
description: Set up the repo, run mirrorball from source, and learn the conventions the codebase holds itself to.
sidebar_position: 1
---

# Development

mirrorball is deliberately small. There is one runtime (Bun), one package manager (Bun),
no build step during development, and no linter config to argue with. You should be
able to go from `git clone` to a running CLI in under a minute.

## Prerequisites

| | |
| --- | --- |
| **Bun 1.3 or newer** | The only required toolchain. `curl -fsSL https://bun.sh/install \| bash` |
| **ssh** | Any OpenSSH client, for manual testing. The automated tests don't need it. |
| **git** | For the obvious reasons. |

Node.js is not required and not supported — mirrorball uses Bun-native APIs (`Bun.spawn`,
`Bun.TOML`, `Bun.stringWidth`, `Bun.which`) that have no Node equivalent we're willing
to shim.

```sh
git clone https://github.com/heysanil/mirrorball-cli.git
cd mirrorball-cli
bun install
```

## Repo layout

```
mirrorball-cli/
├── mirb.ts                 entry point; registers commands, normalizes argv
├── bunli.config.ts         CLI metadata and build targets
├── commands/               one file per subcommand, plus their shared helpers
│   ├── up.ts               the default command — anything argv-shaped ends up here
│   ├── ls.ts               list background sessions
│   ├── stop.ts             stop one or all sessions
│   ├── logs.ts             tail a session's log
│   ├── supervise.ts        `__supervise`, the detached background supervisor
│   └── shared.ts           machine-mode detection, the {ok,data,meta} envelope, session lookup
├── core/                   logic and state; never prints to the terminal
│   ├── types.ts            THE shared contract (see below)
│   ├── errors.ts           MirbError, and classifySshStderr
│   ├── target.ts           parse/format/render `[user@]host[:port]`
│   ├── portspec.ts         parse `3000`, `8080:80`, `8080:db.internal:5432`, ranges
│   ├── ports.ts            local port pre-flight, for better errors than ssh gives
│   ├── bind.ts             bind-address normalization and the exposure predicate
│   ├── ssh.ts              buildSshArgs (pure) and spawning the child
│   ├── probe.ts            waitForBind and probeRemote — bound, then ready/refused
│   ├── session.ts          one ssh process and its forwards; the state machines
│   ├── supervisor.ts       one session across many ssh processes; retry policy
│   ├── state.ts            session records on disk: atomic writes, zod on read
│   ├── config.ts           config.toml and named profiles
│   ├── ids.ts              session ids, prefix resolution, short display ids
│   └── backoff.ts          reconnect delays and the attempt tracker
├── ui/                     rendering: tables, status lines, colour
├── test/                   one `<module>.test.ts` per module; fixtures/ holds the fake ssh
├── docs/                   the documentation site
└── scripts/                install.sh, install.ps1
```

Two structural rules matter more than the rest:

**`core/types.ts` is the contract.** Every shared type lives there. If a module needs
a type from another module, the type is in the wrong place — move it to `types.ts`
rather than importing a concrete implementation to reach it. This is what keeps
`commands/`, `core/` and `ui/` independently testable.

**`core/` never prints.** Terminal output belongs to `ui/` and `commands/`. Core
modules return values and throw `MirbError`; they don't decide what the user sees.

## Running from source

```sh
bun run dev -- 10.0.0.7 3000 8080     # through the bunli dev harness
bun mirb.ts 10.0.0.7 3000 8080        # straight to the entry point, slightly faster
```

The `--` matters: `bun run dev` expands to `bunx bunli dev --entry ./mirb.ts --`, so
everything after your `--` becomes mirrorball's argv rather than bunli's.

To exercise the ssh paths without an ssh server, point `$MIRB_SSH` at the test harness —
it binds the `-L` ports for real, so readiness probes behave:

```sh
MIRB_SSH=$PWD/test/fixtures/fake-ssh.ts bun mirb.ts example.test 3000 --format json
```

`$MIRB_SSH` is resolved through the same executability check as a `PATH` lookup, so the
fixture needs its executable bit. See the [Testing](./testing.md) guide for the scenarios
it can be put through.

To get a global `mirb` on your PATH that points at your working tree:

```sh
bun link          # then `mirb ...` anywhere
bun unlink        # when you're done
```

Both bin names are linked, so `mirrorball ...` works too — the package declares `mirb`
and `mirrorball` pointing at the same entry point.

## Checks

```sh
bun test                 # the whole suite; see the Testing guide
bun test test/ssh.test.ts    # one file
bun x tsc --noEmit       # typecheck (also: bun run typecheck)
bun run build            # standalone binary for this machine, into dist/
bun run build:all        # all five release targets
```

`bun x tsc --noEmit` is not optional before opening a PR. Bun's runtime strips types
without checking them, so a type error will happily run until CI catches it.

`bun run build` is worth running when you touch anything that reads files or resolves
paths at runtime: the compiled binary (`dist/<target>/mirb`) has no source tree next to
it and a different `import.meta`, so a path that works under `bun mirb.ts` can still be
wrong once shipped.

## Code conventions

### TypeScript settings you will feel

The config is strict, plus two flags that change how you write code:

- **`noUncheckedIndexedAccess`** — `arr[0]` has type `T | undefined`. Handle it, or
  assert with `!` only where the surrounding code has already proven the index exists
  (as `resolveIdPrefix` does after a length check).
- **`verbatimModuleSyntax`** — type-only imports must say so:
  `import type { Forward } from './types.ts'`. A value import of a type is a build error.
- **Relative imports carry the `.ts` extension.** `allowImportingTsExtensions` is on;
  `./types.ts`, never `./types`.

### Style

No Prettier, no ESLint — match the surrounding code. In practice that means two-space
indentation, single quotes, no semicolons, and no line-wrapping ceremony.

### Comments explain *why*

The bar for a comment is that it says something the code cannot. `core/backoff.ts` is
the reference:

> Jitter is applied symmetrically so a fleet of mirrorball instances reconnecting after a
> network blip doesn't stampede the same sshd.

A comment restating the line below it is worse than no comment, because it has to be
maintained. JSDoc on exported symbols should describe the contract and the reasoning
behind any surprising part of it.

### Errors

Every failure a user can hit is a `MirbError` carrying a `MirbErrorCode` and, wherever
possible, a `hint` telling them what to actually do. Codes map to process exit codes
through `MirbError#exitCode`, and the codes themselves are part of the JSON output —
so adding a new failure mode means adding a code to `MirbErrorCode` in `types.ts`, not
inventing a new bare `Error`.

Never infer success from ssh's stderr. `classifySshStderr` exists only to explain a
failure that already happened; readiness is decided by probing sockets.

### Prefer the platform

Reach for Bun and `@bunli/utils` before adding a dependency:

| Need | Use |
| --- | --- |
| Colour | `Bun.color(hex, 'ansi')`, or `colors` from `@bunli/utils` |
| Terminal width of a string | `Bun.stringWidth()` (handles emoji and CJK) |
| Stripping ANSI | `Bun.stripANSI()` |
| Parsing config.toml | `Bun.TOML.parse()` |
| Finding a binary | `Bun.which()` |
| Spawning ssh | `Bun.spawn` |
| Config/data/state/cache paths | `configDir()`, `dataDir()`, `stateDir()`, `cacheDir()` from `@bunli/utils` — cross-platform XDG, don't hand-roll `~/.config` |

A PR that adds a runtime dependency needs to say why in the description. There are
currently four (`@bunli/core`, `@bunli/utils`, `nanoid`, `zod`) and that's a feature.

### CLI conventions

- Commands are `defineCommand({ name, description, options, handler })` from
  `@bunli/core`, with options validated by zod schemas.
- **Bunli already owns `--help`/`-h`, `--version`/`-v`, `--format` and `--llms`.**
  `-h` and `-v` are therefore unavailable as short flags for anything of ours; pick
  a different letter rather than fighting for them.
- `positional` arrives raw and variadic. Ports, hosts and profile names are parsed and
  validated by mirrorball's own code, not by the framework — which is why bad input
  produces a `USAGE` `MirbError` with a hint rather than a framework stack trace.
- Take `colors`, `terminal` and `agent` from the handler context instead of detecting
  TTYs yourself. `agent` is true when stdout isn't a TTY; that's the signal to drop
  spinners and animation.
- New identifiers use `core/ids.ts`: lowercase alphanumeric nanoids with a two-letter
  type prefix (`mb_`), never UUIDs.

## Where to go next

- [Testing](./testing.md) — the suite, and the fake-ssh harness that makes it possible
  to test ssh behaviour without an ssh server.
- [Releasing](./releasing.md) — how a tag becomes binaries and a GitHub release.
