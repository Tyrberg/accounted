/**
 * The single process-spawning seam of the fork layer.
 *
 * Every command the sync routine runs goes through {@link Runner}, so tests
 * assert on the exact argv that would have been executed instead of executing
 * anything. Nothing else in fork/ imports node:child_process.
 */

import { spawnSync } from 'node:child_process'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd: string
  /** Hard ceiling so a hung gate cannot wedge a scheduled run forever. */
  timeoutMs?: number
}

export type Runner = (command: string, args: readonly string[], options: RunOptions) => CommandResult

/** Default timeout for a gate: long enough for a cold vitest run, short enough to end. */
export const GATE_TIMEOUT_MS = 45 * 60 * 1000

/** Default timeout for plumbing (fetch, worktree, install). */
export const PLUMBING_TIMEOUT_MS = 30 * 60 * 1000

export function createNodeRunner(): Runner {
  return (command, args, options) => {
    const result = spawnSync(command, [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.error) {
      return { code: -1, stdout: result.stdout ?? '', stderr: String(result.error.message) }
    }
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }
}

export function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ')
}
