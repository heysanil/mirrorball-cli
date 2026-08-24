---
title: mirrorball
description: Instant SSH port forwarding that tells you the truth about whether the tunnel actually works.
sidebar_position: 0
---

# mirrorball

```console
$ mirb 10.0.0.7 3000 3010 8080
```

Three ports forwarded from `10.0.0.7`, with no subcommand, no flags, and no `-L` syntax —
and, more importantly, with an honest answer to the question `ssh` never answers: **is this
tunnel actually carrying anything?**

mirrorball (`mirb`) does not implement SSH. It runs the `ssh` on your `PATH` and watches what
happens, so your `ssh_config`, your agent, your keys, your `ProxyJump` chain and your hardware
token all work exactly as they already do. If `ssh myhost` works, `mirb myhost 3000` works.

---

## The problem

Here is the incantation, the one everybody keeps in a scratch file and edits by hand:

```console
$ ssh -N -L 3000:localhost:3000 -L 3010:localhost:3010 -L 8080:localhost:8080 10.0.0.7
```

It prints nothing and sits there. That silence is doing three different jobs, and there is
no way to tell which one:

**It is silent when the tunnel works.** You find out by switching to a browser and trying.

**It is silent when the tunnel does not work.** If one of those `-L` binds fails — something
is already on 3000 — ssh writes a warning to stderr and *nothing else*: it keeps running, the
session looks healthy, and the exit status is `0`. A tunnel that never bound looks exactly
like one that did. The fix is `-o ExitOnForwardFailure=yes`, which almost nobody types,
because it is the fourth thing you would have to remember about a command you already
resented typing.

**It is silent about the far end.** ssh accepts connections on the local port *before* it
asks the remote sshd to open a channel. So the socket is up whether or not anything is
listening over there, and `curl localhost:3000` failing tells you nothing about which half
is broken. The twenty minutes that follow usually go into debugging an ssh config that was
never wrong, for a service somebody forgot to start.

mirrorball closes all three. It pre-flights every local port before ssh sees a packet, so a
busy port is an instant error naming the process that holds it. It always passes
`ExitOnForwardFailure=yes`, so a failed bind is a failed session. And it opens a real
connection through each finished tunnel, so it can distinguish:

| | |
| --- | --- |
| `●` **ready** | The tunnel is up and something answered on the far end. |
| `○` **refused** | The tunnel is perfect. Nothing is listening on the far end. |
| `✕` **failed** | The forward never came up at all. |

That middle state is the product. It is the difference between "debug your ssh setup" and
"start your server", and no amount of staring at `ssh -N` will give it to you.

---

## Sixty seconds

Install it:

```sh
curl -fsSL https://mirb.dev/install.sh | sh
```

Forward a port:

```console
$ mirb 10.0.0.7 3000
```

```
  mirb ⇄ 10.0.0.7                                      up 4s

   ●  localhost:3000   ←  localhost:3000               ready

   ssh 22030 · reconnects 0 · ^C to stop
```

Forward several, in whatever shape you need:

```console
$ mirb 10.0.0.7 3000 8080:80 5432:db.internal:5432
```

`3000` is the same port at both ends. `8080:80` maps a privileged remote port to an
unprivileged local one. `5432:db.internal:5432` reaches a *third* host as seen from
`10.0.0.7` — the database you cannot ssh into directly. Ranges work too: `3000-3005`.

Leave it running after your shell is gone:

```console
$ mirb --background --name api 10.0.0.7 3000 8080:80
```

```
  lxa2xk  10.0.0.7  ready
    ● localhost:3000 ← localhost:3000  ready
    ● localhost:8080 ← localhost:80  ready
  stop it with: mirb stop lxa2xk
```

mirrorball does not return until the detached supervisor has proved the tunnel works — a
session id handed back before the ports are listening is a trap, not a feature. The supervisor
reconnects through lid closes, VPN flaps and network changes, keeping the same id and the
same local ports.

Then manage what is up:

```console
$ mirb ls
```

```
  ID      NAME  HOST      FORWARDS                UP  STATUS
  lxa2xk  api   10.0.0.7  3000 ← 3000, 8080 ← 80  1s  ● ready
```

```console
$ mirb logs -f api
$ mirb stop lxa2xk
```

Name the things you forward every day:

```toml
# ~/.config/mirb/config.toml
[profiles.api]
host = "deploy@10.0.0.7"
ports = [3000, "8080:80"]
```

```console
$ mirb api
$ mirb api 9229     # the profile, plus a debugger port
```

And when a program is reading instead of a person, mirrorball notices and switches to JSON on
its own — NDJSON while a tunnel is live, a single `{ok, data, meta}` envelope for one-shot
commands. Progress and errors stay on stderr in every mode, so redirecting stdout leaves you
a clean, parseable file.

```console
$ mirb --json 10.0.0.7 3000
{"event":"session.start","ts":"2026-08-19T08:44:09.882Z","id":"mb_hnjvhl5gzqfhc","target":{"host":"10.0.0.7","raw":"10.0.0.7"},"forwards":[{"localPort":3000,"bindAddress":"127.0.0.1","remoteHost":"localhost","remotePort":3000,"source":"3000"}]}
{"event":"forward.bound","ts":"2026-08-19T08:44:09.939Z","localPort":3000}
{"event":"forward.ready","ts":"2026-08-19T08:44:10.692Z","localPort":3000}
{"event":"session.ready","ts":"2026-08-19T08:44:10.693Z","id":"mb_hnjvhl5gzqfhc","ready":1,"total":1}
```

---

## Where to go next

### Getting started

- [Installation](./getting-started/installation.md) — every channel, plus verifying, upgrading
  and uninstalling.
- [Quick start](./getting-started/quick-start.md) — a working tunnel in thirty seconds, then a
  few steps past it.
- [Concepts](./getting-started/concepts.md) — target, forward, session, profile, and the
  readiness model in full.

### Guides

- [Port syntax](./guides/port-syntax.md) — every accepted argument form, and every rejected one.
- [Profiles](./guides/profiles.md) — naming the things you forward every day.
- [Background sessions](./guides/background-sessions.md) — detaching, supervision, reconnects.
- [Bastions and jump hosts](./guides/bastion-and-jump-hosts.md) — reaching what you cannot
  reach directly.
- [SSH configuration](./guides/ssh-configuration.md) — how mirrorball cooperates with
  `ssh_config`.
- [Automation and agents](./guides/automation-and-agents.md) — driving mirrorball from scripts
  and from tools that are not people.
- [Troubleshooting](./guides/troubleshooting.md) — what each failure means and what to do.

### Reference

- [CLI](./reference/cli.md) — every command and flag.
- [Configuration](./reference/configuration.md) — the `config.toml` schema.
- [JSON output](./reference/json-output.md) — the event stream and the envelope.
- [Exit codes](./reference/exit-codes.md) — the stable status codes, for scripts.
- [Environment](./reference/environment.md) — every variable mirrorball reads.

### Explanation

- [How it works](./explanation/how-it-works.md) — the exact ssh command mirrorball builds, and
  why each flag is there.
- [Architecture](./explanation/architecture.md) — the module layers and the state on disk.
- [Design decisions](./explanation/design-decisions.md) — the non-obvious calls, and what each
  one cost.

### Contributing

- [Development](./contributing/development.md) · [Testing](./contributing/testing.md) ·
  [Releasing](./contributing/releasing.md)

---

mirrorball is MIT licensed. Source, issues and releases:
[github.com/heysanil/mirrorball-cli](https://github.com/heysanil/mirrorball-cli).
