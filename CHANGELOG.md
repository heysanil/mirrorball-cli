# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet. Add entries here as they land — one bullet per user-visible change,
under `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`.

## [0.1.0] - 2026-08-19

Initial release.

### Added

- `mirb <host> <ports...>` — the whole point: forward one or more ports with no
  subcommand, no flags, no `-L` syntax. `mirb 10.0.0.7 3000 3010 8080` just works.
- Port argument forms: `3000` (same port both ends), `8080:80` (local:remote),
  and `8080:db.internal:5432` (forward through the remote to a third host).
- Three-state readiness reporting. A forward is `bound` when the local socket
  accepts connections, `ready` when a probe reached the remote service, and
  `refused` when the tunnel is healthy but nothing is listening on the far end —
  the distinction plain `ssh -L` never makes.
- Background sessions supervised by a detached process, with
  `mirb ls`, `mirb stop`, and `mirb logs` to inspect and tear them down.
- Automatic reconnect with exponential backoff and jitter, and an attempt counter
  that resets once a connection has proven stable.
- Named profiles in `config.toml`, so a recurring host/port set becomes `mirb staging`.
- Forwards bind to loopback by default. A `--bind` address that would reach beyond this
  machine is refused outright unless `--expose` is passed as well — an error rather than a
  prompt, so a script and a human get the same behaviour.
- Machine-readable output: `--format json` for one-shot results and NDJSON event
  streaming for long-running sessions, both stable enough to script against.
- Typed, documented exit codes (`0`/`2`/`3`/`4`/`5`/`130`) and error codes on every
  failure, so callers can branch instead of grepping messages.
- Prebuilt standalone binaries for darwin-arm64, darwin-x64, linux-arm64,
  linux-x64 and windows-x64, published as platform packages on npm. Both the installer
  and the npm package put `mirb` on your PATH with `mirrorball` alongside it as an alias,
  so either name works.
- `--auto-port`, which takes the next free local port instead of failing when the
  requested one is busy, and a pre-flight bind check that names the process holding
  a port rather than surfacing ssh's opaque bind error.
- `--probe-settle <ms>` (default 750) to widen the window a socket must stay open
  before a forward counts as `ready`. Refusal costs roughly three round trips, so
  high-latency links and long `-J` chains need more than the default allows.
- Shell-friendly bind addresses: `localhost`, `*`, and bracketed IPv6 literals such
  as `[::1]` are all accepted and collapsed to a single literal, so ssh, the
  pre-flight check and the readiness probe always agree on one socket.

[Unreleased]: https://github.com/heysanil/mirrorball-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/heysanil/mirrorball-cli/releases/tag/v0.1.0
