---
title: Bastions and jump hosts
description: The difference between the three-field port spec and -J, when you need each, and the classic "reach the database behind the bastion" case worked end to end.
sidebar_position: 4
---

# Bastions and jump hosts

mirrorball gives you two ways to reach something that is not on the machine you log into,
and they are constantly mistaken for each other:

- the **third field of a port spec** — `mirb bastion 15432:db-01.internal:5432`
- the **jump host flag** — `mirb -J bastion app-01.internal 3000`

They are not alternatives. They answer different questions, they produce different `ssh`
commands, and picking the wrong one produces a confusing failure rather than an obvious one.

The question that separates them is: **where does the tunnel end?**

| | Where the tunnel ends | What the middle host does |
| --- | --- | --- |
| `local:remotehost:remoteport` | On the host you connected to | It terminates the tunnel and dials `remotehost:remoteport` itself |
| `-J` / `--jump` | On the *final* host in the chain | It relays an encrypted connection and reads nothing |

One more way to put it: the third field is about **what the far end connects to**, and `-J`
is about **how you get to the far end**.

---

## The third field: the far end dials for you

```console
$ mirb bastion.example.com 15432:db-01.internal:5432
```

mirrorball turns that into one `-L` and one hop:

```console
$ ssh -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=10 \
    -L 127.0.0.1:15432:db-01.internal:5432 \
    bastion.example.com
```

```
  your machine                  bastion.example.com            db-01.internal
  ─────────────                 ───────────────────            ──────────────
  127.0.0.1:15432  ──── ssh ────▶  sshd  ──── plain TCP ────▶  :5432
```

You have one SSH connection, to the bastion. When something connects to `127.0.0.1:15432`
on your machine, the bastion's sshd opens an ordinary TCP connection to
`db-01.internal:5432` and splices the two together.

Two consequences follow from that, and both explain most of the confusion on this page:

- **`db-01.internal` is resolved by the bastion, not by you.** It can be a name that only
  exists in the remote network, an entry in the bastion's `/etc/hosts`, or an address in a
  VPC your machine has never heard of. You do not need to be able to resolve it, and
  checking whether you can tells you nothing.
- **The last leg is not encrypted by SSH.** From the bastion to the database it is a plain
  TCP connection. That is normally fine — it is inside the network you were trying to reach
  — but it is worth knowing before you tunnel something sensitive to a third host.

`localhost` is the default for that field, so `mirb bastion 15432:5432` means "the bastion's
own port 5432". `localhost` there is the *bastion's* localhost. See
[Port syntax](./port-syntax.md) for the full grammar.

---

## `-J`: get to a host you cannot reach directly

```console
$ mirb -J bastion.example.com app-01.internal 3000
```

```console
$ ssh -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=10 \
    -L 127.0.0.1:3000:localhost:3000 \
    -J bastion.example.com \
    app-01.internal
```

```
  your machine        bastion.example.com        app-01.internal
  ─────────────       ───────────────────        ───────────────
  127.0.0.1:3000  ═══════ encrypted ══════════▶  sshd ──▶ :3000
                    (relays, cannot read it)
```

`-J` is OpenSSH's `ProxyJump`. Your ssh client authenticates to the bastion, asks it to
relay a TCP connection to `app-01.internal:22`, and then runs a *second*, independent SSH
session inside that relay. The bastion carries ciphertext it cannot read, and your keys
never leave your machine — which is why `ProxyJump` is the modern replacement for
`ForwardAgent`, not a variant of it.

The `-L` forward belongs to the inner session, so `localhost` in a port spec now means
**`app-01.internal`'s** localhost. The middle host has dropped out of the picture entirely.

mirrorball passes `--jump` through to ssh verbatim, so ssh's comma syntax for a chain works
unchanged:

```console
$ mirb -J edge.example.com,bastion.internal app-01.internal 3000
```

Each hop is a separate SSH connection with its own configuration. Per-hop users, ports, and
keys belong in `ssh_config` `Host` blocks rather than on the mirrorball command line — see
[SSH configuration](./ssh-configuration.md).

---

## Both at once

They compose, and the combination is common: you log in *through* a bastion to an
application host, and from there you want a database that only that host can see.

```console
$ mirb -J bastion.example.com app-01.internal 15432:db-01.internal:5432
```

```console
$ ssh -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=10 \
    -L 127.0.0.1:15432:db-01.internal:5432 \
    -J bastion.example.com \
    app-01.internal
```

`-J` decides who terminates the tunnel: `app-01.internal`. The third field decides who that
host dials: `db-01.internal:5432`. Read the two flags in that order and the command stops
being ambiguous.

---

## Worked example: the database behind the bastion

The canonical case. Postgres runs on `db-01.internal:5432`. Nothing on your network can
reach it; `bastion.example.com` can.

**1. Start the tunnel.**

```console
$ mirb --background --name pg deploy@bastion.example.com 15432:db-01.internal:5432
  cxkxy5  deploy@bastion.example.com  ready
    ● localhost:15432 ← db-01.internal:5432  ready
  stop it with: mirb stop cxkxy5
```

`ready` is not "ssh started" — mirrorball opened a connection through the tunnel and Postgres
answered it. If the database were down, or the name wrong, this would say `refused` and
tell you the tunnel itself is fine. That distinction is the whole point of the probe; see
[Concepts](../getting-started/concepts.md).

**2. Use it.** The database is now a local port. Every client speaks to `127.0.0.1`:

```console
$ psql -h 127.0.0.1 -p 15432 -U app appdb
$ DATABASE_URL=postgres://app@127.0.0.1:15432/appdb bun run migrate
```

