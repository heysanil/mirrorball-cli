---
title: Troubleshooting
description: Every error mirrorball can produce, what actually caused it, and what to do — keyed to the exact message text.
sidebar_position: 7
---

# Troubleshooting

Every failure in mirrorball carries a typed code, a one-line message, and — where there is
something useful to say — a hint. All three go to **stderr**, in every output mode:

```console
$ mirb 10.0.0.7 80
mirb: error: localhost:80 needs root: ports below 1024 are privileged
mirb: hint: Use a local port above 1023, e.g. 8080:80.
$ echo $?
4
```

This page is organised by that message. Search it for the line mirrorball printed.

Two commands to reach for before anything else:

- **`mirb ls`** — what is actually forwarding right now. It reads files and asks no daemon, so
  it keeps working when everything else has gone wrong.
- **`mirb logs <id>`** — the full history of a background session, including the error that
  killed it. A foreground session has already printed everything it knows.

---

## Find your message

| The message says | Exit | Section |
| --- | --- | --- |
| `is already in use` | 4 | [A local port is already taken](#a-local-port-is-already-taken) |
| `needs root: ports below 1024 are privileged` | 4 | [A local port below 1024](#a-local-port-below-1024) |
| `is claimed by both` | 2 | [The same local port asked for twice](#the-same-local-port-asked-for-twice) |
| `no free local port between` | 4 | [Auto-port ran out of ports](#auto-port-ran-out-of-ports) |
| `cannot bind …: EADDRNOTAVAIL` | 2 | [A bind address this machine does not have](#a-bind-address-this-machine-does-not-have) |
| `would publish these forwards beyond this machine` | 2 | [Binding beyond loopback needs --expose](#binding-beyond-loopback-needs---expose) |
| `ssh authentication failed` | 3 | [Permission denied](#permission-denied) |
| `host key verification failed` | 3 | [Host key verification failed](#host-key-verification-failed) |
| `too many authentication failures` | 3 | [Too many authentication failures](#too-many-authentication-failures) |
| `could not resolve hostname` | 3 | [The hostname does not resolve](#the-hostname-does-not-resolve) |
| `connection refused by the remote host` | 3 | [sshd refuses the connection](#sshd-refuses-the-connection) |
| `connection timed out` | 3 | [Nothing answers at all](#nothing-answers-at-all) |
| `timed out … waiting for local port … to accept connections` | 3 | [ssh connected but never bound](#ssh-connected-but-never-bound) |
| `nothing is listening on … at the far end` | — | [A forward says refused](#a-forward-says-refused) |
| — (a forward says `ready`, but nothing works) | — | [A forward says ready but connections hang](#a-forward-says-ready-but-connections-hang) |
| `ssh reported a channel failure while probing` | — | [A forward says ready but connections hang](#a-forward-says-ready-but-connections-hang) |
| `the remote host refused to open the forward` | 5 | [The remote sshd forbids forwarding](#the-remote-sshd-forbids-forwarding) |
| `no ssh binary found on PATH` | 3 | [ssh itself is missing](#ssh-itself-is-missing) |
| `$MIRB_SSH points at …` | 3 | [ssh itself is missing](#ssh-itself-is-missing) |
| `the background supervisor did not report a working tunnel` | 1 | [A background start that never finished](#a-background-start-that-never-finished) |
| `no session matches` / `matches N sessions` | 1 | [Naming a session](#naming-a-session) |
| `session record … is corrupt` | 1 | [A corrupt session record](#a-corrupt-session-record) |
| — (a session that does not work) | — | [A stale session after a reboot](#a-stale-session-after-a-reboot) |
| — (a prompt you cannot answer) | 3 | [Authentication in the background](#authentication-in-the-background) |

---

## Local port problems

These are all raised **before ssh runs**. mirrorball binds every requested local port itself
first, because ssh's own bind failure only arrives after a full authentication round trip, as a
single opaque line. Checking locally turns that into an instant, specific error.

### A local port is already taken

```
mirb: error: localhost:3000 is already in use by node (pid 51843)
mirb: hint: Pass --auto-port to take the next free port, or choose another local port.
```

**Cause.** Something on this machine is already listening there. mirrorball names the holder
when it can — that comes from `lsof`, and is simply omitted when `lsof` is unavailable or
declines to answer.

**Fix.** Whichever fits:

```bash
kill 51843                           # if it is yours and you are done with it
mirb 10.0.0.7 3001:3000              # a different local port, same remote port
mirb 10.0.0.7 3000 --auto-port       # walk upward to the next free port
```

`--auto-port` searches the next 100 ports upward, and the port it settles on appears in the
`session.start` event and in `mirb ls` — so a script reads where it landed instead of guessing.
See [Automation](automation-and-agents.md#query-mirb-ls-with-jq).

A subtlety worth knowing: the check is a real bind attempt, not a scan, so it agrees with the
kernel. It is still about *error quality*, not a lock — a port free at check time can be taken
microseconds later. When that happens ssh's own bind failure catches it and reports
`could not bind port 3000: already in use`, which means the same thing at a later stage.

### A local port below 1024

```
mirb: error: localhost:80 needs root: ports below 1024 are privileged
mirb: hint: Use a local port above 1023, e.g. 8080:80.
```

**Cause.** Ports below 1024 need elevated privileges to bind, on every platform mirrorball
supports. Nothing to do with ssh or the remote host.

**Fix.** Move the *local* side up and leave the remote side alone. This is what the `8080:80`
form is for:

```bash
mirb 10.0.0.7 8080:80      # localhost:8080 -> the remote host's port 80
mirb 10.0.0.7 8443:443
```

**`--auto-port` deliberately does not rescue this.** Shifting past the privileged range would
hand you port 1024 in place of port 80, which bears no relation to what you asked for. See
[Port syntax](port-syntax.md) for the full grammar.

If you genuinely need a privileged local port, run mirrorball under whatever mechanism you
would use for any other privileged listener. mirrorball does not elevate itself.

### The same local port asked for twice

```
mirb: error: local port 3000 is claimed by both '3000' and '3000:9000'
mirb: hint: Drop one of them, or move it to a free local port.
```

**Cause.** Two arguments in the same command resolve to the same local port. Almost always a
typo, or a range that overlaps a port named separately (`3000-3005 3002:9000`).

**Fix.** Give each forward its own local port. ssh would have reported this only as a generic
bind failure after connecting, which is why mirrorball checks the argument list first.

### Auto-port ran out of ports

```
mirb: error: no free local port between 3001 and 3100
mirb: hint: Free some ports, or name a local port explicitly.
```

**Cause.** `--auto-port` walked 100 ports upward from the one you asked for and every one was
taken.

**Fix.** Name a local port explicitly, in a range that is actually free. The search is
deliberately linear and adjacent so that "3000 was taken, here is 3001" stays predictable; a
random high port would succeed more often and help much less.

### A bind address this machine does not have

```
mirb: error: cannot bind 10.199.1.0:3000: EADDRNOTAVAIL
mirb: hint: Check the bind address is one this machine actually has.
```

**Cause.** `--bind` named an address that is not configured on any interface here. A different
mistake from a busy port, so it gets its own message.

**Fix.** Use an address the machine has (`ip addr`, or `ifconfig`), or `0.0.0.0` with
`--expose` for every interface.

### Binding beyond loopback needs `--expose`

```
mirb: error: --bind 0.0.0.0 would publish these forwards beyond this machine
mirb: hint: Anyone who can reach this host on the network could use the tunnel. Pass --expose to confirm.
```

**Cause.** mirrorball binds `127.0.0.1` by default. Any other address makes the forward
reachable from your network — and ssh says nothing about it, because `GatewayPorts` does not
govern an explicit bind address. So mirrorball refuses unless you say so in as many words.

**Fix.** If you meant it:

```bash
mirb 10.0.0.7 8080:80 --bind 0.0.0.0 --expose
mirb 10.0.0.7 8080:80 --expose            # bare --expose implies 0.0.0.0
```

This is an error rather than a confirmation prompt on purpose: mirrorball must behave
identically for a human and for a script, and a prompt that a non-interactive caller cancels
would be read as a graceful success.

---

## ssh cannot connect or authenticate

These messages are mirrorball's classification of ssh's own stderr — which mirrorball reads but
never echoes, in either mode. To see OpenSSH's own words, reproduce the connection by hand; see
[When the message is not enough](#when-the-message-is-not-enough).

### Permission denied

```
mirb: error: ssh authentication failed
mirb: hint: Check your key or agent: ssh -v <host>
```

**Cause.** ssh said `Permission denied`. Wrong key, no key offered, wrong username, an account
that is not permitted — or, very commonly, a key whose passphrase could not be entered because
mirrorball was running non-interactively. See
[Authentication in the background](#authentication-in-the-background), which is the case people
hit most.

**Fix.** Start from the hint. `ssh -v <host>` shows exactly which identities were offered and
what the server did with each. If plain `ssh` works and `mirb` does not, the difference is
almost always interactivity, not credentials.

```bash
mirb 10.0.0.7 3000 -i ~/.ssh/id_prod          # offer a specific key
mirb deploy@10.0.0.7 3000                     # a user, if ssh_config does not supply one
```

### Host key verification failed

```
mirb: error: host key verification failed
mirb: hint: Reconcile ~/.ssh/known_hosts, then retry.
```

**Cause.** The host's key does not match what `~/.ssh/known_hosts` records — or the host is
unknown and mirrorball is running without a TTY, so nothing could answer the `yes/no` prompt.

**Fix.** Deal with it in ssh, where the decision belongs. Connect once by hand and accept the
key:

```bash
ssh 10.0.0.7 true      # accept the key interactively, then retry mirb
```

If the key genuinely changed — a rebuilt server, a re-imaged instance — remove the old entry
*after* confirming the change was expected:

```bash
ssh-keygen -R 10.0.0.7
```

**Do not** reach for `-o StrictHostKeyChecking=no`. It disables the check that distinguishes
your server from someone else's. mirrorball will pass it through if you insist
(`mirb 10.0.0.7 3000 -o StrictHostKeyChecking=accept-new`), but it will not choose it for you.

### Too many authentication failures

```
mirb: error: too many authentication failures
mirb: hint: Try -i <key> to offer a single identity.
```

**Cause.** Your agent holds more keys than the server's `MaxAuthTries` allows attempts, so the
connection is dropped before the right one is reached. Nothing is wrong with the key.

**Fix.** Offer exactly one:

```bash
mirb 10.0.0.7 3000 -i ~/.ssh/id_prod -o IdentitiesOnly=yes
```

`IdentitiesOnly=yes` is the half that stops the agent offering everything else first.

### The hostname does not resolve

```
mirb: error: could not resolve hostname
mirb: hint: Check the host name or your DNS.
```

**Cause.** DNS did not answer for that name. Usually a name that only resolves on the VPN, a
typo, or an ssh_config `Host` alias you assumed existed.

**Fix.** Check the VPN and the spelling. Remember that mirrorball deliberately does **not**
validate hostnames: `myserver` may be an ssh_config alias, an `/etc/hosts` entry, or a name a
`ProxyCommand` invents. If `ssh myserver` works, `mirb myserver 3000` works; if it does not, fix
it in ssh first.

### sshd refuses the connection

```
mirb: error: connection refused by the remote host
mirb: hint: Is sshd running and reachable on that port?
```

**Cause.** Something answered at that address and actively refused the TCP connection — usually
sshd is not running, or is listening on a different port.

**Fix.**

```bash
mirb 10.0.0.7 3000 -P 2222      # sshd on a non-default port
```

Note the distinction from [a `refused` forward](#a-forward-says-refused): this is about
reaching **sshd**, not about the service you are forwarding to.

### Nothing answers at all

```
mirb: error: connection timed out
mirb: hint: Check network reachability, or raise --timeout.
```

**Cause.** No answer within ssh's `ConnectTimeout` (10 seconds unless you say otherwise). A
firewall dropping packets, a host that is down, a route that does not exist, a VPN that is not
up.

**Fix.** Confirm reachability first, then raise the budget if the path is simply slow:

```bash
mirb 10.0.0.7 3000 --timeout 30
```

### ssh connected but never bound

```
mirb: error: timed out after 20000ms waiting for local port 3000 to accept connections
mirb: hint: Raise --timeout, or check the remote host permits TCP forwarding.
```

**Cause.** ssh authenticated and stayed alive, but the local listener never started accepting.
The usual reasons are a remote sshd with `AllowTcpForwarding no`, or an authentication step
still waiting on something — a hardware token, a 2FA push — that will never arrive.

The budget is `max(10s, --timeout + 10s)`, separate from the connect timeout on purpose: ssh
binds its listeners *after* authentication, and authentication has no bound.

**Fix.** Raise `--timeout` if the hop is genuinely slow, or check the server's policy:

```bash
ssh 10.0.0.7 'sudo sshd -T | grep -i allowtcpforwarding'
```

---

## The tunnel is up but the service is not

### A forward says refused

```
  ○ localhost:5432 ← db.internal:5432  refused
```

and, in the event stream and in `mirb ls --json`:

```json
{"event":"forward.error","localPort":5432,"code":"REMOTE_REFUSED",
 "message":"nothing is listening on db.internal:5432 at the far end"}
```

**This is not a bug in mirrorball. It is the one thing mirrorball exists to tell you.**

`ssh -L` prints nothing and exits zero when the tunnel is fine and the service at the far end is
dead. Your local port binds, your browser connects, and the connection dies on the far side with
no explanation. Every minute spent debugging your local setup in that state is a minute spent on
the wrong machine.

mirrorball resolves each forward into one of three states, and they mean different things:

| State | What is proven | What is not |
| --- | --- | --- |
| `bound` | The local socket accepts connections. | Whether anything is listening remotely. |
| `ready` | A probe opened a connection *through* the tunnel and it stayed open. | — |
| `refused` | The tunnel works; the far end refused the connection. | Which of the causes below applies. |

So `refused` narrows the problem to the remote host. Go and look there:

```bash
ssh 10.0.0.7 'ss -ltnp | grep 5432'          # is anything listening?
ssh 10.0.0.7 'systemctl status postgresql'
```

The common causes, in order:

1. **The service is not running.** Start it.
2. **The service listens on the remote host's own loopback, and you forwarded to a third host.**
   `mirb 10.0.0.7 5432:db.internal:5432` asks the remote sshd to connect onward to
   `db.internal`; if the database only listens on `db.internal`'s loopback, that connection is
   refused. See [Port syntax](port-syntax.md).
3. **The service is in a container** whose port is not published to the host's network namespace.
4. **A host firewall on the remote side** blocks the sshd → service connection.

A refused forward does not end the session. The session is reported as `degraded`, the other
forwards keep working, and `mirb --background --json` still exits `0` — check `.data.status` if
you need all-or-nothing. And because every reconnect re-probes, a service that comes back moves
from `refused` to `ready` on its own, with nothing for you to restart.

**Turning the probe off.** The probe costs one throwaway TCP connection per forward, which some
services log or bill for. `--no-probe` skips it; forwards then stop at `bound` and are reported
as `bound` rather than `ready`, because that is the strongest honest claim available without it.

**Where the probe can be wrong.** It is a heuristic, and its limits are known:

- A remote service that accepts and then hangs up unprompted — a bare TCP health check, an IP
  allow-list rejecting you — reads as `refused`. Arguably the more useful answer, but not the
  same statement as "nothing is listening".
- On a very slow link, the channel-open failure can take longer than the settle window, and a
  dead service briefly reads as `ready`. That window is 750 ms, which covers round-trip times up
  to roughly 250 ms; raise it with `--probe-settle 1500` on a satellite link or a long `-J`
  chain. When ssh reports a channel failure the probe missed, mirrorball marks the session
  `degraded` and attaches `ssh reported a channel failure while probing (…); this forward may
  not be reachable` rather than a confident lie.

### A forward says ready but connections hang

```
  ● localhost:8080 ← localhost:8080  ready
```

…and then `curl http://127.0.0.1:8080` stalls, or dies the moment it connects.

**Cause.** Almost always **round-trip time**. This is the probe's one dangerous failure
direction, and it is worth understanding rather than working around.

The probe decides by watching a single connection: one closed promptly and silently means the
far end refused it, one still open after the settle window means `ready`. Refusal latency is
about **3× the RTT** to the remote host — measured at 0.3–0.85 ms over loopback, and 103–105 ms
to a host 33 ms away. The window is **750 ms**, so the verdict holds up to roughly 250 ms of
RTT, which is everywhere terrestrial.

Past that — an intercontinental hop, a satellite link, or a long `-J` chain where the cost
compounds per hop — a *dead* service can still be reported `ready`. That is a false positive,
and for a tool whose whole promise is that `ready` means usable it is the error worth guarding
against. The opposite mistake would only be annoying.

There is a backstop. If ssh logged `channel N: open failed` while the probe was running and
every forward nevertheless came back `ready`, at least one of those verdicts is wrong. Rather
than report a confident lie, mirrorball marks the session `degraded` and attaches a detail:

```
ssh reported a channel failure while probing (connect failed: Connection refused);
this forward may not be reachable
```

The channel number is not a port, so mirrorball cannot say *which* forward — hence the hedge. A
`ready` forward carrying that detail should be treated as `refused`, and the
[refused section](#a-forward-says-refused) above applies.

**Fix.** Widen the window to fit the link. Measure first rather than guessing — take the RTT
and allow at least 3× it:

```bash
ping -c 3 far-away.internal
mirb --probe-settle 2000 far-away.internal 8080
mirb --probe-settle 3000 -J bastion.example.com internal.host 5432
```

If you already know the service is up and would rather not pay the startup latency at all,
`--no-probe` skips the question entirely and forwards stop at `bound`.

Two other things read as `ready` when arguably they should not, and are worth ruling out
before blaming the window: a middlebox that completes the TCP handshake on the service's
behalf, and a remote service that accepts the connection and then holds it open without ever
answering. Neither is visible from the local end of a tunnel.

### The remote sshd forbids forwarding

```
mirb: error: the remote host refused to open the forward
mirb: hint: sshd may have AllowTcpForwarding disabled, or a policy is blocking it.
```

**Cause.** The remote sshd answered `administratively prohibited`. It is refusing to open
forwarding channels at all — a policy decision on the server, not a problem with your service.

**Fix.** This one has to be fixed on the server: `AllowTcpForwarding yes` in `sshd_config`, or
whichever `Match` block overrides it for your user. Some managed bastions disable it on purpose.

---

## Authentication in the background

**Symptom.** `mirb --background` fails with `ssh authentication failed`, but the same `ssh`
command works when you type it.

**Cause.** Nobody can answer a prompt in a detached process. So mirrorball passes
`BatchMode=yes` to ssh whenever `--background` is used, and whenever stdin is not a terminal — a
pipeline, a CI job, a subprocess. In batch mode ssh never prompts: an encrypted key with no
agent, a first-time host key, a 2FA challenge all fail immediately, and usually surface as
`ssh authentication failed`.

This is deliberate. A prompt written to a stream nobody is reading is a hang, and a hang is the
most expensive failure a tool can have.

**Fix.** Make the credential available without a prompt, then retry:

```bash
ssh-add ~/.ssh/id_prod       # load the key into your agent, once per login session
ssh 10.0.0.7 true            # accept the host key interactively, once
mirb --background 10.0.0.7 3000
```

For a key with no passphrase and no agent, `-i` is enough:

```bash
mirb --background 10.0.0.7 3000 -i ~/.ssh/id_ci
```

An **interactive foreground** run is different: mirrorball leaves batch mode off and ssh
inherits your terminal, so passphrase prompts, host-key questions and 2FA pushes all work
normally. If you are unsure whether a credential is the problem, run it in the foreground once —
the prompt you get is the answer.

---

## ssh itself is missing

```
mirb: error: no ssh binary found on PATH
mirb: hint: Install OpenSSH, or point mirb at one with MIRB_SSH=/path/to/ssh.
```

**Cause.** mirrorball does not implement SSH; it runs the `ssh` on your `PATH`. There isn't one.

**Fix.** Install OpenSSH, or name a binary:

```bash
MIRB_SSH=/opt/homebrew/bin/ssh mirb 10.0.0.7 3000
mirb 10.0.0.7 3000 --ssh-path /opt/homebrew/bin/ssh
```

The neighbouring message is `$MIRB_SSH points at '/x/ssh', which is not an executable`. Note
that `--ssh-path` and `$MIRB_SSH` resolve through the same check, so this message names
`$MIRB_SSH` even when you used the flag.

---

## Background sessions and state

### A background start that never finished

```
mirb: error: the background supervisor did not report a working tunnel within 28s
mirb: hint: It may still be starting. Check with: mirb ls, or read mirb logs k3n8dq
```

**Cause.** `mirb --background` waits for the detached supervisor to report a usable tunnel
before printing anything. Normally the supervisor fails first, with a real reason, and that
reason is what you see. This message means the parent's own ceiling was reached instead — the
supervisor is wedged rather than failing.

**Fix.** Follow the hint. `mirb ls` shows whether the session eventually came up,
`mirb logs <id>` has the supervisor's own account, and `mirb stop <id>` clears it if it is
stuck.

### A stale session after a reboot

**Symptom.** `mirb ls` lists a session, but nothing is listening on its ports.

**Cause.** Almost always a **recycled pid**. A session record names the supervisor's pid, and
mirrorball treats a record whose pid no longer exists as stale — every `mirb ls` sweeps those,
so an ordinary reboot leaves nothing behind. But if some unrelated process has since been given
that pid, mirrorball cannot tell the difference and keeps the record.

**Fix.** Do **not** run `mirb stop` on it: that would send `SIGTERM` to whatever now owns the
pid. Delete the record instead. Records live under the state directory:

| Platform | Path |
| --- | --- |
| macOS, Linux | `~/.local/state/mirb/sessions/` (`$XDG_STATE_HOME/mirb/sessions/` if set) |
| Windows | `%LOCALAPPDATA%\mirb\State\sessions\` |

```bash
rm ~/.local/state/mirb/sessions/mb_k3n8dq7x2p9wm.json
```

`$MIRB_STATE_DIR` replaces that root wholesale; see
[Environment variables](../reference/environment.md).

To confirm before deleting anything, compare the pid in the record with what is really running:

```bash
mirb ls --json | jq -r '.data.sessions[] | "\(.id) \(.pid)"'
ps -p 51843 -o pid,command
```

A genuine mirrorball supervisor's command line contains `__supervise`.

### A corrupt session record

```
mirb: error: session record /home/you/.local/state/mirb/sessions/mb_x.json is corrupt
mirb: hint: Remove it, or run `mirb ls --prune` to clean up stale records.
```

**Cause.** A record that no longer parses. Records are written atomically — a temp file plus a
rename — so this is debris from a crash mid-write or from an older build, never from normal
operation.

**Fix.** `mirb ls --prune` sweeps unparseable files and reports what it removed:

```console
$ mirb ls --prune
  cleaned up 2 stale records
  no background sessions
  start one with: mirb --background <host> <port>
```

Plain `mirb ls` already prunes; `--prune` only adds the report. And `mirb ls` never fails on a
bad file — it skips it — precisely because it is the command people run when the state directory
is in a bad way.

### Naming a session

```
mirb: error: no session matches 'web'
mirb: hint: Known sessions: k3n8dq (api) -> 10.0.0.7; p2m4xr (db) -> 10.0.0.9
```

**Cause.** The argument matched no id prefix, no `--name`, and no host.

**Fix.** Use one of the candidates the hint lists. A session can be named by id prefix (like a
short git hash), by the `--name` you gave it, or by host.

The neighbouring message is `'k3' matches 2 sessions`. mirrorball refuses to guess which one to
stop and lists the candidates instead — add a character or two. Naming a **host** is different:
it is a deliberate statement about which host, so every session to that host is acted on.

The third is `there are no background sessions`. Note that a **foreground** session is not
listed and cannot be addressed this way; it is stopped with `Ctrl-C`.

`mirb stop` and `mirb logs` each take **one** session, and reject more rather than silently
acting on the first:

```
mirb: error: expected one session, got 2: k3n8dq p2m4xr
mirb: hint: Stop them one at a time, or use --all.
```


---

## When the message is not enough

If the failure is one mirrorball did not recognise, it prints ssh's own last word rather than
inventing an explanation. To go further:

```bash
# What did mirrorball actually run?
mirb ls --json | jq -r '.data.sessions[0].sshArgv | @sh'

# What a background session did, in mirrorball's own words.
mirb logs k3n8dq --lines 200
mirb logs k3n8dq --follow

# Reproduce by hand, with ssh's own diagnostics.
ssh -v -N -L 3000:localhost:3000 10.0.0.7
```

**`mirb logs` is not ssh's log.** It holds the supervisor's timestamped `mirb:` lines — the same
stream you would have watched in the foreground. ssh's stderr is kept in a 64 KiB in-memory tail
and reaches the log only after classification, as the `error:`/`hint:` pair, so raw OpenSSH text
is gone once the process exits.

That also means **raising ssh's verbosity through mirrorball shows you nothing**:
`-o LogLevel=DEBUG2` or `-o LogLevel=DEBUG3` is passed to ssh faithfully, but mirrorball never
echoes ssh's stderr, and `classifySshStderr` explicitly discards lines beginning with `debug`.
When you need ssh's own diagnostics, run the `sshArgv` by hand with `-v` — which is what the
command above does.

`sshArgv` is the exact argument vector mirrorball handed to ssh, so that reproduction is
faithful without guesswork. Anything you pass with `-o` goes straight through — see
[How it works](../explanation/how-it-works.md) for the options mirrorball sets itself, and
[Design decisions](../explanation/design-decisions.md#-o-exitonforwardfailureyes-is-mandatory)
for why `ExitOnForwardFailure=yes` is not negotiable.

---

## See also

- [Exit codes](../reference/exit-codes.md) — the complete code-to-meaning mapping.
- [Automation and agents](automation-and-agents.md) — detecting all of this from a script.
- [Background sessions](background-sessions.md) — `ls`, `stop`, `logs` in full.
- [Port syntax](port-syntax.md) — the argument grammar, including ranges and third-host forwards.
- [How it works](../explanation/how-it-works.md) — what mirrorball asks ssh to do, and how readiness is decided.
