---
title: Design decisions
description: The non-obvious calls in mirrorball, why each was made, and what it cost.
sidebar_position: 3
---

# Design decisions

Each entry is a decision, the reasoning behind it, and — the part that usually goes unwritten —
what the decision gave up. A trade-off recorded only as its upside is not a trade-off, and it
leaves the next person unable to tell whether the constraint still holds.

For the mechanics these decisions produced, see [How it works](how-it-works.md).

---

## Wrap the system `ssh` rather than implement SSH

**Decision.** mirrorball spawns whatever `ssh` `resolveSshPath` finds and passes it arguments.
It contains no SSH implementation, no key handling, no ssh_config parser, and no crypto.

**Why.** SSH is not a protocol you casually reimplement, and the interesting parts of a real
deployment are all in the long tail: `ProxyJump` and `ProxyCommand`, `Include` directives,
`Match` blocks, agent forwarding, hardware tokens, certificate authorities, `known_hosts`
hashing, GSSAPI, keyboard-interactive 2FA, and per-host `Host` aliases carrying fifteen options.
A library gives you the protocol. It does not give you the user's configuration, and the user's
configuration is the reason `ssh prod` works on their machine.

Wrapping the binary inverts the problem: every one of those features works precisely because
mirrorball is not involved. "If `ssh myhost` works, `mirb myhost 3000` works" becomes a promise
mirrorball can actually keep.

The rule propagates further than it first appears. `core/target.ts` states it outright —
mirrorball does not know what a valid host is and must not pretend to, because `myserver` may be
an ssh_config alias, an `/etc/hosts` entry, a name a `ProxyCommand` invents, or a CNAME that
only resolves on the VPN. So target parsing rejects only what could not survive the trip to ssh
(empty parts, embedded whitespace, ports outside 1–65535) and passes everything else through
untouched. Every place mirrorball is tempted to validate something ssh will validate better, it
declines.

It also collapses the security surface. Key material never enters mirrorball's process. There is
no place where a bug could weaken a cipher choice, mishandle a host key, or leak a passphrase,
because none of those values pass through it.

**What we gave up.** A hard dependency on an external binary, so a missing `ssh` is a real error
(`NO_SSH`) rather than an impossibility. Coarse observability: argv in, exit code and stderr
out, and no access to protocol state in between — which is exactly why readiness had to be
solved by observation rather than introspection. Behavioural variation across OpenSSH versions
and vendor patches. And a process per session, which at the scale of "a developer's handful of
tunnels" is not a real cost.

---

<a id="readiness-is-observed-not-parsed"></a>

## Readiness is a TCP connect, never parsed from `ssh -v`

**Decision.** A forward becomes `bound` when a TCP connect to its local port succeeds. ssh's
debug output is never consulted to determine readiness.

**Why.** The tempting approach is `ssh -v` plus a watch for `Local connections to
127.0.0.1:3000 forwarded to remote address localhost:3000`. It works beautifully on the machine
you developed it on, and it is a trap.

That text is debug output. It carries no compatibility guarantee, it is reworded between OpenSSH
releases, it differs between OpenSSH proper and vendor forks, its verbosity thresholds move, and
it is subject to locale. A readiness check built on it is a string-matching bet against every
ssh build your users have, re-rolled at every upgrade — and when it loses it does not error. It
reports "not ready" for a tunnel that is fine, or "ready" for one that is not. A confidently
wrong answer is worse than no answer.

A TCP connect has none of those properties. It behaves identically on every platform and every
ssh version, and it is the same operation your application is about to perform, which makes it
the most honest possible test.

There is a second reason, and it is the sharper one: **the fact the debug line reports is the
fact that tells you least.** It says a listener exists. A listener exists whether or not anything
is alive on the far end. Parsing it perfectly would buy you a worse signal than connecting.

The counterpart to this decision is that a *bare* connect cannot establish more than `bound` —
ssh accepts locally before it opens the channel, so the connect itself succeeds either way.
`refused` therefore comes from what the probe connection does *next*: closed or reset before the
settle window ⇒ `refused`, bytes received or still open after it ⇒ `ready`. That is still socket
lifecycle, not text.

ssh's `channel N: open failed` line is read too, but only as a guard against the probe's one
dangerous failure direction — on a link where three round trips outlast the settle window, a dead
service reports `ready`. If such a line appears while every forward came back `ready`, at least
one of those verdicts is wrong, and the forwards are annotated (and the session degraded) rather
than left insisting. It is worth being precise about why reading that one line is not a
contradiction: it is emitted at *default* verbosity, it reports a channel-level event rather than
narrating internal state, and its reason strings are a small fixed set. It is much closer to an
interface than debug logging is. It is also only ever used to *downgrade* a verdict the probe
already reached, never to establish readiness on its own — and the channel number is not a port,
so it could not attribute a failure to one forward even if we wanted it to.

