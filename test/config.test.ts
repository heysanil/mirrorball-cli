import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, loadConfig, resolveProfile } from '../core/config.ts'
import { MirbError } from '../core/errors.ts'
import type { EnvLike } from '../core/config.ts'

let dir = ''
let env: EnvLike = {}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mirb-config-'))
  env = { MIRB_CONFIG: join(dir, 'config.toml') }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeConfig(toml: string): Promise<void> {
  await Bun.write(join(dir, 'config.toml'), toml)
}

/** Every rejection path must be an MirbError with the CONFIG code, never a raw throw. */
async function expectConfigError(toml: string): Promise<MirbError> {
  await writeConfig(toml)
  try {
    await loadConfig(env)
  } catch (err) {
    expect(err).toBeInstanceOf(MirbError)
    expect((err as MirbError).code).toBe('CONFIG')
    return err as MirbError
  }
  throw new Error('expected loadConfig to throw')
}

describe('configPath', () => {
  test('$MIRB_CONFIG names the file outright', () => {
    expect(configPath({ MIRB_CONFIG: '/somewhere/custom.toml' })).toBe('/somewhere/custom.toml')
  })

  test('falls back to the XDG config directory', () => {
    const path = configPath({ XDG_CONFIG_HOME: '/xdg' })
    expect(path).toBe(join('/xdg', 'mirb', 'config.toml'))
  })

  test('ignores an empty override', () => {
    expect(configPath({ MIRB_CONFIG: '   ', XDG_CONFIG_HOME: '/xdg' })).toBe(
      join('/xdg', 'mirb', 'config.toml')
    )
  })
})

describe('loadConfig', () => {
  test('a missing file is an empty config, not an error', async () => {
    expect(await loadConfig(env)).toEqual({ profiles: {} })
  })

  test('an empty file is an empty config', async () => {
    await writeConfig('')
    expect(await loadConfig(env)).toEqual({ profiles: {} })
  })

  test('round-trips a full profile', async () => {
    await writeConfig(`
[profiles.web]
host = "deploy@10.0.0.7"
ports = [3000, "8080:80"]
name = "web tier"
identity = "~/.ssh/id_ed25519"
jump = "bastion.example.com"
bind = "0.0.0.0"
`)

    const cfg = await loadConfig(env)
    expect(cfg.profiles.web).toEqual({
      host: 'deploy@10.0.0.7',
      ports: [3000, '8080:80'],
      name: 'web tier',
      identity: '~/.ssh/id_ed25519',
      jump: 'bastion.example.com',
      bind: '0.0.0.0'
    })
  })

  test('keeps several profiles apart', async () => {
    await writeConfig(`
[profiles.web]
host = "web"
ports = [3000]

[profiles.db]
host = "db"
ports = ["5432"]
`)
    const cfg = await loadConfig(env)
    expect(Object.keys(cfg.profiles).sort()).toEqual(['db', 'web'])
    expect(cfg.profiles.db?.ports).toEqual(['5432'])
  })

  test('lifts a scalar `ports` into a list', async () => {
    await writeConfig('[profiles.one]\nhost = "h"\nports = 3000\n')
    expect((await loadConfig(env)).profiles.one?.ports).toEqual([3000])
  })

  test('malformed TOML reports the line', async () => {
    const err = await expectConfigError('[profiles.web\nhost = "x"\n')
    expect(err.message).toContain('not valid TOML')
    expect(err.message).toMatch(/line \d+/)
  })

  test('a top-level typo is pointed at [profiles.<name>]', async () => {
    const err = await expectConfigError('[web]\nhost = "h"\nports = [3000]\n')
    expect(err.message).toContain("unknown setting 'web'")
    expect(err.hint).toContain('[profiles.web]')
  })

  test('an unknown profile key names the key', async () => {
    const err = await expectConfigError('[profiles.web]\nhost = "h"\nports = [1]\nhsot = "x"\n')
    expect(err.message).toContain("unknown setting 'profiles.web.hsot'")
  })

  test('a wrong type names the offending key', async () => {
    const err = await expectConfigError('[profiles.web]\nhost = 42\nports = [3000]\n')
    expect(err.message).toContain('profiles.web.host')
    expect(err.message).toContain('expected string')
  })

  test('a missing required key names it', async () => {
    const err = await expectConfigError('[profiles.web]\nports = [3000]\n')
    expect(err.message).toContain('profiles.web.host')
  })

  test('an empty ports list is rejected', async () => {
    const err = await expectConfigError('[profiles.web]\nhost = "h"\nports = []\n')
    expect(err.message).toContain('profiles.web.ports')
  })

  test('a nonsense port element names its index', async () => {
    const err = await expectConfigError('[profiles.web]\nhost = "h"\nports = [3000, true]\n')
    expect(err.message).toContain('profiles.web.ports[1]')
  })

  test('an out-of-range port is rejected', async () => {
    const err = await expectConfigError('[profiles.web]\nhost = "h"\nports = [99999]\n')
    expect(err.message).toContain('profiles.web.ports[0]')
  })

  test('several problems are counted, not dumped', async () => {
    const err = await expectConfigError('[profiles.web]\nhost = 1\nports = [true]\n')
    expect(err.message).toContain('other problem')
  })
})

describe('resolveProfile', () => {
  test('finds a profile by exact name', () => {
    const profile = { host: 'h', ports: [3000] }
    expect(resolveProfile({ profiles: { web: profile } }, 'web')).toBe(profile)
  })

  test('returns null for an unknown name so it can be treated as a host', () => {
    expect(resolveProfile({ profiles: {} }, 'prod')).toBeNull()
  })

  test('is case-sensitive', () => {
    expect(resolveProfile({ profiles: { web: { host: 'h', ports: [1] } } }, 'WEB')).toBeNull()
  })
})
