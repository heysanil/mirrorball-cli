---
title: Background sessions
description: Detach a tunnel with --background, then find it, follow it, and stop it with ls, logs, and stop.
sidebar_position: 3
---

# Background sessions

A foreground `mirb` owns your terminal for as long as the tunnel is up. That is the right
shape when you are watching it. It is the wrong shape when the tunnel is infrastructure —
a database you will query all afternoon, a staging API a test suite needs, a port an agent
is about to connect to.

`--background` detaches the session and hands the terminal back. Four commands make up the
whole surface:

| Command | What it does |
| --- | --- |
| `mirb --background <host> <ports…>` | Start a detached session, and wait until it works |
| `mirb ls` | Every session mirrorball knows about right now |
| `mirb logs <session>` | What that session's supervisor has been saying |
| `mirb stop <session>` | End it and forget it |

---

## Starting one

```console
$ mirb --background --name db bastion.example.com 15432:db-01.internal:5432
  cxkxy5  bastion.example.com  ready
    ● localhost:15432 ← db-01.internal:5432  ready
  stop it with: mirb stop cxkxy5
```

`-b` is the short form. `--name` is optional; it is a label for `mirb ls` and another handle
`stop` and `logs` will accept.

The important detail is what the command does *before* it returns. It does not print a
session id the moment the child is spawned — it blocks until the detached supervisor has
written a record saying the session reached `ready` or `degraded`. By the time your shell
prompt comes back, the local ports are listening and (unless you passed `--no-probe`) the
remote service has answered a probe.

