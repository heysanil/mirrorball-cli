import { describe, expect, test } from 'bun:test'
import net from 'node:net'
import { checkPort, findHolder, preflight } from '../core/ports.ts'
import { MirbError } from '../core/errors.ts'
import type { Forward } from '../core/types.ts'

const isRoot = process.getuid?.() === 0
const hasLsof = Bun.which('lsof') !== null

interface Held {
  port: number
  release: () => Promise<void>
}

/** Bind a real socket: the whole point of the module is that it agrees with the kernel. */
function hold(port = 0, host = '127.0.0.1'): Promise<Held> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ port, host, exclusive: true }, () => {
      const address = server.address() as net.AddressInfo
      resolve({
        port: address.port,
        release: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}

/** An ephemeral port that has just been released: as close to "known free" as one gets. */
async function freePort(): Promise<number> {
  const held = await hold()
  await held.release()
  return held.port
}

function forward(localPort: number, overrides: Partial<Forward> = {}): Forward {
  return {
    localPort,
    bindAddress: '127.0.0.1',
    remoteHost: 'localhost',
    remotePort: localPort,
    source: String(localPort),
    ...overrides
  }
}

describe('checkPort', () => {
  test('reports a listening port as in-use', async () => {
    const held = await hold()
    try {
      const result = await checkPort(held.port)
      expect(result.free).toBe(false)
      expect(result.free === false && result.reason).toBe('in-use')
    } finally {
      await held.release()
    }
  })

  test.skipIf(!hasLsof)('names the process holding the port', async () => {
    const held = await hold()
    try {
      const result = await checkPort(held.port)
      expect(result.free).toBe(false)
      if (result.free) throw new Error('unreachable')
      expect(result.holder).toBeDefined()
      expect(result.holder?.pid).toBe(process.pid)
      expect(result.holder?.command).toBeTruthy()
    } finally {
      await held.release()
    }
  })

  test('reports a free high port as free', async () => {
    expect(await checkPort(await freePort())).toEqual({ free: true })
  })

  test('probes 127.0.0.1 for localhost, where services actually listen', async () => {
    const held = await hold()
    try {
      expect((await checkPort(held.port, 'localhost')).free).toBe(false)
    } finally {
      await held.release()
    }
  })

  test.skipIf(isRoot)('reports a privileged port as privileged', async () => {
    const result = await checkPort(1)
    expect(result.free).toBe(false)
    expect(result.free === false && result.reason).toBe('privileged')
  })
})

describe('findHolder', () => {
  test.skipIf(!hasLsof)('finds the listening process', async () => {
    const held = await hold()
    try {
      const holder = await findHolder(held.port)
      expect(holder?.pid).toBe(process.pid)
    } finally {
      await held.release()
    }
  })

  test('returns null when nothing is listening', async () => {
    expect(await findHolder(await freePort())).toBeNull()
  })
})

describe('preflight', () => {
  test('passes free ports through untouched', async () => {
    const a = await freePort()
    const b = await freePort()
    const input = [forward(a), forward(b)]
    expect(await preflight(input, { autoPort: false })).toEqual(input)
  })

  test('throws PORT_IN_USE naming the holder', async () => {
    const held = await hold()
    try {
      const error = await preflight([forward(held.port)], { autoPort: false }).catch((e) => e)
      expect(error).toBeInstanceOf(MirbError)
      expect(error.code).toBe('PORT_IN_USE')
      expect(error.exitCode).toBe(4)
      expect(error.message).toContain(`localhost:${held.port}`)
      if (hasLsof) expect(error.message).toContain(`pid ${process.pid}`)
    } finally {
      await held.release()
    }
  })

  test('autoPort shifts past a run of occupied ports', async () => {
    const first = await hold()
    // Occupying the immediate neighbour proves the search walks rather than adds one.
    const second = await hold(first.port + 1).catch(() => null)
    try {
      const result = await preflight([forward(first.port)], { autoPort: true })
      expect(result).toHaveLength(1)
      const shifted = result[0]!
      expect(shifted.localPort).toBeGreaterThan(second ? first.port + 1 : first.port)
      expect(await checkPort(shifted.localPort)).toEqual({ free: true })
      // Only the local side moves; the remote and the user's original text survive.
      expect(shifted.remotePort).toBe(first.port)
      expect(shifted.source).toBe(String(first.port))
    } finally {
      await second?.release()
      await first.release()
    }
  })

  test.skipIf(isRoot)('throws PORT_PRIVILEGED even with autoPort', async () => {
    const error = await preflight([forward(80, { remotePort: 80 })], { autoPort: true }).catch((e) => e)
    expect(error).toBeInstanceOf(MirbError)
    expect(error.code).toBe('PORT_PRIVILEGED')
    expect(error.exitCode).toBe(4)
    expect(error.hint).toContain('8080:80')
  })

  test('rejects the same local port requested twice', async () => {
    const port = await freePort()
    const error = await preflight([forward(port), forward(port)], { autoPort: false }).catch((e) => e)
    expect(error).toBeInstanceOf(MirbError)
    expect(error.code).toBe('PORT_IN_USE')
    expect(error.message).toContain('twice')
  })

  test('autoPort separates two forwards that asked for the same port', async () => {
    const port = await freePort()
    const result = await preflight([forward(port), forward(port)], { autoPort: true })
    expect(result[0]!.localPort).toBe(port)
    expect(result[1]!.localPort).toBeGreaterThan(port)
  })

  test('treats a wildcard bind as colliding with loopback on the same port', async () => {
    const port = await freePort()
    const error = await preflight(
      [forward(port), forward(port, { bindAddress: '*' })],
      { autoPort: false }
    ).catch((e) => e)
    expect(error).toBeInstanceOf(MirbError)
    expect(error.code).toBe('PORT_IN_USE')
  })
})
