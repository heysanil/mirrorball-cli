import { defineCommand, option, type TerminalInfo } from '@bunli/core'
import {
  assertExposureAllowed,
  EXPOSED_BIND_ADDRESS,
  normalizeBindAddress,
  assertSshOptionsSafe,
  isExposedAddress
} from '../core/bind.ts'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { loadConfig, resolveProfile, type EnvLike } from '../core/config.ts'
import { MirbError } from '../core/errors.ts'
import { newSessionId, shortId } from '../core/ids.ts'
import { DEFAULT_BIND_ADDRESS, parsePortSpecs } from '../core/portspec.ts'
import { inspectConfiguredForwardings, resolveSshPath } from '../core/ssh.ts'
import { readSession, removeSession, sessionLogPath } from '../core/state.ts'
import { Supervisor } from '../core/supervisor.ts'
import { formatTarget, parseTarget } from '../core/target.ts'
import { EXIT, type Forward, type MirbConfig, type SessionOptions, type Target } from '../core/types.ts'
import { createEventStream } from '../ui/events.ts'
import { createLiveDisplay, formatUptime, localLabel, remoteLabel, type LiveModel } from '../ui/live.ts'
import { createStaticReporter } from '../ui/static.ts'
import { createTheme } from '../ui/theme.ts'
import { envelope, fail, isMachine } from './shared.ts'
import { writePlan } from './supervise.ts'

/**
 * `mirb <host> <ports...>` — the command that is the product.
 *
 * The handler is glue and nothing else: resolve arguments into a `SessionOptions`, hand it
 * to `core/`, and point the result at `ui/`. Every decision with a reason behind it lives in
 * a module this file imports.
 */

/** ssh's ConnectTimeout, in seconds, when the user does not say. */
const DEFAULT_TIMEOUT_S = 10

/** How often the parent asks whether the background supervisor has come up. */
const BACKGROUND_POLL_MS = 40

/**
 * The parent's ceiling for a background start.
 *
 * Deliberately longer than the child's own bind timeout (`max(10s, timeout + 10s)`), so the
 * child always fails first and with a real reason. This firing at all means the supervisor
 * is wedged, which is a different report from "your host is unreachable".
 */
function backgroundBudgetMs(timeoutS: number): number {
  return Math.max(20_000, (timeoutS + 10) * 1000 + 8_000)
}

interface Resolved {
  target: Target
  forwards: Forward[]
  name: string | undefined
  identity: string | undefined
  jump: string | undefined
}

/**
 * The error for a first argument that named neither a profile nor a usable target.
 *
 * Listing the profiles is the whole point: the overwhelmingly likely mistake is a typo in a
 * profile name, and "unknown profile" without the list leaves the user opening config.toml.
 */
function noStartingPoint(head: string, cfg: MirbConfig): MirbError {
  const names = Object.keys(cfg.profiles).sort()
  if (names.length === 0) {
    return new MirbError(
      'USAGE',
      `no ports given for '${head}'`,
      `Name at least one port: mirb ${head} 3000`
    )
  }
  return new MirbError(
    'USAGE',
    `'${head}' is not a known profile, and no ports were given`,
    `Known profiles: ${names.join(', ')}. Or name a port: mirb ${head} 3000`
  )
}

/**
 * Turn positionals and flags into a target and a set of forwards.
 *
 * Resolution order is profile, then target — a profile named `prod` wins over a host named
 * `prod`, because the profile is the thing the user configured on purpose. Flags override
 * the profile's fields one by one, and extra ports append rather than replace: `mirb web
 * 9229` means "the web profile, plus a debugger port".
 */