`core/errors.ts` states the boundary in the source, at the top of `classifySshStderr`, so nobody
later mistakes the classifier for a detector: stderr explains failures that have already been
detected some other way. Nothing about mirrorball's correctness depends on a phrase matching — a
miss changes the wording and the exit code of a failure, not whether the failure was noticed.

**What we gave up.** Passivity. The probe is a real connection to your service: something in
your logs will show a connection no human made, and a service that rate-limits or bills per
connection will count it. That cost is unavoidable rather than incidental — OpenSSH only emits
`open failed` *because* something connected, so refusal is a lazily-evaluated fact and the probe
is what forces the evaluation. `--no-probe` is the way out, and it leaves you with exactly what
`ssh -L` alone would have given you.

We also gave up precise attribution. A refusal is correlated to a probe by timing, not by
identity, so an unrelated client's failure inside the same window can be misattributed.

---

<a id="exitonforwardfailureyes-is-mandatory"></a>

## `-o ExitOnForwardFailure=yes` is mandatory

**Decision.** Always set, never exposed as a flag, and deliberately not overridable through
`--ssh-option`.

**Why.** ssh's default when a `-L` cannot be established is to complain and carry on. With
several forwards that means:

```
mirb deploy@10.0.0.7 3000 8080 5432     # 3000 is already taken locally
```

produces a live session, two working forwards, one missing forward, and **exit code 0**. Nothing
mirrorball printed would be wrong — the session really is up. You find out when traffic to
`localhost:3000` reaches whatever was already squatting there, which, if that is a different
environment's service on the same port, is how a migration runs against the wrong database.

`ExitOnForwardFailure=yes` makes a failed forward fatal and synchronous: ssh exits non-zero
during startup, before reporting any success. That is what makes the exit code trustworthy
enough to build the rest of the model on. Half a tunnel is not a degraded success; it is a
failure that happens to have working parts.

The non-overridability is implemented rather than merely asserted, and the mechanism is worth
knowing. `buildSshArgs` appends the user's `-o` options **last**, and ssh uses the *first* value
it obtains for any keyword. So mirrorball's own options win over the user's, while the user's
still win over everything in `ssh_config` — which is the ordering you want in both directions. A
user who could silently disable `ExitOnForwardFailure` would get back exactly the half-working
tunnel mirrorball exists to prevent, and every guarantee layered above it (the three-state
model, the exit codes, `degraded` meaning what it says) would quietly become false.

**What we gave up.** The "best effort" workflow, where you ask for five forwards and are happy
with whichever four succeed. Anyone who wants that can run several mirrorball sessions and
decide for themselves which failures matter — which is better anyway, because then the decision
is visible. We also gave up the general principle that a pass-through option is truly
pass-through; this is the one keyword where mirrorball overrules you.

---

<a id="batchmode-is-conditional-not-global"></a>

## BatchMode is conditional, not always on

**Decision.** `BatchMode=yes` is set when the session is backgrounded or when stdin is not a
TTY. In the interactive foreground it is left off.

**Why.** The two contexts have opposite failure modes, and any single setting is wrong in one of
them.

Always-on BatchMode locks out every developer whose key has a passphrase not yet in an agent,
who uses keyboard-interactive 2FA, or who is connecting to a host for the first time and needs
to confirm a fingerprint. mirrorball would fail with "permission denied" against a host `ssh`
connects to without complaint, which makes mirrorball look broken.

Always-off BatchMode is worse in the other direction. In a background session or a CI job there
is nobody to answer a prompt, so ssh writes `Enter passphrase:` to a stream nobody is reading
and blocks — forever. A hang is the most expensive failure a tool can have: indistinguishable
from slow progress, never self-resolving, producing no error to search for, and holding a
pipeline until a human notices. Turning that into an immediate typed failure is worth a great
deal.

So the setting follows the only thing that determines the answer: whether a human could possibly
respond. The stdio disposition in `spawnSsh` follows the same logic and is asymmetric on
purpose — stdin is inherited in the foreground so ssh can prompt, and closed off in batch mode
where nothing could be answered; stdout is ignored because `-N` produces none; stderr is *always*
piped, including in backgrounded sessions, because that is precisely where an unexplained
failure is most expensive.

