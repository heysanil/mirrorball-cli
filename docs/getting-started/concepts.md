---
title: Concepts
description: The four nouns mirrorball uses — target, forward, session, profile — and the three readiness states that make it different from ssh -L.
sidebar_position: 3
---

# Concepts

mirrorball has a small vocabulary, and it uses each word in exactly one sense. This page
defines them, then spends most of its length on the one idea the rest of the tool is built
around: **readiness is observed, never assumed**.

---

## Target

A **target** is where to connect and how — everything that maps onto ssh's destination
argument and its `-p` flag.

```console
$ mirb 10.0.0.7 3000
$ mirb deploy@10.0.0.7 3000
$ mirb deploy@10.0.0.7:2222 3000
$ mirb ssh://deploy@10.0.0.7:2222 3000
$ mirb prod-db 3000
```

All five are targets. The last one is the important case: `prod-db` may be an `ssh_config`
`Host` alias, an `/etc/hosts` entry, a name a `ProxyCommand` invents, or a CNAME that only
resolves on the VPN. **mirrorball does not know what a valid host is, and does not pretend
to.** It rejects only what could not survive the trip to ssh — an empty host, embedded
whitespace, a port outside 1–65535, a `ssh://` URI carrying a path or a password — and passes
everything else through untouched.

That is the promise the whole design rests on: *if `ssh myhost` works, `mirb myhost 3000`
works.* Your `ssh_config`, your agent, your hardware token, your `Match` blocks and your
`Include` directives all apply, because mirrorball runs the same `ssh` binary you would have
run by hand.

The colon-port form is a mirrorball convention, not an ssh one. `user@host:2222` on ssh's own
command line would be read as a hostname containing a colon; mirrorball parses the port off
and passes it as `-p`. IPv6 literals need brackets when a port follows: `[::1]:2222`.

## Forward

A **forward** is one local port wired to one remote port. A session may carry many.

```console
$ mirb 10.0.0.7 3000 8080:80 5432:db.internal:5432
```

| Argument | Local | Reaches |
| --- | --- | --- |
| `3000` | `127.0.0.1:3000` | `localhost:3000`, from the ssh host's point of view |
| `8080:80` | `127.0.0.1:8080` | `localhost:80`, same |
| `5432:db.internal:5432` | `127.0.0.1:5432` | `db.internal:5432`, reached *from* the ssh host |

The first field is always a local port. mirrorball deliberately does not accept ssh's
optional leading bind address, because `0.0.0.0:8080:80` and `8080:db:5432` are impossible to
tell apart without resolving the middle field. The bind address lives on `--bind` instead.

Ranges expand: `3000-3005` is six forwards, and `8000-8005:9000-9005` zips two ranges in
order. The full grammar, including the limits and the error cases, is in
[Port syntax](../guides/port-syntax.md).

Every forward binds `127.0.0.1` unless you say otherwise, and that default is a security
decision rather than a convenience. `--bind 0.0.0.0` publishes the forward to every machine
that can reach yours; contrary to a common belief, ssh's `GatewayPorts` setting does not
prevent it, and nothing else in the stack warns you.

So mirrorball **refuses** a non-loopback bind unless `--expose` is also passed. An error, not
a warning, and it exits `2`:

```console
$ mirb --bind 0.0.0.0 10.0.0.7 3000
mirb: error: --bind 0.0.0.0 would publish these forwards beyond this machine
mirb: hint: Anyone who can reach this host on the network could use the tunnel. Pass --expose to confirm.
```

It is an error rather than a confirmation prompt on purpose: mirrorball has to behave
identically for a human and for an agent, and a cancelled prompt on a non-interactive path
would read as a graceful success. A flag is unambiguous in both worlds. Bare `--expose`
implies `0.0.0.0`, and once a session is exposed the display keeps a banner on screen for as
long as it lives.

## Session

A **session** is one ssh process and the forwards it carries, plus the supervision around
it. It is the unit `mirb ls` lists and `mirb stop` ends.

Sessions run in one of two places:

- **Foreground** — `mirb 10.0.0.7 3000`. mirrorball stays attached, paints a live status
  display, and the tunnel dies with it. Ctrl-C stops it.
- **Background** — `mirb --background 10.0.0.7 3000`. mirrorball spawns a detached copy of
  itself as a supervisor, waits until that supervisor reports a working tunnel, prints the
  session id, and exits. The tunnel outlives your shell. See
  [Background sessions](../guides/background-sessions.md).

There is no daemon. One supervisor process per background session, started by the session
and exiting with it — nothing to enable, nothing to garbage-collect, and no way for a
supervisor from one release to end up talking to a CLI from another.