function resolveInvocation(
  positional: string[],
  cfg: MirbConfig,
  flags: {
    bind?: string
    expose?: boolean
    name?: string
    identity?: string
    jump?: string
    port?: number
  }
): Resolved {
  const head = positional[0]
  if (head === undefined) {
    const names = Object.keys(cfg.profiles).sort()
    throw new MirbError(
      'USAGE',
      'no host given',
      names.length > 0
        ? `Try: mirb <host> <port>, or a profile: ${names.join(', ')}`
        : 'Try: mirb 10.0.0.7 3000'
    )
  }

  const rest = positional.slice(1)
  const profile = resolveProfile(cfg, head)

  if (profile === null && rest.length === 0) {
    // Either the word is a typo'd profile or it is a host with no ports. Both are the same
    // dead end, and both are best answered by showing what mirb actually knows about.
    throw noStartingPoint(head, cfg)
  }

  const raw = profile?.host ?? head
  const target = parseTarget(raw)
  if (flags.port !== undefined) target.port = flags.port

  // Bare `--expose` means "publish it", so it implies the wildcard rather than making the
  // user type an address they'd have to look up.
  const bindAddress =
    flags.bind ?? profile?.bind ?? (flags.expose ? EXPOSED_BIND_ADDRESS : DEFAULT_BIND_ADDRESS)

  // Refused, not warned: a forward bound off-loopback is reachable by every machine on the
  // network (verified against real ssh), GatewayPorts does not prevent it, and ssh itself
  // says nothing. Exposure has to be something the user asked for in as many words.
  assertExposureAllowed(bindAddress, flags.expose === true)

  // Collapse names and brackets to a literal here, once, so ssh, the pre-flight check, the
  // readiness probe and the UI all reason about the same address. `localhost` in particular
  // would otherwise make ssh bind two sockets — see normalizeBindAddress.
  const bind = normalizeBindAddress(bindAddress)
  const specs = [...(profile?.ports ?? []).map(String), ...rest]
  const forwards = parsePortSpecs(specs, { bindAddress: bind })

  return {
    target,
    forwards,
    name: flags.name ?? profile?.name,
    identity: flags.identity ?? profile?.identity,
    jump: flags.jump ?? profile?.jump
  }
}

/**
 * Bun's standalone builds mount the entry inside a virtual filesystem, at `/$bunfs/root/...`
 * on posix and `B:\~BUN\root\...` on Windows. Those paths are the discriminator, and the
 * only reliable one: `existsSync()` answers *true* for them, because Bun shims `node:fs`
 * to resolve the embedded VFS from inside the process — while a *child* process gets no
 * such shim and cannot read the path at all. `Bun.embeddedFiles` is likewise no help; it
 * stays empty unless assets were embedded on top of the entry.
 */
function isCompiledBinary(entry: string): boolean {
  return entry.startsWith('/$bunfs/') || /^[A-Za-z]:\\~BUN\\/.test(entry)
}

/**
 * The argv that re-executes mirb as its own supervisor.
 *
 * A compiled single-file build keeps its entry inside Bun's virtual filesystem, where a
 * child process could never read it — there the executable *is* mirb and takes the command
 * directly. Running from source, the entry has to be passed along to the `bun` in
 * `process.execPath`.
 *
 * `entry` and `execPath` are parameters purely so this is unit-testable: getting it wrong
 * breaks only `--background`, only in the compiled binary, which is exactly the
 * combination no test running from source will ever notice.
 */
export function superviseArgv(
  planFile: string,
  entry: string = Bun.main,
  execPath: string = process.execPath
): string[] {
  return isCompiledBinary(entry) || !existsSync(entry)
    ? [execPath, '__supervise', planFile]
    : [execPath, entry, '__supervise', planFile]
}

/** Pull the failure out of a supervisor's log, so a background start can explain itself. */
async function logFailure(logFile: string): Promise<MirbError> {
  const strip = (line: string) => line.replace(/^\S+\s+mirb:\s*/, '').replace(/^mirb:\s*/, '')
  let message = 'the background supervisor exited before the tunnel came up'
  let hint: string | undefined

  try {
    const lines = (await Bun.file(logFile).text()).split('\n')
    for (const line of lines) {
      if (line.includes(' error: ')) message = strip(line).replace(/^error:\s*/, '')
      else if (line.includes(' hint: ')) hint = strip(line).replace(/^hint:\s*/, '')
    }
  } catch {
    // No log at all means the child died before it could open one; the default says so.
  }

  return new MirbError('INTERNAL', message, hint)
}

