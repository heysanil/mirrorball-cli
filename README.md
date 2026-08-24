# mirrorball

Instant SSH port forwarding. One command instead of an `-L` incantation — and, unlike
`ssh -L`, an honest answer to *is anything actually listening on the other end?*

[![CI](https://img.shields.io/github/actions/workflow/status/heysanil/mirrorball-cli/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/heysanil/mirrorball-cli/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/heysanil/mirrorball-cli?style=flat-square&label=release)](https://github.com/heysanil/mirrorball-cli/releases/latest)
[![License](https://img.shields.io/github/license/heysanil/mirrorball-cli?style=flat-square)](LICENSE)

---

This is the command you have been typing:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:3000:localhost:3000 \
  -L 127.0.0.1:3010:localhost:3010 \
  -L 127.0.0.1:8080:localhost:8080 \
  10.0.0.7
```

This is mirrorball (`mirb`):

```sh
mirb 10.0.0.7 3000 3010 8080
```

```
  mirb ⇄ 10.0.0.7                                      up 6s

   ●  localhost:3000   ←  localhost:3000               ready
   ●  localhost:3010   ←  localhost:3010               ready
   ○  localhost:8080   ←  localhost:8080             refused

   ssh 19421 · reconnects 0 · ^C to stop
```

<!-- TODO: demo.gif — record `mirb 10.0.0.7 3000 3010 8080` coming up with one
     port refused, then ^C. Keep it under 15s. -->

Two ports are carrying traffic. The third is a perfectly healthy tunnel to a service that
is not running. `ssh -L` cannot tell you that.

## Why it exists

`ssh -L` binds the local socket during session setup and only opens a channel to the far
side when something connects to it. So the listener comes up whether or not the remote
service exists, and `ssh` prints nothing either way. `kubectl port-forward` behaves the
same: the local port is bound immediately, and a dead pod surfaces as a connection error
in whatever tool you pointed at it several minutes later.

That gap is where the time goes. Your browser says `ECONNREFUSED` and you have no way to
tell whether the tunnel is broken, the port is wrong, or the service simply is not up — so
you go and debug ssh, which was working the whole time.

mirrorball closes it with three states instead of one:

| State | Meaning |
| --- | --- |
| `bound` | The local socket accepts connections. The tunnel exists. |
| `ready` | A probe went through the tunnel and reached a live remote service. |
| `refused` | The tunnel is fine; nothing is listening on the far end. |

`refused` is amber, not red, and that is the point of the whole tool: mirrorball worked,
your service is down. On top of that it adds reconnect with backoff, background sessions
you can list and stop, and NDJSON output for anything that is not a human.

Everything else it delegates. mirrorball does not implement SSH — it runs the `ssh` on your
`PATH`, so your `ssh_config`, your agent, your keys and your `ProxyJump` chain all work
exactly as they already do.

## Install

```sh
# macOS / Linux
curl -fsSL https://mirb.dev/install.sh | sh

# Windows (PowerShell)
irm https://mirb.dev/install.ps1 | iex
```

The installer downloads the release binary for your platform and verifies it against the
release's `checksums.txt` — there is no flag to skip that. It installs to
`$HOME/.local/bin` (`%LOCALAPPDATA%\mirb\bin` on Windows); to put it elsewhere,
`curl -fsSL … | sh -s -- --dir /usr/local/bin`. It also drops a `mirrorball` alias beside
the binary — a symlink, or a `mirrorball.cmd` shim on Windows — so either name works.

From source (needs [Bun](https://bun.sh) 1.3+, and nothing else):

```sh
git clone https://github.com/heysanil/mirrorball-cli.git
cd mirrorball-cli && bun install
bun run build       # compiles a single binary into dist/mirb
```

More detail, including checksum verification by hand and uninstalling:
[Installation](docs/getting-started/installation.md).

## Quick start

```sh
mirb 10.0.0.7 3000                    # localhost:3000 -> 10.0.0.7's localhost:3000
mirb deploy@web-1 8080:80             # different port on each end
mirb bastion 5432:db.internal:5432    # through the ssh host, on to a third machine
mirb myserver 3000 3010 8080          # as many as you like
mirb -J jump.example.com db 5432      # -i, -J, -P and -o pass straight through to ssh
```

`myserver` can be anything ssh accepts: an IP, a hostname, `user@host:2222`, or an
`ssh_config` alias. mirrorball does not try to resolve it — that is ssh's job. If you reach
things through a bastion, see [Bastions and jump hosts](docs/guides/bastion-and-jump-hosts.md).

### Port syntax

| You write | mirrorball forwards |
| --- | --- |
| `3000` | `localhost:3000` → remote `localhost:3000` |
| `8080:80` | `localhost:8080` → remote `localhost:80` |
| `8080:db.internal:5432` | `localhost:8080` → `db.internal:5432`, reached from the ssh host |
| `3000-3005` | six forwards, same port on both ends |
| `8000-8002:9000-9002` | paired ranges, zipped in order |
| `5432:[::1]:5432` | IPv6 literals, bracketed |

The first field is always a local port. ssh's optional leading bind address is not
accepted there, because `0.0.0.0:8080:80` and `8080:db:5432` are impossible to tell apart
without resolving the middle field — use `--bind` instead. Ranges expand to at most 256
forwards. Full grammar: [Port syntax](docs/guides/port-syntax.md).

Forwards bind to `127.0.0.1`. Binding anywhere else publishes the service to your whole
network, so mirrorball refuses unless you also pass `--expose`:

```console
$ mirb --bind 0.0.0.0 10.0.0.7 8080
mirb: error: --bind 0.0.0.0 would publish these forwards beyond this machine
mirb: hint: Anyone who can reach this host on the network could use the tunnel. Pass --expose to confirm.
```

## Profiles

Put the tunnels you open every day in `~/.config/mirb/config.toml`:

```toml
[profiles.staging]
host = "deploy@staging.internal"
ports = [3000, "5432:db.internal:5432"]
name = "staging api"
identity = "~/.ssh/staging_ed25519"
```

```sh
mirb staging            # the profile
mirb staging 9229       # the profile, plus a debugger port
```

Extra ports append rather than replace, and flags override individual profile fields.
[Profiles](docs/guides/profiles.md) · [Configuration reference](docs/reference/configuration.md)

## Background sessions

`--background` detaches a supervisor and waits for it to prove the tunnel works before it
returns — so the ports are listening by the time you get your prompt back.

```console
$ mirb -b --name api 10.0.0.7 5432 6379 8080
  an8ioa  10.0.0.7  degraded
    ● localhost:5432 ← localhost:5432  ready
    ● localhost:6379 ← localhost:6379  ready
    ○ localhost:8080 ← localhost:8080  refused
  stop it with: mirb stop an8ioa

$ mirb ls
  ID      NAME  HOST      FORWARDS                               UP  STATUS
  an8ioa  api   10.0.0.7  5432 ← 5432, 6379 ← 6379, 8080 ← 8080  8s  ○ degraded

$ mirb logs api -f
$ mirb stop an8ioa          # or: mirb stop --all
```

There is no daemon. Each session is a detached `mirb` supervising one `ssh`, its state a
JSON file under `~/.local/state/mirb`. A record whose supervisor is gone is pruned the next
time you run `mirb ls`. [Background sessions](docs/guides/background-sessions.md)

## Agents and scripts

When stdout is not a terminal, mirrorball switches to JSON on its own — no flag to
remember. In the foreground it streams NDJSON events, one per line, as they happen:

```console
$ mirb db.internal 5432 6379 --json
{"event":"session.start","ts":"…","id":"mb_q2czpelcocugb","target":{"host":"db.internal","raw":"db.internal"},"forwards":[…]}
{"event":"forward.bound","ts":"…","localPort":5432}
{"event":"forward.bound","ts":"…","localPort":6379}
{"event":"forward.error","ts":"…","localPort":6379,"code":"REMOTE_REFUSED","message":"nothing is listening on localhost:6379 at the far end"}
{"event":"forward.ready","ts":"…","localPort":5432}
{"event":"session.ready","ts":"…","id":"mb_q2czpelcocugb","ready":1,"total":2}
{"event":"session.exit","ts":"…","id":"mb_q2czpelcocugb","code":143,"reason":"stopped"}
```

(Timestamps abbreviated above; `session.start` also carries the resolved target and the
full forward list.)

`mirb ls`, `mirb stop` and `mirb -b` emit a single `{ok, data, meta}` envelope instead — and
`mirb -b` does not print it until the forwards are usable, so the line that hands a script
a session id has already proven the tunnel. Exit codes are stable and specific: `0` ok,
`2` usage, `3` ssh, `4` local port conflict, `5` remote refused, `130` interrupted. A
script can branch without parsing anything.

[Automation and agents](docs/guides/automation-and-agents.md) ·
[JSON output](docs/reference/json-output.md) ·
[Exit codes](docs/reference/exit-codes.md)

## How it works

mirrorball is an argv builder, a process supervisor and a probe. For
`mirb 10.0.0.7 3000 3010 8080`, this is the entire ssh side of it:

```sh
ssh -N -T \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o ConnectTimeout=10 \
  -L 127.0.0.1:3000:localhost:3000 \
  -L 127.0.0.1:3010:localhost:3010 \
  -L 127.0.0.1:8080:localhost:8080 \
  10.0.0.7
```

No hidden steps: run that by hand and you get the same tunnel. `mirb ls` records the exact
argv of every session, so you can always see what was run.

Three of those flags are load-bearing:

- **`ExitOnForwardFailure=yes`** — without it, ssh keeps running when one of several `-L`
  binds fails, leaving a half-working tunnel that eventually exits `0`.
- **`-N -T`** — no remote command, no pty. mirrorball is a forwarder, never a shell.
- **`ServerAlive*`** — a dead link surfaces in ~45s instead of hanging forever.

Readiness is never inferred from ssh's stderr, which is not an interface and changes
between releases. `bound` is a real TCP connect to the local port. `ready` vs `refused` is
one throwaway connection *through* the tunnel: ssh accepts locally before it knows whether
the remote service exists, so a connection that is closed promptly and silently means
nothing is listening on the far end. `--no-probe` turns that off for services that log or
bill for it.

The honest caveats — what the probe can and cannot tell you — are written down in
[How it works](docs/explanation/how-it-works.md), along with
[the decisions behind it](docs/explanation/design-decisions.md).

## Compared to

| | **mirrorball** | `ssh -L` | [autossh](https://www.harding.motd.ca/autossh/) | [sshuttle](https://github.com/sshuttle/sshuttle) |
| --- | --- | --- | --- | --- |
| What it does | wraps `ssh -L` | port forwarding | keeps an `ssh` alive | transparent subnet routing |
| Distinguishes bound / ready / refused | yes | no | no | n/a — no per-port model |
| Multiple ports in one argument list | `3000 3010 8080` | one `-L` each | via ssh args | forwards subnets, not ports |
| Reconnects | backoff + jitter | no | yes, its whole purpose | yes |
| Manage running tunnels | `ls` / `stop` / `logs` | none | none | pidfile with `-D` |
| Machine-readable output | NDJSON + JSON | no | no | no |
| Needs root | no | no | no | yes, for local firewall rules |
| Needs anything on the remote | no | no | no | yes, Python 3 |

`ssh -L` is the thing mirrorball runs; everything above is `ssh -L` plus the parts that are
tedious to do by hand.

**autossh** is battle-tested and has kept tunnels up for two decades. It solves
reconnection, and only reconnection — if you want a permanent tunnel under systemd, it is
still an excellent answer. mirrorball is aimed at the interactive case: the tunnel you
open, watch, and close an hour later.

**sshuttle** is genuinely a different tool, not a competitor. It routes whole subnets
through an ssh connection like a VPN, which is what you want when you do not know in
advance which addresses you will need. It costs local root and a Python interpreter on the
remote host. mirrorball forwards ports you can name, and needs neither.

## Documentation

Full documentation: **[mirb.dev](https://mirb.dev)**. The same pages live in
[`docs/`](docs/index.md) and render on GitHub. The ones people open most:

| | |
| --- | --- |
| [Installation](docs/getting-started/installation.md) | Every install method, and how to verify a download |
| [Quick start](docs/getting-started/quick-start.md) | Your first tunnel, start to finish |
| [Concepts](docs/getting-started/concepts.md) | Targets, forwards, sessions, readiness states |
| [CLI reference](docs/reference/cli.md) | Every command and flag |
| [Troubleshooting](docs/guides/troubleshooting.md) | When it says `refused`, `failed`, or nothing at all |
| [How it works](docs/explanation/how-it-works.md) | The ssh command, the probe, the failure classifier |
| [Architecture](docs/explanation/architecture.md) | How the code is laid out, and why |

## Contributing

mirrorball is small on purpose — you can read all of it in an afternoon. Bug reports, docs
fixes and "this error message confused me" issues are as welcome as code.

```sh
git clone https://github.com/heysanil/mirrorball-cli.git
cd mirrorball-cli && bun install
bun test
bun run dev -- 127.0.0.1 3000
```

The test suite runs against a fake `ssh` that really binds local ports, so the whole
runtime is covered with no server, no network and no credentials anywhere. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/contributing](docs/contributing/development.md).

## License

[MIT](LICENSE) © Sanil Chawla
