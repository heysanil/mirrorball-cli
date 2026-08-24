---
title: CLI reference
description: Every mirrorball command and flag, the argv rules behind the bare `mirb <host> <port>` form, and what each command prints to a human and to a program.
sidebar_position: 1
---

# CLI reference

mirrorball's command is `mirb` — that is what you type, and what every example below uses. The
installer also leaves a `mirrorball` alias pointing at the same binary, so either name works
wherever you see `mirb`.

Everything on this page is checked against the implementation. If `mirb --help` and this page
disagree, the binary is right and this page is a bug.

```
mirb <target> <port>...             shorthand for `mirb up`
mirb up <target> <port>... [flags]
mirb ls [flags]
mirb stop (<session> | --all) [flags]
mirb logs <session> [flags]
```

---

## How argv is resolved

Bunli, the framework mirrorball is built on, has no concept of a root command: it matches the first
argument against a registered command name and fails otherwise. `mirb 10.0.0.7 3000` would exit 1.
So mirrorball normalizes argv before handing it over (`normalizeArgv` in `mirb.ts`), by exactly
three rules:

1. If the **first** argument is a command name — `up`, `ls`, `stop`, `logs`, `__supervise` — argv
   is passed through untouched.
2. Otherwise, if **any** argument is not a flag (does not start with `-`), `up` is inserted at the
   front.
3. Otherwise — nothing at all, or nothing but flags — argv is passed through, and bunli answers
   with the root help.

Only the first argument is ever consulted. That keeps the rule short enough to hold in your head,
and stops an option *value* from being mistaken for a subcommand.

| You type | What actually runs |
|---|---|
| `mirb 10.0.0.7 3000` | `mirb up 10.0.0.7 3000` |
| `mirb -b 10.0.0.7 3000 8080:80` | `mirb up -b 10.0.0.7 3000 8080:80` |
| `mirb --bind 127.0.0.2 db 5432` | `mirb up --bind 127.0.0.2 db 5432` |
| `mirb web` | `mirb up web` — `web` is looked up as a profile, then as a host |
| `mirb ls` | `mirb ls` |
| `mirb ls 3000` | `mirb ls` — `ls` claims the slot; `3000` is an ignored positional |
| `mirb up ls 3000` | `mirb up` against a host literally named `ls` |
| `mirb` | root help, exit 0 |
| `mirb --help`, `mirb --version` | root help / version, exit 0 |

**The escape hatch.** A host or ssh_config alias named `up`, `ls`, `stop`, or `logs` is not
reachable through the bare form, because rule 1 fires first. Write `up` explicitly:

```bash
mirb up ls 3000          # forwards port 3000 from the host named "ls"
mirb up stop 5432        # forwards port 5432 from the host named "stop"
```

**The one gotcha.** A global flag that *takes a value*, placed before a subcommand, defeats rule 1:
its value is a bare word, so rule 2 fires and the subcommand becomes a positional.

```bash
mirb --format json ls    # WRONG: runs `mirb up --format json ls`, which forwards from a host named "ls"
mirb ls --format json    # right: the command name goes first
```

bunli consumes `--format json` as a global flag before the handler sees its positionals, so the
one positional left is `ls`, and the failure is about the ports it does not have:

```
mirb: error: no ports given for 'ls'
mirb: hint: Name at least one port: mirb ls 3000
```

Putting the command name first is also the only ordering that reads correctly, so it is what every
example below does.

Unrecognized flags are ignored rather than rejected: `mirb up --nope 10.0.0.7 3000` forwards port
3000 and says nothing about `--nope`.

---

## Global flags

These belong to bunli and work on every command, including the bare form.

| Flag | Short | Description |
|---|---|---|
| `--help` | `-h` | Usage for the CLI or for one command. |
| `--version` | `-v` | mirrorball's version. |
| `--format <fmt>` | — | Force a machine format: `json`, `yaml`, `md`, or `toon`. Also forces machine mode (see below). |
| `--llms` | — | A one-screen Markdown manifest of every command, for pasting into an agent's context. |
| `--llms-full` | — | The same manifest with every flag, type, and default. |

