---
title: Configuration
description: The complete config.toml schema, where the file lives on each platform, and exactly how flags, profile values, and defaults override one another.
sidebar_position: 2
---

# Configuration

`config.toml` holds **named profiles** and nothing else. A profile is a host plus the ports you
always forward from it, so that this:

```bash
mirb deploy@10.0.0.7 3000 8080:80 5432:db.internal:5432
```

becomes this:

```bash
mirb api
```

There are no global settings, no defaults section, and no way to change mirrorball's behaviour from
the file — timeouts, retries, probing, and the rest are flags, and only flags. mirrorball is fully
usable with no config file at all; a missing one is the normal case, not an error.

---

## Where the file lives

| Platform | Path |
|---|---|
| Linux | `$XDG_CONFIG_HOME/mirb/config.toml`, else `~/.config/mirb/config.toml` |
| macOS | `$XDG_CONFIG_HOME/mirb/config.toml`, else `~/.config/mirb/config.toml` |
| Windows | `%APPDATA%\mirb\config.toml`, else `%USERPROFILE%\AppData\Roaming\mirb\config.toml` |

macOS uses the XDG path, **not** `~/Library/Application Support`. That is deliberate: mirrorball is
a terminal tool that sits next to `~/.ssh/config`, and a path you can `cat` without quoting a space
is worth more here than platform orthodoxy.

`$MIRB_CONFIG` overrides all of this. It names the **file**, not a directory:

```bash
MIRB_CONFIG=./mirb.toml mirb api
```

mirrorball creates neither the file nor its directory. Create them yourself:

```bash
mkdir -p ~/.config/mirb && $EDITOR ~/.config/mirb/config.toml
```

Session records and logs live somewhere else entirely — see
[Environment variables](environment.md) for `$MIRB_STATE_DIR` and the state paths.

Only `mirb up` reads the config; `ls`, `stop`, and `logs` never open it. A `config.toml` you have
broken cannot stop you from finding and stopping the sessions you already have running.

---

## Schema

Every profile is a `[profiles.<name>]` table. The `<name>` is what you type as the first argument,
matched exactly — there is no prefix matching and no case folding.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `host` | string, non-empty | **yes** | — | The ssh destination. Any form `mirb <target>` accepts: a host, an `ssh_config` alias, `user@host`, `user@host:port`, `ssh://user@host:port`, or an IPv6 literal. |
| `ports` | string, integer, or array of either | **yes** | — | One or more port specifications, in mirrorball's `-L` subset: `3000`, `"8080:80"`, `"8080:db.internal:5432"`, `"3000-3005"`. At least one entry. |
| `name` | string | no | none | Label shown in `mirb ls` and usable as a `mirb stop` / `mirb logs` argument. Defaults to nothing, *not* to the profile's key. |
| `identity` | string | no | ssh decides | Path to an ssh private key. Becomes `ssh -i`. |
| `jump` | string | no | none | Jump host or chain. Becomes `ssh -J`. |
| `bind` | string | no | `127.0.0.1` | Local address every forward in this profile binds. A non-loopback value still requires `--expose` on the command line. |

Nothing else is accepted. The schema is strict, so a typo is an error naming the exact key rather
than a setting that silently does nothing:

```console
$ mirb api
mirb: error: ~/.config/mirb/config.toml: unknown setting 'profiles.api.bnd'
mirb: hint: Valid profile keys: host, ports, name, identity, jump, bind.
```

### `ports` shorthands

A single port does not need to be an array, and a number does not need to be a string. All four of
these mean the same thing:

```toml
# four spellings of one forward — pick one, they are not four lines of a file
ports = 3000
ports = "3000"
ports = [3000]
ports = ["3000"]
```

Anything with a colon or a dash in it has to be quoted, because TOML would not otherwise parse it:

```toml
ports = ["8080:80", "5432:db.internal:5432", "3000-3005"]
```

