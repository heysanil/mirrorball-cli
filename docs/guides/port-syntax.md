---
title: Port syntax
description: Every port form mirrorball accepts, what each one expands to, the rejections and their messages, and how --bind and --auto-port change the local side.
sidebar_position: 1
---

# Port syntax

Every positional argument after the host is a **port spec**. Each one expands into one or
more forwards, and each forward becomes one `-L` argument on the `ssh` command line.

```console
$ mirb 10.0.0.7 3000 8080:80 5432:db.internal:5432
```

The grammar is a deliberately strict subset of ssh's own `-L` grammar. ssh allows a
leading bind address (`[bind:]port:host:hostport`), which makes `0.0.0.0:8080:80` and
`8080:db:5432` impossible to tell apart without resolving the middle field. mirrorball
(`mirb` on the command line) refuses that ambiguity: **the first field is always a local
port**, and the bind address lives on [`--bind`](#--bind-choosing-the-local-address).

---

## The forms

| Form | Example | Expands to |
| --- | --- | --- |
| `PORT` | `3000` | `127.0.0.1:3000` → `localhost:3000` |
| `LOCAL:REMOTE` | `8080:80` | `127.0.0.1:8080` → `localhost:80` |
| `LOCAL:HOST:REMOTE` | `8080:db.internal:5432` | `127.0.0.1:8080` → `db.internal:5432` |
| `START-END` | `3000-3005` | six forwards, same port on both sides |
| `LSTART-LEND:RSTART-REND` | `8000-8005:9000-9005` | six forwards, zipped in order |
| `LSTART-LEND:HOST:RSTART-REND` | `8000-8002:db.internal:9000-9002` | three forwards to a third host |
| IPv6 middle field | `8080:[::1]:5432` | `127.0.0.1:8080` → `[::1]:5432` |

`localhost` in the "expands to" column means *localhost as the ssh host sees it* — the
machine you connected to, not yours. That is the default whenever you do not name a middle
field, and it is the overwhelmingly common case: the service lives on the box you SSH'd
into.

### A bare port

```console
$ mirb 10.0.0.7 3000
```

One forward: bind `127.0.0.1:3000` here, connect onward to `localhost:3000` there. A bare
port means both sides, so you never have to write `3000:3000`.

### Remapping the port

```console
$ mirb 10.0.0.7 8080:80
```

The remote nginx is on `80`, which you cannot bind locally without root (see
[privileged ports](#privileged-ports)). `8080:80` puts it on `http://localhost:8080`.

### Reaching a third host

The middle field is resolved **by the remote sshd**, not by you. This is how you reach a
database that only has a private address:

```console
$ mirb bastion.example.com 5432:db.internal:5432
```

`db.internal` never has to resolve on your machine. It has to resolve on `bastion`. This
field is often confused with `-J`, which solves a different problem; see
[Bastions and jump hosts](./bastion-and-jump-hosts.md) for the two side by side.

### Ranges

```console
$ mirb 10.0.0.7 3000-3005
```

Six forwards: `3000→3000`, `3001→3001`, … `3005→3005`. A one-port range (`3000-3000`) is
legal and means exactly that port.

Paired ranges are **zipped in order**, element by element:

```console
$ mirb 10.0.0.7 8000-8005:9000-9005
```

gives `8000→9000`, `8001→9001`, … `8005→9005`. Both sides must be the same length, and a
middle field is allowed: `8000-8002:db.internal:9000-9002`.

### Several specs at once

Specs are processed in the order you typed them, and the resulting `-L` arguments keep that
order. Verified output for a three-spec invocation:

```console
$ mirb example.test '34900:[::1]:5432' 34901:db.internal:5432 34902
```

```text
ssh -N -T \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -o ConnectTimeout=10 \
  -L 127.0.0.1:34900:[::1]:5432 \
  -L 127.0.0.1:34901:db.internal:5432 \
  -L 127.0.0.1:34902:localhost:34902 \
  example.test
```

Note that the bind address is always written explicitly into the `-L` spec, even when it is
the default. (`-o BatchMode=yes` joins the list whenever nobody could answer a passphrase
prompt — `--background`, or a stdin that is not a TTY.) See
[How it works](../explanation/how-it-works.md) for why the other flags are there.

---

## IPv6

An IPv6 literal in the middle field **must be bracketed**, because the spec is
colon-delimited and `8080:::1:5432` is not parseable by anything, including ssh:

```console
$ mirb 10.0.0.7 '8080:[::1]:5432'
$ mirb 10.0.0.7 '8080:[2001:db8::8a2e:370:7334]:443'
$ mirb 10.0.0.7 '8000-8001:[fe80::1]:9000-9001'
```

Quote them in a shell — square brackets are glob characters in bash and zsh.

mirrorball keeps the brackets when it builds the `-L` argument, because that is the form
OpenSSH requires. Brackets are **only** for IPv6 literals; a bracketed hostname is rejected
rather than silently unwrapped.

| Input | Message |
| --- | --- |
| `8080:::1:5432` | `'8080:::1:5432' has 5 colon-separated parts; expected at most 3`<br/>hint: `IPv6 literals must be bracketed: 8080:[::1]:5432.` |
| `8080:[::1:5432` | `unbalanced '[' in '8080:[::1:5432'` |
| `8080:[::1]]:5432` | `unbalanced ']' in '8080:[::1]]:5432'` |
| `8080:host]:5432` | `unbalanced ']' in '8080:host]:5432'` |
| `8080:[example.com]:5432` | `'[example.com]' in '8080:[example.com]:5432' is bracketed but is not an IPv6 address` |
| `8080:[]:5432` | `empty bracketed host in '8080:[]:5432'` |
| `8080:[::1]x:5432` | `malformed bracketed host '[::1]x' in '8080:[::1]x:5432'` |

The **ssh host itself** is a separate argument with its own rules — `mirb '[::1]' 3000` and
`mirb 'user@[2001:db8::1]:2222' 3000` both work — covered in
[How it works](../explanation/how-it-works.md).

---

## What gets rejected

Every rejection below is a `USAGE` error and exits **2**. See
[Exit codes](../reference/exit-codes.md).

### Port numbers

Ports run `1`–`65535` on both sides. Port `0` is excluded deliberately: to the kernel it
means "pick any free port", and mirrorball would then have nothing honest to print in the
ready line.

```console
$ mirb example.test 0
mirb: error: port 0 in '0' is out of range (1-65535)
mirb: hint: Port 0 means "any free port", which mirb cannot report back.
```

`abc`, `30 00`, `3000.5`, `0x1f` and `+3000` are all refused rather than coerced — a port
that silently became `3000` would be worse than an error.

A host in the local slot gets a hint pointing at the right flag, because this is the single
most common mistake the grammar produces:

```console
$ mirb example.test localhost:8080
mirb: error: 'localhost' in 'localhost:8080' is not a port number
mirb: hint: The first field is always a port. To change the bind address use --bind.
```

### Structure

| Input | Message |
| --- | --- |
| `'   '` (blank) | `empty port specification` |
| `8080:` | `'8080:' has an empty remote port` |
| `:80` | `':80' has an empty local port` |
| `8080::80` | `'8080::80' has an empty host field` |
| `8080:my host:80` | `host 'my host' in '8080:my host:80' contains whitespace` |
| `8080:db:5432:6000` | `'8080:db:5432:6000' has 4 colon-separated parts; expected at most 3` |

The grammar hint on all of these is the same one line: `Write PORT, LOCAL:REMOTE, or
LOCAL:HOST:REMOTE — e.g. 3000, 8080:80, 8080:db.internal:5432.`

Whitespace *around* a spec is trimmed and forgiven — `mirb example.test '  3000  '` works,
and the spec recorded on the forward is the trimmed `3000`. Whitespace *inside* one is not.

### Ranges

| Input | Message |
| --- | --- |
| `3005-3000` | `range 3005-3000 in '3005-3000' ends before it starts (3005 > 3000)` |
| `3000-` | `'3000-' in '3000-' is not a valid port range` |
| `8080:-80` | `'-80' in '8080:-80' is not a valid port range` |
| `3000-3005-3010` | `'3000-3005-3010' in '3000-3005-3010' is not a valid port range` |
| `8000-8005:9000-9002` | `'8000-8005:9000-9002' pairs ranges of different sizes: 8000-8005 spans 6 ports but 9000-9002 spans 3` |
| `8000-8005:9000` | same, `…8000-8005 spans 6 ports but 9000 spans 1` |

### Duplicate local ports

Two specs cannot claim the same local port. This is caught at parse time rather than at
bind time, because ssh's `ExitOnForwardFailure` would turn the second bind into an opaque
failure and leave you to work out which two of your arguments collided.

```console
$ mirb example.test 3000 3000
mirb: error: '3000' is listed twice; local port 3000 can only be bound once
mirb: hint: Drop one of them, or move it to a free local port.

$ mirb example.test 3000-3005 3002:80
mirb: error: local port 3002 is claimed by both '3000-3005' and '3002:80'
mirb: hint: Drop one of them, or move it to a free local port.
```

The *remote* side has no such rule — reaching one remote port from two local ports is a
perfectly reasonable thing to want:

```console
$ mirb bastion 5432:db-a:5432 5433:db-b:5432
```

---

## The 256-port expansion cap

A single range argument may expand to at most **256** forwards.

```console
$ mirb example.test 1-65535
mirb: error: range 1-65535 in '1-65535' spans 65535 ports; mirb forwards at most 256 at once
mirb: hint: Narrow the range, or list the ports you actually need.
```

Each forward becomes its own `-L` argument and its own listening socket, so `mirb host
1-65535` is never a real request — it is a typo or a port scan. mirrorball counts the span
before allocating anything, so rejecting it costs nothing.

Exactly 256 is accepted; 257 is not:

```console
$ mirb example.test 1000-1256
mirb: error: range 1000-1256 in '1000-1256' spans 257 ports; mirb forwards at most 256 at once
```

The cap is **global, not per range argument**. `mirb host 1000-1255 2000-2255` is two
legal ranges totalling 512 forwards, and is refused: the limit bounds the argv and the
socket count handed to ssh, and neither cares how you spelled it. The cap exists to catch a nonsense range, not to police a
total; the practical ceiling on a real invocation is your file-descriptor limit and the
`MaxSessions` of the remote sshd.

---

## `--auto-port`: taking the next free local port

By default a busy local port is a hard failure, exit **4**:

```console
$ mirb example.test 34940
mirb: error: localhost:34940 is already in use by bun (pid 44318)
mirb: hint: Pass --auto-port to take the next free port, or choose another local port.
```

mirrorball tries to bind each local port itself before spawning ssh, which is what lets it
name the process holding the port (via `lsof`, best-effort — a missing or slow `lsof` just
drops the "by …" clause).

`--auto-port` turns that failure into an upward search for a free port:

```console
$ mirb --background --json --auto-port example.test 34940 34941
```

With something already holding `34940`, that produces:

| You asked for | You got | Remote port |
| --- | --- | --- |
| `34940` | `34941` | `34940` |
| `34941` | `34942` | `34941` |

Three things to note:

- **Only the local port moves.** The remote side is what you asked for, untouched.
- **The search is linear and adjacent** — `+1`, `+2`, … up to 100 tries. A random high port
  would be free more often and guessable much less; "3000 was taken, here is 3001" is the
  point.
- **A shifted forward still knows what you typed.** The spec that produced it is kept, so
  `mirb ls` and the live display can show the request next to the result.

If the whole window is busy you get a bounded error rather than a scan to 65535:

```text
mirb: error: no free local port between 34941 and 35040
mirb: hint: Free some ports, or name a local port explicitly.
```

### Privileged ports

Local ports below 1024 need root, and `--auto-port` deliberately does **not** rescue them:

```console
$ mirb example.test 80
mirb: error: localhost:80 needs root: ports below 1024 are privileged
mirb: hint: Use a local port above 1023, e.g. 8080:80.
```

Shifting past a privileged port would mean skipping the entire 1–1023 range and handing
back a port bearing no relation to the one requested. "80 is taken, here is 1024" is not a
guess anyone would make. The hint offers the shift people already do by hand: `8080:80`,
`8443:443`.

Both port failures exit **4**.

---

## `--bind`: choosing the local address

`--bind` sets the local address for **every forward in the command**. There is no per-spec
bind address — that is the ambiguity the grammar exists to avoid.

The default is `127.0.0.1`, which is loopback: only this machine can reach the forward.

```console
$ mirb --bind ::1 example.test 34910
```

Addresses mirrorball treats as loopback, and therefore accepts with no further ceremony:

| Accepted as loopback | Note |
| --- | --- |
| *(unset)* | the default, `127.0.0.1` |
| `localhost` | prefer a literal; see below |
| `127.0.0.1` … `127.255.255.255` | the whole `127.0.0.0/8` block, as a full dotted quad |
| `::1`, `[::1]` | brackets are accepted and stripped before the local bind |

Everything else — `0.0.0.0`, `*`, `::`, a LAN address like `192.168.1.10`, and also
near-misses like `127.1`, `127.0.0.256` or `127.evil.com` — counts as **exposed**. The test
is a whitelist of loopback spellings rather than a blacklist of dangerous ones, so it fails
closed: `127.evil.com` is a hostname whose owner chooses where it resolves, and a prefix
test would have published your forward to the internet without a word.

:::danger Binding beyond loopback publishes the forward to your network

`--bind 0.0.0.0` makes every forward in the session reachable by **every machine that can
reach yours**. A staging database, an admin panel, a dev server with no auth — all of it,
to anyone on the coffee-shop Wi-Fi.

`GatewayPorts` does not save you. Contrary to a widespread belief it governs `-L` as well
as `-R`, and an explicit `0.0.0.0` or `*` bypasses it entirely. Verified against
OpenSSH 10.2p1 by reaching the forward from a second machine on the LAN. **The bind address
is the only thing standing between you and exposure.**
:::

Because of that, mirrorball refuses a non-loopback bind unless you also pass `--expose`:

```console
$ mirb example.test 34700 --bind 0.0.0.0
mirb: error: --bind 0.0.0.0 would publish these forwards beyond this machine
mirb: hint: Anyone who can reach this host on the network could use the tunnel. Pass --expose to confirm.
```

This is an error rather than a confirmation prompt on purpose: mirrorball has to behave the
same for a human and for an agent, and a prompt on a non-interactive path is worse than
useless — a cancelled prompt exits 0, so a script would read success and carry on.

### `--expose`

`--expose` is the acknowledgement. On its own it also *implies* the wildcard, so you do not
have to look up an address you were going to type anyway:

```console
$ mirb --expose example.test 34701            # binds 0.0.0.0
$ mirb --bind 0.0.0.0 --expose example.test 34701
$ mirb --bind '*' --expose example.test 34711
$ mirb --bind 192.168.13.22 --expose example.test 34720   # one interface only
```

All four are verified working. `--bind` always wins over `--expose`'s implied wildcard, so
combining them narrows the exposure rather than widening it.

Once a session is exposed, mirrorball says so continuously — the live display carries a
persistent banner (`exposed on … — reachable from your network`) above the forwards and
paints the exposed local addresses in the alert colour; the plain-text reporter used in CI
and redirected output prints a `warning: exposed on …` line. A one-shot notice would scroll
away, and the entire risk of a non-loopback bind is that it is invisible.

### Bind addresses that fail

The bind address is checked against this machine before ssh is spawned, so a wrong one
fails immediately instead of after authentication:

```console
$ mirb --bind 127.0.0.2 example.test 34432
mirb: error: cannot bind 127.0.0.2:34432: EADDRNOTAVAIL
mirb: hint: Check the bind address is one this machine actually has.
```

An IPv6 bind address works either way — `--bind ::1` and `--bind '[::1]'` both bind
loopback. Brackets are ssh's spelling, needed to disambiguate a colon-delimited `-L` spec;
mirrorball strips them before asking the kernel to listen and puts them back before handing
the spec to ssh.

Prefer a literal address over a name. `--bind localhost` passes the exposure check, but the
name is resolved twice by two different things — ssh resolves it when it binds, and
mirrorball's pre-flight and readiness probe use `127.0.0.1` — and on a machine where
`localhost` prefers `::1` those two can disagree, leaving a forward that is bound but never
reports ready. `--bind 127.0.0.1` or `--bind ::1` says exactly what you mean.

---

## See also

- [Profiles](./profiles.md) — put a host and its ports in `config.toml`, including `bind`.
- [Bastions and jump hosts](./bastion-and-jump-hosts.md) — the third field versus `-J`.
- [Troubleshooting](./troubleshooting.md) — keyed to the exact error text, including every
  port and bind failure above.
- [CLI reference](../reference/cli.md) — every flag on `mirb up`.
- [How it works](../explanation/how-it-works.md) — the full `ssh` argv and the readiness probe.
- [Exit codes](../reference/exit-codes.md) — `2` for usage, `4` for a port conflict.
