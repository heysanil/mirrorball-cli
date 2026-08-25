# AGENTS.md

Working notes for anyone — human or agent — modifying **mirrorball**.

This is not a tour of the code; the code is readable and `docs/` explains it for users. This
file holds the things that are **expensive to rediscover**: invariants that look like style but
are load-bearing, facts about OpenSSH and Bunli that were established by measurement rather
than documentation, and the couplings where changing one file silently requires changing
another.

If you read one section, make it [Invariants](#invariants-that-look-like-style-and-are-not).

---

## Orientation

**The project is `mirrorball`. The command is `mirb`. The repo is `heysanil/mirrorball-cli`.**
Those three names differ on purpose; keep prose and code samples using the right one.

`mirb 10.0.0.7 3000 3010 8080` replaces an `ssh -N -L …` incantation. mirrorball **wraps the
system `ssh`** and never reimplements it: `~/.ssh/config` aliases, `ProxyJump`, agent
forwarding and hardware keys all apply untouched.

### The one idea

`ssh -L` binds the local socket whether or not anything is listening on the far end. You find
out when your first request hangs. mirrorball distinguishes three states:

| state | meaning | who fixes it |
|---|---|---|
| `bound` | the local socket accepts connections | — |
| `ready` | a probe reached the remote service | — |
| `refused` | the tunnel is healthy, the remote service is down | **you fix your app** |
| `failed` | mirrorball could not establish the forward | **you fix your ssh** |

`refused` vs `failed` is the entire product. If they ever render alike, the feature is
invisible. That is why `ui/theme.ts` paints `refused` amber and `failed` red, and why
`Theme.forward` is a `Record<ForwardStatus, …>` — the compiler forces exhaustiveness.

### Layout

```
mirb.ts              entry: argv normalization, command registration
commands/            CLI wiring — up, ls, stop, logs, __supervise, shared
core/                pure logic and the runtime; never imports ui/
ui/                  presentation only; may import core/
test/                12 files; fixtures/fake-ssh.ts is the keystone
docs/                22 pages + one meta.json per folder, Diátaxis-shaped
scripts/             install.sh, install.ps1
site/                mirb.dev (fumapress); reads ../docs. Node + npm, not Bun
```

**`core/types.ts` is the contract.** Every module depends on it rather than on each other.
If you need a type from another module, it belongs there. Three zod schemas are pinned to it by
compile-time asserts — `core/state.ts` (`SessionRecord`), `core/config.ts` (`Profile`,
`MirbConfig`), `commands/supervise.ts` (`SessionPlan`) — so adding a required field to the type
without the schema is a type error. The reverse is not caught.

**Dependency rule:** `core/` never prints and never imports `ui/`.

---

## Invariants that look like style, and are not

Each of these survives review only if you know why it is there. Every one has a comment in
place; this is the index.

### Every `-L` carries an explicit bind address
`core/ssh.ts` — guarded by `test/invariants.test.ts`.

A bare `-L PORT:host:port` makes ssh bind **both** `127.0.0.1` and `::1`. If a squatter holds
only IPv4, the IPv6 bind succeeds, `ExitOnForwardFailure` never fires, and the user gets a live
tunnel on `::1` while `127.0.0.1` belongs to somebody else — silently. Shortening
`127.0.0.1:3000:localhost:3000` to `3000:localhost:3000` "because it works" reintroduces this.
The test asserts every emitted `-L` has exactly four colon-separated fields.

### mirrorball's `-o` options precede the user's
`core/ssh.ts` — guarded by `test/invariants.test.ts`.

ssh takes the **first** value it obtains for a keyword. Measured both directions. So emitting
ours first makes `--ssh-option ExitOnForwardFailure=no` unable to disable the safety property,
while user options still override their `ssh_config`. **Argument order is a security property.**

### `isLoopbackAddress` is a full literal match, never a prefix test
`core/bind.ts` — guarded by `test/bind.test.ts`.

`startsWith('127.')` accepts the **hostname** `127.evil.com`, which resolves wherever its owner
points it. This predicate is the only thing between a user and publishing an internal service,
because an explicit `0.0.0.0`/`*` bypasses `GatewayPorts` entirely. It **fails closed**:
`127.1`, `127.0.0.256`, `127.0.0.1:8080`, `0.0.0.0.0` are all "exposed".

The tests that matter are the near-misses, not `127.0.0.1` and `0.0.0.0`.

### `localhost` is collapsed to `127.0.0.1` before it reaches ssh
`core/bind.ts` `normalizeBindAddress`.

`localhost` is a *name*: ssh hands it to `getaddrinfo()` and binds one socket per family — the
same dual-stack trap as above. It also makes mirrorball disagree with itself, since the
pre-flight check and the readiness probe each resolve `localhost` independently and may pick a
different socket than ssh bound.

### The ssh option gate matches both spellings
`core/bind.ts` `sshOptionKeyword` — guarded by `test/bind.test.ts`.

ssh accepts `-o Keyword=value` **and** `-o "Keyword value"`. Splitting on `=` alone let
`-o "LocalForward 9999 localhost:9999"` through, creating a listener absent from `ls`, from the
event stream, and from `stop`. Match the leading identifier.

### `classifySshStderr` branch order
`core/errors.ts`.

Generic branches contain substrings that also appear in specific ones:

```
bind [::1]:1023: Permission denied            contains "permission denied"
channel 3: open failed: connect failed: …     contains "connection refused"
```

Bind/forward branches must precede auth and connect branches, or the specific codes become
unreachable. The bug is invisible without tests using those exact strings — which exist.

### `session.exit` is terminal on the event stream
`core/session.ts` `emit()`.

`probeAll()` can still be in flight when ssh dies, so a `forward.ready` could otherwise land
*after* `session.exit`. A consumer treating the stream as a lifecycle would see a session come
back to life. Nothing may follow `session.exit`.

### `hasExited` vs `exited`
`core/ssh.ts`.

`exited` deliberately waits for stderr to drain so classification has the full text. Readiness
must **not** wait for that: during those milliseconds the process is gone, and a squatter would
answer a bind probe and be reported as `forward.bound` for a listener ssh never owned.

### Readiness re-checks process state after preflight
`core/session.ts` `start()`.

Preflight is the first `await`, so a Ctrl-C can land while it runs; `proc` is still null, `stop()`
finishes immediately, and spawning afterwards produces a child nothing will ever terminate.

### The forward cap is global, not per-range
`core/portspec.ts` `MAX_TOTAL_FORWARDS`.

`1000-1255 2000-2255` is two legal ranges and 512 forwards. A per-range check also misses 257
bare ports. The limit bounds argv and socket count; neither cares how it was spelled.

### `isOurSupervisor` before signalling, `isProcessAlive` for display
`core/state.ts`, `commands/stop.ts`.

`stop` sends SIGTERM then SIGKILL. Pids are recycled, so existence is not sufficient for a
destructive act — ownership is checked via the process command line. But `ls` uses plain
liveness on purpose: a false negative there would *hide a running session*, which is worse than
showing a stale one. **Conservative where destructive, permissive where informational.**

### `process.on('SIGHUP', () => {})` in the supervisor
`commands/supervise.ts`. The no-op listener *is* the mechanism — Node's default SIGHUP action
is terminate, and installing any listener replaces it. Deleting it as dead code kills every
background session when the terminal closes.

### No line in the live frame may wrap
`ui/live.ts` — guarded by `test/ui.test.ts`.

One wrapped line makes every subsequent cursor-up off by one for the rest of the session,
eating scrollback. Truncation is enforced against `Bun.stringWidth`, not `.length`.

### Colour formats are named, never `'ansi'`
`ui/theme.ts` — guarded by `test/ui.test.ts`.

`Bun.color(hex, 'ansi')` re-derives colour support from the environment and returns `""` when it
disapproves, silently overriding the level you resolved. Use `'ansi-16m'` / `'ansi-256'`.
**This shipped; only CI caught it**, because every local run had a TTY and a `COLORTERM`.

### Handlers catch their own errors instead of throwing
`commands/shared.ts` `fail()`. See [Bunli](#bunli-091) — a thrown error loses its exit code and
its fields.

---

## OpenSSH — measured, not assumed

All against **OpenSSH_10.2p1**, several against a throwaway sshd and a second LAN machine. If
any turns out to be version-specific, revisit the decision above it rather than patching around.

**ssh exits 255 for everything.** Bind conflict, auth, DNS, refused, malformed `-L`, privileged
port — all 255. Other codes are reserved for relaying a remote command's status, and `-N` has no
remote command. There is no shortcut: `classifySshStderr` is infrastructure, not a nicety.

**A bare `-L` binds two sockets.**
```
-L 45963:localhost:3000            -> [::1]:45963 AND 127.0.0.1:45963
-L 127.0.0.1:45962:localhost:3000  -> 127.0.0.1:45962 only
```
With an explicit bind, the protection works — occupied port gives exit 255 in **90 ms** with
`bind: Address already in use` / `cannot listen to port` / `Could not request local forwarding`.

**`GatewayPorts` governs `-L`, not just `-R`** — `man ssh_config` says so explicitly — **and an
explicit `0.0.0.0`/`*` bypasses it entirely.** Verified reachable from another LAN machine. The
bind address is the only protection, which is why `--expose` exists.

**`channel N: open failed` is non-fatal**, and only the reason token is stable: the channel
number varies with session history, and the trailing text is the *remote's* errno string
(macOS and Linux differ). Match `open failed:` plus the reason. Reachable reasons via `-L` are
`administratively prohibited` and `connect failed`.

**Refusal latency ≈ 3 × RTT.** Six runs each: loopback (RTT 0.098 ms) → 0.32–0.85 ms;
github.com (RTT 32.9 ms) → 103–105 ms. Fixed overhead is sub-millisecond, so this is a
*relation*. The probe settle window is therefore an RTT budget — 750 ms covers ~250 ms RTT.
**Exceeding it reports a dead service as `ready`**, the dangerous direction.

**Partial forward failure leaks nothing.** Five `-L` with the third occupied: ssh binds 1 and 2,
fails 3, **still binds 4 and 5**, then fatals after the loop. Exit 255 in 62 ms, zero surviving
listeners. mirrorball cleans up only its own state.

**Without `-f`, the exit code is a failure signal with no success counterpart.** A failed bind
resolves almost immediately; a successful launch never resolves at all. There is no positive
verdict to read — which is exactly why the TCP connect probe is load-bearing rather than a weaker
restatement. `-f` is deliberately not used: the supervisor needs ssh as a live child.

---

## Bunli 0.9.1

Pre-1.0 and moving. All of this was read from the vendored source, not the docs. **Re-check on
upgrade.**

**There is no root command.** `findCommand()` throws `CommandNotFoundError` when argv[0] is not
a registered name, so `mirb 10.0.0.7 3000` cannot work unaided. `mirb.ts` normalizes argv,
injecting `up`. It consults **argv[0] only** — scanning further would mistake an option *value*
for a subcommand. `mirb up ls 3000` is the escape hatch for a host named `ls`.

**A thrown error loses its exit code and its fields.** Every error path in `@bunli/core` is a
hardcoded `process.exit(1)`; nothing reads a custom `exitCode`. `serializeCliError` keeps extra
fields only for Bunli's own tagged errors, and ours gets wrapped first — so `code` and `hint`
never reach `--json`. **Workaround:** catch in the handler, render, set `process.exitCode`, and
**return normally**. Bunli only assigns `process.exitCode = 0` on the `PromptCancelledError`
path; the ordinary success path leaves it alone.

**A cancelled prompt is a *graceful* exit 0** — `Result.ok`, exit 0. A prompt reachable from a
piped or backgrounded path reports **success** while doing nothing. mirrorball never prompts.
Keep it that way; that is also why `--expose` is a flag and not a confirmation.

**`-v` and `-h` are reserved**, along with `--format`, `--llms`, `--llms-full`. Hence `-P` for
ssh's port and no short verbose flag.

**Machine output is free.** The handler context carries `agent` (true when stdout is not a TTY),
`format`, and `output()` writing a `{ok, data, meta}` envelope. Piping any command already
yields JSON. `--json` is sugar — but note `defaultFormat: 'json'` on the commands exists for
exactly one case: `--json` on a TTY.

**Positionals are raw `string[]`** with no arity enforcement. All validation is ours.

**Unrecognised flags are silently ignored.** `mirb ls --nope` exits 0 with a normal envelope, so
a typo is indistinguishable from success.

---

## Bun

- **`Bun.color(hex, 'ansi')` re-detects the environment.** Name the format. (See invariants.)
- `Bun.stringWidth()` is unicode-aware; `.length` is wrong for alignment.
- `Bun.TOML.parse()` exists — profiles need no dependency.
- **`Bun.spawn` + `unref()` with all-ignore stdio outlives the parent** and reparents to pid 1.
  Verified; no `setsid`/`nohup` needed.
- **`--bytecode` does not work**: `@opentui/core` and `@opentui/react` (transitive via bunli)
  use top-level await. Not fixable from our side.
- **Binaries are ~61 MB before any of our code** — Bun's runtime floor; ours add ~5 MB. There is
  no application-level size win. Don't chase it.
- **Cross-compiling needs `bun install --os '*' --cpu '*'`.** OpenTUI's runtime packages are
  platform-gated optional deps; a plain install fetches only the host's and
  `bunli build --targets all` fails.

---

## Testing

`bun test` — 402 tests, ~17 s, fully offline.

**`test/fixtures/fake-ssh.ts` is the keystone.** It impersonates ssh and *actually binds the
`-L` ports it is given*, so it is indistinguishable from the real thing as far as the three-state
model is concerned. Selected with `MIRB_SSH`. Modes: `ok`, `refused`, `slow`, `hang`, `die`,
`auth-fail`, `connect-fail`, `bind-fail`, `ignore-term`; `FAKE_SSH_MODE` is comma-separated and
the last entry repeats, so `die,ok` means "fail once, then work".

A fixture built on *"failure implies non-zero exit"* could not reproduce mirrorball's real bugs —
ssh does not exit on most forwarding failures.

**Isolation seams — always use them.** `MIRB_SSH`, `MIRB_STATE_DIR`, `MIRB_CONFIG`. Never touch
the real state or config directory.

**Never assert on global process state.** A `pgrep -f` count is contaminated by anything else on
the machine — including other agents. Scope by PPID, or better, assert on an artifact the code
under test produces (the fixture's `attempts.log` counts *your* spawns and nothing else). This
produced a convincing false "orphan leak" once.

**Deterministic timing:** pass `{ jitter: 0 }` to backoff, and explicit `settleMs` to probes.

**`test/invariants.test.ts` holds the security properties.** If you are changing argv
construction or bind handling, that is the file that will stop you.

---

## Contracts

**Exit codes** — `core/types.ts`, mapped in `core/errors.ts`:
`0` ok · `1` generic · `2` usage/config · `3` ssh connect/auth · `4` local port conflict ·
`5` remote refused · `130` SIGINT.

Two subtleties the docs state and code must keep true:
- **`session.exit.code` is ssh's**, not mirrorball's — `143` (128+SIGTERM) is normal for a stop.
  Do not "fix" it to 130; they are different vocabularies.
- **`degraded` is a success.** A session with a refused forward still works.

**NDJSON events** — `core/types.ts`: `session.start`, `forward.bound`, `forward.ready`,
`forward.error`, `session.ready`, `session.reconnecting`, `session.exit`.

**Stream discipline:** stdout carries data and nothing else, ever. The live view runs only on an
interactive TTY; the static reporter and all errors go to stderr; NDJSON owns fd 1.

**The guarantee that matters to scripts:** `--background --json` does not print until the ports
are actually usable.

**Env vars:** `MIRB_SSH`, `MIRB_STATE_DIR`, `MIRB_CONFIG`, `MIRB_ASCII` (binary);
`MIRB_INSTALL_DIR`, `MIRB_VERSION`, `MIRB_NO_PATH_UPDATE` (installers only — keep the
distinction, it confuses people). Plus `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, `XDG_*`.

**Paths:** macOS follows **XDG alongside Linux** — `~/.config/mirb`, `~/.local/state/mirb`, *not*
`~/Library`. A docs rewrite got this wrong once. Windows uses `%APPDATA%` / `%LOCALAPPDATA%`.

**Release assets:** `mirb-<version>-<os>-<arch>.tar.gz` (`.zip` for Windows), binary at the
**archive root**, plus `checksums.txt` in `sha256sum` format (`<64 hex><two spaces><name>`).
`scripts/install.sh` and `install.ps1` both parse this; changing the shape breaks installs.

---

## Couplings — change X, you must change Y

| Change | Also change |
|---|---|
| Add a command | `RESERVED` **and** `cli.command(...)` in `mirb.ts` — registered but not reserved gets swallowed |
| Session id prefix (`mb_`) | `core/ids.ts` (three hardcoded `3`s), `commands/shared.ts` `prefixMatches`, `core/state.ts` `ID_PATTERN` (also the path-traversal guard) |
| A field on `SessionRecord`/`Profile`/`SessionPlan` | its zod schema — the type asserts catch one direction only |
| Add a build target | `bunli.config.ts` `build.targets` (single source now) |
| Error message format in `ui/static.ts` | `commands/up.ts` parses `' error: '` / `' hint: '` out of the supervisor's log |
| Anything user-facing | the docs page that documents it — `docs/reference/cli.md` says the binary wins, so drift is a doc bug |
| Add or rename a docs page | that folder's `meta.json`. The trailing `"..."` will still surface it, but at the bottom and unordered |
| `PALETTE` in `ui/theme.ts` | `site/src/app.css` — the site's landing tokens are a hand copy; nothing imports across the package boundary |
| `scripts/install.sh` / `.ps1` | nothing, but the site serves them at `mirb.dev/install.sh`; a deploy has to follow, and `site.yml` watches `scripts/**` for that reason |
| A heading in `docs/` | any link with a `#fragment` pointing at it — `site/scripts/check-docs.mjs` is what catches those, since the build's link validation strips fragments |

**Deliberately duplicated:** four near-identical address-mapping tables (`bind.ts` policy,
`ports.ts` bind side, `probe.ts` connect side, `ui/live.ts` display). They answer different
questions and unifying them would be wrong.

---

## Conventions

- **Comments explain *why*, not what.** The code says what. Every invariant above earns its
  comment by naming what breaks without it.
- TypeScript strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Relative imports carry
  the `.ts` extension.
- Conventional commits. No AI attribution in commit messages.
- Docs pages carry `title` / `description` / `sidebar_position` frontmatter. `pageSchema`
  strips anything it does not know, so extra keys are silently dropped rather than rejected.
- **Sidebar order lives in each folder's `meta.json`**, not in frontmatter. Every one ends
  with `"..."`, the fumadocs rest operator: a page you forget to list lands at the bottom of
  its section instead of vanishing. Permissive where informational, as with `ls`.
- **`docs/` is plain CommonMark + GFM.** No raw HTML — the markdown compiler *deletes* it
  rather than erroring, so a `<br/>` disappears silently. No stray `.json` either: fumadocs
  globs every JSON under `docs/` and validates it as a meta file. Admonitions are
  `:::note` / `:::warn[Title]`, blank-line delimited, via remark-directive.
- Internal links are relative and keep the `.md` extension so they resolve on GitHub; they
  must start with `./` or `../`, because that is the only form the site's link resolver
  rewrites. `site/scripts/check-docs.mjs` enforces all of the above.

---

## Known gaps

Honest list. None are secret; all were found by review rather than by users.

1. **A filtered or blackholed remote reads as `ready`.** If the remote `connect()` stays pending
   rather than refusing, the socket stays open and the settle timer wins. The late-failure
   watcher downgrades the session when ssh eventually logs the channel failure, but the first
   verdict is optimistic. A real fix needs a fourth state (`unverified`) rather than folding it
   into `ready`.
2. **`--probe-settle` above 3000 ms inverts the verdict** — it exceeds the un-configurable probe
   timeout, so every healthy forward reports `refused`. No upper bound is enforced, and
   `core/types.ts` actively encourages raising the value on slow links.
3. **`REMOTE_REFUSED` / exit 5 is unreachable in production.** The only call site passes
   `processExited: true`, which suppresses the channel branch. The exit-codes doc describes a
   path that does not exist.
4. **`isOurSupervisor` returns `true` when `ps` is unavailable** (Windows), so `stop` would
   signal whatever pid the record names — the exact case the check exists to prevent.
5. **`stop`'s SIGKILL fallback can orphan ssh**: it kills the supervisor, not its child, then
   removes the record, leaving a bound port with no id to stop it.
6. **`saveSession` failures are swallowed**, so an unwritable state dir yields a live detached
   tunnel that `ls` and `stop` cannot find.
7. **Untested:** `core/ids.ts`, `core/backoff.ts`, `commands/shared.ts`,
   `assertNoExposedConfiguredForwardings` / `inspectConfiguredForwardings` (the fake-ssh fixture
   has no `-G` mode), `MIRB_ASCII`.
8. **CI never runs `--targets all`** (only `native`) and there is **no Windows runner**, so the
   Windows binary is cross-compiled and never executed. `release.yml` has a `workflow_dispatch`
   trigger specifically so the cross-compile can be exercised on demand.
9. **Nothing verifies the git tag matches `package.json`**, or that `compress` is still `false`.
   Both are human-checklist items.
10. **The site's landing page restates CLI behaviour in its own prose.** `site/src/pages/index.tsx`
    and `site/src/lib/states.ts` describe the four states and the comparison table directly, so
    `docs/` is no longer the only place that can drift from the binary. Keep its claims to
    things `README.md` or `docs/` already say.
11. **`waku/adapters/cloudflare`'s serverless entry does not boot on workerd** — its rolldown
    runtime shim calls `createRequire(import.meta.url)` where that is `undefined`. mirb.dev
    sidesteps it by deploying static assets only and deleting the adapter's deploy redirect
    (`site/scripts/strip-server-deploy.mjs`). If the site ever needs a dynamic route, that
    upstream bug has to be solved first.
12. **Adding a docs page needs a `fumapress dev` restart.** The content glob is expanded when
    `press.config.tsx` is transformed, and `docs/` sits outside the Vite root, so new files are
    not picked up live. Editing an existing page hot-reloads fine.

---

## The site

`site/` builds **mirb.dev** with [Fumapress](https://press.fumadocs.dev) and deploys to
Cloudflare Workers. `cd site && npm run dev`.

**It is a Node/npm package inside a Bun repo, deliberately.** fumapress declares
`engines.node >= 24`, is a Waku + Vite 8 RSC app, and patches module resolution in ways that
assume npm-style hoisting. `site/package-lock.json` also tells Cloudflare Workers Builds to
use npm and Node 24 with no configuration. The CLI package and `bun.lock` are untouched, and
the root `tsconfig.json` `include` list does not mention `site/`, so `bun run typecheck`
cannot see it.

**Content lives in `docs/`, not in `site/`.** `dir: '../docs'` in `press.config.tsx`. The
docs are read on GitHub as often as on the site, and every docs path in this file points at
the repo root. See the Conventions section for what that costs in exchange.

**A content file cannot resolve bare imports on its own.** `docs/` is outside the Vite root,
so Node's walk from a page goes `docs/explanation` → `docs` → repo root and never reaches
`site/node_modules`. The `react/jsx-runtime` the MDX compiler injects into every page has
nothing to resolve against. `resolveContentImports()` in `vite.config.ts` re-anchors those
to the site — with `this.resolve`, not an alias, because `react/jsx-runtime` has a
`react-server` export condition an alias would flatten.

**This one is invisible on a dev machine.** The CLI's `bun install` leaves a
`<repo>/node_modules` containing react as a transitive dep of bunli, which satisfies the
import by accident. It built fine locally and failed on the first CI run. To reproduce a CI
environment, `mv node_modules` aside and build.

**It deploys as static assets with no Worker.** `mode: 'static'` prerenders all 24 routes and
the search index, so there is nothing to run at request time. The adapter nonetheless builds
a serverless entry and writes `.wrangler/deploy/config.json` redirecting `wrangler deploy` to
it; `scripts/strip-server-deploy.mjs` removes that redirect after every build. Without it
`wrangler` silently prefers the generated config — it prints "Using redirected Wrangler
configuration" — and ships a Worker that does not boot. Only `name`,
`compatibility_date` and `compatibility_flags` are read from `site/wrangler.jsonc`; a
`routes` block there would be ignored, so the custom domain is attached out of band.

**Versions are pinned exactly, no carets.** fumapress is 1.x on a Waku beta and a Vite major,
with a lot of load-bearing compatibility shim. Upgrade deliberately, the way Bunli 0.9.1 is
handled.

**`mirb.dev/install.sh` is `scripts/install.sh`.** `scripts/sync-installers.mjs` copies it
into `site/public/` on predev and prebuild; the copies are gitignored. `scripts/install.sh`
stays the only place either installer is edited.

---

## Release

Tag `vX.Y.Z` → `.github/workflows/release.yml` builds five targets, packages archives and
`checksums.txt`, and uploads them. **There is no npm channel** — npm refused both `mirb` and
`mirb-cli` under its similarity check on new names (`mitt`, `mime`, `mri`, `sirv-cli`), unrelated
to availability. A scoped name would work; it was judged not worth it for a CLI you install once.
The packaging code is in git history if that changes.

`package.json` is `private: true` so nothing can publish it by accident.

The installer places `mirb` on PATH and `mirrorball` beside it — a symlink, or a `.cmd` shim on
Windows where symlinks need elevation. It verifies sha256 before installing and has **no flag to
skip that**, deliberately: a flag that disables verification is a flag an attacker can talk a
user into typing.
