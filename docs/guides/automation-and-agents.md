---
title: Automation and agents
description: Driving mirrorball from scripts, CI and coding agents — the readiness guarantee, reading the event stream, branching on exit codes, and recipes that work.
sidebar_position: 6
---

# Automation and agents

mirrorball (`mirb`) is meant to be driven by programs as often as by people. Four promises make
that workable, and this page is about using them:

1. **Machine output happens without a flag.** Pipe `mirb` anywhere and you get structured data.
2. **stdout carries data and nothing else.** Every human-facing line is on stderr.
3. **Exit codes name the class of failure.** A script can branch without parsing prose.
4. **`--background` does not return until the ports actually work.** No polling, no `sleep 2`.

For the field-by-field shape of everything mirrorball emits, see
[JSON output](../reference/json-output.md). This page is about what to *do* with it.

---

## Machine mode is automatic

mirrorball switches to machine output when **any** of these is true:

| Signal | Typical case |
| --- | --- |
| stdout is not a TTY | `mirb 10.0.0.7 3000 \| jq`, a CI runner, a subprocess |
| `--json` | forcing structured output on a terminal |
| `--format json\|yaml\|md\|toon` | asking for a specific serialization |

That first row is the important one. A tool that only speaks JSON when told to will eventually
be run by a script that forgot, and the script will parse a progress bar. mirrorball inverts the
default: the moment stdout is a pipe, a file, or another process, the human display is gone.

```bash
# Both produce machine output. The flag is redundant in the first.
mirb --json 10.0.0.7 3000 | ./consume.sh
mirb 10.0.0.7 3000 | ./consume.sh
```

### Which shape you get

| You run | You get |
| --- | --- |
| `mirb ls`, `mirb stop`, `mirb --background` | one `{ok, data, meta}` envelope, then exit |
| `mirb logs` | the raw log text — only `--format` turns it into an envelope |
| a **foreground** `mirb up` | an NDJSON event stream, one line per state change, until you stop it |

A foreground session runs for hours, so a report delivered at exit would be useless to
anything waiting for the tunnel. `--format` therefore only selects the serialization of the
*envelope*; a foreground `mirb up` streams NDJSON whatever you pass. A **background** session
produces no NDJSON at all — the detached supervisor writes human-readable text to its log
file, and `mirb --background` hands you an envelope and returns.

### stdout and stderr

Progress lines, warnings, `error:` and `hint:` all go to **stderr**, in every output mode
including the machine ones. stdout carries structured data or nothing.

```bash
mirb 10.0.0.7 3000 > events.ndjson     # events in the file, progress still on your terminal
mirb ls --json 2>/dev/null | jq .      # errors discarded, data intact
```

