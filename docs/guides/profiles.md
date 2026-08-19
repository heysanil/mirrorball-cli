---
title: Profiles
description: Name a host and its ports once in config.toml, then invoke it by name — with the resolution order, the override rules, and the escape hatch for a profile named after a subcommand.
sidebar_position: 2
---

# Profiles

A profile is a name for a host plus the ports you always forward from it. Once
`config.toml` has one, this:

```console
$ mirb --identity ~/.ssh/deploy -J bastion.example.com deploy@db.internal:2200 5432:5432
```

becomes this:

```console
$ mirb db
```

Profiles are entirely optional. mirrorball (`mirb`) is fully usable without a config file,
and a missing one is not an error — it resolves to an empty config. A file that *is* on
disk but wrong is a hard failure, because silently ignoring a profile you are trying to use
is far more confusing than refusing to start.

This page is the guide. The exhaustive schema, the full precedence table, and the list of
what a profile *cannot* set live in the
[Configuration reference](../reference/configuration.md).

---

## Where `config.toml` lives

| Platform | Path |
| --- | --- |
| macOS, Linux | `$XDG_CONFIG_HOME/mirb/config.toml`, or `~/.config/mirb/config.toml` when `XDG_CONFIG_HOME` is unset |
| Windows | `%APPDATA%\mirb\config.toml`, or `~\AppData\Roaming\mirb\config.toml` when `APPDATA` is unset |

macOS uses `~/.config/mirb/`, not `~/Library/Application Support/`. That is deliberate:
mirrorball is a terminal tool, and a dotfile under `~/.config` is where people who edit
config by hand expect to find it.

`$MIRB_CONFIG` overrides the whole lookup and names **the file itself**, not a directory:

```console
$ MIRB_CONFIG=./mirb.toml mirb web
```

That exists so a project can carry its own profiles, and so tests can point at a throwaway
config without an XDG dance. See [Environment](../reference/environment.md) for the other
`MIRB_*` variables.

mirrorball never creates the file. Make it yourself:

```console
$ mkdir -p ~/.config/mirb && $EDITOR ~/.config/mirb/config.toml
```

---

## A worked example

```toml
# ~/.config/mirb/config.toml

[profiles.web]
host = "deploy@10.0.0.7"
ports = [3000, "8080:80"]
name = "web tier"

[profiles.db]
host = "deploy@db.internal:2200"
ports = ["5432:5432"]
name = "primary db"
identity = "~/.ssh/deploy_ed25519"
jump = "bastion.example.com"

[profiles.staging]
host = "staging"          # an ssh_config Host alias
ports = ["3000-3005", "9229:9229"]

[profiles.metrics]
host = "monitor"
ports = 9090              # a scalar is fine when there is only one
bind = "127.0.0.1"
```

`mirb db` then builds, and runs, exactly this:

```text
ssh -N -T \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -o ConnectTimeout=10 \
  -L 127.0.0.1:5432:localhost:5432 \
  -p 2200 \
  -i ~/.ssh/deploy_ed25519 \
  -J bastion.example.com \
  deploy@db.internal
```

The `:2200` in `host` becomes `-p 2200` — ssh reads `user@host:2200` on a command line as a
*hostname containing a colon*, so mirrorball splits it. `~` in `identity` is expanded by ssh
itself (verified against OpenSSH 10.2p1), so a literal tilde in the TOML is fine.

---

## Every field

Only `host` and `ports` are required. Any other key is an error — the whole point of
validating config is to catch a typo before it silently becomes "no host at all".

