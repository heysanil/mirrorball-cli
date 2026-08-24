---
title: Testing
description: How the mirrorball test suite is organised, and how the fake-ssh harness lets the whole thing run without a network or an ssh server.
sidebar_position: 2
---

# Testing

```bash
bun test                        # everything
bun test test/target.test.ts    # one file
bun test -t "IPv6"              # one describe/test name
```

The whole suite runs offline, on a laptop with no ssh agent, in CI with no ssh server:
402 tests across 12 files in about 17 seconds. Nothing in `test/` may connect to a real
host, and nothing may depend on a real `ssh` binary being installed. That constraint is
why the fake-ssh harness exists.

## How the suite is organised

```
test/
├── target.test.ts       ── core/target.ts
├── portspec.test.ts     ── core/portspec.ts
├── ports.test.ts        ── core/ports.ts
├── bind.test.ts         ── core/bind.ts
├── ssh.test.ts          ── core/ssh.ts
├── session.test.ts      ── core/session.ts
├── state.test.ts        ── core/state.ts
├── config.test.ts       ── core/config.ts
├── errors.test.ts       ── core/errors.ts
├── ui.test.ts           ── ui/
├── commands.test.ts     ── commands/, driven through @bunli/test
├── invariants.test.ts   the security properties; see below
└── fixtures/
    └── fake-ssh.ts      the ssh impersonator every ssh-touching test runs against
```

One `<module>.test.ts` per module under test, and a `fixtures/` directory for the doubles.
A new `core/` module arrives with its test file in the same PR.

Three layers, in increasing order of cost — write your test at the cheapest layer that
can actually fail when the behaviour is wrong.

**Pure unit tests** cover the parsers, the id helpers, backoff, error classification.
No processes, no sockets, no clock. Most of the suite lives here and most bugs are
catchable here.

**Harness tests** cover anything that spawns ssh: session start-up, readiness
transitions, reconnect, teardown. These run against `fixtures/fake-ssh.ts` rather than
real ssh.

**Command tests** drive a whole command through `@bunli/test`, asserting on what the
user sees: rendered output, the `--format json` envelope, and the process exit code.
Keep these few and end-to-end-ish; they're the slowest and the most brittle.

`invariants.test.ts` sits outside that ordering. It holds the security properties — that
every emitted `-L` carries an explicit bind address, and that mirrorball's `-o` options
precede the user's. If you are changing argv construction or bind handling, that is the
file that will stop you.

## Conventions

Standard `bun:test`, no extra runner:

```ts
import { describe, expect, test } from 'bun:test'
```

- **Assert on codes, not prose.** For failures, check `err.code` and `err.exitCode` from
  `MirbError`. Message wording is allowed to improve; `'USAGE'` and exit `2` are the contract.
  The exception is when the message content *is* the promise — e.g. that a rejection names
  the offending argument back to the user.
- **Table-driven where the cases are uniform.** `test/target.test.ts` loops a list of raw
  targets through `parse → format → parse`; adding a case is one line, and a failure names
  the case. Prefer that over fifteen near-identical `test()` blocks.
- **A local helper beats repetition.** `expectUsage(raw)` in `target.test.ts` collapses the
  throw-and-inspect dance into one call and returns the error for further assertions.
- **Comments explain why the case exists**, matching the house style — "ssh_config aliases
  pass through untouched — mirrorball never resolves them" tells the next reader what breaks if
  they 'fix' it.
- **Never sleep to synchronize.** Await the thing you actually care about — the event, the
  socket accepting, the process exiting. A `setTimeout` in a test is a CI flake with a delay.
- **Ask the OS for ports.** Bind port `0` and read back what you got, or take the port from
  the harness. Hardcoded ports collide with whatever else the CI runner is doing.
- **Never touch the real user's state.** Session records, logs and config resolve through
  `@bunli/utils`' `stateDir`/`configDir`/`dataDir`, with `$MIRB_STATE_DIR` and `$MIRB_CONFIG`
  overriding them. Point both at a per-test temp directory and clean up afterwards; a test
  that writes to the developer's real config or stops one of their live sessions is a bug,
  not an inconvenience.
- **Make randomness explicit.** `backoffDelay` jitters by design. Pass `{ jitter: 0 }` when
  asserting an exact delay, and assert a range when the jitter itself is what's under test.

## The fake-ssh harness

`test/fixtures/fake-ssh.ts` is a small Bun program that pretends to be `ssh`. mirrorball
never knows the difference: it spawns it with exactly the argv it would hand OpenSSH, and
the harness behaves the way a real `ssh -N -T -L ...` would — including **actually binding
the local ports named by `-L`**.

That last part is the whole trick. mirrorball's readiness model doesn't trust ssh's stderr;
a forward is `bound` because the local socket accepts a connection, and `ready` because a
probe got through to the far end. A mock that only printed plausible output would fail
every readiness probe. Because the harness really listens, the code under test is the
same code that runs in production.

:::note
`test/fixtures/fake-ssh.ts` is the authoritative description of its own behaviour —
scenario names and env var spellings live in that file. If this page and the file
disagree, the file is right; please fix this page in the same PR.
:::

### How mirrorball finds it

`resolveSshPath()` in `core/ssh.ts` checks `$MIRB_SSH` before `PATH`, and resolves it
through `Bun.which()` — the same executability check a PATH lookup gets. Two consequences
for the fixture:

