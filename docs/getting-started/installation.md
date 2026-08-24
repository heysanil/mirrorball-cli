---
title: Installation
description: Every way to install mirrorball — the shell installer, npm, or from source — plus verifying, upgrading, uninstalling, and where files land.
sidebar_position: 1
---

# Installation

mirrorball ships as a single compiled binary with no runtime dependencies. Pick whichever
channel fits how you already install things; they all end up with the same executable.

The command you type is **`mirb`**. Every channel also installs **`mirrorball`** as a second
name for the same binary — a symlink on macOS and Linux, a tiny `.cmd` shim on Windows, a
second `bin` entry under npm — so whichever name you remember is the one that works.

## Requirements

| | |
| --- | --- |
| **An `ssh` client** | Any OpenSSH. mirrorball does not implement SSH — it runs the `ssh` on your `PATH`, which is what makes your `ssh_config`, agent and keys work unchanged. |
| **macOS, Linux, or Windows** | Prebuilt for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64`. |

Bun and Node are **not** required to run a released binary. They are only needed if you
install from source, or via npm (where a small Node shim picks the right binary).

If `ssh` is missing, mirrorball says so with the `NO_SSH` error code rather than failing
obscurely:

```
mirb: error: no ssh binary found on PATH
mirb: hint: Install OpenSSH, or point mirb at one with MIRB_SSH=/path/to/ssh.
```

---

## The install script

**macOS and Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/heysanil/mirrorball-cli/main/scripts/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/heysanil/mirrorball-cli/main/scripts/install.ps1 | iex
```

The script detects your platform, resolves the latest release, downloads the matching
archive, **verifies its SHA-256 against the release's `checksums.txt`**, and installs the
binary. Verification is not optional and there is no switch to skip it — a flag that turns
integrity checking off is a flag an attacker can talk someone into typing.

Afterwards you have both names on your `PATH`:

```console
$ mirb --version
mirb v0.1.0
$ mirrorball --version
mirb v0.1.0
```

On macOS and Linux, `mirrorball` is a symlink pointing at `mirb` in the same directory. On
Windows it is a `mirrorball.cmd` shim that forwards to `mirb.exe`, because a symlink there
would need administrator rights or developer mode. Either way the alias is best-effort: if it
cannot be created — an unwritable directory, or an unrelated `mirrorball` already sitting in
the way — the install of `mirb` still succeeds.

### Options

The shell installer takes flags or environment variables:

| Flag | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `--version <x.y.z>` | `MIRB_VERSION` | latest release | Install a specific version. `1.2.3` and `v1.2.3` both work. |
| `--dir <path>` | `MIRB_INSTALL_DIR` | `$HOME/.local/bin` | Where to put the binary. |
| `--help` | | | Print usage and exit. |
| | `NO_COLOR` | | Disable coloured output. |

```sh
curl -fsSL https://raw.githubusercontent.com/heysanil/mirrorball-cli/main/scripts/install.sh \
  | sh -s -- --version 0.1.0 --dir /usr/local/bin
```

The PowerShell script takes the same ideas as parameters:

| Parameter | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `-Version <x.y.z>` | `MIRB_VERSION` | latest release | Install a specific version. |
| `-Dir <path>` | `MIRB_INSTALL_DIR` | `%LOCALAPPDATA%\mirb\bin` | Where to put `mirb.exe`. |
| `-NoPathUpdate` | `MIRB_NO_PATH_UPDATE` | | Do not touch the user `PATH`; print instructions instead. |
| `-Help` | | | Print usage and exit. |