export default defineCommand({
  name: 'up' as const,
  description: 'Forward ports from a remote host over ssh',
  // mirb's machine output is JSON, never toon: --json has to mean JSON even on a terminal,
  // and every consumer of this is a program. An explicit --format still wins.
  defaultFormat: 'json' as const,
  options: {
    background: option(z.coerce.boolean().default(false), {
      short: 'b',
      description: 'Detach and keep forwarding after mirb exits',
      argumentKind: 'flag'
    }),
    json: option(z.coerce.boolean().default(false), {
      description: 'Stream NDJSON events on stdout',
      argumentKind: 'flag'
    }),
    'auto-port': option(z.coerce.boolean().default(false), {
      description: 'Take the next free local port when one is busy',
      argumentKind: 'flag'
    }),
    bind: option(z.string().optional(), {
      description: `Local address to bind (default ${DEFAULT_BIND_ADDRESS})`
    }),
    expose: option(z.coerce.boolean().default(false), {
      description: 'Allow binding beyond loopback, making forwards reachable from the network',
      argumentKind: 'flag'
    }),
    name: option(z.string().optional(), { description: 'Label this session for mirb ls' }),
    identity: option(z.string().optional(), { short: 'i', description: 'ssh identity file' }),
    port: option(z.coerce.number().int().min(1).max(65535).optional(), {
      short: 'P',
      description: 'ssh port on the remote host'
    }),
    jump: option(z.string().optional(), { short: 'J', description: 'ssh jump host' }),
    'ssh-option': option(z.array(z.string()).default([]), {
      short: 'o',
      description: 'Pass an option straight to ssh (repeatable)',
      repeatable: true
    }),
    retry: option(z.coerce.number().int().min(0).optional(), {
      description: 'Max reconnect attempts (default: unlimited)'
    }),
    'no-retry': option(z.coerce.boolean().default(false), {
      description: 'Never reconnect',
      argumentKind: 'flag'
    }),
    'no-probe': option(z.coerce.boolean().default(false), {
      description: 'Skip the remote-service probe; report bound instead of ready',
      argumentKind: 'flag'
    }),
    timeout: option(z.coerce.number().int().min(1).default(DEFAULT_TIMEOUT_S), {
      description: 'ssh connect timeout in seconds'
    }),
    quiet: option(z.coerce.boolean().default(false), {
      short: 'q',
      description: 'Suppress progress and summaries (errors and machine output still print)',
      argumentKind: 'flag'
    }),
    'probe-settle': option(z.coerce.number().int().min(1).optional(), {
      description: 'How long a socket must stay open before a forward counts as ready (ms)'
    }),
    'ssh-path': option(z.string().optional(), { description: 'Use a specific ssh binary' })
  },
  handler: async ({ flags, positional, terminal, signal, agent, formatExplicit, output, env }) => {
    const machine = isMachine({ agent, formatExplicit }, flags.json)
    const startedAt = Date.now()

    try {
      // Forwarding smuggled through -o would bypass both the exposure gate and mirb's own
      // state — the port would exist, bound wherever the option said, and appear nowhere.
      assertSshOptionsSafe(flags['ssh-option'])

      const cfg = await loadConfig(env)
      const resolved = resolveInvocation(positional, cfg, flags)

      // Nobody can answer a passphrase prompt in a detached process or in a pipeline, and a
      // prompt written to a stream no one is reading is a hang — the most expensive failure
      // a tool can have. In an interactive foreground, ssh must stay able to ask.
      const batch = flags.background || process.stdin.isTTY !== true

      const options: SessionOptions = {
        target: resolved.target,
        forwards: resolved.forwards,
        name: resolved.name,
        timeout: flags.timeout,
        probe: !flags['no-probe'],
        probeSettleMs: flags['probe-settle'],
        retry: flags['no-retry'] ? 0 : flags.retry,
        sshOptions: flags['ssh-option'],
        identity: resolved.identity,
        jump: resolved.jump,
        // `--ssh-path` and `$MIRB_SSH` are the same affordance, so they resolve through the
        // same executability check — a bad path fails here rather than as a spawn error.
        sshPath: resolveSshPath(flags['ssh-path'] ? { ...env, MIRB_SSH: flags['ssh-path'] } : env),
        batch
      }

      // ssh will also honour LocalForward/DynamicForward from ~/.ssh/config. Those listeners
      // would be invisible to mirb — absent from `ls`, from the event stream, and from `stop` —
      // so an exposed one has to be refused here or the gate is decorative.
      await assertNoExposedConfiguredForwardings(options, flags.expose)

      if (flags.background) {
        await startBackground({
          options,
          env,
          machine,
          quiet: flags.quiet,
          autoPort: flags['auto-port'],
          terminal,
          output,
          startedAt
        })
        return
      }

      await runForeground({
        options,
        env,
        signal,
        machine,
        quiet: flags.quiet,
        autoPort: flags['auto-port'],
        terminal
      })
    } catch (err) {
      // A Ctrl-C during start-up unwinds as an error; it is a decision the user made, not a
      // failure to report to them.
      if (signal.aborted) process.exit(EXIT.SIGINT)
      fail(err)
    }
  }
})