- It needs a `#!/usr/bin/env bun` shebang and the executable bit
  (`chmod +x test/fixtures/fake-ssh.ts`). mirrorball spawns `[sshPath, ...args]` directly;
  there is no `bun` in front of it.
- If the bit is missing, the failure is a `NO_SSH` `MirbError` saying `$MIRB_SSH points at
  '...', which is not an executable` — raised at resolve time, before anything spawns. That
  message in a test failure means `chmod`, not a bug in your change.

Tests point `$MIRB_SSH` at the fixture by absolute path:

```ts
const FAKE_SSH = new URL('./fixtures/fake-ssh.ts', import.meta.url).pathname

test('a forward that binds reaches ready', async () => {
  const proc = Bun.spawn(['bun', 'mirb.ts', 'example.test', '3000'], {
    env: { ...process.env, MIRB_SSH: FAKE_SSH, /* scenario selector */ },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  // assert on the NDJSON events, then on the exit code
})
```

Derive the path from `import.meta.url` rather than writing a relative one: mirrorball spawns
ssh in the *user's* working directory, and `bun test` can be invoked from anywhere.

### The argv it receives

`buildSshArgs()` emits a fixed order, which the harness can rely on but shouldn't have to:

```
-N -T
-o ExitOnForwardFailure=yes
-o ServerAliveInterval=<n> -o ServerAliveCountMax=<n>
-o ConnectTimeout=<seconds>
[-o BatchMode=yes]
-L <bind>:<localPort>:<remoteHost>:<remotePort>   (once per forward)
[-p <port>] [-i <identity>] [-J <jump>]
[-o <user option>]...
[user@]host
```

Every `-L` spec carries an explicit bind address, and IPv6 literals in it are bracketed —
parse accordingly. The harness doubles as an assertion surface here: if mirrorball starts
emitting something malformed, the fixture is what notices first.

One flag changes what a correct harness must do. `ExitOnForwardFailure=yes` is mirrorball's
promise that a failed bind is a failed session, so **when the harness cannot bind a `-L`
port it must exit non-zero rather than carry on** — mimicking real ssh, and keeping the
port-conflict path honest.

`SIGTERM` and `SIGINT` should close the listeners and exit. That is how teardown tests
confirm mirrorball doesn't orphan its child.

### Scenarios

A scenario is chosen with an environment variable the test sets, and decides how the fake
ssh behaves once it has read its argv. The set exists to cover the states mirrorball reports
differently:

| Behaviour | What the test gets to observe |
| --- | --- |
| Everything works | ports bind, probes succeed, forwards reach `ready` |
| Tunnel up, remote service down | ports bind but connections through them are refused → `refused`, exit code 5 |
| Local port already taken | bind fails, ssh exits non-zero → `PORT_IN_USE`, exit code 4 |
| Authentication failure | OpenSSH-shaped `Permission denied` on stderr, non-zero exit → `SSH_AUTH` |
| Unresolvable host, refused, or timed out | the matching `SSH_CONNECT` classification |
| Drops after being up | exercises the reconnect path and `BackoffTracker` |
| Slow to come up | exercises `--timeout` and the connecting → ready transition |

Each row maps onto a branch of `classifySshStderr()` or onto a readiness state. That is the
bar for a new scenario: it earns its place by being a situation mirrorball reports differently.

### Adding a scenario

1. Open `test/fixtures/fake-ssh.ts` and find the scenario table — the record mapping a
   scenario name to a function that receives the parsed argv.
2. Add an entry. Keep the behaviour **specific and boring**: bind or don't bind, print a
   line and exit, or hold. A scenario with branching logic of its own is a second
   implementation of ssh, and it will grow bugs of its own.
3. If it writes to stderr, copy the wording from real OpenSSH. The substrings in
   `classifySshStderr()` are matched against real output, so inventing a message means you
   are testing the harness instead of the classifier. [How it works](../explanation/how-it-works.md)
   catalogues the observed strings, exit statuses and — more often than you'd expect — the
   *absence* of an exit status. One trap in particular: in
   `channel N: open failed: <reason>: <server message>`, only `<reason>` is a fixed value.
   The channel number moves, and the trailing text is the remote's errno string, which
   differs between a macOS and a Linux server. Print a realistic full line, but assert only
   on the reason.
4. Add the scenario to the table above, and to the fixture's own doc comment.
5. Write the test. It must fail if you revert your production change.

Scenario names are lowercase and hyphenated, and name the *situation* rather than the
assertion — `remote-refused`, not `expects-exit-5`.

## Typechecking is part of testing

```bash
bun x tsc --noEmit
```

`test/` is inside the `include` list in `tsconfig.json`, so the suite is typechecked under
the same strict settings as the source: `noUncheckedIndexedAccess` applies to your
fixtures too, and relative imports need the `.ts` extension.

## Debugging a failing test

- `bun test -t "<name>"` narrows to one case before you start reading output.
- Run the harness directly with the argv mirrorball would have given it:
  ```bash
  ./test/fixtures/fake-ssh.ts -N -T -o ExitOnForwardFailure=yes \
    -L 127.0.0.1:3000:127.0.0.1:3000 example.test
  ```
- Reproduce end to end by hand — this is often faster than instrumenting the test:
  ```bash
  MIRB_SSH=$PWD/test/fixtures/fake-ssh.ts bun mirb.ts example.test 3000 --format json
  ```
- If a test passes alone and fails in the suite, suspect a fixed port number or a
  leaked child process before you suspect the runner.
