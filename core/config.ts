import { homedir } from 'node:os'
import { join } from 'node:path'
import { configDir, type PlatformEnv } from '@bunli/utils'
import { z } from 'zod'
import { MirbError } from './errors.ts'
import type { MirbConfig, Profile } from './types.ts'

/**
 * The subset of `process.env` these modules need. Passed in rather than read from the
 * global so tests never have to mutate (and race on) the real environment, and so the
 * bunli handler's `env` can be threaded straight through.
 */
export type EnvLike = Record<string, string | undefined>

/** Compile-time proof that a zod schema still matches the shared contract. */
type AssertExtends<A extends B, B> = A

const portEntrySchema = z.union([
  z.string().min(1),
  z.number().int().min(1).max(65535)
])

/**
 * `ports = 3000` is what people write when a profile forwards exactly one port, and
 * failing that with "expected array" would be pedantry. A scalar is lifted into a
 * one-element list; `undefined` is left alone so a *missing* key still reports as one.
 */
const portsSchema = z.preprocess(
  (value) => (value === undefined || Array.isArray(value) ? value : [value]),
  z.array(portEntrySchema).min(1)
)

/**
 * strictObject, deliberately: the whole point of validating config is to catch
 * `hosts = ` before it silently becomes "no host at all".
 */
const profileSchema = z.strictObject({
  host: z.string().min(1),
  ports: portsSchema,
  name: z.string().optional(),
  identity: z.string().optional(),
  jump: z.string().optional(),
  bind: z.string().optional()
})

const configSchema = z.strictObject({
  profiles: z.record(z.string(), profileSchema).default({})
})

type _ProfileMatchesContract = AssertExtends<z.infer<typeof profileSchema>, Profile>
type _ConfigMatchesContract = AssertExtends<z.infer<typeof configSchema>, MirbConfig>

function platformEnv(env: EnvLike): PlatformEnv {
  return { platform: process.platform, env, homedir: homedir() }
}

/**
 * Absolute path to config.toml.
 *
 * `$MIRB_CONFIG` names the *file*, not its directory — it exists so tests and one-off
 * invocations can point at a throwaway config without an XDG dance.
 */
export function configPath(env: EnvLike = process.env): string {
  const override = env.MIRB_CONFIG?.trim()
  if (override) return override
  return join(configDir('mirb', platformEnv(env)), 'config.toml')
}

/** `profiles.web.ports[0]` — the string a user can actually search their file for. */
function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`
    return acc === '' ? String(segment) : `${acc}.${String(segment)}`
  }, '')
}

/**
 * Turn the first zod issue into a sentence that names the offending key.
 *
 * Only the first is reported: a config with five problems is almost always one
 * misunderstanding, and five stacked messages read like a stack trace.
 */
function describeIssue(issue: z.core.$ZodIssue): { message: string; hint?: string } {
  if (issue.code === 'unrecognized_keys') {
    const parent = formatPath(issue.path)
    const key = issue.keys[0] ?? '?'
    const full = parent === '' ? key : `${parent}.${key}`
    return {
      message: `unknown setting '${full}'`,
      hint:
        parent === ''
          ? `Profiles live under [profiles.<name>] — did you mean [profiles.${key}]?`
          : `Valid profile keys: host, ports, name, identity, jump, bind.`
    }
  }

  const where = formatPath(issue.path)
  const what = issue.message.replace(/^Invalid input:\s*/, '')
  return { message: where === '' ? what : `${where}: ${what}` }
}

/** Bun's TOML parser reports an AggregateError of BuildMessages; each carries a line. */
function describeTomlError(err: unknown): string {
  const sub = err instanceof AggregateError ? err.errors : []
  const parts: string[] = []

  for (const message of sub.slice(0, 2)) {
    const line = (message as { line?: unknown }).line
    const text = (message as { message?: unknown }).message
    if (typeof text !== 'string') continue
    parts.push(typeof line === 'number' ? `line ${line}: ${text}` : text)
  }

  if (parts.length > 0) return parts.join('; ')
  return err instanceof Error ? err.message : 'not valid TOML'
}

/**
 * Read and validate config.toml.
 *
 * A missing file is the overwhelmingly common case — mirrorball is fully usable without one —
 * so it resolves to an empty config rather than an error. Anything that *is* on disk
 * but wrong throws, because silently ignoring a profile the user is trying to use is
 * far more confusing than refusing to start.
 */
export async function loadConfig(env: EnvLike = process.env): Promise<MirbConfig> {
  const path = configPath(env)
  const file = Bun.file(path)

  if (!(await file.exists())) return { profiles: {} }

  let text: string
  try {
    text = await file.text()
  } catch (err) {
    throw new MirbError(
      'CONFIG',
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      'Check the file permissions.'
    )
  }

  let raw: unknown
  try {
    raw = Bun.TOML.parse(text)
  } catch (err) {
    throw new MirbError('CONFIG', `${path} is not valid TOML — ${describeTomlError(err)}`)
  }

  const result = configSchema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    const { message, hint } = first
      ? describeIssue(first)
      : { message: 'failed validation', hint: undefined }
    const extra = result.error.issues.length - 1
    const suffix = extra > 0 ? ` (and ${extra} other problem${extra > 1 ? 's' : ''})` : ''
    throw new MirbError('CONFIG', `${path}: ${message}${suffix}`, hint)
  }

  return result.data
}

/**
 * Look up a profile by name. Returns null rather than throwing so callers can fall
 * back to treating the word as a hostname — `mirb prod 3000` is ambiguous by design,
 * and a profile named "prod" simply wins over a host named "prod".
 */
export function resolveProfile(cfg: MirbConfig, name: string): Profile | null {
  return cfg.profiles[name] ?? null
}