Every session gets an id: `mb_` plus 13 lowercase alphanumeric characters. You never type
the whole thing. `mirb ls` shows the first six characters after the prefix, and any unique
prefix resolves:

```console
$ mirb stop lxa2xk
```

An **ambiguous** prefix stops nothing and lists the candidates. mirrorball will not guess
which session you meant to kill. A host name or a `--name` label also resolves, and there the
rule is different on purpose: naming a host is a deliberate statement about *which host*, so
two tunnels to the same host both match and both get stopped.

When a session drops — a lid closes, a VPN reconnects, wifi changes — the supervisor
rebuilds it behind the same id and the same local ports, with exponential backoff and
jitter. It reconnects only for failures a later attempt could plausibly survive. A wrong key
or a typo'd hostname fails immediately and says so, because retrying those would lock an
account out or hide the typo.

## Profile

A **profile** is a named target and its ports, stored in `config.toml`.

```toml
[profiles.web]
host = "deploy@10.0.0.7"
ports = [3000, "8080:80"]
name = "web tier"
```

```console
$ mirb web
$ mirb web 9229
```

The second invocation means "the `web` profile, plus a debugger port" — extra ports append
rather than replace, and flags override the profile's fields one at a time. A profile named
`prod` wins over a host named `prod`, because the profile is the thing you configured on
purpose. Full syntax and precedence rules: [Profiles](../guides/profiles.md).

---

## The three readiness states

This is the part `ssh -L` leaves out.

`ssh -L 3000:localhost:3000 myhost` binds a local socket and then says nothing, forever. It
says nothing when the tunnel is perfect, and it says nothing when the remote service does
not exist — the local socket accepts either way, because ssh accepts on the local port
*before* it asks the far sshd to open a channel. So `curl localhost:3000` failing tells you
nothing about which half is broken, and the twenty minutes that follow usually go into
debugging an ssh config that was never wrong.

mirrorball answers the question directly, and it answers it by **making real TCP
connections**, not by reading ssh's stderr. That text is not an interface: it changes between
OpenSSH releases, it can be localised, and `debug1: Local forwarding listening` is printed
*around* — not exactly at — the moment the listener starts accepting. A connect that succeeds
is the only signal that means precisely what it says.

Each forward ends up in one of these:

| State | Glyph | What mirrorball verified | What it means for you |
| --- | --- | --- | --- |
| `bound` | `◐` | It opened a TCP connection to the local port and it was accepted | The tunnel is up. Nothing has been said about the far end yet. |
| `ready` | `●` | A probe connection through the tunnel stayed open (or sent bytes back) | The remote service is there. Point your client at it. |
| `refused` | `○` | The probe connection was accepted and then closed, promptly and silently | **The tunnel is fine. The service on the far end is not listening.** |

`refused` is the state that pays for the whole tool. It is rendered amber, not red, and the
glyph is a hollow ring against `ready`'s filled one — because red would say "mirrorball
failed you", and what actually happened is that mirrorball worked and your service is down.

Two more states exist for completeness:

| State | Glyph | Meaning |
| --- | --- | --- |
| `pending` | `·` | Not attempted yet. The starting state of every forward. |
| `failed` | `✕` | Could not bind or forward at all. The local port never started accepting. |

With probing on (the default), `bound` is a waypoint rather than a destination, and the
display calls it **probing**. With `--no-probe` there is nothing to probe and `bound` is the
terminal state, so it is labelled `bound` — the strongest claim mirrorball can honestly make
when it has not looked.

### How `ready` and `refused` are told apart

One connection per forward, and a stopwatch.

mirrorball opens a single TCP connection to the local end of the forward. ssh accepts it,
then asks the far sshd for a channel. If nothing is listening over there, sshd answers with a
channel-open failure and ssh closes the local socket having sent nothing — so a connection
that dies quickly and silently means `refused`. A connection still open after the settle
window means `ready`, and any inbound byte (an SSH, SMTP, Postgres or Redis banner) settles
it early and positively.

The settle window defaults to **750 ms**, and that number was measured rather than guessed.
Refusal latency is about 3× the round-trip time to the remote host: ~0.3–0.9 ms over
loopback, ~103–105 ms against a host 33 ms away. 750 ms therefore covers round trips up to
roughly 250 ms, which is essentially everywhere terrestrial, including a `-J` bastion chain
where the cost compounds per hop. Tune it with `--probe-settle` if your path is stranger
than that.

Where this is wrong, stated plainly:

