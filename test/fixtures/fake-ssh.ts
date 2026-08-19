#!/usr/bin/env bun
/**
 * A stand-in for `ssh(1)`, so mirb's runtime can be tested end to end with no ssh server, no
 * network, and no credentials anywhere.
 *
 * The trick that makes it worth having: it parses the `-L` specs it is handed and *actually
 * listens* on those local ports. Since mirb's readiness signal is a TCP connect to the local
 * port (never a line of ssh stderr), a fake that binds is indistinguishable from the real
 * thing as far as the three-state model is concerned — and a fake that binds and then hangs
 * up on you is exactly a tunnel to a dead remote service.
 *
 * Point mirb at it with `MIRB_SSH` (or `SessionOptions.sshPath`) and script it with the
 * environment:
 *
 *   FAKE_SSH_MODE          comma-separated, one per invocation; the last entry repeats, so
 *                          'die,ok' means "fail once, then work forever".
 *     ok            bind, accept, hold connections open           -> probe says 'ready'
 *     refused       bind, but hang up on every connection         -> probe says 'refused'
 *     slow          wait FAKE_SSH_BIND_DELAY_MS, then behave as ok
 *     hang          never bind, never exit                        -> bind timeout
 *     die           behave as ok, then exit after FAKE_SSH_LIFETIME_MS
 *     auth-fail     "Permission denied (publickey)."      exit 255
 *     connect-fail  "...Connection refused"               exit 255
 *     bind-fail     ssh's own local-forward bind failure   exit 255
 *     ignore-term   behave as ok, but swallow SIGTERM (tests SIGKILL escalation)
 *   FAKE_SSH_STATE         directory; one JSON line per invocation is appended to
 *                          attempts.log, which is how tests count spawns exactly.
 *   FAKE_SSH_BIND_DELAY_MS, FAKE_SSH_LIFETIME_MS, FAKE_SSH_EXIT_CODE
 */
import { appendFileSync, mkdirSync, readFileSync, writeSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

const argv = process.argv.slice(2)

/** `bind:localPort:remoteHost:remotePort`, with either host possibly bracketed for IPv6. */
const SPEC = /^(?:\[([^\]]+)\]|([^:]*)):(\d+):(?:\[([^\]]+)\]|([^:]+)):(\d+)$/

interface Listener {
  bind: string
  port: number
}

function forwards(): Listener[] {
  const out: Listener[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-L') continue
    const match = SPEC.exec(argv[i + 1] ?? '')
    if (!match) continue
    const bind = match[1] ?? match[2] ?? ''
    out.push({ bind: bind === '' || bind === '*' ? '0.0.0.0' : bind, port: Number(match[3]) })
  }
  return out
}

const stateDir = process.env.FAKE_SSH_STATE
const attemptsLog = stateDir ? join(stateDir, 'attempts.log') : null

function priorAttempts(): number {
  if (!attemptsLog) return 0
  try {
    return readFileSync(attemptsLog, 'utf8').split('\n').filter((line) => line.trim().length > 0).length
  } catch {
    return 0
  }
}

const attempt = priorAttempts()
const modes = (process.env.FAKE_SSH_MODE ?? 'ok')
  .split(',')
  .map((m) => m.trim())
  .filter((m) => m.length > 0)
const mode = modes[Math.min(attempt, modes.length - 1)] ?? 'ok'

if (stateDir && attemptsLog) {
  mkdirSync(stateDir, { recursive: true })
  // Written before anything can fail, so the count is honest even for the modes that exit
  // immediately — a test asserting "did not retry" depends on it.
  appendFileSync(attemptsLog, `${JSON.stringify({ attempt, mode, pid: process.pid, argv })}\n`)
}

const number = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** writeSync(2) rather than process.stderr.write: process.exit must not outrun the message. */
function say(message: string): void {
  writeSync(2, message.endsWith('\n') ? message : `${message}\n`)
}

function die(message: string, code = number('FAKE_SSH_EXIT_CODE', 255)): never {
  say(message)
  process.exit(code)
}

/** Held so the sockets are not collected; 'ok' means the peer sees a connection that stays up. */
const open = new Set<net.Socket>()

function listen(hangUp: boolean): void {
  for (const forward of forwards()) {
    const server = net.createServer((socket) => {
      open.add(socket)
      socket.on('close', () => open.delete(socket))
      socket.on('error', () => {})
      // end(), not destroy(): a FIN is what ssh sends after a channel-open failure, and it
      // is the case mirb's probe has to tell apart from a healthy connection.
      if (hangUp) socket.end()
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      die(`bind [${forward.bind}]:${forward.port}: ${err.code ?? err.message}`)
    })
    server.listen(forward.port, forward.bind)
  }
}

switch (mode) {
  case 'auth-fail':
    die('Permission denied (publickey,keyboard-interactive).')
  case 'connect-fail':
    die('ssh: connect to host fake.invalid port 22: Connection refused')
  case 'bind-fail':
    die(
      'bind [127.0.0.1]:3000: Address already in use\n' +
        'channel_setup_fwd_listener_tcpip: cannot listen to port: 3000\n' +
        'Could not request local forwarding.'
    )
  case 'hang':
    // Nothing binds and nothing exits: the caller's bind timeout is the only way out.
    setInterval(() => {}, 1 << 30)
    break
  case 'slow':
    setTimeout(() => listen(false), number('FAKE_SSH_BIND_DELAY_MS', 200))
    break
  case 'refused':
    listen(true)
    break
  case 'die':
    listen(false)
    setTimeout(() => {
      die('Timeout, server fake.invalid not responding.')
    }, number('FAKE_SSH_LIFETIME_MS', 150))
    break
  case 'ignore-term':
    process.on('SIGTERM', () => {})
    listen(false)
    break
  default:
    listen(false)
    break
}
