---
title: Environment variables
description: Every environment variable mirrorball reads, what it does, and what it defaults to.
sidebar_position: 5
---

# Environment variables

mirrorball (`mirb`) reads a small, deliberate set of variables. Four are its own; the rest
are conventions it honours because a tool that ignores `NO_COLOR` is a tool that has to be
worked around.

Everything here is read from mirrorball's own process environment. ssh is spawned as a
child and inherits that environment unchanged, so `SSH_AUTH_SOCK`, `SSH_ASKPASS` and the
rest of OpenSSH's own variables keep working exactly as they do when you run `ssh` by
hand — mirrorball neither reads nor rewrites them.

## mirrorball's own

| Variable | Type | Default | Effect |
| --- | --- | --- | --- |
| `MIRB_SSH` | path or command name | unset — `ssh` from `PATH` | The ssh binary to run. |
| `MIRB_STATE_DIR` | absolute path | platform state dir (below) | Where background session records and logs live. |
| `MIRB_CONFIG` | absolute path to a **file** | platform config dir (below) | Which `config.toml` to load. |
| `MIRB_ASCII` | truthy string | unset | Force ASCII symbols instead of Unicode ones. |

### `MIRB_SSH`

Resolved through the same executability check as a `PATH` lookup, so a stale override fails
immediately and by name rather than as a confusing spawn error later:

```
mirb: error: $MIRB_SSH points at '/nope/ssh', which is not an executable
mirb: hint: Unset MIRB_SSH to use the ssh on your PATH.
```

That is a `NO_SSH` failure, [exit 3](exit-codes.md). A value that is empty or only whitespace
counts as unset. A bare name (`ssh-9.9`) is looked up on `PATH` like any command.

`--ssh-path` is the same affordance and takes the same route, and wins when both are given.

```bash
MIRB_SSH=/opt/homebrew/bin/ssh mirb example.test 3000
```

### `MIRB_STATE_DIR`

Replaces the platform state root wholesale — not a parent of it. mirrorball creates
`sessions/`, `logs/` and `pending/` directly underneath.

| Platform | Default root |
| --- | --- |
| macOS, Linux | `$XDG_STATE_HOME/mirb`, else `~/.local/state/mirb` |
| Windows | `%LOCALAPPDATA%\mirb\State`, else `~\AppData\Local\mirb\State` |

Two isolated mirrorball instances on one machine is the everyday reason to set it; the test
suite uses it for the same reason.

```bash
MIRB_STATE_DIR=/tmp/mirb-scratch mirb ls
```

Empty or whitespace-only counts as unset.

### `MIRB_CONFIG`

Names the file, not its directory — it exists so a throwaway config needs no XDG dance.

| Platform | Default path |
| --- | --- |
| macOS, Linux | `$XDG_CONFIG_HOME/mirb/config.toml`, else `~/.config/mirb/config.toml` |
| Windows | `%APPDATA%\mirb\config.toml`, else `~\AppData\Roaming\mirb\config.toml` |

A missing file is not an error — mirrorball is fully usable without one. A file that exists
but is malformed is a `CONFIG` failure, [exit 2](exit-codes.md).

```bash
MIRB_CONFIG=./ci-profiles.toml mirb staging
```

### `MIRB_ASCII`

Any truthy value swaps the box-drawing and geometric glyphs for ASCII. "Truthy" here means
set, non-empty, and not `0` or `false` — so `MIRB_ASCII=0` is the same as not setting it
at all, and leaves the decision to the locale.

Without it, mirrorball decides from the locale (below), because there is no way to ask a
terminal whether it will render `●` without printing it and measuring the cursor.

## Colour and glyphs

| Variable | Type | Default | Effect |
| --- | --- | --- | --- |
| `NO_COLOR` | any non-empty value | unset | Disables colour entirely. Beats everything else. |
| `FORCE_COLOR` | `0`–`3`, or any truthy/falsy string | unset | Overrides detection in both directions. |
| `COLORTERM` | string | unset | `truecolor` or `24bit` anywhere in the value selects 24-bit colour. |
| `TERM` | string | unset | `dumb` disables colour *and* the live display. |
| `LC_ALL`, `LC_CTYPE`, `LANG` | locale string | unset | The first one set decides whether Unicode symbols are used. |