Use `127.0.0.1`, not `localhost`. mirrorball binds loopback IPv4, and `localhost` resolves to
`::1` first on many systems — which is a different address, with nothing listening on it.

**3. Check on it, and stop it.**

```console
$ mirb ls
  ID      NAME  HOST                        FORWARDS      UP      STATUS
  cxkxy5  pg    deploy@bastion.example.com  15432 ← 5432  4m 12s  ● ready

$ mirb stop pg
  cxkxy5  deploy@bastion.example.com  stopped
```

**4. Make it a profile**, once you have typed it twice:

```toml
# ~/.config/mirb/config.toml
[profiles.pg]
host = "deploy@bastion.example.com"
ports = ["15432:db-01.internal:5432"]
name = "pg"
```

```console
$ mirb pg
```

`jump`, `identity`, and `bind` are profile fields too, so a `-J` chain can live in the file
as well. See [Profiles](./profiles.md).

---

## Choosing between them

Work down this list; the first match is your answer.

1. **Can you `ssh` to the host the service runs on?** Then you need neither. `mirb thathost
   3000` is the whole command.
2. **Can you `ssh` to a host that can reach the service over TCP?** Use the third field:
   `mirb thathost 15432:service.internal:5432`. This is the bastion case, and it is the one
   people reach for `-J` for by mistake.
3. **Can you only reach the host you want by going through another SSH server?** Use `-J`
   for the hop, and then treat the final host as in 1 or 2.
4. **Is the hop already in your `ssh_config` as `ProxyJump` or `ProxyCommand`?** Use
   neither flag. mirrorball does not touch your ssh config, so `mirb app-01.internal 3000`
   already goes through it.

Symptoms of the wrong choice:

| Symptom | Likely cause |
| --- | --- |
| `could not resolve hostname`, naming the *service* host | You put an internal name in the target slot instead of the third field |
| Forward reports `refused`, and the service is definitely up | The far end is dialling the wrong host — check whose `localhost` you meant |
| `Permission denied`, naming a host you never meant to log into | You used `-J` where you needed the third field, so ssh is trying to *log in* to the database host |
| `connection timed out` on the target | The target is not directly reachable; you need `-J`, not a third field |

---

## What the far end can refuse

The third field only works if the far sshd is willing to open the channel.

```console
$ mirb bastion.example.com 15432:db-01.internal:5432
```

Two failure shapes, and mirrorball separates them because the fix is different:

- **`refused`** — the tunnel is up and the far end tried, but nothing answered. The
  forward's detail says so in as many words: `nothing is listening on
  db-01.internal:5432 at the far end`. Check the service, or the name you gave it.
- **`the remote host refused to open the forward`**, with the hint `sshd may have
  AllowTcpForwarding disabled, or a policy is blocking it.` — the far sshd said
  `administratively prohibited`. No amount of retrying fixes this; a bastion configured
  with `AllowTcpForwarding no` will never forward anything, and `PermitOpen` may allow
  only specific destinations.

Neither of these takes the session down on its own. A session with a working tunnel and a
refused forward is `degraded`, not `failed`: it keeps serving the forwards that work. See
[Exit codes](../reference/exit-codes.md) for what that means for a script.

---

## Latency: the one caveat that is specific to chains

This is the section for you if your bastion is on another continent.

mirrorball decides `ready` by opening one connection through the tunnel and seeing whether
it stays open. A dead service is detected by the far end hanging up — and that hang-up costs
about **three round trips**. Measured: 0.3–0.85 ms over loopback, 103–105 ms to a host with
a 33 ms RTT. The probe waits **750 ms** by default before calling a still-open socket
`ready`, which covers RTTs up to roughly 250 ms.

A `-J` chain multiplies RTT per hop, so bastion users are the people most likely to run
past that budget — and the direction it fails in is the bad one: a **dead** service briefly
reports `ready`.

There is a backstop. If ssh logs `channel N: open failed` while a probe is in flight and
every forward came back `ready`, at least one of those verdicts is wrong, so mirrorball marks
the session `degraded` and annotates the forwards rather than reporting a confident lie. You
will see it in the forward's detail: `ssh reported a channel failure while probing (…); this
forward may not be reachable`.

For a long chain, raise the settle window instead of relying on the backstop:

```console
$ mirb --probe-settle 2000 -J edge.example.com,bastion.internal app-01.internal 15432:db-01.internal:5432
```

| Flag | Effect |
| --- | --- |
| `--probe-settle <ms>` | How long a connection must stay open before the forward counts as `ready`. Default 750. |
| `--no-probe` | Skip the probe entirely. Forwards report `bound` — the socket is up, and mirrorball claims nothing about the far end. |
| `--timeout <s>` | ssh's `ConnectTimeout`, and the basis for the bind budget: `max(10s, --timeout + 10s)` for every local socket to start accepting. A chain that takes 15 seconds to build needs a bigger number than the default 10. |

`--no-probe` is also the right flag when the far service logs or bills for every connection:
the probe is a real connection, one per forward, every time the session comes up.

---

## Related

- [Port syntax](./port-syntax.md) — the full grammar for the third field, ranges, and IPv6.
- [SSH configuration](./ssh-configuration.md) — `ProxyJump` in `ssh_config`, identities per
  hop, and running the generated ssh command by hand.
- [Background sessions](./background-sessions.md) — keeping a bastion tunnel up all day.
- [Profiles](./profiles.md) — putting a jump chain in a file instead of your shell history.
- [How it works](../explanation/how-it-works.md) — the argv, the probe, and the readiness
  model in full.
