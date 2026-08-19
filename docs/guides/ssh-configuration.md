---
title: SSH configuration
description: What mirrorball puts on the ssh command line, what it leaves entirely to ssh, and how to debug a tunnel by running that command yourself.
sidebar_position: 5
---

# SSH configuration

mirrorball does not implement SSH. It runs the `ssh` on your `PATH` and watches what happens,
which means your `~/.ssh/config` applies exactly as it would if you had typed the command
yourself. There is no mirrorball-side config file for hosts, no key management, no
known-hosts store, and no parser for `ssh_config` anywhere in the codebase.

That is a deliberate boundary, and it is worth knowing precisely where it sits: mirrorball
owns the *forwarding*, ssh owns the *connection*.

---

## What mirrorball puts on the command line

Every session is one `ssh` process, built in a fixed order:

```console
$ ssh -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=10 \
    [-o BatchMode=yes] \
    -L 127.0.0.1:3000:localhost:3000 \
    [-p 2222] [-i ~/.ssh/id_ed25519] [-J bastion] \
    [your -o options] \
    user@host
```

| Argument | Where it comes from | Notes |
| --- | --- | --- |
| `-N -T` | Always | No remote command, no pty. mirrorball is a forwarder, never a shell. |
| `-o ExitOnForwardFailure=yes` | Always | A failed bind must be a failed session, not a half-working tunnel that exits 0. |
| `-o ServerAliveInterval=15`, `-o ServerAliveCountMax=3` | Always | A dead link surfaces in about 45 seconds instead of hanging. |
| `-o ConnectTimeout=<n>` | `--timeout`, default 10 | Seconds. |
| `-o BatchMode=yes` | `--background`, or a non-TTY stdin | See [below](#batchmode-the-one-thing-mirrorball-decides-for-you). |
| `-L <bind>:<local>:<host>:<port>` | One per forward | The bind address is always explicit. See [Port syntax](port-syntax.md). |
| `-p <n>` | `--port`/`-P`, or `host:2222` | Absent unless you asked; otherwise ssh's own default applies. |
| `-i <path>` | `--identity`/`-i`, or a profile's `identity` | Absent unless you asked. |
| `-J <spec>` | `--jump`/`-J`, or a profile's `jump` | Passed through verbatim, commas and all. See [Bastions and jump hosts](bastion-and-jump-hosts.md). |
| `-o <k=v>` | `--ssh-option`/`-o`, repeatable | Yours, appended last. |
| `user@host` | The target | The port is *not* here — it travels as `-p`. |

Anything not in that table, mirrorball does not pass. No `-F`, no `-v`, no `-C`, no `-A`, no
`-4`/`-6`, no `StrictHostKeyChecking`, no `UserKnownHostsFile`.

### The order guarantee

mirrorball's own `-o` options come first and yours are appended after them. ssh uses the
**first** value it obtains for a keyword, so `ExitOnForwardFailure`, `ServerAliveInterval`,
`ServerAliveCountMax`, `ConnectTimeout` and `BatchMode` cannot be overridden from the
command line:

```console
$ ssh -G -o ExitOnForwardFailure=yes -o ExitOnForwardFailure=no example.com | grep -i exitonforward
exitonforwardfailure yes
```

`--ssh-option ExitOnForwardFailure=no` is therefore a no-op, and that is intentional:
without it, one failed bind out of five leaves ssh running with a tunnel that is missing a
forward, and mirrorball's entire promise is that a failed bind is a failed session.

Everything *else* you pass with `-o` still behaves normally — command-line options beat
`ssh_config`, so `-o` remains the way to override your own config for one invocation.

---

## What mirrorball never touches

All of this is handled by ssh itself, from your `ssh_config`, with no involvement from
mirrorball:

| Feature | Still works because |
| --- | --- |
| `Host` aliases and `HostName` | The target string is handed to ssh untouched |
| `Match` blocks (`Match host`, `Match exec`, …) | Evaluated by ssh at connect time |
| `User`, `Port` defaults | mirrorball only passes `-p` / `user@` when you asked for them |
| `IdentityFile`, `IdentitiesOnly`, `AddKeysToAgent` | mirrorball adds `-i` only when you pass one |
| `IdentityAgent`, `ForwardAgent`, `ssh-agent` | mirrorball never sets or clears agent options |
| Hardware keys (FIDO2/`sk-*`, PKCS#11, smartcards) | ssh drives the token directly |
| `ProxyJump`, `ProxyCommand` | mirrorball adds `-J` only when you pass one |
| `known_hosts`, `StrictHostKeyChecking`, `HostKeyAlias` | Entirely ssh's business |
| `Include`, `CanonicalizeHostname`, `SetEnv`, `Compression` | Never referenced |
| GSSAPI / Kerberos, 2FA and keyboard-interactive prompts | ssh prompts on the terminal mirrorball gave it |

So a `Host` block is the cleanest way to make a `mirb` command short:

```
# ~/.ssh/config
Host staging
  HostName app-01.eu-west-1.internal
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_staging
  ProxyJump bastion.example.com
```

```console
$ mirb staging 3000
```

mirrorball passes the single word `staging` to ssh and ssh does the rest — including the jump
host, which is why `--jump` is unnecessary here. It deliberately does not validate that a
target resolves: `staging` may be an alias, a `/etc/hosts` entry, a name a `ProxyCommand`
invents, or a CNAME that only exists on the VPN. It rejects only what could not survive the
trip to ssh — whitespace, an empty user or host, a port outside 1–65535, a `user:password@`
form (ssh has no such concept), or a non-`ssh://` scheme.

### One gotcha: connection multiplexing

mirrorball never sets `ControlMaster`, `ControlPath`, or `ControlPersist`. If *your* config
enables multiplexing, the ssh it starts may attach to an existing master connection rather
than opening its own — in which case the tunnel's life is tied to that master's, not to the
ssh process mirrorball is watching. `mirb ls` will still report the session honestly, because
readiness is measured by connecting to the local port rather than by inspecting ssh.

---

## Identities

`--identity` (`-i`) is passed straight through as ssh's `-i`:

```console
$ mirb -i ~/.ssh/id_deploy deploy@bastion.example.com 15432:db-01.internal:5432
```

ssh expands `~` in `-i` itself, so a quoted path works even when your shell would not have
expanded it — verified against OpenSSH_10.2p1:

```console
$ ssh -G -i '~/.ssh/id_test' example.com
Warning: Identity file /Users/you/.ssh/id_test not accessible: No such file or directory.
```

Two things `-i` does *not* do, both of which are ssh semantics rather than mirrorball's:

- **It does not stop ssh offering your other keys.** `-i` appends an identity; the agent's
  keys are still offered. If you are hitting `too many authentication failures` — which
  mirrorball reports with the hint `Try -i <key> to offer a single identity.` — the complete
  fix is `-i` plus `IdentitiesOnly`:

  ```console
  $ mirb -i ~/.ssh/id_deploy -o IdentitiesOnly=yes bastion.example.com 15432:5432
  ```

- **It does not apply per hop.** Each hop of a `-J` chain is a separate SSH connection with
  its own configuration. Per-hop keys belong in `ssh_config` `Host` blocks.

A profile can carry `identity` so you never type it. See [Profiles](profiles.md).

---

## BatchMode: the one thing mirrorball decides for you

mirrorball adds `-o BatchMode=yes` in two situations:

- `--background`, always.
- Whenever its own **stdin is not a terminal** — a pipeline, a CI job, a systemd unit, an
  agent harness.

In both cases nothing can answer a passphrase prompt, a 2FA challenge, or a host-key
confirmation, and a prompt written to a stream nobody is reading is a hang — the most
expensive way a tool can fail. `BatchMode=yes` turns that hang into an immediate, typed
error. Because mirrorball's `-o` options come first, `--ssh-option BatchMode=no` cannot
switch it back off.

In an interactive foreground session the opposite is true: ssh inherits mirrorball's stdin,
so it can prompt you normally, and passphrases, 2FA codes, and `Are you sure you want to
continue connecting?` all work.

The practical consequence is a habit worth forming — **do the interactive part once, in the
foreground, before you background anything**:

```console
$ ssh-add ~/.ssh/id_deploy          # unlock the key into the agent
$ ssh bastion.example.com true      # accept the host key once
$ mirb --background bastion.example.com 15432:db-01.internal:5432
```

Hardware keys are the same story from a different angle. Touching a FIDO2 token is not
answering a *prompt*, so `BatchMode` does not block it — but somebody still has to be there
to touch it, and if nobody does, the detached supervisor runs out its bind budget
(`max(10s, --timeout + 10s)`) and reports a failed start. Bring the key up in the
foreground, or keep the credential in an agent.

---

## Choosing the ssh binary

The `ssh` that gets run is the first one on `PATH`, unless you say otherwise:

| | |
| --- | --- |
| `--ssh-path <path>` | For one invocation |
| `$MIRB_SSH` | For a shell, a test harness, a systemd unit |

They are the same affordance and resolve through the same check, so a bad path fails
immediately rather than as a confusing spawn error later:

```console
$ mirb --ssh-path /nope/ssh 10.0.0.7 3000
mirb: error: $MIRB_SSH points at '/nope/ssh', which is not an executable
mirb: hint: Unset MIRB_SSH to use the ssh on your PATH.
$ echo $?
3
```

The message names `$MIRB_SSH` in both cases because both go through the same resolver. A
bare name is looked up on `PATH` (so `--ssh-path ssh` and a full path behave the same way),
and the lookup honours the `PATH` mirrorball was given, with no fallback to an ambient one.

The usual reason to set it is a newer OpenSSH than the system's — a Homebrew build, say:

```console
$ MIRB_SSH=/opt/homebrew/bin/ssh mirb bastion.example.com 15432:db-01.internal:5432
```

See [Environment](../reference/environment.md) for every variable mirrorball reads.

---

## Bind addresses are mirrorball's, not ssh's

One forwarding decision mirrorball does *not* delegate: which local address a forward binds.

ssh's `-L` grammar allows an optional leading bind address, which makes `0.0.0.0:8080:80`
and `8080:db:5432` impossible to tell apart without resolving the middle field. mirrorball
refuses that ambiguity — the first field of a port spec is always a port, and the bind
address lives on `--bind`.

It also refuses to publish a forward by accident:

```console
$ mirb --bind 0.0.0.0 10.0.0.7 8080
mirb: error: --bind 0.0.0.0 would publish these forwards beyond this machine
mirb: hint: Anyone who can reach this host on the network could use the tunnel. Pass --expose to confirm.
$ echo $?
2
```

This corrects a belief worth stating plainly, because it is widespread and wrong:
**`GatewayPorts` governs `-L`, not just `-R`** — and an explicit `0.0.0.0` or `*` bypasses
it entirely. Verified against OpenSSH_10.2p1 from a second machine on the LAN:
`-L 0.0.0.0:PORT:…` is reachable from `192.168.x.x` with no `GatewayPorts` setting involved,
while a default `-L PORT:…` is loopback-only. The bind address is the only thing standing
between you and an internal service published to the network, so exposure is an explicit
flag rather than a warning you can miss:

```console
$ mirb --expose 10.0.0.7 8080
```

Bare `--expose` implies `0.0.0.0`; pass `--bind` as well to publish on one interface only.
An exposed session carries a persistent banner while it runs:

```
  mirb ⇄ 10.0.0.7                                      up 5s
  ▲  exposed on 0.0.0.0:8080 — reachable from your network
```

---

## Debugging by running the ssh command yourself

mirrorball keeps the exact argv it handed to ssh, and the fastest way to debug a connection
is to run it yourself with `-vvv`. There is no hidden step and no wrapper: the same command,
typed by hand, does the same thing.

**For a background session**, the argv is in the record:

```console
$ mirb ls --json | jq -r '.data.sessions[0].sshArgv | join(" ")'
-N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -o BatchMode=yes -L 127.0.0.1:15432:db-01.internal:5432 deploy@bastion.example.com
```

`sshArgv` does not include the binary, so prefix it with `ssh` (and drop `BatchMode=yes` if
you want to be prompted):

```console
$ ssh -vvv $(mirb ls --json | jq -r '.data.sessions[0].sshArgv | join(" ")')
```

**For a foreground session**, the live display's footer shows ssh's own pid:

```
   ssh 41234 · reconnects 0 · ^C to stop
```

```console
$ ps -p 41234 -o command=
```

**Why this is the recommended path, rather than turning up ssh's logging through the CLI:**
mirrorball pipes ssh's stderr and keeps only the last 64 KiB of it, in memory, to explain a
failure after the fact. It is never used to decide that a tunnel is up — that is a real TCP
connect to the local port — and it is not written to the session log. So
`--ssh-option LogLevel=DEBUG3` mostly disappears, while the same option on a hand-run ssh
puts everything on your terminal.

A short checklist, in the order that isolates fastest:

1. `ssh -vvv <argv>` — does the connection itself work? If not, it is an ssh problem and
   mirrorball is only the messenger.
2. Leave that ssh running and connect to the local port: `nc -vz 127.0.0.1 15432`. If the
   port refuses, the forward is not being set up. If it accepts and then drops, the far end
   is refusing the channel — see [Bastions and jump hosts](bastion-and-jump-hosts.md).
3. Compare with `mirb <same host> <same ports>` in the foreground. A difference between the
   two is worth a bug report; attach the `sshArgv`.

See [Troubleshooting](troubleshooting.md) for failures grouped by symptom.

---

## Related

- [Bastions and jump hosts](bastion-and-jump-hosts.md) — `-J`, `ProxyJump`, and the third
  field of a port spec.
- [Port syntax](port-syntax.md) — the grammar `-L` specs are built from.
- [Background sessions](background-sessions.md) — where `BatchMode` starts to matter.
- [CLI reference](../reference/cli.md) — every flag, with defaults.
- [Environment](../reference/environment.md) — `MIRB_SSH`, `MIRB_CONFIG`, `MIRB_STATE_DIR`.
- [How it works](../explanation/how-it-works.md) — why each fixed flag is there.
