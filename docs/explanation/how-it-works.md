---
title: How it works
description: The ssh command mirrorball builds, why every flag is there, and how it decides a tunnel is actually up.
sidebar_position: 1
---

# How it works

mirrorball (`mirb`) is three things: an argv builder, a process supervisor, and a probe. It
does not implement SSH — it runs the `ssh` on your `PATH` and watches what happens.
Everything in your `ssh_config` therefore applies, unchanged, because it is the same client
you would have run by hand.

What mirrorball adds is the part `ssh -L` leaves out: an answer to *is the tunnel actually
carrying anything*.

Vocabulary used below — target, forward, session, and the readiness states — is defined in
[Concepts](../getting-started/concepts.md).

---

## From arguments to a running tunnel

Take the canonical invocation:

```console
$ mirb 10.0.0.7 3000 3010 8080
```

Five things happen before a single packet leaves the machine.

1. **argv normalization.** mirrorball has no root command, so `mirb.ts` injects the implied
   subcommand: anything whose first argument is not a known command becomes `mirb up …`.
   Only the first slot is consulted, which keeps the rule unambiguous — `mirb up ls 3000`
   targets a host literally named `ls`.
2. **Target parsing.** `10.0.0.7` becomes a `Target`. mirrorball deliberately does *not*
   validate that a host exists or resolves; `myserver` may be an `ssh_config` alias, a
   `/etc/hosts` entry, a name a `ProxyCommand` invents, or a CNAME that only resolves on the
   VPN. Resolving it is ssh's job. mirrorball rejects only what could not survive the trip
   to ssh — empty parts, embedded whitespace, ports outside 1–65535.
3. **Profile lookup.** If the first argument names a profile in `config.toml`, the profile
   wins over a host of the same name. See [Profiles](../guides/profiles.md).
4. **Port spec parsing.** `3000`, `8080:80`, `8080:db.internal:5432`, `3000-3005` and
   paired ranges expand into a list of `Forward`s. Duplicate local ports are rejected here,
   at parse time, rather than later as an opaque bind failure. See
   [Port syntax](../guides/port-syntax.md).
