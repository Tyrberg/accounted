/**
 * The only tests here that actually spawn a process. Everything else in fork/
 * injects a fake {@link Runner}, which means the real one would otherwise never
 * be executed by anything before the first scheduled run.
 */

import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'

import { createNodeRunner, formatCommand, GATE_TIMEOUT_MS, PLUMBING_TIMEOUT_MS } from '../lib/exec'

describe('createNodeRunner', () => {
  const runner = createNodeRunner()

  it('captures the exit code and stdout of a command that succeeds', () => {
    const result = runner('node', ['-e', 'process.stdout.write("hello")'], { cwd: tmpdir() })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hello')
  })

  it('captures a non-zero exit code and stderr instead of throwing', () => {
    const result = runner('node', ['-e', 'process.stderr.write("nope"); process.exit(3)'], {
      cwd: tmpdir(),
    })

    expect(result.code).toBe(3)
    expect(result.stderr).toBe('nope')
  })

  it('reports a missing binary as a failure rather than crashing the run', () => {
    const result = runner('definitely-not-a-real-binary-xyz', [], { cwd: tmpdir() })

    expect(result.code).toBe(-1)
    expect(result.stderr).not.toBe('')
  })

  it('honours the timeout so a hung gate cannot wedge a scheduled run forever', () => {
    const result = runner('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: tmpdir(),
      timeoutMs: 250,
    })

    expect(result.code).not.toBe(0)
  })
})

describe('timeouts and formatting', () => {
  it('gives a cold vitest run room while still being bounded', () => {
    expect(GATE_TIMEOUT_MS).toBeGreaterThan(10 * 60 * 1000)
    expect(PLUMBING_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('formats a command the way the reports quote it', () => {
    expect(formatCommand('git', ['worktree', 'add'])).toBe('git worktree add')
  })
})
