---
title: Exit codes
description: Every exit code mirrorball can produce, when it occurs, and which error code maps onto it.
sidebar_position: 4
---

# Exit codes

mirrorball's exit codes are part of its interface. They are small in number and each one
names a *class* of failure, so a script can branch on "the port was taken" without parsing
English. The explanation always goes to stderr; the code is what you test.

## The codes

| Code | Name | When it occurs |
| --- | --- | --- |
| `0` | OK | The command did what it was asked. `ls`, `stop` and `logs` on success; a `--background` start that came up `ready` or `degraded`. |
| `1` | GENERIC | A failure with no more specific class: an internal error, or a session id that matched nothing. Also what bunli itself exits with when an option fails validation. |
| `2` | USAGE | Bad arguments, or a config file mirrorball cannot use. Nothing was attempted. |
| `3` | SSH | ssh could not connect, could not authenticate, or could not be found. |
| `4` | PORT_CONFLICT | A local port is already bound, or is privileged and mirrorball is not. |
| `5` | REMOTE_REFUSED | The tunnel was fine and the remote service was not there. |
| `130` | SIGINT | You stopped it. The normal way a foreground session ends. |

Anything outside this table came from the runtime, not from mirrorball.

## Error codes

Every failure inside mirrorball is a `MirbError` carrying a `MirbErrorCode`. That code is what
decides the exit status, and it is also what appears in a
[`forward.error` event](json-output.md#forwarderror).

| `MirbErrorCode` | Exit | Meaning |
| --- | --- | --- |
| `USAGE` | `2` | Bad arguments: no host, no ports, an unparseable port spec, a duplicate local port, a `--bind` that would publish the forward without `--expose`. |
| `CONFIG` | `2` | `config.toml` exists but is malformed, or names a setting mirrorball does not have. |
| `PORT_IN_USE` | `4` | A local port is already bound. Raised by mirrorball's own preflight, and by ssh's bind failure when something takes the port in between. |
| `PORT_PRIVILEGED` | `4` | A local port below 1024 without the privileges to bind it. |
| `SSH_AUTH` | `3` | Permission denied, too many authentication failures, or host key verification failed. |
| `SSH_CONNECT` | `3` | DNS failure, connection refused, timeout, a local port that never started accepting — and the fallback for any ssh failure mirrorball cannot classify. |
| `NO_SSH` | `3` | No ssh binary on `PATH`, or `$MIRB_SSH` / `--ssh-path` pointing at something that is not executable. |
| `REMOTE_REFUSED` | `5` | ssh reported a channel-open failure and exited. The tunnel worked; nothing was listening at the far end. |
| `SESSION_NOT_FOUND` | `1` | No background session matches the id, name or host given — or an id prefix that matches several, which mirrorball refuses to guess at. |
| `INTERNAL` | `1` | A bug, or an unexpected runtime failure. Includes a `--background` supervisor that never reported a working tunnel. |

`SSH_CONNECT` being the fallback is deliberate: an ssh that died mid-session for unclear
reasons is far more often a network problem than anything else, and `SSH_CONNECT` is one of
the few codes mirrorball will retry on.

## Notes on particular cases

**A degraded session is not a failure.** A tunnel that came up with one forward `refused`
exits like any other: 0 from `--background`, 130 when you Ctrl-C the foreground. mirrorball
told you which forward is unusable — in `forwards[].status`, in a `forward.error` event, and
in amber on the display — and throwing away the forwards that work would be a worse answer
than reporting the ones that do not. Exit code 5 is for something else: ssh itself giving
up with a channel-open failure as its last word.

**A foreground `mirb up` does not exit 0.** It runs until you stop it (130) or until it gives
up (a class code). There is no third ending. Scripts that want a success code should use
`--background`, which exits 0 once the tunnel is proven, or watch for
[`session.ready`](json-output.md#sessionready) on the event stream.

**SIGTERM also exits 130.** mirrorball treats any requested stop as the same event, whether
it arrived as Ctrl-C or as a signal from a process manager. This is deliberately not the
conventional 143: 130 here means "someone asked mirrorball to stop, and it did", which is
exactly what happened.

**`--background` propagates the supervisor's code.** When the detached supervisor dies
before reporting a working tunnel, the parent reads the failure out of the supervisor's log,
prints it, removes the half-written record, and exits with the *child's* code — so
`mirb example.test 3000 -b` against an unreachable host still exits 3, not 1. A child that
somehow exited 0 without coming up is reported as 1.

**Ambiguity is an error, not a guess.** `mirb stop k3` matching two sessions exits 1 and
lists both. The command on the other end of that decision kills processes.

**bunli owns a few exits of its own.** `--help` and `--version` exit 0. An option that fails
validation exits 1 with a structured error on stderr, before mirrorball's handler ever runs.
Unrecognised flags are ignored rather than rejected.

## Checking them

```bash
mirb example.test 45241:3000 --background --json > session.json
case $? in
  0) echo "up" ;;
  4) echo "local port taken" ;;
  3) echo "cannot reach the host" ;;
  *) echo "see stderr" ;;
esac
```

The codes are stable. They are defined once, in `EXIT` in `core/types.ts`, and the mapping
from error code to exit code lives in `MirbError.exitCode` in `core/errors.ts` — one switch,
covered by tests, so `stop` and `up` cannot disagree about what a busy port is worth.

## See also

- [JSON output](json-output.md) — the envelope, the event stream, and where errors are written
- [CLI reference](cli.md) — which command can produce which failure
- [Configuration](configuration.md) — a malformed `config.toml` is exit 2