The full port grammar — remaps, third-host forwards, ranges, paired ranges, and the reason the
first field is always a port rather than a bind address — is in the
[CLI reference](cli.md#mirb-up).

---

## A complete example

```toml
# ~/.config/mirb/config.toml
#
# Every table here is a profile. The table name is what you type:
#   mirb api

[profiles.api]
# Anything `mirb <target>` accepts. An ssh_config alias is usually the best answer,
# because then ~/.ssh/config keeps owning the user, port, and ProxyCommand.
host = "deploy@10.0.0.7"
# A bare number is the same port on both sides. Quote anything with punctuation.
ports = [3000, "8080:80"]
# Shown in `mirb ls`, and accepted by `mirb stop` / `mirb logs`.
name = "api"

[profiles.db]
# The service is not on the ssh host — it is on db.internal, which only the ssh
# host can reach. The middle field is resolved from the remote side.
host = "bastion-prod"
ports = "5432:db.internal:5432"
identity = "~/.ssh/prod_ed25519"

[profiles.staging]
# Two hops: reach staging through the bastion. Becomes `ssh -J bastion-prod`.
host = "staging.internal"
jump = "bastion-prod"
ports = ["3000-3005", "9229"]

[profiles.demo]
# A profile may ask for a non-loopback bind, but it cannot grant itself the
# permission: `mirb demo` still fails until you type `mirb --expose demo`.
host = "10.0.0.7"
ports = 8080
bind = "0.0.0.0"

[profiles.ipv6]
# IPv6 literals are bracketed in both places they appear.
host = "[2001:db8::1]:2222"
ports = "8080:[::1]:80"
```

Used:

```bash
mirb api                  # 3000 and 8080:80 from deploy@10.0.0.7
mirb db                   # 5432 from db.internal, via bastion-prod
mirb api 9229             # the api profile, plus a debugger port
mirb --background api     # the api profile, detached
mirb stop api             # by the profile's `name`
```

---

## Precedence

For every value a session needs, the first source that has an opinion wins:

| Value | 1. Flag | 2. Profile | 3. Default |
|---|---|---|---|
| ssh destination | — | `host` | the first positional, read as a target |
| ssh port | `--port` / `-P` | the `:port` in `host` | ssh's own (`ssh_config`, else 22) |
| forwards | positionals, **appended** | `ports` | — |
| bind address | `--bind` | `bind` | `0.0.0.0` with `--expose`, else `127.0.0.1` |
| session label | `--name` | `name` | none |
| identity file | `--identity` / `-i` | `identity` | ssh decides |
| jump host | `--jump` / `-J` | `jump` | none |

Four consequences worth having in mind:

**Ports append; they do not replace.** Extra positionals are added to the profile's list, in the
order the profile lists them followed by the order you typed them. `mirb api 9229` is "the api
profile, plus a debugger port" — there is no way to subtract a port a profile declares, and a
local port claimed twice is a usage error naming both specs.

**A profile beats a host of the same name.** The first positional is looked up as a profile first,
because a profile is the thing you configured on purpose. If you have a profile called `prod` and
an unrelated ssh host called `prod`, the profile wins, and the host is unreachable through the bare
form. Rename one of them.

**Only the first positional is a profile name.** Everything after it is a port specification.
`mirb 10.0.0.7 api` does not expand `api`; it fails with "not a port number".

**A profile named `up`, `ls`, `stop`, or `logs` needs the long form.** Those words are claimed by
argv normalization before profile lookup ever happens, so reach the profile with `mirb up ls`. See
[How argv is resolved](cli.md#how-argv-is-resolved).

### What a profile cannot set

These are flags only, with no profile equivalent: `--background`, `--json`, `--auto-port`,
`--expose`, `--ssh-option`, `--retry`, `--no-retry`, `--no-probe`, `--timeout`, `--quiet`,
`--probe-settle`, `--ssh-path`.

`--expose` is on that list on purpose. A profile can *request* a non-loopback `bind`, but the
exposure check runs on the address that finally resolves, so publishing a forward to the network
always takes an explicit flag at the moment you run it:

```console
$ mirb demo
mirb: error: --bind 0.0.0.0 would publish these forwards beyond this machine
mirb: hint: Anyone who can reach this host on the network could use the tunnel. Pass --expose to confirm.
```

---

## When the file is wrong

A missing file is fine and silent. A file that exists but does not parse or does not validate is a
hard failure with exit code 2, because silently ignoring the profile you are trying to use is far
more confusing than refusing to start.

Only the first problem is reported, with a count of the rest. A config with five errors is almost
always one misunderstanding, and five stacked messages read like a stack trace.

| What you wrote | What mirrorball says |
|---|---|
| `[web]` instead of `[profiles.web]` | `unknown setting 'web'` — hint: `Profiles live under [profiles.<name>] — did you mean [profiles.web]?` |
| `bnd = "0.0.0.0"` | `unknown setting 'profiles.web.bnd'` — hint: `Valid profile keys: host, ports, name, identity, jump, bind.` |
| no `host` | `profiles.web.host: expected string, received undefined` |
| `ports = []` | `profiles.web.ports: Too small: expected array to have >=1 items` |
| `ports = [70000]` | `profiles.web.ports[0]: Too big: expected number to be <=65535` |
| `[profiles.web` (unclosed) | `is not valid TOML — line 1: Expected t_close_bracket but found host` |

Every message is prefixed with the absolute path of the file it read, so an unexpected
`$MIRB_CONFIG` or an XDG override shows itself immediately.

A name that is neither a profile nor a target with ports gets the list of what mirrorball does
know:

```console
$ mirb ap
mirb: error: 'ap' is not a known profile, and no ports were given
mirb: hint: Known profiles: api, db, demo, ipv6, staging. Or name a port: mirb ap 3000
```

---

## See also

- [CLI reference](cli.md) — every command and flag, and the port grammar in full
- [Environment variables](environment.md) — `MIRB_CONFIG`, `MIRB_STATE_DIR`, and the XDG variables
- [Exit codes](exit-codes.md) — a config error is exit 2