**What we gave up.** Behaviour that depends on context, which is a real cost — the same command
can succeed in your terminal and fail in a script. We judged that cheaper than the hang, and the
direction is at least intuitive: backgrounding something makes it *stricter* about needing
input, not looser. There is deliberately no flag to force BatchMode off in a non-interactive
context, because the only thing it would buy is the hang.

---

## The background supervisor is this binary, re-executed

**Decision.** `mirb up --background` re-executes mirrorball itself as a detached `__supervise`
process. There is no separate daemon binary, no installed service, and no shared broker.

**Why.** Something must outlive your shell to own the ssh process, notice it die, apply backoff,
respawn, and keep the session record current. The candidates are a separate daemon binary, a
long-running system service, or the same binary in a different mode.

The same binary wins on nearly every axis. One thing to install, one thing to version, and no
possibility of a supervisor from one release talking to a CLI from another — a failure class
that costs far more to debug than it ever costs to prevent. Every module the supervisor needs is
already linked in. The code path is testable by invoking a command, like any other. And it
composes with how mirrorball ships: a single compiled executable, where a second binary would
double a release matrix that already spans five targets.

It is a *supervisor*, not a daemon, and the distinction is deliberate: one process per session,
started by the session, exiting with the session. There is no shared process whose crash takes
down every tunnel at once, nothing to `enable` or `start`, and no broker to garbage-collect.
`mirb ls` reads files; it never talks to a server. That is also what makes the state model
possible — one writer per record, so no locking.

Naming the command `__supervise` keeps it out of help output while leaving it directly runnable,
which makes debugging a background session as simple as running the supervisor in the foreground
and watching.

**What we gave up.** A process per session rather than one for all of them — irrelevant at
mirrorball's scale, and it would matter at a hundred sessions. No cross-session coordination:
two mirrorball instances cannot negotiate a port between themselves, they both check and one
loses. And a hidden command in the surface area, which is a small tax on anyone reading the
source, largely paid down by the naming.

---

## Session state is plain JSON, written atomically

**Decision.** One JSON file per session under the state directory, written to a sibling temp
file and `rename()`d into place, validated with zod on both read and write. No embedded
database, no store library, no lockfile.

**Why.** Look at the actual requirements: a handful of records, a few hundred bytes each, one
writer per record, readers that scan a directory. That is the smallest data problem a program
can have, and two primitives the operating system already provides solve it completely.

`rename(2)` is atomic within a filesystem, so a reader sees the whole old record or the whole
new one and never a torn write. That is not a hypothetical — `mirb ls` racing a supervisor's
status update is routine. And one writer per record means no contention: no lock to acquire, no
lock to leak, and no stale lock left behind by a `SIGKILL`ed process.

Plain JSON also buys properties a database takes away. You can `cat` a record while debugging.
You can `rm` a wedged one. `jq` works. There is no migration step, no binary format a crash can
corrupt into an unreadable state, and no dependency that must build on all five release targets.
When state goes wrong the recovery instruction is "delete this file", which is a support answer
anyone can follow.

Three details fall out of taking the model seriously rather than treating it as a shortcut:

- **Validation runs on the way out, too.** A record that `listSessions()` would skip should never
  reach the disk in the first place; catching it at the write site points at the bug instead of
  at a mysteriously missing session later.
- **The schema is non-strict on purpose.** A record written by a newer mirrorball may carry
  fields this build has never heard of, and refusing to list those sessions would be worse than
  ignoring the extras.
- **There is no `fsync`.** Durability across a power cut is explicitly not a goal: a session
  record that outlives the process it describes is worthless anyway. Atomicity is what matters
  here; durability is not.

Liveness is a separate question from the file's contents, because a `SIGKILL`ed supervisor never
gets to write `stopped`. It is answered with signal 0, and `EPERM` counts as *alive* — a process
owned by another user still exists, and treating that as dead would let mirrorball cheerfully
prune a running supervisor.

**What we gave up.** Queries: `mirb ls` reads every record and filters in memory, fine for tens
and wrong for tens of thousands. Multi-writer safety, which we do not need because ownership is
one supervisor per record. And cross-machine state, deliberately — these records describe local
pids, and syncing them would produce records that confidently describe processes that do not
exist here.

---

## No built-in throughput statistics

**Decision.** mirrorball does not report bytes transferred, connection counts, or per-forward
bandwidth.

**Why.** This gets requested, and it sounds nearly free, so it is worth writing down why it is
not.

mirrorball does not sit in the data path. `ssh` owns the listening socket and moves the bytes;
mirrorball spawned it and watches from outside. To count bytes, mirrorball would have to
*become* a proxy: bind the local port itself, accept your connections, open its own connection
to an ssh forward on some other port, and shuttle bytes between the two.

