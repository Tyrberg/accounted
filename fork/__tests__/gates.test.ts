import { describe, it, expect } from 'vitest'

import type { CommandResult, Runner } from '../lib/exec'
import { GATES, runGates, runUpstreamGates, type FsProbe } from '../lib/gates'
import { isAllowedGitInvocation } from '../lib/git'

interface Recorded {
  command: string
  args: string[]
  cwd: string
}

function recorder(results: Record<string, CommandResult> = {}): { runner: Runner; calls: Recorded[] } {
  const calls: Recorded[] = []
  const runner: Runner = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd })
    const key = [command, ...args].join(' ')
    return results[key] ?? { code: 0, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

function probe(present: string[]): FsProbe {
  return { exists: (path) => present.includes(path) }
}

const resolve = (base: string, relative: string) => `${base}/${relative}`

const ALL_TOOLING = [
  '/repo/node_modules/vitest',
  '/repo/node_modules/eslint',
  '/repo/node_modules/typescript',
]

describe('runGates', () => {
  it('runs every gate and labels the tree it ran in', () => {
    const { runner, calls } = recorder()

    const results = runGates({ runner, fs: probe(ALL_TOOLING), cwd: '/repo', tree: 'fork tree', resolve })

    expect(results.map((r) => r.gate)).toEqual(GATES.map((g) => g.id))
    expect(results.every((r) => r.status === 'pass')).toBe(true)
    expect(results.every((r) => r.tree === 'fork tree')).toBe(true)
    expect(calls.map((c) => [c.command, ...c.args].join(' '))).toEqual([
      'npm test',
      'npm run check:lint',
      'npm run check:guards',
    ])
  })

  it('skips only the gate whose own tooling is missing, and still reports the others', () => {
    // The failure this pins: an all-or-nothing preflight that skips three gates
    // while the report names one of them.
    const { runner, calls } = recorder()

    const results = runGates({
      runner,
      fs: probe(['/repo/node_modules/vitest', '/repo/node_modules/typescript']),
      cwd: '/repo',
      tree: 'fork tree',
      resolve,
    })

    expect(results).toHaveLength(GATES.length)
    expect(results.find((r) => r.gate === 'npm run check:lint')?.status).toBe('skipped')
    expect(results.find((r) => r.gate === 'npm run check:lint')?.detail).toContain('eslint not installed')
    expect(results.find((r) => r.gate === 'npm test')?.status).toBe('pass')
    expect(results.find((r) => r.gate === 'npm run check:guards')?.status).toBe('pass')
    expect(calls.map((c) => c.args.join(' '))).toEqual(['test', 'run check:guards'])
  })

  it('names check:guards when typescript is missing, since that gate needs it at run time', () => {
    const { runner } = recorder()

    const results = runGates({
      runner,
      fs: probe(['/repo/node_modules/vitest', '/repo/node_modules/eslint']),
      cwd: '/repo',
      tree: 'fork tree',
      resolve,
    })

    const guards = results.find((r) => r.gate === 'npm run check:guards')
    expect(guards?.status).toBe('skipped')
    expect(guards?.detail).toContain('typescript not installed')
  })

  it('reports a red gate with its exit code and the tail of its output', () => {
    const { runner } = recorder({ 'npm test': { code: 1, stdout: 'a\nb\nc\nd', stderr: '' } })

    const results = runGates({ runner, fs: probe(ALL_TOOLING), cwd: '/repo', tree: 'fork tree', resolve })

    const test = results.find((r) => r.gate === 'npm test')
    expect(test?.status).toBe('fail')
    expect(test?.detail).toContain('exit 1')
    expect(test?.detail).toContain('d')
  })
})

describe('runUpstreamGates', () => {
  const base = {
    fs: probe([
      '/tmp/scratch/node_modules/vitest',
      '/tmp/scratch/node_modules/eslint',
      '/tmp/scratch/node_modules/typescript',
    ]),
    root: '/repo',
    worktreePath: '/tmp/scratch',
    ref: 'upstream/main',
    resolve,
  }

  it('creates a detached worktree at upstream tip, installs, gates there, and always removes it', () => {
    const { runner, calls } = recorder()

    const outcome = runUpstreamGates({ ...base, runner })

    expect(outcome.ok).toBe(true)
    expect(outcome.results.every((r) => r.tree === 'upstream tip')).toBe(true)
    expect(calls.map((c) => [c.command, ...c.args].join(' '))).toEqual([
      'git worktree add --detach /tmp/scratch upstream/main',
      'npm ci',
      'npm test',
      'npm run check:lint',
      'npm run check:guards',
      'git worktree remove --force /tmp/scratch',
    ])
    expect(calls.filter((c) => c.command === 'npm').every((c) => c.cwd === '/tmp/scratch')).toBe(true)
  })

  it('treats a failed npm ci as plumbing, not as upstream going red, and still cleans up', () => {
    const { runner, calls } = recorder({ 'npm ci': { code: 1, stdout: '', stderr: 'ENOTFOUND registry' } })

    const outcome = runUpstreamGates({ ...base, runner })

    expect(outcome.ok).toBe(false)
    expect(outcome.results).toEqual([])
    expect(outcome.ok === false && outcome.reason).toContain('npm ci')
    expect(calls.map((c) => c.args.join(' '))).toContain('worktree remove --force /tmp/scratch')
  })

  it('reports a failed worktree creation instead of silently gating our own tree', () => {
    const { runner, calls } = recorder({
      'git worktree add --detach /tmp/scratch upstream/main': {
        code: 128,
        stdout: '',
        stderr: 'fatal: invalid reference',
      },
    })

    const outcome = runUpstreamGates({ ...base, runner })

    expect(outcome.ok).toBe(false)
    expect(outcome.results).toEqual([])
    expect(calls.some((c) => c.args.includes('ci'))).toBe(false)
  })

  it('refuses a scratch path inside the checkout, which vitest and eslint would then walk', () => {
    const { runner, calls } = recorder()

    const outcome = runUpstreamGates({ ...base, runner, worktreePath: '/repo/.upstream' })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toContain('inside the checkout')
    expect(calls).toEqual([])
  })

  it('issues only git commands that are on the read-only allowlist', () => {
    const { runner, calls } = recorder()

    runUpstreamGates({ ...base, runner })

    const gitCalls = calls.filter((c) => c.command === 'git')
    expect(gitCalls.length).toBeGreaterThan(0)
    for (const call of gitCalls) {
      expect(isAllowedGitInvocation(call.args)).toBe(true)
    }
  })
})