- A remote service that accepts and then hangs up unprompted — a bare TCP health check, an
  IP allow-list rejecting you — reads as `refused`. Arguably the more useful answer, but it
  is not the same thing as "nothing is listening".
- On a link slow enough that refusal takes longer than the settle window, a dead service
  reports `ready` first and reality arrives a moment later. mirrorball guards this direction
  specifically: if ssh wrote a `channel N: open failed` line while probes were in flight and
  every forward still came back `ready`, at least one verdict is wrong, so the session is
  marked degraded and says so rather than printing a confident lie.
- A middlebox that completes the handshake on the service's behalf reads as `ready`.

The probe costs one throwaway connection per forward. That is why `--no-probe` exists: some
services log or bill for it.

## Session status

A forward has a status; so does the session as a whole.

| Status | Meaning |
| --- | --- |
| `starting` | Arguments resolved, nothing spawned yet. |
| `connecting` | ssh is running; forwards are still being classified. |
| `ready` | Every forward is `ready` (or `bound`, under `--no-probe`). |
| `degraded` | The tunnel is up, but at least one forward is `refused` or `failed`. |
| `reconnecting` | ssh exited for a retryable reason; waiting out a backoff. |
| `stopped` | Ended because it was asked to. |
| `failed` | Ended because it could not continue. |

`degraded` is not an error and does not exit. A session with three good forwards and one
dead service is still doing useful work, and throwing away the three would be the wrong
trade. It shows up in the display, in `mirb ls`, and in the JSON.

## Machine output

Every command has a machine mode, and mirrorball switches into it on its own when stdout is
not a terminal — so `mirb 10.0.0.7 3000 | jq` produces JSON without anyone remembering a
flag. `--json` forces it; an explicit `--format` forces it and picks the encoding.

`mirb up --json` streams **NDJSON**: one compact event per line, written the instant it
happens, so a consumer can react to `forward.ready` rather than wait for a summary.

```json
{"event":"session.start","ts":"2026-08-19T08:44:09.882Z","id":"mb_hnjvhl5gzqfhc","target":{"host":"10.0.0.7","raw":"10.0.0.7"},"forwards":[{"localPort":3000,"bindAddress":"127.0.0.1","remoteHost":"localhost","remotePort":3000,"source":"3000"}]}
{"event":"forward.bound","ts":"2026-08-19T08:44:09.939Z","localPort":3000}
{"event":"forward.ready","ts":"2026-08-19T08:44:10.692Z","localPort":3000}
{"event":"session.ready","ts":"2026-08-19T08:44:10.693Z","id":"mb_hnjvhl5gzqfhc","ready":1,"total":1}
{"event":"session.exit","ts":"2026-08-19T08:44:12.723Z","id":"mb_hnjvhl5gzqfhc","code":143,"reason":"stopped"}
```

`mirb ls`, `mirb stop` and `mirb --background` return a single `{ok, data, meta}` envelope
instead, because they are one-shot commands with an answer rather than a stream.

**stdout is data; stderr is for humans.** Progress, warnings, errors and hints go to stderr
in every mode, including the machine ones — so `mirb 10.0.0.7 3000 > out.txt` leaves progress
on your terminal and `out.txt` parseable.

Failures carry a stable code (`PORT_IN_USE`, `SSH_AUTH`, `REMOTE_REFUSED`, …) and a stable
process exit status, so a script can branch without matching on message text. See
[Exit codes](../reference/exit-codes.md).

---

## Where things live

| | Path |
| --- | --- |
| Config | `~/.config/mirb/config.toml` (`%APPDATA%\mirb\config.toml` on Windows) |
| Session records | `~/.local/state/mirb/sessions/<id>.json` |
| Session logs | `~/.local/state/mirb/logs/<id>.log` |

`XDG_CONFIG_HOME` and `XDG_STATE_HOME` are honoured. `$MIRB_CONFIG` overrides the config
*file* path, and `$MIRB_STATE_DIR` replaces the state root wholesale — useful for running two
isolated instances on one machine. The full list is in
[Environment](../reference/environment.md).

Records are written atomically and validated on read, so `mirb ls` racing a supervisor's
status update is routine rather than exotic. A record whose supervisor is gone is reported
as stopped and swept on the next `mirb ls`; there is nothing to clean up by hand.

---

## Next

- [Quick start](quick-start.md) — put this vocabulary to work.
- [How it works](../explanation/how-it-works.md) — the exact ssh command mirrorball builds,
  and why each flag is there.
- [Design decisions](../explanation/design-decisions.md) — the calls behind the model above,
  and what each one cost.