| Key | Type | Required | What it does |
| --- | --- | --- | --- |
| `host` | string | yes | The ssh destination. Anything [`mirb <host>`](../explanation/how-it-works.md) accepts: `host`, `user@host`, `user@host:2222`, `ssh://user@host:2222`, `[2001:db8::1]`, or a bare `ssh_config` alias. |
| `ports` | string, integer, or array of either | yes | One or more [port specs](./port-syntax.md). Integers must be `1`–`65535`. Strings may be any accepted form, including ranges and `LOCAL:HOST:REMOTE`. |
| `name` | string | no | Human label. Shown by `mirb ls`, and accepted as an argument by `mirb stop` and `mirb logs`. It does *not* default to the profile's key. |
| `identity` | string | no | `ssh -i` identity file. |
| `jump` | string | no | `ssh -J` jump host. |
| `bind` | string | no | Local bind address for every forward in the profile. See [exposure](#exposure-is-never-inherited-silently). |

### `ports` in detail

A scalar is lifted into a one-element list, because `ports = 3000` is what people write
when a profile forwards exactly one port and failing that with "expected array" would be
pedantry. All of these are valid:

```toml
ports = 3000
ports = "8080:80"
ports = [3000, "8080:80"]
ports = ["3000-3005", "5432:db.internal:5432", "8443:[::1]:443"]
```

Each element is parsed by the same grammar as a command-line argument, so every rule in
[Port syntax](./port-syntax.md) applies unchanged — including the 256-port range cap and
the rejection of duplicate local ports.

---

## Using a profile

```console
$ mirb web
```

Extra positional ports **append** to the profile's, they do not replace them:

```console
$ mirb web 9229
```

means "the web profile, plus a debugger port". The profile's ports come first in the `-L`
list, then yours, in the order written. A collision between the two is the ordinary
duplicate-port error:

```console
$ mirb web 3000
mirb: error: '3000' is listed twice; local port 3000 can only be bound once
mirb: hint: Drop one of them, or move it to a free local port.
```

Everything else about the session works normally — `--background`, `--json`, `--auto-port`
and the rest all apply to a profile invocation.

---

## How flags override a profile

Flags win, field by field. Nothing is all-or-nothing: overriding `--jump` leaves the
profile's `identity` and `bind` alone.

| Profile key | Flag that overrides it |
| --- | --- |
| `host`'s ssh port | `--port`, `-P` |
| `name` | `--name` |
| `identity` | `--identity`, `-i` |
| `jump` | `--jump`, `-J` |
| `bind` | `--bind` |
| `ports` | *(none — extra positional ports append)* |
| `host` | *(none — a different host is a different profile, or a plain target)* |

A verified run with every override applied at once:

```console
$ mirb --name adhoc -i ~/.ssh/other -J other.example.com -P 2222 --bind 0.0.0.0 --expose db 5433:5432
```

produces `-L 0.0.0.0:5432:localhost:5432 -L 0.0.0.0:5433:localhost:5432 -p 2222
-i ~/.ssh/other -J other.example.com deploy@db.internal`, and the session is labelled
`adhoc` in `mirb ls`.

Note that `--bind` applies to *every* forward in the command, the profile's included —
there is no way to bind one forward differently from another.

### Exposure is never inherited silently

`bind` in a profile does **not** grant permission to publish the forward. The exposure gate
runs on the *resolved* bind address, so a profile that asks for `0.0.0.0` still needs
`--expose` on the command line:

```toml
[profiles.pub]
host = "example.test"
ports = [8080]
bind = "0.0.0.0"
```

```console
$ mirb pub
mirb: error: --bind 0.0.0.0 would publish these forwards beyond this machine
mirb: hint: Anyone who can reach this host on the network could use the tunnel. Pass --expose to confirm.

$ mirb --expose pub          # binds 0.0.0.0
```

This is on purpose. A config file is written once and read by future-you at 2am; the
decision to make an internal service reachable by every machine on the network has to be
made in the invocation, not inherited from a file. See
[`--bind` and `--expose`](./port-syntax.md#--bind-choosing-the-local-address) for what
exposure actually means.

Bare `--expose` with no `--bind` implies `0.0.0.0` — but a profile's `bind` still wins over
that implication, so `--expose` on a profile that pins a loopback address stays on
loopback.

---

## Resolution order

mirrorball has no root command, so `mirb.ts` decides what your first word meant before
bunli ever sees it. The order is **subcommand → profile → target**.

1. **Subcommand.** If the *first* argv token is `up`, `ls`, `stop`, `logs` or
   `__supervise`, that is the command. Only the first slot is consulted, which keeps the
   rule unambiguous and stops an option *value* from being mistaken for a subcommand.
2. **Profile.** Otherwise `up` is injected, and the first positional is looked up in
   `config.toml`. A profile named `prod` wins over a host named `prod` — the profile is the
   thing you configured on purpose. Lookup is exact and **case-sensitive**: a profile
   `[profiles.WEB]` is not found by `mirb web`.
3. **Target.** If no profile matches, the word is handed to the target parser as a host,
   an `ssh_config` alias, or a `user@host:port`. mirrorball does not try to decide whether a
   host "exists" — that is ssh's job, and the reason it can resolve an alias, a
   `/etc/hosts` entry, or a name only your VPN knows.

When step 2 and step 3 both come up empty, the error lists what mirrorball does know about:

```console
$ mirb nope
mirb: error: 'nope' is not a known profile, and no ports were given
mirb: hint: Known profiles: db, metrics, staging, web. Or name a port: mirb nope 3000
```

With no config file at all, the same dead end is reported as the missing thing it actually
is:

```console
$ mirb example.test
mirb: error: no ports given for 'example.test'
mirb: hint: Name at least one port: mirb example.test 3000
```

With no arguments at all there is nothing to inject `up` in front of, so argv goes straight
through to bunli and you get the help text. Name the subcommand and stop there to get the
profile list instead:

```console
$ mirb up
mirb: error: no host given
mirb: hint: Try: mirb <host> <port>, or a profile: db, metrics, staging, web
```

---

## A profile named after a subcommand

Step 1 runs first, so a profile named `ls`, `up`, `stop` or `logs` is shadowed by the
command of that name:

```console
$ mirb ls          # lists background sessions; the profile is not consulted
```

The escape hatch is to type the subcommand yourself. `up` in the first slot means
"everything after this is a target and ports", so the profile becomes reachable again:

```console
$ mirb up ls                 # runs the profile named "ls"
$ mirb up ls 3000            # a host literally named "ls", forwarding 3000
```

**`up` has to be the first argv token for this to work.** Flags go after it:

```console
$ mirb up ls --background --json      # correct
$ mirb --background --json up ls      # WRONG
mirb: error: 'ls' in 'ls' is not a port number
mirb: hint: The first field is always a port. To change the bind address use --bind.
```

In the second form the first token is `--background`, which is not a subcommand, so `up` is
injected in front of the whole line — and the `up` you typed is read as the host, leaving
`ls` in the port slot.

The simplest fix is to not name a profile after a subcommand. There are five reserved
words and an unlimited supply of alternatives.

---

## When the config is wrong

Config errors are `CONFIG` errors and exit **2**, the same as a usage error. Only the first
problem is reported, with a count of the rest: a file with five problems is almost always
one misunderstanding, and five stacked messages read like a stack trace.

```console
$ mirb web
mirb: error: /Users/you/.config/mirb/config.toml: profiles.web.host: expected string, received number (and 1 other problem)
```

Two things make these messages worth reading rather than skimming:

- **The absolute path comes first**, so you can see which config mirrorball actually read.
  That is the fastest way to notice a `$MIRB_CONFIG` you set in a shell three days ago.
- **The key is written the way you would grep for it** — `profiles.web.ports[0]`, not "at
  index 0 of the array in the table". Paste it into your editor's search box.

The schema is strict, so a typo is a named error rather than a setting that silently does
nothing:

```console
$ mirb web
mirb: error: /Users/you/.config/mirb/config.toml: unknown setting 'profiles.web.hsot'
mirb: hint: Valid profile keys: host, ports, name, identity, jump, bind.
```

A table of every config error and its exact text is in the
[Configuration reference](../reference/configuration.md#when-the-file-is-wrong); the
message-keyed index of *all* mirrorball errors is in [Troubleshooting](./troubleshooting.md).

---

## See also

- [Port syntax](./port-syntax.md) — everything valid in a `ports` entry, and what `--bind` does.
- [Configuration reference](../reference/configuration.md) — the complete schema and precedence table.
- [Bastions and jump hosts](./bastion-and-jump-hosts.md) — when a profile wants `jump` and when it wants a three-field port spec.
- [CLI reference](../reference/cli.md) — every flag that can override a profile value.
- [How it works](../explanation/how-it-works.md) — argv normalization, target parsing, and the ssh command.
- [Environment variables](../reference/environment.md) — `MIRB_CONFIG` and the rest.
- [Exit codes](../reference/exit-codes.md) — a bad config exits `2`.
