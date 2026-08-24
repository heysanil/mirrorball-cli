---
title: JSON output
description: The {ok, data, meta} envelope, the response shape of every one-shot command, and the full NDJSON event catalogue mirrorball streams while a tunnel is up.
sidebar_position: 3
---

# JSON output

mirrorball (`mirb`) emits two different kinds of machine output, and which one you get
depends on the command, not on a flag:

- **An envelope.** One JSON document, written once, when the command is done. This is what
  `mirb ls`, `mirb stop`, `mirb logs --format …` and `mirb --background` produce.
- **An NDJSON event stream.** One compact JSON object per line, written the instant the
  thing it describes happens. This is what a *foreground* `mirb up` produces, for as long as
  the tunnel is alive.

A foreground session is a process that runs for hours; a report delivered at exit would be
useless to anything waiting for the tunnel to come up. A `ls` is a question with one answer.
The two shapes exist because those are two different problems.

## When mirrorball switches to machine output

Three signals, any of which is enough:

| Signal | Where it comes from |
| --- | --- |
| `--json` | Explicit. Available on `up`, `ls` and `stop`. |
| `--format json\|yaml\|md\|toon` | Explicit. A global flag bunli owns; every command accepts it. |
| stdout is not a TTY | Implicit. `mirb web 3000 \| jq` needs no flag. |

The last one is the point of the design: piping mirrorball into anything gives you
parseable output without anybody having to remember a flag.

`--format` selects the serialisation of the **envelope** only. The event stream is always
JSON, one object per line — `--format yaml` on a foreground `mirb up` still yields NDJSON,
because a streaming YAML document is not a thing a consumer can read incrementally.

```bash
# The envelope, as YAML.
mirb ls --format yaml

# Still NDJSON, despite the flag.
mirb example.test 3000 --format yaml
```

## The envelope