`irm | iex` cannot forward parameters, so pass them through a script block or the
environment:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/heysanil/mirrorball-cli/main/scripts/install.ps1))) -Version 0.1.0
```

```powershell
$env:MIRB_VERSION = '0.1.0'; irm https://raw.githubusercontent.com/heysanil/mirrorball-cli/main/scripts/install.ps1 | iex
```

### Notes

- **Alpine and other musl systems.** The release binaries are compiled against glibc. The
  installer warns rather than refuses, because `gcompat` makes them work often enough that
  a hard stop would be wrong. If `mirb` will not start, install `gcompat` or build from
  source.
- **PATH.** If the install directory is not already on your `PATH`, the script prints the
  exact line to add and the exact file to add it to, chosen for your shell.
- **Replacing a running binary.** The installer stages the new binary and `rename(2)`s it
  into place, so an upgrade during a live background session does not hit `ETXTBSY` and does
  not disturb the running process.

---

## Is there an npm package?

Not currently. npm rejected both candidate names — `mirb` and then `mirb-cli` — under its
similarity check on new package names, which compares against existing packages
(`mitt`, `mime`, `mri`, `sirv-cli`) and is unrelated to whether a name is free.

Rather than publish under a name nobody would guess, mirrorball ships through the install
script and the [GitHub Releases](https://github.com/heysanil/mirrorball-cli/releases) page.
Both give you the same binary, verified against the same `checksums.txt`.

## From source

You need [Bun](https://bun.sh) 1.3 or newer. Node is not supported: mirrorball uses
Bun-native APIs (`Bun.spawn`, `Bun.TOML`, `Bun.stringWidth`, `Bun.which`, `Bun.color`) with
no Node equivalent worth shimming.

```sh
git clone https://github.com/heysanil/mirrorball-cli.git
cd mirrorball-cli
bun install
bun run build          # standalone binary for this machine -> ./dist/mirb
```

`bun run build` compiles for the host platform only. `bun run build:all` cross-compiles all
five release targets. Put the result somewhere on your `PATH`:

```sh
install -m 755 dist/mirb ~/.local/bin/mirb
mirb --version
```

A source build produces the `mirb` binary only. If you want the long name too, add the
symlink yourself:

```sh
ln -sf mirb ~/.local/bin/mirrorball
```

To run straight from the source tree without compiling, the entry file is `mirb.ts`:

```sh
bun /path/to/mirrorball-cli/mirb.ts 10.0.0.7 3000
```

If you are going to work *on* mirrorball rather than just with it, use `bun link` and read
[Development](../contributing/development.md) instead — it covers the dev loop, the test
harness, and the conventions the codebase holds to.

---

## Verifying a download by hand

Every release publishes a `checksums.txt` alongside the archives. To check an asset yourself:

```sh
VERSION=0.1.0
BASE=https://github.com/heysanil/mirrorball-cli/releases/download/v$VERSION

curl -fsSLO $BASE/checksums.txt
curl -fsSLO $BASE/mirb-$VERSION-darwin-arm64.tar.gz

sha256sum --ignore-missing -c checksums.txt
```

On macOS without GNU coreutils:

```sh
shasum -a 256 mirb-$VERSION-darwin-arm64.tar.gz
grep darwin-arm64 checksums.txt
```

Asset names follow `mirb-<version>-<os>-<arch>.tar.gz`, except Windows which ships `.zip`.

Then confirm what you installed:

```console
$ mirb --version
mirb v0.1.0
```

(Piped or redirected, that same command emits JSON — mirrorball switches to machine output
whenever stdout is not a terminal.)

---

## Upgrading

| Installed with | Upgrade |
| --- | --- |
| Install script | Re-run it. It resolves the latest release and replaces the binary in place. |
| Source | `git pull && bun install && bun run build` |

To pin or roll back, pass a version:

```sh
curl -fsSL https://raw.githubusercontent.com/heysanil/mirrorball-cli/main/scripts/install.sh | sh -s -- --version 0.1.0
```

Background sessions are supervised by the `mirb` process that started them, not by the binary
on disk, so an upgrade does not disturb a running tunnel. The next `mirb ls` you run is the
new build reading the old build's records — which is fine, because session records are
validated permissively on read for exactly this reason.

---

## Uninstalling

Remove the binary and its alias:

```sh
rm ~/.local/bin/mirb ~/.local/bin/mirrorball   # or wherever --dir put them
npm uninstall -g mirb                          # if installed from npm
```

```powershell
Remove-Item "$env:LOCALAPPDATA\mirb\bin\mirb.exe"
Remove-Item "$env:LOCALAPPDATA\mirb\bin\mirrorball.cmd"
```

Then, if you want mirrorball gone completely, remove its config and state:

```sh
rm -rf ~/.config/mirb                # profiles
rm -rf ~/.local/state/mirb           # session records and logs
```

Stop any background sessions first — `mirb stop --all` — or you will leave orphaned
supervisor processes holding local ports with nothing left to manage them.

---

## Where files land

| | macOS / Linux | Windows |
| --- | --- | --- |
| Binary (install script) | `$HOME/.local/bin/mirb` | `%LOCALAPPDATA%\mirb\bin\mirb.exe` |
| Alias | `$HOME/.local/bin/mirrorball` → `mirb` | `%LOCALAPPDATA%\mirb\bin\mirrorball.cmd` |
| Config | `~/.config/mirb/config.toml` | `%APPDATA%\mirb\config.toml` |
| Session records | `~/.local/state/mirb/sessions/` | `%LOCALAPPDATA%\mirb\State\sessions\` |
| Session logs | `~/.local/state/mirb/logs/` | `%LOCALAPPDATA%\mirb\State\logs\` |

`XDG_CONFIG_HOME` and `XDG_STATE_HOME` are honoured where set. `$MIRB_CONFIG` points at a
config *file* directly, and `$MIRB_STATE_DIR` replaces the state root wholesale — handy for
running two isolated instances on one machine. The full list of environment variables is in
[Environment](../reference/environment.md).

mirrorball creates nothing until you use it. No config file is required; a missing one is the
common case, not an error.

---

## Next

- [Quick start](quick-start.md) — a working tunnel in thirty seconds.
- [Concepts](concepts.md) — the vocabulary, and the readiness model.