That is a serious architectural change wearing a feature's clothes. It adds a hop to every
connection on a latency-sensitive path a developer uses interactively. It puts mirrorball's code
between your client and your service, so a mirrorball bug becomes a truncated response or a
broken stream — a data-plane failure rather than a control-plane one, which is a completely
different severity class. It doubles the socket count and takes over the port that `-L` was
going to bind, complicating every error message about port conflicts. And it makes mirrorball
responsible for things ssh already handles correctly: half-close semantics, backpressure, and
teardown.

All of that to produce a number the operating system already has. `ss`, `netstat`, `lsof`,
`nettop`, and your service's own metrics each report traffic on that port without inserting
anything into the path.

The general form of the rule: **mirrorball stays out of the data plane.** Its value is knowing
whether the path works, not carrying what travels over it. The probe is the single deliberate
exception, and it is one connection at startup rather than a permanent position in the path.

**What we gave up.** A genuinely nice display — a live per-forward throughput readout would look
great. And connection counting, which is the more defensible half of the request and could
return one day via `ss`-style inspection of the listening socket rather than by proxying.

---

## Smaller calls

**The pre-flight bind check is about error quality, not safety.** mirrorball tries to bind each
local port itself before spawning ssh, and asks `lsof` who holds it when that fails. ssh's own
bind failure is one opaque line that arrives *after* authentication, so without the check you
pay for a full connection and possibly a 2FA prompt to learn that port 3000 was taken by a dev
server you forgot about. *Gave up:* strictness — a port free during the check can be taken
microseconds later, so this is not a guarantee. `ExitOnForwardFailure` is the real backstop and
the classifier covers the window between them. `lsof` is best-effort in every direction
(missing, refusing, hanging, unrecognised output all yield "no holder known"), because it only
decorates an error mirrorball was already going to raise.

**Forwards bind `127.0.0.1` unless told otherwise, and the bind address is always explicit.**
Binding all interfaces by default would make a tunnel to a production database reachable by
everyone on whatever network you are attached to — failing open, silently, with no symptom that
would prompt you to check. The bind address is also written into every `-L` spec rather than
left to ssh's default, so what mirrorball printed and what ssh bound cannot diverge. *Gave up:*
convenience for container and VM cases where a wider bind is what you want. That is now
something you type, which is the right side of the trade for a default that cannot be
un-exposed after the fact.

**Port 0 is rejected and ranges are capped at 256.** To the kernel, port 0 means "pick any free
port", which would leave mirrorball with nothing honest to print in a ready line. And `mirb host
1-65535` is never a real request — it is a typo or a port scan — so failing immediately with a
countable number beats spawning an ssh with 65,000 arguments and watching the kernel refuse the
1024th bind. *Gave up:* a legitimate very-wide range, which nobody has yet wanted.

**Errors carry a code, and exit codes are part of the API.** Every failure is a `MirbError` with
a `MirbErrorCode`, and each code maps to a stable process exit code. A message is for humans and
should be free to improve; a code is what a script branches on and must not change. Separating
them means every message in mirrorball can be reworded without breaking a caller. *Gave up:*
the freedom to add error cases casually — a new code changes a documented surface. See
[Exit codes](../reference/exit-codes.md).

**Session ids resolve by prefix, and ambiguity is an error.** Full ids exist so they can be
unique, not so they can be typed; `resolveIdPrefix` matches a leading fragment the way git
matches short hashes. When a fragment matches more than one session it throws rather than
choosing, because the commands taking an id are the ones that stop things, and silently killing
the wrong session is not a recoverable mistake. Ids are separately constrained to
`[a-z0-9_]{1,64}` before they ever become a path, because ids arrive from argv as well as from
`newSessionId()`, and there is no legitimate `mirb stop ../../..`. *Gave up:* almost nothing,
beyond occasionally typing one more character.

**`$MIRB_SSH` and `$MIRB_STATE_DIR` exist as seams, not just as features.** Both are genuine
user affordances — a newer OpenSSH from Homebrew, two isolated mirrorball instances on one
machine — and both are what the integration tests use to substitute a fake ssh and a scratch
state directory. Designing the test seam as a documented option rather than as a private hook
means the tested path and the shipped path are the same path. *Gave up:* two more entries in the
environment surface. See [Environment](../reference/environment.md).

---

## Related

- [How it works](how-it-works.md) — the argv, the readiness model, reconnection.
- [Architecture](architecture.md) — the layers, the state machine, state on disk.
