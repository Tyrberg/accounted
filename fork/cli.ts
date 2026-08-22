#!/usr/bin/env -S npx tsx
/**
 * The one executable entry point of the fork layer.
 *
 * Usage:
 *   npx tsx fork/cli.ts verify                     offline: manifest + our tree
 *   npx tsx fork/cli.ts sync [--upstream-gates]    the weekly routine
 *   npx tsx fork/cli.ts status                     is the schedule alive?
 *
 * Flags:
 *   --upstream-gates   also run the gates in a scratch worktree at upstream's tip
 *   --skip-gates       anchors and drift only
 *   --json             emit the machine-readable outcome instead of the report
 *
 * Exit codes are documented in fork/sync.ts. An unknown flag is a usage error
 * (exit 1) rather than a silent no-op: a scheduled run that did something other
 * than what the crontab asked for is worse than one that refused.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { createNodeRunner } from './lib/exec'
import { emitAlert, EXIT, run, type SyncDeps, type SyncOptions } from './sync'

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): SyncOptions {
  const positionals = argv.filter((arg) => !arg.startsWith('-'))
  const flags = argv.filter((arg) => arg.startsWith('-'))

  if (positionals.length !== 1) {
    throw new UsageError(
      `expected exactly one command (verify | sync | status), got ${positionals.length === 0 ? 'none' : positionals.join(', ')}`,
    )
  }
  const mode = positionals[0]
  if (mode !== 'verify' && mode !== 'sync' && mode !== 'status') {
    throw new UsageError(`unknown command "${mode}": expected verify, sync or status`)
  }

  const options: SyncOptions = { mode, upstreamGates: false, skipGates: false, json: false }
  for (const flag of flags) {
    switch (flag) {
      case '--upstream-gates':
        options.upstreamGates = true
        break
      case '--skip-gates':
        options.skipGates = true
        break
      case '--json':
        options.json = true
        break
      default:
        throw new UsageError(`unknown flag "${flag}"`)
    }
  }

  if (options.upstreamGates && options.skipGates) {
    throw new UsageError('--upstream-gates and --skip-gates contradict each other')
  }
  if (mode !== 'sync' && (options.upstreamGates || options.skipGates)) {
    throw new UsageError(`--upstream-gates and --skip-gates only apply to "sync", not "${mode}"`)
  }

  return options
}

export function createNodeDeps(root: string): SyncDeps {
  return {
    root,
    runner: createNodeRunner(),
    fs: {
      exists: (path) => existsSync(path),
      readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
      writeFile: (path, content) => writeFileSync(path, content, 'utf8'),
      mkdirp: (path) => mkdirSync(path, { recursive: true }),
    },
    resolve: (base, relative) => join(base, relative),
    now: () => new Date(),
    env: process.env,
    // Outside the repo on purpose: a worktree inside it would be picked up by
    // vitest, eslint and the antipattern walker on the very next run.
    scratchDir: join(tmpdir(), 'accounted-fork-upstream-gates'),
  }
}

export function main(argv: readonly string[], root: string): number {
  let options: SyncOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`fork/cli.ts: ${error.message}\n`)
      return EXIT.usage
    }
    throw error
  }

  const deps = createNodeDeps(root)
  const outcome = run(deps, options)

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: outcome.mode,
          exitCode: outcome.exitCode,
          adaptationAlarms: outcome.adaptationAlarms,
          gateFailures: outcome.gateFailures,
          plumbingProblems: outcome.plumbingProblems,
          notes: outcome.notes,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    process.stdout.write(`${outcome.report}\n`)
  }

  if (options.mode === 'sync') {
    const alert = emitAlert(deps, outcome)
    process.stdout.write(`Alert: ${alert.detail}\n`)
  }

  return outcome.exitCode
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2), dirname(dirname(fileURLToPath(import.meta.url))))
}
