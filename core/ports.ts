import net from 'node:net'
import { MirbError } from './errors.ts'
import type { Forward } from './types.ts'

/**
 * Local port pre-flight.
 *
 * ssh's own bind failure is a single opaque line on stderr ("bind: Address already in
 * use") that arrives *after* authentication, so the user pays for a full connection
 * before learning their port was taken. Checking locally first turns that into an
 * instant, specific error that can even name the process holding the port.
 *
 * This is about error quality, not safety: a port free here can be taken microseconds
 * later. `-o ExitOnForwardFailure=yes` remains the real backstop.
 */

/**
 * Whoever is sitting on the port. Purely a nicety layered on top of the bind probe —
 * the probe is ground truth, this only explains it.
 */
export interface ProcessInfo {
  command: string
  pid: number
  user?: string
}

export type PortCheck =
  | { free: true }
  | { free: false; reason: 'in-use' | 'privileged'; holder?: ProcessInfo }

/** Below this, binding needs root on every platform mirb runs on. */
const PRIVILEGED_BELOW = 1024

/** Bounded so a machine with a busy block fails fast instead of scanning to 65535. */
const AUTO_PORT_TRIES = 100

/** lsof can wedge on a stuck mount or a huge process table; a holder name is never worth hanging for. */
const LSOF_TIMEOUT_MS = 1500

/**
 * Translate an ssh bind address into one node:net can probe meaningfully.
 *
 * `*` is how ssh spells "every interface"; node:net spells it `0.0.0.0`, and probing
 * the literal `*` fails for a reason that has nothing to do with the port.
 *
 * `localhost` is the subtler one: node resolves it to `::1` first on most systems, so
 * probing the name can bind a *different* address than the one the service occupies
 * and cheerfully report a busy port as free. Dev servers listen on 127.0.0.1, so that
 * is what we test.
 */
function probeHost(bindAddress: string): string {
  if (!bindAddress || bindAddress === 'localhost') return '127.0.0.1'
  if (bindAddress === '*') return '0.0.0.0'
  // `[::1]` is ssh's spelling, not the kernel's: brackets exist to disambiguate a colon-
  // delimited -L spec. Passing them through to listen() fails with "Failed to listen at
  // [::1]", so a user who reasonably copied the bracketed form out of an ssh man page
  // would be told their port was unusable. Strip them for the OS; ssh still gets them.
  const unbracketed = bindAddress.startsWith('[') && bindAddress.endsWith(']')
    ? bindAddress.slice(1, -1)
    : bindAddress
  return unbracketed
}

/**
 * 127.0.0.1 is what we bind, but "localhost:3000" is what people paste into a browser,
 * so that is what error messages should say.
 */
function label(bindAddress: string, port: number): string {
  const host = probeHost(bindAddress)
  const shown = host === '127.0.0.1' || host === '::1' ? 'localhost' : host
  return `${shown}:${port}`
}

/** Two forwards collide when they share a port and either side binds every interface. */
function overlaps(a: string, b: string): boolean {
  const [x, y] = [probeHost(a), probeHost(b)]
  return x === y || x === '0.0.0.0' || y === '0.0.0.0' || x === '::' || y === '::'
}

type BindFailure = 'in-use' | 'privileged' | null

/**
 * The one source of truth: actually try to bind. Anything softer (scanning /proc,
 * asking lsof) disagrees with the kernel often enough to matter.
 *
 * `exclusive` keeps libuv from handing back a shared cluster handle, which would
 * silently succeed on a port another worker already owns.
 */
function bindProbe(port: number, host: string): Promise<BindFailure> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()

    server.once('error', (err: NodeJS.ErrnoException) => {
      // The listen failed, so there is no socket to close.
      if (err.code === 'EADDRINUSE') return resolve('in-use')
      if (err.code === 'EACCES') return resolve('privileged')
      reject(
        new MirbError(
          'USAGE',
          `cannot bind ${host}:${port}: ${err.code ?? err.message}`,
          'Check the bind address is one this machine actually has.'
        )
      )
    })

    server.once('listening', () => {
      server.close(() => resolve(null))
    })

    server.listen({ port, host, exclusive: true })
  })
}

/**
 * Ask lsof who is listening. Every failure mode here — lsof missing, lsof refusing,
 * lsof hanging, output in a format we don't recognise — is answered with null, because
 * this only ever decorates an error we are already going to raise.
 */
export async function findHolder(port: number): Promise<ProcessInfo | null> {
  try {
    if (!Bun.which('lsof')) return null

    // Field mode (-F) instead of the human table: the table truncates COMMAND to nine
    // characters and shifts columns depending on the widest row on the machine.
    const proc = Bun.spawn(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-FpcL'], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
      timeout: LSOF_TIMEOUT_MS
    })

    const text = await new Response(proc.stdout).text()
    await proc.exited
    return parseLsofFields(text)
  } catch {
    return null
  }
}