```json
{
  "ok": true,
  "data": { },
  "meta": { "command": "ls", "durationMs": 1 }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | `boolean` | `true` on every envelope mirrorball writes. Failures do not produce one — see [Errors](#errors). |
| `data` | object | The command's payload. Shape is per-command, documented below. |
| `meta.command` | `string` | `up`, `ls`, `stop` or `logs`. Never the alias you typed. |
| `meta.durationMs` | `number` | Wall-clock milliseconds. Present on every command mirrorball emits today. |

`undefined` fields are absent, not `null` — that is `JSON.stringify`'s behaviour and
mirrorball does not fight it. A session with no `--name` has no `name` key at all.

## Command responses

### `mirb --background`

Written only after the supervisor has reported a working tunnel, so the ports in it are
already listening by the time you read them.

```bash
mirb example.test 45241:3000 --background --name web --json
```

```json
{
  "ok": true,
  "data": {
    "id": "mb_foskwpi71k9jt",
    "name": "web",
    "pid": 15478,
    "status": "ready",
    "target": "example.test",
    "forwards": [
      {
        "localPort": 45241,
        "bindAddress": "127.0.0.1",
        "remoteHost": "localhost",
        "remotePort": 3000,
        "source": "45241:3000",
        "status": "ready"
      }
    ],
    "logFile": "/Users/you/.local/state/mirb/logs/mb_foskwpi71k9jt.log"
  },
  "meta": { "command": "up", "durationMs": 1017 }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | `mb_` + 13 lowercase alphanumerics. Any unambiguous prefix works as an argument to `stop` and `logs`. |
| `name` | `string?` | From `--name` or the profile. Absent when unset. |
| `pid` | `number` | The **supervisor's** pid, not ssh's. This is what `mirb stop` signals. |
| `status` | `string` | `ready` or `degraded`; the parent does not print until it sees one of those two. |
| `target` | `string` | Rendered, e.g. `deploy@example.test:2222` — not the `Target` object. |
| `forwards` | array | See [Forward objects](#forward-objects). |
| `logFile` | `string` | Absolute path. The same file `mirb logs` reads. |

`degraded` means the tunnel is up and at least one forward is `refused` or `failed`. It is
still a successful start, and it still exits 0 — read `forwards[].status` to decide whether
that matters to you.

### `mirb ls`

```bash
mirb ls --json
```

```json
{
  "ok": true,
  "data": {
    "sessions": [
      {
        "id": "mb_foskwpi71k9jt",
        "name": "web",
        "pid": 15478,
        "status": "ready",
        "target": "example.test",
        "forwards": [
          {
            "localPort": 45241,
            "bindAddress": "127.0.0.1",
            "remoteHost": "localhost",
            "remotePort": 3000,
            "source": "45241:3000",
            "status": "ready"
          }
        ],
        "startedAt": "2026-08-19T08:42:20.048Z",
        "reconnects": 0,
        "logFile": "/Users/you/.local/state/mirb/logs/mb_foskwpi71k9jt.log",
        "sshArgv": [
          "-N", "-T",
          "-o", "ExitOnForwardFailure=yes",
          "-o", "ServerAliveInterval=15",
          "-o", "ServerAliveCountMax=3",
          "-o", "ConnectTimeout=10",
          "-o", "BatchMode=yes",
          "-L", "127.0.0.1:45241:localhost:3000",
          "example.test"
        ]
      }
    ],
    "pruned": []
  },
  "meta": { "command": "ls", "durationMs": 1 }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `sessions[].startedAt` | `string` | ISO-8601, UTC. |
| `sessions[].reconnects` | `number` | How many times the tunnel has been rebuilt under this id. |
| `sessions[].sshArgv` | `string[]` | The exact argv handed to ssh, minus the binary. Verbose, but it is the only thing that answers "what did mirrorball actually run?" without opening a file. |
| `pruned` | `string[]` | Ids of records removed on this run because their supervisor was gone. |

Pruning happens on every `mirb ls`, not only under `--prune`: a record whose supervisor has
died describes a tunnel that no longer exists, and listing it would send a caller to a port
nothing is on. `--prune` only changes whether the human-readable mode mentions it; `pruned`
is always populated in the envelope.

### `mirb stop`

```bash
mirb stop fosk --json
```

```json
{
  "ok": true,
  "data": {
    "stopped": [
      {
        "id": "mb_foskwpi71k9jt",
        "name": "web",
        "target": "example.test",
        "outcome": "stopped"
      }
    ]
  },
  "meta": { "command": "stop", "durationMs": 28 }
}
```

| `outcome` | Meaning |
| --- | --- |
| `stopped` | SIGTERM was enough; the supervisor tore its tunnel down and exited. |
| `killed` | SIGTERM was ignored for 3s, so SIGKILL followed. The record is removed either way. |
| `already-gone` | The process was not alive. Only the record was removed. |

`mirb stop --all` with nothing running is not an error: `stopped` is `[]` and the exit code is
0. Naming a session that does not exist *is* an error — see
[exit codes](./exit-codes.md).

### `mirb logs`

`mirb logs` is the one command where a pipe does **not** switch to JSON. The log is plain
text, one record per line, and `mirb logs web | grep reconnect` wants exactly those bytes.
Only an explicit `--format` — where the caller has said out loud that they want to parse it —
produces an envelope.

```bash
mirb logs fosk --format json --lines 3
```

```json
{
  "ok": true,
  "data": {
    "id": "mb_foskwpi71k9jt",
    "logFile": "/Users/you/.local/state/mirb/logs/mb_foskwpi71k9jt.log",
    "lines": [
      "2026-08-19T08:42:20.863Z mirb: localhost:45241 <- localhost:3000 ready",
      "2026-08-19T08:42:20.864Z mirb: session connecting (1 ready)",
      "2026-08-19T08:42:20.864Z mirb: session ready (1 ready)"
    ]
  },
  "meta": { "command": "logs", "durationMs": 1 }
}
```

`lines` has no trailing empty entry: the file ends in a newline, and `--lines 1` returning
`[""]` would look like an empty log. `--follow` is ignored under `--format`; there is no way
to append to a document that has already been closed.

### Forward objects

`forwards[]` entries are the same shape everywhere they appear — in the envelope, in a
session record on disk, and (minus `status`) in the `session.start` event.

| Field | Type | Notes |
| --- | --- | --- |
| `localPort` | `number` | The port actually bound. Under `--auto-port` this may differ from what you asked for. |
| `bindAddress` | `string` | `127.0.0.1` unless `--bind`/`--expose` said otherwise. |
| `remoteHost` | `string` | Host the remote sshd connects onward to, from *its* point of view. `localhost` for the common case. |
| `remotePort` | `number` | Port on `remoteHost`. |
| `source` | `string` | The argument you typed that produced this forward. Preserved verbatim so `--auto-port` can show what you asked for next to what you got. |
| `status` | `string` | `pending`, `bound`, `ready`, `refused` or `failed`. |
| `detail` | `string?` | Present on `refused` and `failed`. One sentence explaining which. |

The three-state readiness model is the reason `bound` and `ready` are different words:
`bound` means the local socket accepts connections, `ready` means a probe reached the service
at the far end. With `--no-probe`, `ready` is never claimed and forwards stop at `bound`.

## The NDJSON event stream

Emitted by a foreground `mirb up` in machine mode. One JSON object per line, on stdout,
flushed synchronously — a consumer running `mirb example.test 3000 | jq -c` reacts to
`forward.ready` as it happens, which only works if the write actually reaches the pipe.

Background sessions do **not** produce NDJSON. The detached supervisor writes human-readable
text to its log file instead; `mirb --background` gives you an envelope and returns.

Every event carries `event` and `ts`. `ts` is ISO-8601 UTC, stamped by the emitter, so the
order on the wire is the order things happened.

### `session.start`

The tunnel is being attempted. Always the first line of a session, and re-emitted under the
same `id` on every reconnect.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Stable across reconnects. |
| `target` | object | `{host, raw}` plus `user` and `port` when they were given. |
| `forwards` | array | Post-preflight, so these are the ports mirrorball will really use — `localPort` already reflects any `--auto-port` shift, while `source` still shows what you typed. |

```json
{"event":"session.start","ts":"2026-08-19T08:46:09.950Z","id":"mb_7s3wh8qxv3kni","target":{"host":"example.test","raw":"deploy@example.test:2222","user":"deploy","port":2222},"forwards":[{"localPort":45292,"bindAddress":"127.0.0.1","remoteHost":"localhost","remotePort":80,"source":"45291:80"}]}
```

### `forward.bound`

The local socket is accepting connections. Not a claim about the remote service.

| Field | Type | Notes |
| --- | --- | --- |
| `localPort` | `number` | Identifies the forward. Local ports are unique within a session, which is what makes them usable as a key. |

```json
{"event":"forward.bound","ts":"2026-08-19T08:41:46.695Z","localPort":45231}
```

### `forward.ready`

A probe opened a connection through the tunnel and the service at the far end kept it open.
This is the event to wait on before pointing a client at the port. Never emitted under
`--no-probe`.

| Field | Type | Notes |
| --- | --- | --- |
| `localPort` | `number` | Identifies the forward. |

```json
{"event":"forward.ready","ts":"2026-08-19T08:41:47.448Z","localPort":45231}
```

### `forward.error`

One forward is unusable. **Not fatal** — the session stays up and the other forwards keep
working. A session with any of these ends up `degraded` rather than `failed`.

| Field | Type | Notes |
| --- | --- | --- |
| `localPort` | `number` | Identifies the forward. |
| `code` | `string` | A [`MirbErrorCode`](./exit-codes.md#error-codes). In practice `REMOTE_REFUSED` (the probe was refused) or `SSH_CONNECT` (the local port never started accepting). |
| `message` | `string` | The same sentence that lands in `forwards[].detail`. |

```json
{"event":"forward.error","ts":"2026-08-19T08:41:56.411Z","localPort":45232,"code":"REMOTE_REFUSED","message":"nothing is listening on localhost:5432 at the far end"}
```

### `session.ready`

Every forward has been classified. This is not a promise that they all worked — read
`ready` against `total`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | The session. |
| `ready` | `number` | Forwards that are `ready`, plus those that are `bound` when probing is off. |
| `total` | `number` | Forwards in the session. |

`ready: 0` is a legitimate value: the tunnel is up and nothing is listening at the far end.

```json
{"event":"session.ready","ts":"2026-08-19T08:41:47.449Z","id":"mb_l5gggff5pmrz7","ready":1,"total":1}
```

### `session.reconnecting`

ssh exited for a reason worth retrying, and mirrorball is waiting out a backoff before trying
again. Followed by another `session.start` under the same `id`.

| Field | Type | Notes |
| --- | --- | --- |
| `attempt` | `number` | 1-based. |
| `delayMs` | `number` | The wait, exponential with jitter. |

```json
{"event":"session.reconnecting","ts":"2026-08-19T08:42:05.843Z","attempt":1,"delayMs":1062}
```

### `session.exit`

The ssh process is gone. On a retryable failure this is followed by
`session.reconnecting`; otherwise it is the last line.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | The session. |
| `code` | `number` | ssh's exit status when ssh ran, otherwise mirrorball's own exit code for the failure that stopped it from running. `143` is the usual value for a stop, being 128 + SIGTERM. |
| `reason` | `string` | `stopped` for a requested stop, otherwise the classified failure. |

```json
{"event":"session.exit","ts":"2026-08-19T08:41:47.867Z","id":"mb_l5gggff5pmrz7","code":255,"reason":"Timeout, server fake.invalid not responding."}
```

`code` here is ssh's, not mirrorball's. The process exit code is a separate, much smaller
vocabulary — see [exit codes](./exit-codes.md).

### A complete stream

One forward, one reconnect, then Ctrl-C:

```
{"event":"session.start","ts":"2026-08-19T08:42:05.213Z","id":"mb_1ylyydp5on0ad","target":{"host":"example.test","raw":"example.test"},"forwards":[{"localPort":45233,"bindAddress":"127.0.0.1","remoteHost":"localhost","remotePort":80,"source":"45233:80"}]}
{"event":"forward.bound","ts":"2026-08-19T08:42:05.269Z","localPort":45233}
{"event":"forward.error","ts":"2026-08-19T08:42:05.842Z","localPort":45233,"code":"REMOTE_REFUSED","message":"nothing is listening on localhost:80 at the far end"}
{"event":"session.ready","ts":"2026-08-19T08:42:05.842Z","id":"mb_1ylyydp5on0ad","ready":0,"total":1}
{"event":"session.exit","ts":"2026-08-19T08:42:05.843Z","id":"mb_1ylyydp5on0ad","code":255,"reason":"Timeout, server fake.invalid not responding."}
{"event":"session.reconnecting","ts":"2026-08-19T08:42:05.843Z","attempt":1,"delayMs":1062}
{"event":"session.start","ts":"2026-08-19T08:42:06.907Z","id":"mb_1ylyydp5on0ad","target":{"host":"example.test","raw":"example.test"},"forwards":[{"localPort":45233,"bindAddress":"127.0.0.1","remoteHost":"localhost","remotePort":80,"source":"45233:80"}]}
{"event":"forward.bound","ts":"2026-08-19T08:42:06.962Z","localPort":45233}
{"event":"forward.ready","ts":"2026-08-19T08:42:07.713Z","localPort":45233}
{"event":"session.ready","ts":"2026-08-19T08:42:07.713Z","id":"mb_1ylyydp5on0ad","ready":1,"total":1}
{"event":"session.exit","ts":"2026-08-19T08:42:11.057Z","id":"mb_1ylyydp5on0ad","code":143,"reason":"stopped"}
```

### Consuming it

```bash
# React to readiness as it happens.
mirb example.test 3000 --json | jq -c 'select(.event == "forward.ready")'
```

The stream is for watching a session you are keeping alive. If what you actually want is
"wait until the tunnel works, then do something", use `--background`: it does not print
until the forwards are proven, and it exits 0 when they are.

```bash
mirb example.test 5432 --background --json > session.json
psql -h localhost -p 5432 -U postgres
mirb stop "$(jq -r .data.id session.json)"
```

A consumer that stops reading — `| head -1`, a `jq` that exits early — does not crash
mirrorball. The closed pipe (EPIPE) makes the event stream go quiet and the tunnel keeps
working, which is why the process does not die on the one way people casually inspect a
stream.

## Errors

A failure never produces an `ok: false` envelope on stdout. mirrorball writes the error to
**stderr**, in the same two-line form a human gets, and exits with a code that names the
class of failure:

```
mirb: error: could not bind port 3000: already in use
mirb: hint: Something else is listening there. Free it, pick another local port, or pass --auto-port.
```

Stdout stays clean, so a consumer's `JSON.parse` never has to survive a sentence that was
meant for a person. Branch on the exit code, and read stderr for the explanation. The full
mapping is in [exit codes](./exit-codes.md).

The one exception belongs to bunli, not to mirrorball: an option that fails validation
before the handler runs produces a structured error document, also on stderr, and exits 1.

```bash
mirb example.test 3000 --timeout abc
```

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

## The stdout / stderr contract

The rule mirrorball holds to, without exception:

- **When mirrorball is in machine mode, stdout carries machine output and nothing else.** The
  envelope, or the NDJSON stream. No progress, no warnings, no hints, no errors.
- **Everything written for a person goes to stderr.** Progress lines, the exposure warning,
  `error:` and `hint:`.

The invariant that pays for itself is `mirb example.test 3000 > out.txt`: progress still
appears on your terminal, and `out.txt` still parses.

In human mode — a TTY, no `--json`, no `--format` — the *results* of one-shot commands do go
to stdout (the `ls` table, the `stop` lines, raw `logs` output), and so does the live
display, because at that point stdout is a terminal and there is nobody to confuse. Progress
and errors are on stderr either way.

Each NDJSON line is written with a synchronous, looping write, and `JSON.stringify` escapes
any newline inside a message, so a hostile hostname cannot split one event across two lines.
One line is always exactly one record.

## See also

- [CLI reference](./cli.md) — the flags that select each output mode
- [Exit codes](./exit-codes.md) — what mirrorball returns when it fails
- [Environment variables](./environment.md) — `NO_COLOR`, `MIRB_STATE_DIR`, and the rest