That matters most for the caller who is not a human. A flag that returned early would hand
a script a set of ports that are not up yet, and the first thing that script does is
connect to them. See
[Automation and agents](automation-and-agents.md#the-guarantee---background-gives-you)
for what a program can rely on.

The wait is bounded. The detached child gives ssh `max(10s, --timeout + 10s)` to get its
local sockets accepting — 20 seconds at the default `--timeout 10`. The parent waits
`max(20s, --timeout + 18s)` — 28 seconds at the default. The parent's ceiling is
deliberately the larger of the two, so the child always fails first and with a real reason;
the parent's timeout firing at all means the supervisor is wedged, which is a different
report from "your host is unreachable".

### When the start fails

The parent reads the failure out of the child's log and reports it as its own, with the
same message, hint, and [exit code](../reference/exit-codes.md) you would have got in the
foreground:

```console
$ mirb --background 10.0.0.7 15432
mirb: error: ssh authentication failed
mirb: hint: Check your key or agent: ssh -v <host>
$ echo $?
3
```

Nothing is left behind — no record, no log, nothing in `mirb ls`. A session that never
existed should not appear in a listing of sessions that do. If the message is not enough on
its own, [Troubleshooting](troubleshooting.md) is keyed to the exact text.

### `--background` implies `BatchMode=yes`

Nothing can answer a passphrase prompt, a 2FA challenge, or a host-key confirmation in a
detached process, and a prompt written to a stream nobody is reading is a hang — the most
expensive way a tool can fail. So a backgrounded session runs ssh with `BatchMode=yes` and
no stdin, and an ssh that *would* have prompted fails immediately instead.

In practice: load the key into your agent (`ssh-add`) and accept the host key once in the
foreground before you background anything. See
[SSH configuration](ssh-configuration.md#batchmode-the-one-thing-mirrorball-decides-for-you).

### What "detached" actually means

mirrorball re-executes *itself* as `mirb __supervise <plan-file>` — same binary, same argv
builder, same probe, same backoff, with its output going to a log file instead of your
terminal.

- Its stdio is fully detached and the handle is unref'd, so it outlives the process that
  started it and reparents to pid 1.
- It installs a no-op `SIGHUP` handler. Closing the terminal, or logging out of the SSH
  session you started it from, does not take the tunnel with it.
- There is one supervisor per session and no daemon: nothing to enable, nothing to
  garbage-collect, and no way for a supervisor from one release to end up talking to a CLI
  from another.

---

## Sessions have short ids

A session id is `mb_` plus a 13-character lowercase nanoid. You are never expected to type
one. `mirb ls` shows the first six characters, and every command that takes a session accepts
any unambiguous prefix, git-style:

```console
$ mirb stop cxkxy5      # the short id, as printed
$ mirb stop cxk         # any unique prefix works
$ mirb stop mb_cxkxy5   # the mb_ prefix is optional
```

An ambiguous prefix stops nothing and lists the candidates. It never guesses — quietly
picking one of several sessions to kill is the kind of thing a tool gets remembered for.

`stop` and `logs` also accept a **host** or a `--name` label. These behave differently on
purpose:

| You typed | `mirb stop` | `mirb logs` |
| --- | --- | --- |
| An id prefix matching one session | Stops it | Tails it |
| An id prefix matching several | Error, lists candidates | Error, lists candidates |
| A host or name matching one | Stops it | Tails it |
| A host or name matching several | Stops **all** of them | Error, lists candidates |

Naming a host is a deliberate statement about *which host*, so stopping every tunnel to it
is what you asked for. Tailing two log files at once is not a thing, so `logs` refuses:

```console
$ mirb logs 10.0.0.7
mirb: error: '10.0.0.7' matches 2 sessions
mirb: hint: Name one: o61r60 -> 10.0.0.7; ylrk5j -> 10.0.0.7
```

Both commands take exactly one session argument. `mirb stop a b` is a usage error rather
than a partial success — quietly stopping `a` while reporting success is the kind of thing
you discover much later, when `b` is still holding a port. Use `--all` to stop everything.

---

## `mirb ls`

```console
$ mirb ls
  ID      NAME  HOST                 FORWARDS      UP  STATUS
  cxkxy5  db    bastion.example.com  15432 ← 5432  1s  ● ready
```

| Column | Meaning |
| --- | --- |
| `ID` | First six characters of the session id |
| `NAME` | `--name`, or `-` |
| `HOST` | The target, in the same form you could paste back into `mirb` |
| `FORWARDS` | `local ← remote`, one entry per forward |
| `UP` | Time since the session started |
| `STATUS` | The session status (see [below](#status-vocabulary)) |

`ls` reads files and nothing else. There is no daemon to ask, which is why it keeps working
when everything else has gone wrong — which is exactly when people run it. On a narrow
terminal the `FORWARDS` column is the one that gets truncated; it is the longest and the
most guessable.

Two things happen on every run, not only under a flag:

- **Stale records are pruned.** A record whose supervisor process is gone describes a
  tunnel that no longer exists, and listing it would send someone to a port nothing is on.
- **Nothing is invented.** A record that cannot be parsed is skipped rather than taken down
  the whole listing.

`--prune` only adds a line saying how many stale records were cleaned up:

```console
$ mirb ls --prune
  cleaned up 1 stale record
  no background sessions
  start one with: mirb --background <host> <port>
```

For programs, `mirb ls --json` (or any pipe, which mirrorball detects) emits the full record
for each session — including `logFile`, `reconnects`, and the exact `sshArgv` handed to ssh:

```console
$ mirb ls --json | jq -r '.data.sessions[] | "\(.id) \(.status) \(.reconnects)"'
mb_cxkxy5wq3m18t ready 0
```

---

## `mirb logs`

```console
$ mirb logs db
2026-08-19T08:47:36.624Z mirb: bastion.example.com: 1 forward
2026-08-19T08:47:36.625Z mirb:   localhost:15432 <- db-01.internal:5432
2026-08-19T08:47:36.625Z mirb: session starting (1 pending)
2026-08-19T08:47:36.684Z mirb: localhost:15432 <- db-01.internal:5432 probing
2026-08-19T08:47:36.684Z mirb: session connecting (1 probing)
2026-08-19T08:47:37.437Z mirb: localhost:15432 <- db-01.internal:5432 ready
2026-08-19T08:47:37.437Z mirb: session connecting (1 ready)
2026-08-19T08:47:37.438Z mirb: session ready (1 ready)
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--lines`, `-n` | 50 | How many lines of history to show |
| `--follow`, `-f` | off | Keep printing new lines until the session ends |

The log is plain text, one record per line, and that is exactly what `mirb logs` prints —
an agent piping it into `grep` wants the same bytes a human does. Only an explicit
`--format` turns it into a structured envelope, because that is the one case where the
caller has said out loud that they want to parse it.

`--follow` polls by byte offset every 200 ms and returns when the supervisor's process
exits, so `mirb logs -f <id>` is a reasonable thing to leave running next to a flaky link.

Two things the log is **not**:

- It is not ssh's stderr. The supervisor keeps the last 64 KiB of that in memory and uses
  it to classify a failure; what reaches the file is mirrorball's own report — the `error:`
  and `hint:` lines you would have seen on the terminal. If you need OpenSSH's own output,
  run the ssh command yourself: see
  [Debugging by hand](ssh-configuration.md#debugging-by-running-the-ssh-command-yourself).
- It is not durable. The log is deleted with the record when the session ends. Copy
  anything you want to keep before you `stop`.

---

## `mirb stop`

```console
$ mirb stop db
  cxkxy5  bastion.example.com  stopped
```

`--all` stops every session; `--json` forces the machine envelope. The last column is the
outcome, and there are three:

| Outcome | What happened |
| --- | --- |
| `stopped` | `SIGTERM`, and the supervisor exited within 3 seconds |
| `killed` | It did not, so it got `SIGKILL` |
| `removed (already gone)` | The process was already dead; only the record was left |

`SIGTERM` is what a supervisor is built to handle: it closes the ssh connection, writes a
final record, and leaves. `SIGKILL` exists only because a wedged supervisor still holding
your local ports is a worse outcome than an ungraceful exit. The record and its log are
removed either way — a record whose process is gone describes nothing.

---

## Status vocabulary

A session reports one status; each forward inside it reports its own. The reasoning behind
the three-state forward model is in
[Concepts](../getting-started/concepts.md#the-three-readiness-states).

| Session status | Meaning |
| --- | --- |
| `starting` | Pre-flight; ssh has not been spawned yet |
| `connecting` | ssh is running, forwards are being bound and probed |
| `ready` | Every forward is usable |
| `degraded` | The tunnel is up, but at least one forward is `refused` or `failed` |
| `reconnecting` | ssh exited for a retryable reason; waiting out a backoff |
| `stopped` | Ended because it was asked to |
| `failed` | Ended for a reason retrying would not fix |

| Forward status | Shown as | Meaning |
| --- | --- | --- |
| `pending` | `pending` | Not attempted yet |
| `bound` | `probing`, or `bound` under `--no-probe` | The local socket accepts connections |
| `ready` | `ready` | A probe reached the remote service |
| `refused` | `refused` | The tunnel is fine; nothing is listening at the far end |
| `failed` | `failed` | The forward could not be established |

`degraded` is a success, not a failure: the session stays up and keeps serving the forwards
that work. A background start returns normally on `degraded`, and the record says so:

```console
$ mirb --background 10.0.0.7 15432 --json | jq -c '.data | {status, forwards: [.forwards[].status]}'
{"status":"degraded","forwards":["refused"]}
```

---

## Sleep, VPN changes, and dropped links

Close a laptop lid, switch networks, or watch a VPN reconnect, and the ssh process dies.
The supervisor's whole job is that you do not find out about it from a failing request.

ssh is configured with `ServerAliveInterval=15` and `ServerAliveCountMax=3`, so a link that
has silently gone away surfaces in about 45 seconds rather than hanging indefinitely. When
ssh exits, the supervisor classifies the exit and either replaces the process or gives up:

- **Retryable** — the link died, the host went away, DNS failed, the local port was still
  held by the ssh that just died. Wait, then spawn a *new* ssh with the same argv.
- **Not retryable** — bad credentials, a host key mismatch, a privileged port, a missing
  ssh binary. These fail identically in thirty seconds' time, and retrying a wrong password
  can lock an account out. The session goes to `failed`.

The wait is exponential with jitter: 1 s, doubling, capped at 30 s, ±20 %. The attempt
counter resets once a connection has held for 60 seconds, so a session that flaps once an
hour does not creep up to a 30-second wait for a blip it could have ridden out instantly.

`--retry N` bounds the attempts, `--no-retry` disables reconnection entirely, and omitting
both means unlimited. The first attempt is never retried under any setting: you are standing
there waiting, and a typo'd hostname should say so immediately rather than disappearing
behind a backoff schedule.

A reconnect shows up in the log, and in the `reconnects` field of the record:

```
2026-08-19T08:43:41.867Z mirb: session failed (1 ready)
2026-08-19T08:43:41.867Z mirb: reconnecting in 1s (attempt 1)
2026-08-19T08:43:41.868Z mirb: session reconnecting (1 ready)
2026-08-19T08:43:42.965Z mirb: session reconnecting (1 pending)
2026-08-19T08:43:43.020Z mirb: localhost:19201 <- localhost:19201 probing
2026-08-19T08:43:43.774Z mirb: localhost:19201 <- localhost:19201 ready
```

Two guarantees hold across a reconnect, and both exist so that whatever you pointed at the
tunnel keeps working:

- **The local ports never move.** The ports the first attempt actually took are frozen for
  the life of the session. `--auto-port` can shift a busy port on the *first* attempt only;
  a reconnect that quietly moved to a different port would break every client already
  pointed at the old one, so instead it fails and retries.
- **Every forward is re-probed.** A remote service that died and came back moves from
  `refused` to `ready` on its own, with nothing for you to restart.

For the full reasoning, see
[How it works](../explanation/how-it-works.md#reconnection-and-backoff).

---

## When a supervisor dies

A supervisor that exits cleanly takes its record and its log with it. A supervisor that is
killed outright cannot, so cleanup falls to whoever runs `mirb ls` next: it prunes every
record whose pid is gone, deletes the matching log, and only then prints. No session that
does not exist is ever listed.

There is one edge worth knowing, because no tool can clean it up for you:

**`SIGKILL` on a supervisor orphans its ssh, and the orphan keeps the port bound.** A
killed process runs no shutdown code and signals no children — this is true of any parent,
not something specific to mirrorball. `mirb ls` will prune the record, and the tunnel will
still be there:

```console
$ kill -9 <supervisor pid>
$ mirb ls
  no background sessions
$ lsof -nP -iTCP:15432 -sTCP:LISTEN
COMMAND   PID  USER   FD   TYPE  ... NAME
ssh     33115 you      4u  IPv4  ... 127.0.0.1:15432 (LISTEN)
```

Use `mirb stop` rather than `kill`, and if you already have an orphan, `lsof` on the port
names the process to kill. Note that the pid in a session record is always the
**supervisor's**, not ssh's — that is the process `mirb stop` signals, and the one whose
liveness decides whether a record is stale.

---

## Where state lives

| | Linux and macOS | Windows |
| --- | --- | --- |
| State root | `$XDG_STATE_HOME/mirb/`, default `~/.local/state/mirb/` | `%LOCALAPPDATA%\mirb\State\` |

```
<state root>/
  sessions/
    mb_cxkxy5wq3m18t.json     one record per session, JSON, written atomically
  logs/
    mb_cxkxy5wq3m18t.log      one log per session, plain text
  pending/
    mb_cxkxy5wq3m18t.json     a start-up plan, deleted the moment the child reads it
```

`$MIRB_STATE_DIR` replaces the root wholesale — set it to run two isolated mirrorball
instances on one machine, or to keep a test run away from your real sessions. Session state
is machine-local and disposable: it must not end up in a dotfile repo or a synced home
directory, where a record from another machine would describe a pid that does not exist
here. See [Environment](../reference/environment.md).

---

## Related

- [SSH configuration](ssh-configuration.md) — what mirrorball hands to ssh, and how to run
  that command yourself.
- [Bastions and jump hosts](bastion-and-jump-hosts.md) — reaching a service that is not on
  the host you log into.
- [Profiles](profiles.md) — turn a daily target into `mirb staging`.
- [Automation and agents](automation-and-agents.md) — the JSON envelope and the event stream.
- [Troubleshooting](troubleshooting.md) — failures grouped by the message mirrorball printed.
- [CLI reference](../reference/cli.md) — every flag, with defaults.
- [How it works](../explanation/how-it-works.md) — the readiness model and the backoff.
- [Architecture](../explanation/architecture.md#where-state-lives) — the record format and
  why writes are atomic.