Because bunli owns `-h` and `-v`, **no flag of mirrorball's own may use them**. That is why the
identity flag is `-i`, the ssh port flag is `-P`, and there is no `-v` for "verbose" — `mirb logs`
is the verbose mode.

---

## Human output and machine output

Every command decides once, the same way (`isMachine` in `commands/shared.ts`). Output is
**machine-readable** when any of these is true:

- `--json` was passed (`up`, `ls`, `stop`),
- `--format` was passed explicitly,
- stdout is not a TTY — which is what makes `mirb 10.0.0.7 3000 | jq` work without a flag.

Otherwise output is for a human: colour, alignment, a live frame where the terminal supports one.

Machine output is a single envelope, in the format `--format` asked for, defaulting to JSON:

```json
{
  "ok": true,
  "data": { "sessions": [], "pruned": [] },
  "meta": { "command": "ls", "durationMs": 1 }
}
```

Two deliberate exceptions:

- **`mirb up` in the foreground** streams [NDJSON events](#json-event-stream), one per line, instead
  of a single envelope. There is no final state to summarise while the tunnel is still running.
- **`mirb logs`** prints the raw log unless `--format` is passed. `agent` mode alone is not enough:
  a pipe wants the log text, and turning `mirb logs x | grep` into JSON would break it.

Errors never go to stdout, in any mode. They go to stderr in this shape, and the process exits
with the code for that failure (see [exit codes](./exit-codes.md)):

```
mirb: error: 'nosuchprofile' is not a known profile, and no ports were given
mirb: hint: Known profiles: db, web. Or name a port: mirb nosuchprofile 3000
```

Two failures happen before mirrorball's own code runs, and those are reported by bunli in its own
JSON shape on stderr, exiting `1`: a flag value that fails validation (`--timeout abc`,
`--probe-settle 0`), reported as `"kind": "validation"`, and a first argument that is neither a
command nor anything the normalizer could turn into one (`mirb --nope`), reported as
`"kind": "command-not-found"`. Neither carries a mirrorball error code, so neither gets a
mirrorball exit code.

```json
{
  "ok": false,
  "error": {
    "kind": "validation",
    "name": "BunliValidationError",
    "tag": "BunliValidationError",
    "message": "Invalid option 'timeout': Invalid input: expected number, received NaN",
    "command": "up",
    "option": "timeout",
    "expectedType": "default"
  }
}
```

---

## `mirb up`

```
mirb up <target> <port>... [flags]
mirb <target> <port>...              # same thing
```

Open an ssh connection and forward one or more local ports through it. In the foreground it runs
until you stop it; with `--background` it detaches a supervisor and returns once the tunnel is
proven up.

### Arguments

**`<target>`** — the first positional. It is resolved as a **profile name first**, then as an ssh
destination. A profile named `prod` wins over a host named `prod`, because the profile is the thing
you configured on purpose. See [Configuration](./configuration.md).

As a destination, these forms parse:

| Form | Example |
|---|---|
| host or ssh_config alias | `db`, `10.0.0.7`, `box.example.com` |
| `user@host` | `deploy@10.0.0.7` |
| `user@host:port` | `deploy@10.0.0.7:2222` |
| `ssh://user@host:port` | `ssh://deploy@10.0.0.7:2222` |
| IPv6 literal, bracketed | `[2001:db8::1]`, `deploy@[2001:db8::1]:2222` |
| IPv6 literal, bare | `2001:db8::1` (two or more colons is the tell) |

mirrorball does not try to decide what a valid host is — an alias, a `/etc/hosts` entry, a name a
`ProxyCommand` invents, and a VPN-only CNAME are all ssh's business. It rejects only what could not
survive the trip: an empty part, embedded whitespace, a URI password, a path on an `ssh://` URL, a
port outside 1–65535.

**`<port>...`** — one or more port specifications, in the order you typed them. The grammar is a
strict subset of ssh's own `-L`:

| Form | Example | Meaning |
|---|---|---|
| `PORT` | `3000` | local 3000 ← `localhost:3000` on the remote |
| `LOCAL:REMOTE` | `8080:80` | local 8080 ← `localhost:80` on the remote |
| `LOCAL:HOST:REMOTE` | `8080:db.internal:5432` | local 8080 ← `db.internal:5432`, reached *from* the ssh host |
| `START-END` | `3000-3005` | six forwards, same port on both sides |
| `L1-L2:R1-R2` | `8000-8005:9000-9005` | paired ranges, zipped in order |
| bracketed IPv6 middle field | `8080:[::1]:5432` | brackets are required for an IPv6 literal |

Rules the parser enforces, each with its own error message:

- The **first field is always a port**, never a bind address. ssh's `[bind:]port:host:hostport`
  makes `0.0.0.0:8080:80` and `8080:db:5432` impossible to tell apart without resolving the middle
  field; mirrorball refuses that ambiguity and puts the bind address on `--bind`.
- Paired ranges must be the same length.
- A single range may span at most **256** ports.
- The same local port may not be claimed twice, whether by one argument or by two.
- Port `0` is rejected: to the kernel it means "any free port", which mirrorball would then have
  nothing honest to print.

### Flags

| Flag | Short | Type | Default | Description |
|---|---|---|---|---|
| `--background` | `-b` | flag | `false` | Detach and keep forwarding after `mirb` exits. Returns only once the tunnel is up. |
| `--json` | — | flag | `false` | Stream NDJSON events on stdout. |
| `--auto-port` | — | flag | `false` | Take the next free local port when the requested one is busy. |
| `--bind <address>` | — | string | `127.0.0.1` | Local address every forward binds on. |
| `--expose` | — | flag | `false` | Allow a bind beyond loopback. Bare `--expose` means `0.0.0.0`. |
| `--name <label>` | — | string | profile `name`, else none | Label this session for `mirb ls`, `mirb stop`, `mirb logs`. |
| `--identity <path>` | `-i` | string | profile `identity` | ssh identity file. Becomes `ssh -i`. |
| `--port <n>` | `-P` | integer 1–65535 | ssh's own default | ssh port on the remote host. Becomes `ssh -p`. |
| `--jump <spec>` | `-J` | string | profile `jump` | ssh jump host. Becomes `ssh -J`. |
| `--ssh-option <k=v>` | `-o` | string, repeatable | none | Passed straight to ssh as `-o k=v`. |
| `--retry <n>` | — | integer ≥ 0 | unlimited | Maximum reconnect attempts. `0` disables reconnection. |
| `--no-retry` | — | flag | `false` | Never reconnect. Same as `--retry 0`. |
| `--no-probe` | — | flag | `false` | Skip the remote-service probe; forwards report `bound` instead of `ready`. |
| `--timeout <s>` | — | integer ≥ 1 | `10` | ssh `ConnectTimeout`, in seconds. |
| `--quiet` | `-q` | flag | `false` | Suppress progress and summaries. Errors and machine output still print. |
| `--probe-settle <ms>` | — | integer ≥ 1 | `750` | How long a socket must stay open before a forward counts as `ready`. Honoured in the foreground and travels in the plan file to a background supervisor. |
| `--ssh-path <path>` | — | string | `$MIRB_SSH`, else `ssh` on `PATH` | Use a specific ssh binary. Resolved and checked for executability before anything is spawned. |

`--probe-settle` is an RTT budget, not a timeout. mirrorball calls a forward `ready` only once a
probe connection has survived this long, because a tunnel to a dead remote service is torn down
roughly three round trips after you connect to it. The 750 ms default covers an RTT up to about
250 ms — essentially everywhere terrestrial. Raise it for a satellite link or a long `-J` chain,
where each hop compounds; lowering it trades correctness for speed in the dangerous direction,
since a value that is too small reports a dead service as healthy.

Four flags interact in ways worth spelling out:

- **`--bind` and `--expose`.** A forward bound off loopback is reachable by every machine that can
  reach yours — `GatewayPorts` does not prevent it, and ssh says nothing about it. So mirrorball
  refuses a non-loopback bind unless you also pass `--expose`, and refuses it as an error rather
  than a prompt, so a script and a human get the same behaviour. The check applies to whatever
  address is finally resolved, including one that came from a profile's `bind`.

  ```
  $ mirb --bind 0.0.0.0 10.0.0.7 8080
  mirb: error: --bind 0.0.0.0 would publish these forwards beyond this machine
  mirb: hint: Anyone who can reach this host on the network could use the tunnel. Pass --expose to confirm.
  ```

- **`--ssh-option`.** Your `-o`s are appended after mirrorball's own, and ssh honours the *first*
  value it sees for a keyword — so mirrorball's `ExitOnForwardFailure=yes`, `ServerAlive*`,
  `ConnectTimeout` and `BatchMode` win over an attempt to override them, while everything else you
  pass still overrides `ssh_config`. `ExitOnForwardFailure` in particular is not negotiable:
  without it a failed bind leaves a half-working tunnel that exits 0.

- **`--retry`.** Reconnection is attempted only for failures a later attempt could plausibly
  survive — a dropped connection, a local port the dying ssh has not released yet, a remote service
  that was not up yet. A bad key, a missing ssh binary, a privileged port or a malformed argument
  fails once and stays failed. Delays are exponential with jitter, 1 s to 30 s.

### Foreground vs background

In the foreground, `mirb up` occupies the terminal and Ctrl-C ends it (exit 130). ssh keeps stdin,
so it can still ask for a passphrase, a 2FA code, or a host-key confirmation.

`--background` writes a plan file, re-executes mirrorball as a detached supervisor, and then
**waits**: it does not return until that supervisor has written a record saying the forwards are
`ready` (or `degraded`), or has died trying. Handing back a session id and a set of ports that are
not listening yet would be worse than useless to the agent or script that immediately connects to
them. Backgrounded sessions always run ssh in `BatchMode`, since nothing in a detached process can
answer a prompt.

### Examples

```bash
# One port, foreground, Ctrl-C to stop
mirb 10.0.0.7 3000

# Several ports, including a remapped one and a range
mirb 10.0.0.7 3000 8080:80 9000-9004

# A database behind the ssh host, not on it
mirb deploy@bastion.example.com 5432:db.internal:5432

# Detach, and label it
mirb --background --name api deploy@10.0.0.7:2222 3000

# Take the next free port instead of failing on a busy one
mirb --auto-port 10.0.0.7 3000

# Publish on the LAN, deliberately
mirb --expose 10.0.0.7 8080

# Through a jump host, with a specific key, no reconnection
mirb -J bastion -i ~/.ssh/id_ed25519 --no-retry 10.0.0.7 3000

# Hand ssh an option of your own
mirb -o StrictHostKeyChecking=accept-new 10.0.0.7 3000
```

A backgrounded start prints the session, its forwards, and how to stop it:

```
  ityzsd  127.0.0.1  ready
    ● localhost:45701 ← localhost:45701  ready
    ● localhost:45702 ← localhost:80  ready
  stop it with: mirb stop ityzsd
```

### JSON event stream

`mirb up --json` (or any foreground `up` whose stdout is a pipe) writes one JSON object per line:

```
{"event":"session.start","ts":"…","id":"mb_j031yvs5v6pjp","target":{"host":"10.0.0.7","raw":"10.0.0.7"},"forwards":[…]}
{"event":"forward.bound","ts":"…","localPort":3000}
{"event":"forward.ready","ts":"…","localPort":3000}
{"event":"session.ready","ts":"…","id":"mb_j031yvs5v6pjp","ready":1,"total":1}
{"event":"session.reconnecting","ts":"…","attempt":1,"delayMs":1043}
{"event":"session.exit","ts":"…","id":"mb_j031yvs5v6pjp","code":255,"reason":"Timeout, server 10.0.0.7 not responding."}
```

`forward.error` carries `{ localPort, code, message }`, where `code` is the same
[error code](./exit-codes.md) the exit status is derived from.

`mirb up --background` is different: it is a request with an answer, so it prints one envelope.

```json
{
  "ok": true,
  "data": {
    "id": "mb_40w26siieu0dq",
    "name": "demo",
    "pid": 13723,
    "status": "ready",
    "target": "10.0.0.7",
    "forwards": [
      {
        "localPort": 3000,
        "bindAddress": "127.0.0.1",
        "remoteHost": "localhost",
        "remotePort": 3000,
        "source": "3000",
        "status": "ready"
      }
    ],
    "logFile": "/Users/you/.local/state/mirb/logs/mb_40w26siieu0dq.log"
  },
  "meta": { "command": "up", "durationMs": 812 }
}
```

---

## `mirb ls`

```
mirb ls [flags]
```

List background sessions. It reads files and nothing else — there is no daemon to ask — so it keeps
working when everything else has gone wrong, which is exactly when people run it.

Before listing, `ls` **always** prunes records whose supervisor process is gone, plus any file that
no longer parses. A record for a dead supervisor describes a tunnel that no longer exists, and
listing it would send someone to a port with nothing on it. `--prune` does not enable the cleanup;
it only makes `ls` say how many records it swept.

| Flag | Short | Type | Default | Description |
|---|---|---|---|---|
| `--json` | — | flag | `false` | Force JSON output. |
| `--prune` | — | flag | `false` | Also report the stale records that were cleaned up. |

Positional arguments are accepted and ignored, which is why `mirb ls 3000` lists sessions rather
than forwarding anything.

```
$ mirb ls
  ID      NAME  HOST       FORWARDS                   UP  STATUS
  ityzsd  api   127.0.0.1  45701 ← 45701, 45702 ← 80  1s  ● ready
```

The `FORWARDS` column is the one that gives way on a narrow terminal — it is the longest and the
most guessable. Widths are measured with `Bun.stringWidth`, so a CJK hostname does not leave the
status column ragged.

In machine mode each session additionally carries `startedAt`, `reconnects`, `logFile`, and
`sshArgv` — the exact argv handed to ssh, which answers "what did mirrorball actually run?" without
opening a file:

```json
{
  "ok": true,
  "data": {
    "sessions": [
      {
        "id": "mb_qldudkm585383",
        "name": "demo",
        "pid": 13724,
        "status": "ready",
        "target": "example.test",
        "forwards": [ { "localPort": 18080, "bindAddress": "127.0.0.1", "remoteHost": "localhost", "remotePort": 80, "source": "18080:80", "status": "ready" } ],
        "startedAt": "2026-08-19T08:41:51.842Z",
        "reconnects": 0,
        "logFile": "/Users/you/.local/state/mirb/logs/mb_qldudkm585383.log",
        "sshArgv": ["-N", "-T", "-o", "ExitOnForwardFailure=yes", "…"]
      }
    ],
    "pruned": []
  },
  "meta": { "command": "ls", "durationMs": 3 }
}
```

---

## `mirb stop`

```
mirb stop <session> [flags]
mirb stop --all
```

Stop a background session and forget it: the record and its log file are both removed.

**One session argument, not a list.** Only the first positional is read; `mirb stop a b` stops `a`
and says nothing about `b`. To stop several at once, use `--all`, or a name or host that they
share.

**`<session>`** is an id prefix, a `--name` label, or a host. The two behave differently on purpose:

- An **id prefix** must resolve to exactly one session. An ambiguous prefix stops nothing and lists
  the candidates instead — quietly picking one of several sessions to kill is the kind of thing a
  tool gets remembered for. The six-character id in `mirb ls` is the prefix to use; `mb_` may be
  included or left off.
- A **name or host** is a deliberate statement about *which* host, so every session matching it is
  stopped.

| Flag | Short | Type | Default | Description |
|---|---|---|---|---|
| `--all` | — | flag | `false` | Stop every background session. |
| `--json` | — | flag | `false` | Force JSON output. |

Each session gets SIGTERM, three seconds to tear its tunnel down, then SIGKILL. The record is
removed either way, and the outcome is reported per session as `stopped`, `killed`, or
`already-gone`.

```bash
mirb stop ityzsd                 # by id prefix
mirb stop api                    # by --name label
mirb stop 10.0.0.7               # every session to that host
mirb stop --all
```

```
$ mirb stop ityzsd
  ityzsd  127.0.0.1  stopped
```

```json
{
  "ok": true,
  "data": {
    "stopped": [
      { "id": "mb_ywvl3exmp95bj", "target": "10.0.0.7", "outcome": "stopped" }
    ]
  },
  "meta": { "command": "stop", "durationMs": 56 }
}
```

Running `mirb stop` with neither a session nor `--all` is a usage error (exit 2).

---

## `mirb logs`

```
mirb logs <session> [flags]
```

Print what a background session's supervisor has been saying. One record per line, timestamped,
including every status change and the ssh failure that ended a session.

**`<session>`** resolves the same way as for `stop`, with one difference: an argument matching more
than one session is an error here rather than a fan-out. A host with two tunnels is a legitimate
thing to `stop`; it is not a thing to tail.

| Flag | Short | Type | Default | Description |
|---|---|---|---|---|
| `--follow` | `-f` | flag | `false` | Keep printing new lines until the session's supervisor exits. |
| `--lines <n>` | `-n` | integer ≥ 1 | `50` | How many lines of history to show first. |

`logs` has no `--json`. It prints the raw log text unless you pass `--format`, because
`mirb logs x | grep …` has to keep working:

```bash
mirb logs ityzsd                 # last 50 lines
mirb logs ityzsd -n 200          # more history
mirb logs ityzsd -f              # follow
mirb logs ityzsd --format json   # structured, for a program
```

```
$ mirb logs ityzsd
2026-08-19T08:42:07.722Z mirb: 127.0.0.1: 1 forward
2026-08-19T08:42:07.722Z mirb:   localhost:45211 <- localhost:45211
2026-08-19T08:42:07.722Z mirb: session starting (1 pending)
2026-08-19T08:42:07.780Z mirb: localhost:45211 <- localhost:45211 probing
2026-08-19T08:42:07.780Z mirb: session connecting (1 probing)
2026-08-19T08:42:08.533Z mirb: localhost:45211 <- localhost:45211 ready
2026-08-19T08:42:08.535Z mirb: session ready (1 ready)
```

Following polls the file by byte offset every 200 ms and stops when the supervisor's process is
gone. A truncated or rotated file is re-read from the start rather than printed as garbage.

Because a session's log is deleted with its record, `mirb logs` on a session you just stopped
reports that no session matches.

---

## `mirb __supervise`

```
mirb __supervise <plan-file>
```

Internal. This is the detached process `--background` starts: mirrorball re-executed as its own
supervisor, with everything it needs in a plan file that it reads once and then deletes. There is
one supervisor per session, started by the session and exiting with it — no daemon to enable, no
broker to garbage-collect, and no way for a supervisor from one release to end up talking to a CLI
from another.

It is listed in `mirb --help` because bunli lists every registered command. Do not run it directly;
its plan-file format is not a stable interface. See
[Design decisions](../explanation/design-decisions.md) for why background sessions work this way.

---

## Exit codes

`0` on success, `2` for a usage or config error, `3` for ssh failures, `4` for a local port
conflict, `5` when the tunnel is up but the remote service refused, `130` for Ctrl-C, `1` for
everything else. The full table, with the error code each one comes from, is in
[Exit codes](./exit-codes.md).

## See also

- [Configuration](./configuration.md) — named profiles in `config.toml`
- [Environment variables](./environment.md) — `MIRB_CONFIG`, `MIRB_STATE_DIR`, `MIRB_SSH`,
  `MIRB_ASCII`, `NO_COLOR`, `FORCE_COLOR`, and the XDG variables behind the paths above
- [JSON output](./json-output.md) — the envelope and the full NDJSON event catalogue
- [Exit codes](./exit-codes.md)
- [How it works](../explanation/how-it-works.md) — the ssh command mirrorball builds, and how it
  decides a tunnel is actually up