interface BackgroundArgs {
  options: SessionOptions
  env: EnvLike
  machine: boolean
  quiet: boolean
  autoPort: boolean
  terminal: TerminalInfo
  output: (data: unknown) => void
  startedAt: number
}

/**
 * Detach a supervisor, then wait for it to prove the tunnel works.
 *
 * The waiting is the entire value of `--background`. A flag that returned the moment the
 * child was spawned would hand an agent a session id and a set of ports that are not
 * listening yet, and the first thing that agent does is connect to them. So the parent
 * blocks until the child has written a record saying `ready`, and only then prints.
 */
async function startBackground(args: BackgroundArgs): Promise<void> {
  const { options, env, machine, quiet, autoPort, terminal, output, startedAt } = args

  const id = newSessionId()
  const logFile = sessionLogPath(id, env)
  const plan = await writePlan(
    {
      id,
      name: options.name,
      logFile,
      retry: options.retry,
      autoPort,
      probeSettleMs: options.probeSettleMs,
      options
    },
    env
  )

  // stdio fully detached and unref'd: verified to outlive the parent and reparent to pid 1.
  // The child's own stderr would otherwise hold this process's pipe open forever.
  const child = Bun.spawn(superviseArgv(plan), {
    env,
    stdio: ['ignore', 'ignore', 'ignore']
  })
  child.unref()

  let exitCode: number | undefined
  void child.exited.then((code) => {
    exitCode = code
  })

  const deadline = Date.now() + backgroundBudgetMs(options.timeout)

  for (;;) {
    const record = await readSession(id, env).catch(() => null)

    if (record && (record.status === 'ready' || record.status === 'degraded')) {
      if (machine) {
        output(
          envelope(
            'up',
            {
              id: record.id,
              name: record.name,
              pid: record.pid,
              status: record.status,
              target: formatTarget(record.target),
              forwards: record.forwards,
              logFile: record.logFile
            },
            startedAt
          )
        )
      } else if (!quiet) {
        const theme = createTheme({ env, terminal })
        const session = theme.session[record.status]
        const lines = [
          `  ${theme.bold(shortId(record.id))}  ${formatTarget(record.target)}  ${session.paint(session.label)}`
        ]
        for (const f of record.forwards) {
          const style = theme.forward[f.status]
          lines.push(
            `    ${style.paint(style.symbol)} ${localLabel(f)} ${theme.muted(theme.symbols.arrow)} ${theme.muted(remoteLabel(f))}  ${style.paint(style.label)}`
          )
        }
        lines.push(`  ${theme.muted(`stop it with: mirb stop ${shortId(record.id)}`)}`)
        process.stdout.write(`${lines.join('\n')}\n`)
      }
      return
    }

    // The child's exit is the definitive failure signal; the record may never have been
    // written at all if it died early.
    if (exitCode !== undefined) {
      const error = await logFailure(logFile)
      // The failure has been read out of the log and reported; leaving the record behind
      // would put a session in `mirb ls` that never existed, and the log with it.
      await removeSession(id, env)
      createStaticReporter().error(error)
      process.exit(exitCode === 0 ? EXIT.GENERIC : exitCode)
    }

    if (Date.now() >= deadline) {
      throw new MirbError(
        'INTERNAL',
        `the background supervisor did not report a working tunnel within ${Math.round(backgroundBudgetMs(options.timeout) / 1000)}s`,
        `It may still be starting. Check with: mirb ls, or read mirb logs ${shortId(id)}`
      )
    }

    await Bun.sleep(BACKGROUND_POLL_MS)
  }
}

interface ForegroundArgs {
  options: SessionOptions
  env: EnvLike
  signal: AbortSignal
  machine: boolean
  quiet: boolean
  autoPort: boolean
  terminal: TerminalInfo
}