/** `-F` emits one tagged field per line: `p<pid>`, `c<command>`, `L<login>`. */
function parseLsofFields(text: string): ProcessInfo | null {
  let pid: number | undefined
  let command: string | undefined
  let user: string | undefined

  for (const line of text.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      // A second record means several listeners (pre-forked workers, SO_REUSEPORT).
      // Naming the first one is enough to point the user at the culprit.
      if (pid !== undefined) break
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n)) pid = n
    } else if (tag === 'c') {
      command = value
    } else if (tag === 'L') {
      user = value
    }
  }

  if (pid === undefined || !command) return null
  return user ? { command, pid, user } : { command, pid }
}

/**
 * Is this local port usable, and if not, why? `host` defaults to loopback because that
 * is what mirb binds unless the user asks for more exposure.
 *
 * Throws MirbError('USAGE') only when the *address* is unusable (e.g. an IP this machine
 * does not have) — that is a different mistake from a busy port and deserves saying so.
 */
export async function checkPort(port: number, host = '127.0.0.1'): Promise<PortCheck> {
  const failure = await bindProbe(port, probeHost(host))
  if (failure === null) return { free: true }
  // A privileged port has no holder to blame — the kernel refused us, not a process.
  if (failure === 'privileged') return { free: false, reason: 'privileged' }

  const holder = await findHolder(port)
  return holder ? { free: false, reason: 'in-use', holder } : { free: false, reason: 'in-use' }
}

interface Claim {
  address: string
  port: number
  source: string
}

function inUseError(bindAddress: string, port: number, holder?: ProcessInfo): MirbError {
  const who = holder ? ` by ${holder.command} (pid ${holder.pid})` : ''
  return new MirbError(
    'PORT_IN_USE',
    `${label(bindAddress, port)} is already in use${who}`,
    'Pass --auto-port to take the next free port, or choose another local port.'
  )
}

/**
 * Walk upward for a port nobody holds.
 *
 * Deliberately linear and adjacent: --auto-port exists so that "3000 was taken, here is
 * 3001" stays predictable enough to guess. A random high port would be free more often
 * and useful much less.
 */
async function nextFreePort(start: number, bindAddress: string, claimed: Claim[]): Promise<number> {
  const host = probeHost(bindAddress)

  for (let i = 1; i <= AUTO_PORT_TRIES; i++) {
    const candidate = start + i
    if (candidate > 65535) break
    if (claimed.some((c) => c.port === candidate && overlaps(c.address, bindAddress))) continue
    if (await bindProbe(candidate, host) === null) return candidate
  }

  throw new MirbError(
    'PORT_IN_USE',
    `no free local port between ${start + 1} and ${Math.min(start + AUTO_PORT_TRIES, 65535)}`,
    'Free some ports, or name a local port explicitly.'
  )
}

/**
 * Check every local port before a single packet goes to ssh.
 *
 * Returns the forwards to actually use — identical to the input unless autoPort shifted
 * something. `source` is left alone on a shifted forward so the UI can still show what
 * the user asked for next to what they got.
 *
 * A privileged port throws even under autoPort: shifting past it would mean skipping the
 * whole 1-1023 range and handing back a port bearing no relation to the one requested.
 * "80 is taken, here is 1024" is not a guess anyone would make.
 */
export async function preflight(forwards: Forward[], opts: { autoPort: boolean }): Promise<Forward[]> {
  const claimed: Claim[] = []
  const resolved: Forward[] = []

  for (const forward of forwards) {
    const { bindAddress, localPort, source } = forward

    // A duplicate inside one command is a typo, and ssh would only report it as a
    // generic bind failure after connecting.
    const clash = claimed.find((c) => c.port === localPort && overlaps(c.address, bindAddress))
    if (clash) {
      if (!opts.autoPort) {
        throw new MirbError(
          'PORT_IN_USE',
          `${label(bindAddress, localPort)} is requested twice ('${clash.source}' and '${source}')`,
          'Each forward needs its own local port.'
        )
      }
      const shifted = await nextFreePort(localPort, bindAddress, claimed)
      claimed.push({ address: bindAddress, port: shifted, source })
      resolved.push({ ...forward, localPort: shifted })
      continue
    }

    const check = await checkPort(localPort, bindAddress)

    if (check.free) {
      claimed.push({ address: bindAddress, port: localPort, source })
      resolved.push(forward)
      continue
    }

    if (check.reason === 'privileged') {
      throw new MirbError(
        'PORT_PRIVILEGED',
        `${label(bindAddress, localPort)} needs root: ports below ${PRIVILEGED_BELOW} are privileged`,
        // 80 -> 8080, 443 -> 8443: the shift people already use by hand.
        `Use a local port above ${PRIVILEGED_BELOW - 1}, e.g. ${localPort + 8000}:${forward.remotePort}.`
      )
    }

    if (!opts.autoPort) throw inUseError(bindAddress, localPort, check.holder)

    const shifted = await nextFreePort(localPort, bindAddress, claimed)
    claimed.push({ address: bindAddress, port: shifted, source })
    resolved.push({ ...forward, localPort: shifted })
  }

  return resolved
}
