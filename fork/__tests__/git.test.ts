import { describe, it, expect } from 'vitest'

import type { CommandResult, Runner } from '../lib/exec'
import {
  changedVersusUpstream,
  countAhead,
  countBehind,
  describeRef,
  DisallowedGitCommandError,
  isAllowedGitInvocation,
  readRemotes,
  runGit,
  upstreamTree,
} from '../lib/git'

function runner(results: Record<string, CommandResult> = {}): Runner {
  return (command, args) => results[[command, ...args].join(' ')] ?? { code: 0, stdout: '', stderr: '' }
}

describe('the git allowlist', () => {
  it('permits exactly the read-only shapes the routine needs', () => {
    expect(isAllowedGitInvocation(['fetch', '--no-tags', 'upstream'])).toBe(true)
    expect(isAllowedGitInvocation(['show', 'upstream/main:docker-compose.yml'])).toBe(true)
    expect(isAllowedGitInvocation(['diff', '--name-only', 'upstream/main...HEAD'])).toBe(true)
    expect(isAllowedGitInvocation(['rev-parse', 'upstream/main'])).toBe(true)
    expect(isAllowedGitInvocation(['rev-list', '--count', 'HEAD..upstream/main'])).toBe(true)
    expect(isAllowedGitInvocation(['log', '-1', '--format=%cI', 'upstream/main'])).toBe(true)
    expect(isAllowedGitInvocation(['remote'])).toBe(true)
    expect(isAllowedGitInvocation(['worktree', 'add', '--detach', '/tmp/x', 'upstream/main'])).toBe(true)
    expect(isAllowedGitInvocation(['worktree', 'remove', '--force', '/tmp/x'])).toBe(true)
  })

  it('refuses anything that could move HEAD, stage work or rewrite history', () => {
    const forbidden = [
      ['merge', 'upstream/main'],
      ['rebase', 'upstream/main'],
      ['checkout', 'upstream/main'],
      ['reset', '--hard', 'upstream/main'],
      ['pull'],
      ['push', 'origin', 'main'],
      ['add', '.'],
      ['commit', '-m', 'sync'],
      ['clean', '-fd'],
      ['stash'],
      ['branch', '-D', 'main'],
      // A fetch with a refspec could update local branches: only the bare
      // three-token form is allowed.
      ['fetch', '--no-tags', 'upstream', '+refs/heads/*:refs/heads/*'],
    ]

    for (const args of forbidden) {
      expect(isAllowedGitInvocation(args)).toBe(false)
      expect(() => runGit(runner(), '/repo', args)).toThrow(DisallowedGitCommandError)
    }
  })
})

describe('upstreamTree', () => {
  it('returns file contents at the upstream ref', () => {
    const tree = upstreamTree(
      runner({ 'git show upstream/main:docker-compose.yml': { code: 0, stdout: 'services:\n', stderr: '' } }),
      '/repo',
      'upstream/main',
    )
    expect(tree.read('docker-compose.yml')).toBe('services:\n')
  })

  it('maps a non-zero git show to "no such file at that ref"', () => {
    const tree = upstreamTree(
      runner({ 'git show upstream/main:fork/README.md': { code: 128, stdout: '', stderr: 'does not exist' } }),
      '/repo',
      'upstream/main',
    )
    expect(tree.read('fork/README.md')).toBeNull()
  })
})

describe('repository queries', () => {
  it('detects whether the manifest remote is configured', () => {
    const configured = readRemotes(
      runner({ 'git remote': { code: 0, stdout: 'origin\nupstream\ngitlab\n', stderr: '' } }),
      '/repo',
      'upstream',
    )
    expect(configured).toEqual({ hasRemote: true, remotes: ['origin', 'upstream', 'gitlab'] })

    const missing = readRemotes(
      runner({ 'git remote': { code: 0, stdout: 'origin\n', stderr: '' } }),
      '/repo',
      'upstream',
    )
    expect(missing.hasRemote).toBe(false)
  })

  it('reads the changed-file list and drops blank lines', () => {
    const result = changedVersusUpstream(
      runner({
        'git diff --name-only upstream/main...HEAD': {
          code: 0,
          stdout: 'fork/sync.ts\n\nfork/README.md\n',
          stderr: '',
        },
      }),
      '/repo',
      'upstream/main',
    )
    expect(result).toEqual({ ok: true, paths: ['fork/sync.ts', 'fork/README.md'] })
  })

  it('reports a failed diff rather than pretending nothing changed', () => {
    const result = changedVersusUpstream(
      runner({
        'git diff --name-only upstream/main...HEAD': { code: 128, stdout: '', stderr: 'bad revision' },
      }),
      '/repo',
      'upstream/main',
    )
    expect(result).toEqual({ ok: false, error: 'bad revision' })
  })

  it('describes the upstream tip, and returns null when the ref does not resolve', () => {
    const described = describeRef(
      runner({
        'git rev-parse upstream/main': { code: 0, stdout: 'abc123\n', stderr: '' },
        'git log -1 --format=%cI upstream/main': { code: 0, stdout: '2026-08-20T10:00:00+02:00\n', stderr: '' },
      }),
      '/repo',
      'upstream/main',
    )
    expect(described).toEqual({ sha: 'abc123', committedAt: '2026-08-20T10:00:00+02:00' })

    expect(
      describeRef(runner({ 'git rev-parse upstream/main': { code: 128, stdout: '', stderr: '' } }), '/repo', 'upstream/main'),
    ).toBeNull()
  })

  it('counts distance in both directions and treats unparseable output as unknown', () => {
    const counts = runner({
      'git rev-list --count HEAD..upstream/main': { code: 0, stdout: '508\n', stderr: '' },
      'git rev-list --count upstream/main..HEAD': { code: 0, stdout: '0\n', stderr: '' },
    })
    expect(countBehind(counts, '/repo', 'upstream/main')).toBe(508)
    expect(countAhead(counts, '/repo', 'upstream/main')).toBe(0)

    const garbage = runner({
      'git rev-list --count HEAD..upstream/main': { code: 0, stdout: 'not a number\n', stderr: '' },
    })
    expect(countBehind(garbage, '/repo', 'upstream/main')).toBeNull()
  })
})
