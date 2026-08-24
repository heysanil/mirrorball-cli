---
title: Quick start
description: Your first tunnel in thirty seconds, then background sessions, multiple ports, and reading the states mirrorball reports.
sidebar_position: 2
---

# Quick start

You need mirrorball (`mirb`) on your `PATH` ([install it](./installation.md)) and a host you
can already `ssh` into. That second condition is the only one mirrorball adds nothing to: it
runs the `ssh` binary you already have, so if `ssh myhost` works, everything below works.

---

## Thirty seconds

Forward one port:

```console
$ mirb 10.0.0.7 3000
```

```
  mirb ⇄ 10.0.0.7                                      up 4s

   ●  localhost:3000   ←  localhost:3000               ready

   ssh 22030 · reconnects 0 · ^C to stop
```

`localhost:3000` on your machine now reaches `localhost:3000` on `10.0.0.7`. The filled
circle and the word **ready** are the point: mirrorball opened a real connection through the
tunnel and something answered. That is a stronger claim than `ssh -L` ever makes.

Ctrl-C stops it.

## Several ports at once

Positional arguments, in any number, in any of the supported forms:

```console
$ mirb 10.0.0.7 3000 8080:80 5432:db.internal:5432
```

```
  mirb ⇄ 10.0.0.7                                      up 4s

   ●  localhost:3000   ←  localhost:3000               ready
   ●  localhost:8080   ←  localhost:80                 ready
   ●  localhost:5432   ←  db.internal:5432             ready

   ssh 54287 · reconnects 0 · ^C to stop
```

- `3000` — same port on both ends.
- `8080:80` — local 8080, remote 80. Use this whenever the remote port is privileged;
  binding below 1024 locally needs root, and mirrorball will tell you so rather than let ssh
  fail after authenticating.
- `5432:db.internal:5432` — reaches a *third* host, `db.internal`, as seen from `10.0.0.7`.
  This is how you get at a database that is not on the box you can ssh to.

Ranges work too: `mirb 10.0.0.7 3000-3005`. The complete grammar is in
[Port syntax](../guides/port-syntax.md).

## When the far end is not there

```console
$ mirb 10.0.0.7 3000 8080:80
```

```
  mirb ⇄ 10.0.0.7                                      up 2s

   ○  localhost:3000   ←  localhost:3000             refused
   ○  localhost:8080   ←  localhost:80               refused

   ssh 20769 · reconnects 0 · ^C to stop
```

Hollow circles, and the word **refused**. This is not a broken tunnel — the tunnel is
perfect. Nothing is listening on `10.0.0.7` at those ports. Go start your server; mirrorball
will report `ready` the next time it probes.

Telling those two failures apart is the entire reason mirrorball exists. See
[the three readiness states](./concepts.md#the-three-readiness-states) for how the
distinction is made and where it can be wrong.

## Leave it running

`--background` (or `-b`) detaches the tunnel from your shell:

```console
$ mirb --background --name api 10.0.0.7 3000 8080:80
```

```
  lxa2xk  10.0.0.7  ready
    ● localhost:3000 ← localhost:3000  ready
    ● localhost:8080 ← localhost:80  ready
  stop it with: mirb stop lxa2xk
```

mirrorball does not return until the detached supervisor has proved the tunnel works. A flag
that returned the moment the child was spawned would hand you a session id and a set of ports
that are not listening yet — and the first thing anyone does with that id is connect.

`lxa2xk` is the session's short id. It survives your terminal closing.

## Manage what is running

```console
$ mirb ls
```

```
  ID      NAME  HOST      FORWARDS                UP  STATUS
  lxa2xk  api   10.0.0.7  3000 ← 3000, 8080 ← 80  1s  ● ready
```

```console
$ mirb logs api
```

```
2026-08-19T08:42:27.910Z mirb: 10.0.0.7: 2 forwards
2026-08-19T08:42:27.911Z mirb:   localhost:3000 <- localhost:3000
2026-08-19T08:42:27.911Z mirb:   localhost:8080 <- localhost:80
2026-08-19T08:42:27.911Z mirb: session starting (2 pending)
2026-08-19T08:42:27.969Z mirb: localhost:3000 <- localhost:3000 probing
2026-08-19T08:42:27.969Z mirb: session connecting (1 probing, 1 pending)
2026-08-19T08:42:27.970Z mirb: localhost:8080 <- localhost:80 probing
2026-08-19T08:42:27.970Z mirb: session connecting (2 probing)
2026-08-19T08:42:28.723Z mirb: localhost:3000 <- localhost:3000 ready
2026-08-19T08:42:28.723Z mirb: session connecting (1 ready, 1 probing)
2026-08-19T08:42:28.724Z mirb: localhost:8080 <- localhost:80 ready
2026-08-19T08:42:28.724Z mirb: session connecting (2 ready)
2026-08-19T08:42:28.724Z mirb: session ready (2 ready)
```

`mirb logs -f api` follows. `mirb logs -n 200 api` shows more history.

```console
$ mirb stop lxa2xk
```

```
  lxa2xk  10.0.0.7  stopped
```

Any unique id prefix works, as does the `--name` label or the host. `mirb stop --all` ends
everything. More in [Background sessions](../guides/background-sessions.md).

## Name it once, use it forever

Put a target and its ports in `~/.config/mirb/config.toml`:

```toml
[profiles.api]
host = "deploy@10.0.0.7"
ports = [3000, "8080:80"]
```

```console
$ mirb api
$ mirb api 9229     # the profile, plus a debugger port
```

Flags still override, and extra ports append. See [Profiles](../guides/profiles.md).

---

## Two things worth knowing early

### The port you want is already taken

```
mirb: error: localhost:3000 is already in use by Python (pid 37380)
mirb: hint: Pass --auto-port to take the next free port, or choose another local port.
```

mirrorball tries to bind every local port itself *before* spawning ssh, which is why this
arrives instantly and names the process instead of arriving as an opaque ssh error after you
have authenticated. `--auto-port` walks upward to the next free port — `3000` busy means
`3001`, predictably, rather than a random high port.

### It switches to JSON on its own

When stdout is not a terminal, mirrorball assumes a program is reading it:

```console
$ mirb ls | jq '.data.sessions[].status'
```

For a live tunnel, `--json` streams NDJSON — one event per line, written the moment it
happens:

```console
$ mirb --json 10.0.0.7 3000
```

```json
{"event":"session.start","ts":"2026-08-19T08:44:09.882Z","id":"mb_hnjvhl5gzqfhc","target":{"host":"10.0.0.7","raw":"10.0.0.7"},"forwards":[{"localPort":3000,"bindAddress":"127.0.0.1","remoteHost":"localhost","remotePort":3000,"source":"3000"}]}
{"event":"forward.bound","ts":"2026-08-19T08:44:09.939Z","localPort":3000}
{"event":"forward.ready","ts":"2026-08-19T08:44:10.692Z","localPort":3000}
{"event":"session.ready","ts":"2026-08-19T08:44:10.693Z","id":"mb_hnjvhl5gzqfhc","ready":1,"total":1}
```

Progress and errors always go to stderr, so redirecting stdout leaves you a clean file and
still shows you what is happening.

---

## Next

- [Concepts](./concepts.md) — target, forward, session, profile, and the readiness model in
  full.
- [Port syntax](../guides/port-syntax.md) — every accepted form, and every rejected one.
- [Background sessions](../guides/background-sessions.md) — supervision, reconnects, and
  where the state lives.
- [How it works](../explanation/how-it-works.md) — the exact ssh command behind all of this.