The precedence is who gets to overrule whom:

1. `NO_COLOR`, set to anything non-empty, wins outright — including `NO_COLOR=0`. Presence is
   the signal, per [no-color.org](https://no-color.org). It is a promise a user made to their
   whole toolchain, not a hint.
2. `FORCE_COLOR` beats detection. Set to `0`, `false` or the empty string it means *no*
   colour. Set to `3` it means 24-bit. Any other truthy value means "colour, and skip the TTY
   and `TERM=dumb` checks" — `1` and `2` both land on 256 colours.
3. Otherwise: no colour unless stdout is a terminal that reports colour support, and none at
   all when `TERM=dumb`.
4. `COLORTERM` upgrades a colour-capable destination to 24-bit. 256 colours is the floor for
   anything that claims colour at all — mirrorball's palette quantises to it without any of
   its five hues collapsing into a neighbour.

For glyphs, `LC_ALL` is consulted first, then `LC_CTYPE`, then `LANG`; the first one that is
set decides, and it has to match `utf-8` or `utf8` (case-insensitively) for Unicode symbols.
An unset locale is treated as *not* UTF-8: mojibake in a status line is worse than plain
ASCII in a status line.

`TERM=dumb` does double duty. Besides killing colour it also sends `mirb up` to the
append-only reporter instead of the live redrawn frame, which is the right output for a
terminal that cannot move a cursor.

## Paths and lookup

| Variable | Read for |
| --- | --- |
| `PATH` | Finding `ssh` (and resolving `MIRB_SSH`), and finding `lsof` to name the process holding a busy local port. |
| `HOME` | The base of every default path below, via the platform's home-directory lookup. |
| `XDG_STATE_HOME` | The state root, on macOS and Linux. |
| `XDG_CONFIG_HOME` | The config directory, on macOS and Linux. |
| `APPDATA` | The config directory, on Windows. |
| `LOCALAPPDATA` | The state root, on Windows. |

`XDG_DATA_HOME` and `XDG_CACHE_HOME` are **not** read. mirrorball keeps no cache and stores
nothing it would call user data — a session record is state, and it lives in the state
directory.

An `XDG_*` variable that is empty or whitespace-only falls back to the `~/...` default, and
`MIRB_STATE_DIR` / `MIRB_CONFIG` override the result either way.

## The install scripts

These are read by `install.sh` and `install.ps1` when you install mirrorball, not by the CLI
afterwards.

| Variable | Script | Effect |
| --- | --- | --- |
| `MIRB_VERSION` | both | Install a specific release instead of the latest. Same as `--version` / `-Version`. |
| `MIRB_INSTALL_DIR` | both | Install into this directory. Same as `--dir` / `-Dir`. Defaults to `$HOME/.local/bin` on macOS and Linux, `%LOCALAPPDATA%\mirb\bin` on Windows. |
| `MIRB_NO_PATH_UPDATE` | `install.ps1` | Skip adding the install directory to the user `PATH`. Same as `-NoPathUpdate`. |
| `NO_COLOR` | both | Plain output during the install. |

```bash
MIRB_VERSION=0.2.0 MIRB_INSTALL_DIR=/usr/local/bin \
  curl -fsSL https://raw.githubusercontent.com/heysanil/mirrorball-cli/main/scripts/install.sh | sh
```

## Repository tooling

Not part of mirrorball's interface; listed so nobody has to grep for them. The test suite's
fake ssh is driven by `FAKE_SSH_*` variables, documented alongside it in
[Testing](../contributing/testing.md).

## See also

- [Configuration](configuration.md) — what goes in the file `MIRB_CONFIG` points at
- [CLI reference](cli.md) — the flags that override these
- [Exit codes](exit-codes.md) — `MIRB_SSH` pointing at nothing is exit 3