A failure produces **no envelope**. There is no `ok: false` to test for on stdout — branch on
the exit code and read stderr for the sentence. (The one exception is bunli's own option
validation, which prints a structured error to stderr and exits 1; see
[JSON output](../reference/json-output.md#errors).)

---

## The guarantee `--background` gives you

**`mirb up --background` does not print until the ports are usable.**

This is why the flag exists in this shape. A background start that returned as soon as the
child was spawned would hand a script a session id and a set of ports that are not listening
yet — and the very next thing that script does is connect to them. So the parent blocks until
the detached supervisor reports `ready` or `degraded`, and only then writes its envelope.

By the time your script's next line runs:

- every local port in `forwards[]` is bound and accepting;
- each forward's `status` reflects a real probe (`ready`, or `refused` with a `detail`);
- the supervisor is detached, survives your shell closing, and reconnects on its own.

If the tunnel could not be brought up, mirrorball prints the reason to stderr and exits
non-zero instead. The reason is read back out of the supervisor's own log, so it names the real
cause rather than "the child died".

**A degraded session still exits `0`.** One forward `refused` and the rest `ready` gives you
`"status": "degraded"` and exit `0` — the tunnel works, and discarding the forwards that are
fine would be the wrong call. If you need all-or-nothing, test `.data.status` yourself; the
[strict variant](#bring-a-tunnel-up-use-it-tear-it-down) below shows how.

---

## Reading the event stream

Seven events, each one line of JSON with `event` and `ts`. What they mean to a consumer:

| `event` | What it tells you |
| --- | --- |
| `session.start` | ssh is about to be spawned. Emitted **after** local-port preflight, so `forwards[]` holds the ports mirrorball will really use — including any `--auto-port` shift. |
| `forward.bound` | The local socket accepts connections. Says nothing about the remote service. |
| `forward.ready` | A probe reached the far end. This forward is usable. |
| `forward.error` | That forward is not usable, with a `code` and a `message`. |
| `session.ready` | Startup finished. `ready < total` means the session came up degraded. |
| `session.reconnecting` | ssh died on a retryable failure; a new `session.start` follows after `delayMs`. |
| `session.exit` | This ssh process ended. `code` is ssh's status (`143` for a `SIGTERM` teardown). |

Full field lists are in [JSON output](../reference/json-output.md#the-ndjson-event-stream).
Four rules matter when you are the one consuming it:

1. **`id` is stable across reconnects.** One logical session, many ssh processes. A second
   `session.start` with the same id is a reconnect, not a new tunnel.
2. **Ports do not move on a reconnect.** The ports the first successful attempt took are
   reused for every later one, so a client already pointed at `127.0.0.1:3000` keeps working.
   `--auto-port` only ever shifts a port on the *first* attempt.
3. **`session.ready` is a summary, not a promise that everything works.** Compare `ready`
   against `total`, or track `forward.error`.
4. **Treat `session.exit` and `session.reconnecting` as the authority on liveness.** When ssh
   dies during the startup probe, `session.ready` can land after `session.exit` for that
   attempt — the probe was already in flight. Key off the exit, not off the last line.

Ignore events you do not recognise rather than failing on them; new kinds are additive.

### `| head` will not stop mirrorball

mirrorball survives a closed stdout: a dead pipe stops the writes, it does not take the tunnel
down. So `mirb --json 10.0.0.7 3000 | head -1` prints one line and then waits forever, because
mirrorball is still forwarding. To read events and then move on, redirect to a file and manage
the process yourself — see [the readiness-wait recipe](#foreground-tunnel-with-a-readiness-wait).

---

## Branching on exit codes

| Code | Means | Common causes |
| --- | --- | --- |
| `0` | success | including a `--background` start that came up `degraded` |
| `1` | generic | no session matched; an internal error |
| `2` | usage | bad arguments, unknown profile, bad config, `--bind` without `--expose` |
| `3` | ssh | auth, host key, DNS, timeout, refused sshd, no ssh binary |
| `4` | port conflict | a local port is taken, or is below 1024 |
| `5` | remote refused | the tunnel was fine; the far end refused the channel |
| `130` | interrupted | `SIGINT` — the normal end of a foreground session |

Two of those will bite a script that was not expecting them:

- **`130` is success, in context.** A foreground session stopped with `SIGINT` exits `130`, not
  `0`. Either treat it as success, or start the session with `--background` and end it with
  `mirb stop`.
- **`0` does not mean every forward works.** See [the readiness
  guarantee](#the-guarantee---background-gives-you) above.

The complete mapping, including which `MirbErrorCode` produces which exit, is in
[Exit codes](../reference/exit-codes.md).

---

## Recipes

### Bring a tunnel up, use it, tear it down

The whole pattern. The `trap` is what makes it safe to `set -e` above it.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Returns only once 127.0.0.1:15432 actually forwards to db.internal:5432.
id=$(mirb --background --json --name ci-db 10.0.0.7 15432:db.internal:5432 | jq -r '.data.id')
trap 'mirb stop "$id" >/dev/null' EXIT

psql -h 127.0.0.1 -p 15432 -c 'select 1'
```

Add a strictness check when a partially-working tunnel is not good enough:

```bash
out=$(mirb --background --json --name ci-db 10.0.0.7 15432:db.internal:5432)
id=$(jq -r '.data.id' <<<"$out")
trap 'mirb stop "$id" >/dev/null' EXIT

jq -e '.data.status == "ready"' <<<"$out" >/dev/null || {
  jq -r '.data.forwards[] | select(.status != "ready") | "\(.localPort): \(.status) — \(.detail // "")"' <<<"$out" >&2
  exit 1
}
```

On a degraded session that second form prints the diagnosis and exits 1:

```
15432: refused — nothing is listening on db.internal:5432 at the far end
```

### Foreground tunnel with a readiness wait

Use this when you want the event stream — for a log, or to notice reconnects — rather than a
detached supervisor.

```bash
#!/usr/bin/env bash
set -euo pipefail

events=$(mktemp)
mirb --json 10.0.0.7 3000 >"$events" &
mirb_pid=$!

cleanup() {
  status=$?
  kill -INT "$mirb_pid" 2>/dev/null || true
  wait "$mirb_pid" 2>/dev/null || true
  rm -f "$events"
  exit "$status"
}
trap cleanup EXIT

# Wait for readiness, and give up the moment mirb does.
until grep -q '"event":"session.ready"' "$events"; do
  kill -0 "$mirb_pid" 2>/dev/null || { echo "mirb exited before the tunnel came up" >&2; exit 1; }
  sleep 0.1
done

jq -r 'select(.event == "session.ready") | "ready: \(.ready)/\(.total)"' "$events"
curl -fsS http://127.0.0.1:3000/health
```

The liveness check inside the loop is the part people leave out. Without it, a wrong hostname
turns a two-second script into an infinite one.

### React to events as they arrive

```bash
mirb --json 10.0.0.7 3000 8080:80 | while IFS= read -r line; do
  case $(jq -r .event <<<"$line") in
    forward.ready)        echo "up: $(jq -r .localPort <<<"$line")" ;;
    forward.error)        echo "broken: $(jq -r '"\(.localPort) \(.code) \(.message)"' <<<"$line")" >&2 ;;
    session.reconnecting) echo "link lost, retrying in $(jq -r .delayMs <<<"$line")ms" >&2 ;;
  esac
done
```

```
up: 3000
up: 8080
link lost, retrying in 1177ms
up: 3000
up: 8080
```

### Query `mirb ls` with jq

```bash
# The local port a named session ended up on — it may have moved, under --auto-port.
mirb ls --json | jq -r '.data.sessions[] | select(.name == "ci-db") | .forwards[0].localPort'

# Exit non-zero unless every forward of every session is ready.
mirb ls --json | jq -e '[.data.sessions[].forwards[].status] | length > 0 and all(. == "ready")'

# Everything that is not ready, with the reason.
mirb ls --json | jq -r '
  .data.sessions[] as $s | $s.forwards[]
  | select(.status != "ready")
  | "\($s.name // $s.id) \(.localPort) \(.status) \(.detail // "")"'

# Sessions started more than an hour ago.
mirb ls --json | jq -r --arg cut "$(date -u -v-1H +%FT%TZ 2>/dev/null || date -u -d '1 hour ago' +%FT%TZ)" \
  '.data.sessions[] | select(.startedAt < $cut) | .id'

# What mirrorball actually ran.
mirb ls --json | jq -r '.data.sessions[0].sshArgv | @sh'
```

Absent optional fields are omitted, not `null` — a session with no `--name` has no `name` key
at all. Use `.name // .id` rather than testing for null.

### Clean up everything

```bash
mirb stop --all --json | jq -r '.data.stopped[] | "\(.id) \(.outcome)"'
```

`outcome` is `stopped`, `killed` (SIGTERM was not enough), or `already-gone`. `--all` is safe
to run when nothing is up: it prints an empty array and exits `0`.

### Tail a background session's log

```bash
mirb logs ci-db --lines 200            # raw text, greppable
mirb logs ci-db --follow               # until the session ends
mirb logs ci-db --format json | jq -r '.data.lines[]'
```

---

## Notes for coding agents

- **Discover the surface without guessing.** `mirb --llms` prints a compact Markdown summary of
  every command; `mirb --llms-full` prints the full manifest including every flag. Both are
  cheaper than parsing `--help` five times.
- **mirrorball never prompts in a non-interactive context.** When stdin is not a TTY — or
  whenever `--background` is used — mirrorball forces ssh's `BatchMode=yes`, so a passphrase, a
  first-time host key or a 2FA challenge fails immediately with a classified error instead of
  hanging on a prompt nobody can answer. A hang is the most expensive failure a tool has. It
  also means the key must already be in an agent; see
  [Troubleshooting](./troubleshooting.md#authentication-in-the-background).
- **A refusal is an error, never a prompt.** Binding beyond loopback requires `--expose` and is
  rejected with exit `2` otherwise, rather than asking for confirmation, so mirrorball behaves
  identically for a human and for a program.
- **Prefer `--background` to managing a child process.** The supervisor outlives your session,
  reconnects on its own, and is addressable by id or `--name` from any later invocation. Far
  less state for an agent to hold.
- **Address sessions by id prefix.** `mirb stop k3n8dq` works like a short git hash. An
  ambiguous prefix stops nothing and lists the candidates — mirrorball will not guess which
  session to kill. `stop` and `logs` each take exactly one session, or `--all`.
- **Read `detail`, not just `status`.** A `refused` forward carries a sentence naming the
  remote host and port that was not listening. That is the difference between "the tunnel is
  broken" and "your service is not running".

---

## See also

- [JSON output](../reference/json-output.md) — every field of every envelope and event.
- [Exit codes](../reference/exit-codes.md) — the complete mapping.
- [Troubleshooting](./troubleshooting.md) — every error string mirrorball produces, and what to do.
- [Background sessions](./background-sessions.md) — the `ls`/`stop`/`logs` workflow in full.
- [Environment variables](../reference/environment.md) — `MIRB_STATE_DIR`, `MIRB_CONFIG`, `MIRB_SSH`.
