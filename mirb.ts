#!/usr/bin/env bun
import { createCLI } from '@bunli/core'
import pkg from './package.json' with { type: 'json' }

import upCommand from './commands/up.ts'
import lsCommand from './commands/ls.ts'
import stopCommand from './commands/stop.ts'
import logsCommand from './commands/logs.ts'
import superviseCommand from './commands/supervise.ts'

/**
 * Commands that own the first argv slot. Anything else in that slot is a target
 * or a profile name, and belongs to `up`.
 */
const RESERVED = new Set(['up', 'ls', 'stop', 'logs', '__supervise'])

/**
 * Bunli has no default/root command: `findCommand()` matches argv against registered
 * command names and throws CommandNotFoundError otherwise. `mirb 10.0.0.7 3000` would
 * exit 1. So we inject `up` before handing argv over.
 *
 * Only argv[0] is consulted. That keeps the rule unambiguous and avoids mistaking an
 * option *value* for a subcommand. `mirb up ls 3000` targets a host literally named "ls".
 */
export function normalizeArgv(argv: string[]): string[] {
  const head = argv[0]
  if (head !== undefined && RESERVED.has(head)) return argv
  if (argv.some((a) => !a.startsWith('-'))) return ['up', ...argv]
  return argv // bare `mirb`, `--help`, `--version`: let bunli handle it
}

const cli = await createCLI({
  name: 'mirb',
  version: pkg.version,
  description: pkg.description
})

cli.command(upCommand)
cli.command(lsCommand)
cli.command(stopCommand)
cli.command(logsCommand)
cli.command(superviseCommand)

await cli.run(normalizeArgv(process.argv.slice(2)))