/**
 * Run the session in this process until it is stopped or gives up.
 *
 * Three display modes, chosen in this order because each is the only correct answer in its
 * case: NDJSON when something is consuming stdout, the live frame when a human is watching
 * a real terminal, and append-only lines everywhere else — a CI log, a dumb terminal, a
 * redirected stream. `--quiet` removes the human half of that and nothing else: errors still
 * print, and so does anything a program asked for, because silencing data a caller requested
 * is not what quiet means anywhere else.
 */
async function runForeground(args: ForegroundArgs): Promise<void> {
  const { options, env, signal, machine, quiet, autoPort, terminal } = args

  const supervisor = new Supervisor(options, {
    signal,
    retry: options.retry,
    session: { autoPort, probeSettleMs: options.probeSettleMs }
  })

  const startedAt = Date.now()
  let note: string | undefined

  const model = (): LiveModel => ({
    target: formatTarget(options.target),
    forwards: supervisor.forwards,
    status: supervisor.status,
    startedAt,
    sshPid: supervisor.sshPid,
    reconnects: supervisor.reconnects,
    probe: options.probe,
    note
  })

  // A live frame needs a terminal that can move a cursor. Anything else — CI, TERM=dumb,
  // a redirect — gets lines that still make sense read out of a file six hours later.
  const live = !machine && !quiet && terminal.isInteractive && !terminal.isCI && env.TERM !== 'dumb'
  const stream = machine ? createEventStream() : undefined
  const display = live
    ? createLiveDisplay({
        theme: createTheme({ env, terminal }),
        signal,
        // Read live so a resize is picked up, but never trust a 0 — a pty that has not been
        // sized yet reports one, and a frame one column wide is every line truncated away.
        width: () => process.stdout.columns || terminal.width,
        height: () => process.stdout.rows || terminal.height
      })
    : undefined
  const reporter = !machine && !quiet && !live ? createStaticReporter() : undefined

  let ticker: ReturnType<typeof setInterval> | undefined

  const paint = () => {
    display?.update(model())
    reporter?.update(model())
  }

  supervisor.on('session.reconnecting', (e) => {
    note = `reconnecting in ${Math.round(e.delayMs / 1000)}s (attempt ${e.attempt})`
  })
  supervisor.on('session.ready', () => {
    note = undefined
  })
  supervisor.onAny((e) => {
    stream?.emit(e)
    paint()
  })

  const finish = () => {
    if (ticker !== undefined) clearInterval(ticker)
    stream?.close()
  }

  try {
    if (display) {
      // The uptime counter is the only thing on screen that changes without an event.
      ticker = setInterval(() => display.update(model()), 1000)
      display.update(model())
    }
    await supervisor.start()
  } catch (err) {
    finish()
    display?.stop()
    throw err
  }

  const exit = await supervisor.finished
  finish()
  display?.stop({ note: `stopped after ${formatUptime(Date.now() - startedAt)}` })
  reporter?.stop(model())

  if (signal.aborted || exit.requested) process.exit(EXIT.SIGINT)
  if (exit.error) fail(exit.error)
  process.exit(EXIT.OK)
}

/**
 * Refuse to start when ssh's own configuration would bind a forward beyond this machine.
 *
 * `--ssh-option` already rejects forwarding keywords, but `~/.ssh/config` is the other way in,
 * and it is the more dangerous one: a `LocalForward 0.0.0.0:…` written months ago under a
 * `Host` block would expose a service every time that host is used, silently. `ssh -G` tells
 * us what ssh actually resolved, so we ask rather than guess.
 */
async function assertNoExposedConfiguredForwardings(
  options: SessionOptions,
  expose: boolean
): Promise<void> {
  if (expose) return

  const configured = await inspectConfiguredForwardings(options)
  const exposed = configured.filter((f) => isExposedAddress(f.bindAddress))
  if (exposed.length === 0) return

  throw new MirbError(
    'USAGE',
    `your ssh config sets up forwarding that would bind beyond this machine: ${exposed.map((f) => f.raw).join('; ')}`,
    'Remove the LocalForward/DynamicForward from ~/.ssh/config for this host, or pass --expose to accept it.'
  )
}