5. **Local port pre-flight.** mirrorball tries to bind each local port itself before
   spawning ssh. This is about error quality, not safety — see
   [below](#the-pre-flight-bind-check).

Only then is the argv assembled.

---

## The ssh command mirrorball builds

For the invocation above, with no identity, jump host, or extra options:

```console
$ ssh -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=10 \
    -L 127.0.0.1:3000:localhost:3000 \
    -L 127.0.0.1:3010:localhost:3010 \
    -L 127.0.0.1:8080:localhost:8080 \
    10.0.0.7
```

`ConnectTimeout` carries whatever `--timeout` resolved to, in seconds; everything else above
is fixed. `mirb ls` records the exact argv for every session, and `mirb logs` will show it
back to you. There is no hidden step: that command, run by hand, does the same thing.

### Why each flag is there

**`-N` — do not execute a remote command.** mirrorball is a forwarder, never a shell.
Without `-N`, ssh starts a login shell on the far end, which prints the MOTD into the stream
mirrorball is reading and ties the tunnel's lifetime to a shell that a server-side idle
timeout is free to kill.

**`-T` — do not allocate a pty.** A pty would put your terminal into a mode ssh controls,
which changes how `Ctrl-C` is delivered and can leave the terminal in a strange state if
mirrorball is killed abruptly. It would also expose the connection to remote tty idle
timeouts. `-N` already makes a pty unlikely; `-T` makes it impossible.

**`-o ExitOnForwardFailure=yes` — a failed forward is a failed session.** This is the
single most important flag mirrorball sets, and it has [its own entry in Design
decisions](design-decisions.md#-o-exitonforwardfailureyes-is-mandatory). OpenSSH's default
is `no`, which means a `-L` that cannot be set up produces a warning on stderr and *nothing
else*: ssh keeps running, the session looks healthy, and the exit status is `0`. With three
forwards and one taken port, you get two working tunnels, one that refuses connections, and
no indication which layer is at fault.

**`-o ServerAliveInterval=15` and `-o ServerAliveCountMax=3` — notice when the link dies.**
`ServerAliveInterval` defaults to `0`, meaning *disabled*. Left at the default, a tunnel
whose network path has quietly gone away — a NAT table that expired, a laptop that slept, a
Wi-Fi handoff — stays "up" forever: the TCP socket is still open, writes just never arrive
anywhere, and nothing ever exits. These two options make ssh send an encrypted keepalive
through the connection every 15 seconds and tear the session down after 3 unanswered ones,
so a dead link surfaces as a process exit in about 45 seconds. That exit is what mirrorball
reconnects on. (This is not `TCPKeepAlive`, which operates at the TCP layer, is spoofable
by a middlebox, and defaults to a two-hour idle timer.)

**`-o ConnectTimeout=<seconds>` — bound the initial connect.** Carries the value of
`--timeout`. A host that black-holes packets otherwise leaves ssh in `connect()` for the
operating system's default, which is around two minutes. This caps only the TCP connect for
the SSH connection itself; it does not bound authentication. mirrorball clamps the value to
a positive integer because ssh rejects fractional and zero values outright.

**`-o BatchMode=yes`, conditionally — only when nobody can answer a prompt.** Added when the
session is backgrounded or when stdin is not a TTY; omitted otherwise. BatchMode disables
every interactive prompt: key passphrase, password, keyboard-interactive (which is how most
2FA arrives), and host-key confirmation. In a detached supervisor those prompts go to a log
file nobody is reading and ssh waits forever — the session never fails, so nothing retries
and nothing reports. In an interactive foreground run they are exactly what you want. See
[Design decisions](design-decisions.md#batchmode-is-conditional-not-always-on).

**`-L <bind>:<lport>:<rhost>:<rport>` — one per forward, always with an explicit bind
address.** Two reasons the bind address is never omitted. First, privacy: the default is
`127.0.0.1`, so a forward is not reachable from your network unless you ask for that with
`--bind`. Second, and less obvious: when you write plain `ssh -L 3000:localhost:3000`, ssh
resolves the *implied* listen address to every loopback address the machine has and binds a
socket for each — typically `127.0.0.1` and `::1`. If only one of those binds fails, ssh
considers the forward established, so `ExitOnForwardFailure` never fires and you get a
tunnel that is live on `::1` while `127.0.0.1` belongs to somebody else. An explicit bind
address resolves to exactly one socket, which is what makes `ExitOnForwardFailure` an exact
signal rather than an approximate one.

**`-p`, `-i`, `-J` — only when you asked for them.** The port travels as `-p` rather than in
the destination, because `user@host:2222` on ssh's command line is read as a *hostname*
containing a colon and fails to resolve; the colon-port form is a mirrorball/scp convention,
not an ssh one.

### Option ordering, and who wins

ssh uses the **first** value it obtains for any given keyword. mirrorball's own `-o` options
are therefore emitted before yours, and your pass-through `-o` options come last:

```
[mirrorball's options] [-L …] [-p/-i/-J] [your -o options] destination
```

The effect is a deliberate three-level precedence. mirrorball's mandatory options beat
yours; yours beat everything in `ssh_config`; `ssh_config` beats OpenSSH's defaults. You can
set anything mirrorball does not set, and override anything your config sets — but you
cannot turn off `ExitOnForwardFailure`, because a user who silently disabled it would get
back exactly the half-working tunnel mirrorball exists to prevent.

The argument order overall is fixed and snapshot-tested. ssh does not care about it; a
stable order makes `mirb logs` diffable and turns an accidental reordering into a failing
test rather than a mystery in the field.

### What mirrorball does *not* pass

**No `-v`.** mirrorball never asks ssh for debug output, because it never reads debug
output. The one stderr line it does depend on is printed at default verbosity. (You can
still add `-o LogLevel=DEBUG` yourself; it ends up in the session log.)

**No `-f`.** ssh's own backgrounding forks and the original process exits, which would leave
mirrorball holding a pid that is already gone — nothing to supervise, no exit to react to,
nothing to signal on `mirb stop`. mirrorball backgrounds *itself* instead and keeps ssh as a
foreground child of the supervisor.

**Nothing that weakens host key checking.** No `StrictHostKeyChecking`, no
`UserKnownHostsFile`, no `-o` that would make an unknown host connect anyway. If a host key
is unrecognised, that is a decision for you to make once, with `ssh` itself.

### stdio

Deliberately asymmetric:

| Stream | Foreground | Background / batch |
|---|---|---|
| stdin | inherited, so ssh can prompt for a passphrase, a 2FA code, or a host key | closed — nothing could answer |
| stdout | ignored; `-N` produces none | ignored |
| stderr | piped | piped |

stderr is piped in both cases because it is the only account mirrorball will ever get of
*why* something failed. Only the last 64 KiB is retained, which is more than enough for a
classification and stops a `LogLevel=DEBUG3` session from growing an unbounded string inside
a supervisor that may run for weeks.

---

## The pre-flight bind check

Before ssh is spawned at all, mirrorball tries to bind each local port itself, and asks
`lsof` who holds it if the bind fails.

This exists purely for error quality. ssh's own bind failure is one opaque line that
arrives *after* authentication, so you pay for a full round trip and possibly a 2FA prompt
before learning that port 3000 was taken by a dev server you forgot about. Checking first
turns that into an instant error that can name the process.

It is not a safety mechanism: a port that is free during the check can be taken microseconds
later. `ExitOnForwardFailure` remains the real backstop, and the stderr classifier handles
the window between the two. `lsof` is best-effort in every direction — missing, refusing,
hanging, or printing something unrecognised all produce "no holder known" rather than a
failure, because it only ever decorates an error mirrorball was already going to raise.

---

## The three-state readiness model

This is the part that makes mirrorball worth having.

| State | Meaning | How mirrorball knows |
|---|---|---|
| `pending` | not attempted yet | — |
| `bound` | the local socket accepts connections | a TCP connect to the local port succeeded |
| `ready` | a probe connection reached the remote service | the probe connection sent data, or stayed open past the settle window |
| `refused` | the tunnel is fine; the remote service is not listening | the probe connection was closed without sending anything |
| `failed` | the forward could not be established at all | ssh exited, and its stderr said why |

The distinction that matters is **`bound` vs `ready`**. `ssh -L` only ever tells you the
first one, and the first one is nearly worthless on its own: the local listener exists
whether or not anything is alive on the far end. That is why "the tunnel is up but curl
hangs" is such a common and such an annoying experience — both halves of that sentence are
true, and neither tool involved will say which layer is at fault.

### Why readiness is a connect, and not ssh's debug output

The only signal mirrorball uses to move a forward from `pending` to `bound` is a TCP connect
to the local port. ssh's debug output is never consulted for this. The reasons are laid out
in [Design
decisions](design-decisions.md#readiness-is-a-tcp-connect-never-parsed-from-ssh--v), but the
short version is that the text varies by OpenSSH version and by locale, while a TCP connect
behaves identically everywhere, and the fact the debug line reports ("a listener is about to
be attempted") is precisely the fact that tells you least — OpenSSH logs it before the
`bind()` call, not after.

This is a claim about ssh's *debug text* only. ssh's **exit status** is not text: it does
not drift between releases or locales, and mirrorball relies on it heavily — an exit is what
produces `failed`, and `classifySshStderr` only ever runs on one.

But the exit status cannot answer this question, for a structural reason. mirrorball does
not pass `-f`, because a supervisor needs a live child to wait on and signal. So ssh only
exits when something goes *wrong*: with `ExitOnForwardFailure=yes` a failed bind exits 255
immediately, while a fully successful bind produces no event at all — ssh simply keeps
running and `proc.exited` never resolves. **The exit status is a failure signal that has no
success counterpart.** The only positive evidence the process itself offers is "still alive
after N milliseconds", which is a race by construction. That is why the connect is
load-bearing here rather than redundant: it is the only signal that says yes.

### Why a connect cannot establish more than `bound`

It is tempting to assume that if the remote service is dead, the local connect will fail.
It will not. ssh accepts your connection on the local socket *first*, and only then asks the
server to open a channel to `remoteHost:remotePort`. If the server refuses, your local
socket is closed cleanly — you observe connect-then-EOF, which is indistinguishable at the
socket layer from a service that accepted you and had nothing to say.

Concretely, against a tunnel whose remote end refuses everything:

```console
$ nc -vz 127.0.0.1 45921
Connection to 127.0.0.1 port 45921 [tcp/*] succeeded!
$ echo $?
0
```

`nc` reports success and exits `0`. There is no errno on the local socket that means "the
remote refused", which is why mirrorball cannot classify refusal from the connection itself
and has to look elsewhere.

### What the probe does

The probe is the second step, and it is the only way to learn anything about the far end.
`probeRemote` in `core/probe.ts` opens exactly one connection per forward and reads the
verdict off that socket's behaviour — it does not parse ssh's stderr at all:

1. Connect to the local port. (`waitForBind` has already established `bound`; the probe
   takes that as given.)
2. Inbound bytes settle it immediately and positively as `ready` — an SSH, SMTP, Postgres or
   Redis banner arrives before anything else can happen.
3. Otherwise the connection has to *survive*. Still open after `settleMs` (default 750 ms)
   ⇒ `ready`. Closed or reset before that ⇒ `refused`. A hard ceiling of `timeoutMs`
   (default 3 s) also yields `refused`.

So `refused` is inferred from a close, not read from a message. ssh does log
`channel N: open failed: <reason>: <server message>` when the far sshd rejects the channel,
and `classifySshStderr` matches on the `<reason>` token — but that path runs when the session
*exits*, to explain a failure after the fact. See
[How failures are classified](#how-failures-are-classified) for what it matches and why.

Probing is gated by `SessionOptions.probe`; with it off, every forward stops at `bound` —
which is exactly what `ssh -L` alone would have given you.

The mechanism is worth stating plainly: **the probe is not observing remote state, it is
what makes remote state observable.** The far sshd only attempts `connect()` to your service
*because* something connected to the local port; until then there is nothing to succeed or
fail. No amount of patience will make `ssh -L` reveal it at startup. Refusal is a
lazily-evaluated fact, and the probe is the connection that forces the evaluation.

### What the probe cannot tell you

Be clear-eyed about this. The probe answers exactly one question — "did something accept a
connection at the other end of this tunnel" — and it does so imperfectly.

- **A service that accepts and then immediately closes looks healthy.** A proxy with no
  backend, a server that hangs up on unrecognised input, a container mid-restart with the
  port already bound: all of these report `ready`.
- **A firewall that DROPs looks healthy.** The remote sshd's own `connect()` is still in
  progress when `settleMs` expires, so the socket is still open and mirrorball calls it
  `ready`. Your first real request then hangs.
- **`ready` says nothing about the protocol.** A socket that stays open is a socket that
  stays open. If you asked for `8080:5432` and got a Postgres server where you expected
  HTTP, mirrorball will happily call it `ready`.
- **The probe is a real connection to your service.** Something in your logs will show a
  connection from the ssh host that no human made, and a service that rate-limits or
  charges per connection will count it. This is unavoidable: see the previous section on
  laziness. `--no-probe` is the way out.
- **On a slow enough hop, `ready` can arrive before the truth does.** A refusal takes
  roughly three round trips to come back — ssh's own overhead is sub-millisecond, so the
  latency is set almost entirely by the link. Once 3×RTT exceeds `settleMs`, the probe
  reports `ready` and the refusal lands a moment later; `-J` compounds this per hop. Note
  the direction of the error: the failure mode is a **dead service reported as healthy**,
  never a healthy one reported as dead. `settleMs` is the tunable that sets where the line
  falls, trading startup latency on every healthy forward against accuracy on a slow link.

None of these make the probe less useful than not having one. They make `ready` mean "the
far end accepted a connection", not "your service works" — and the docs should say so
rather than let the green checkmark imply more than it knows.

---

## How failures are classified

Two distinct sources, because ssh treats them differently:

- **Connection failures make ssh exit**, always with status **255**. DNS failure,
  unroutable host, no sshd on the port, authentication failure, a malformed `-L` — all of
  them exit.
- **Forward failures often do not.** Depending on the option set and how many address
  families were involved, ssh may log a line and keep running with a partial tunnel. This
  is exactly what `ExitOnForwardFailure=yes` and an explicit bind address exist to
  eliminate.

`classifySshStderr` maps ssh's own words onto a typed `MirbErrorCode`, which determines the
exit code (see [Exit codes](../reference/exit-codes.md)). The matched phrases are chosen for
stability across OpenSSH releases:

| ssh says | mirrorball reports | Exit |
|---|---|---|
| `Could not resolve hostname …` | `SSH_CONNECT` | 3 |
| `connect to host … Operation timed out` | `SSH_CONNECT` | 3 |
| `connect to host … Connection refused` | `SSH_CONNECT` | 3 |
| `Permission denied (publickey,…)` | `SSH_AUTH` | 3 |
| `Host key verification failed` | `SSH_AUTH` | 3 |
| `Too many authentication failures` | `SSH_AUTH` | 3 |
| `bind …: Address already in use` / `cannot listen to port` | `PORT_IN_USE` | 4 |
| `open failed: administratively prohibited` / `connect failed` | `REMOTE_REFUSED` | 5 |

When nothing matches, you get ssh's own last non-debug line, verbatim, under
`SSH_CONNECT`. Nothing about mirrorball's correctness depends on a match landing — the
classification only changes the wording and the exit code of a failure that has already
happened. That is a very different bet from deriving readiness the same way.

Two details worth knowing when reading raw stderr yourself:

- The parenthesised list in `Permission denied (publickey,password,keyboard-interactive)`
  is the set of methods the **server** offered, not the ones you tried. It is usually the
  fastest route to the actual problem.
- **You cannot count `bind` lines to count failures.** When a listen address resolves to
  several families, OpenSSH logs only the last one at error level and demotes the rest to
  verbose. Two failed sockets can produce one visible line.

Failure strings above were verified against OpenSSH 10.2p1, `connect failed` included:
against an sshd that permits forwarding, a dead remote port produced
`channel N: open failed: connect failed: Connection refused`, and a remote-side hostname that
would not resolve produced the same `connect failed` reason followed by the resolver's own
message. That difference is the point — the reason field is portable, the text after it is
not, and a check that matches the whole line will pass on one platform and fail on another.

---

## Reconnection and backoff

mirrorball does not reconnect ssh. It replaces it.

When the ssh process exits, the supervisor reads the exit status and the captured stderr and
decides between two outcomes:

- **Fatal — do not retry.** Authentication failures, host key mismatches, port conflicts,
  malformed forwarding specs. Retrying a wrong credential achieves nothing and may lock an
  account; retrying a taken port will not free it. The session goes to `failed` and
  mirrorball exits with the classified code.
- **Transient — retry.** The link died, the server went away, the network moved. The
  session goes to `reconnecting`, mirrorball waits, and spawns a *new* ssh process with the
  identical argv.

The wait comes from `backoffDelay`: 1 s for the first attempt, doubling, capped at 30 s,
with ±20 % jitter applied symmetrically. The jitter is there because a fleet of machines
that all lost the same VPN will otherwise reconnect to the same sshd at the same instant,
repeatedly.

`BackoffTracker` resets the attempt counter once a connection has held for 60 seconds.
Without that reset, a session that flaps once an hour would eventually be waiting the full
30 seconds to recover from a blip it could have ridden out instantly.

`--retry` controls the ceiling: omitted means unlimited, `--retry 0` means never reconnect,
and any other number bounds the attempts before the session is marked `failed`.

Every reconnect rebinds every local port, and every forward returns to `pending` and is
probed again. Two consequences follow. A port that something else grabbed while mirrorball
was disconnected will fail the reconnect rather than silently coming back short —
`ExitOnForwardFailure` again. And a remote service that died and came back will move from
`refused` to `ready` on its own, without you restarting anything.

---

## Foreground and background

In the **foreground**, the mirrorball process you started *is* the supervisor. It owns the
ssh child, prints status as forwards move through the readiness states, and exits when you
press `Ctrl-C` — which forwards `SIGINT` to ssh, waits for it, and exits `130`.

In the **background**, mirrorball re-executes itself as a detached `__supervise` process,
which does exactly the same work with its output redirected to a log file and its state
written to a session record. Nothing else changes: same argv builder, same probe, same
backoff. See [Background sessions](../guides/background-sessions.md) for the commands, and
[Architecture](architecture.md#where-state-lives) for where the record and the log end up.
