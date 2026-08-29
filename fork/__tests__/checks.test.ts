import { describe, it, expect } from 'vitest'

import {
  evaluateAdaptations,
  pathIsOwned,
  reconcileDrift,
  UNAVAILABLE_TREE,
  type Tree,
} from '../lib/checks'
import { parseManifest, type Adaptation } from '../lib/manifest'

function tree(files: Record<string, string>): Tree {
  return { read: (path) => (path in files ? files[path] : null) }
}

function adaptation(overrides: Partial<Record<string, unknown>> = {}): Adaptation {
  const source = JSON.stringify({
    upstream: { repo: 'erp-mafia/accounted', remote: 'upstream', ref: 'upstream/main' },
    maxSyncAgeDays: 10,
    adaptations: [
      {
        id: 'example',
        tier: 1,
        summary: 'x',
        why: 'y',
        paths: ['fork/'],
        tracked: true,
        upstream: { status: 'not-applicable' },
        checks: [
          {
            kind: 'local-contains',
            path: 'fork/README.md',
            pattern: 'marker',
            reason: 'The marker is gone.',
          },
        ],
        ...overrides,
      },
    ],
  })
  return parseManifest(source).adaptations[0]
}

describe('evaluateAdaptations', () => {
  it('passes a local-contains check when the marker is still in our tree', () => {
    const results = evaluateAdaptations([adaptation()], {
      local: tree({ 'fork/README.md': 'has the marker here' }),
      upstream: UNAVAILABLE_TREE,
      includeUpstream: false,
    })

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('pass')
  })

  it('fails a local-contains check when an upgrade reverted our change', () => {
    const results = evaluateAdaptations([adaptation()], {
      local: tree({ 'fork/README.md': 'upstream text without it' }),
      upstream: UNAVAILABLE_TREE,
      includeUpstream: false,
    })

    expect(results[0].status).toBe('fail')
    expect(results[0].detail).toContain('no longer matches')
  })

  it('fails a local-contains check when the whole file was deleted', () => {
    const results = evaluateAdaptations([adaptation()], {
      local: tree({}),
      upstream: UNAVAILABLE_TREE,
      includeUpstream: false,
    })

    expect(results[0].status).toBe('fail')
    expect(results[0].detail).toContain('missing from working tree')
  })

  it('fails an upstream-contains check when upstream refactored the anchor away', () => {
    const anchored = adaptation({
      tracked: false,
      checks: [
        {
          kind: 'upstream-contains',
          path: 'docker-compose.yml',
          pattern: '^  app:$',
          reason: 'Compose merges by service name.',
        },
      ],
    })

    const results = evaluateAdaptations([anchored], {
      local: tree({}),
      upstream: tree({ 'docker-compose.yml': 'services:\n  web:\n' }),
      includeUpstream: true,
    })

    expect(results[0].status).toBe('fail')
    expect(results[0].check.reason).toContain('Compose merges by service name')
  })

  it('fails an upstream-absent check once upstream grows the thing we said it must not have', () => {
    const absent = adaptation({
      checks: [
        {
          kind: 'local-contains',
          path: 'fork/README.md',
          pattern: 'marker',
          reason: 'gone',
        },
        {
          kind: 'upstream-absent',
          path: 'fork/README.md',
          pattern: '[\\s\\S]',
          reason: 'Upstream created its own fork/ directory.',
        },
      ],
    })

    const collided = evaluateAdaptations([absent], {
      local: tree({ 'fork/README.md': 'marker' }),
      upstream: tree({ 'fork/README.md': 'upstream now has one too' }),
      includeUpstream: true,
    })
    expect(collided[1].status).toBe('fail')

    const clean = evaluateAdaptations([absent], {
      local: tree({ 'fork/README.md': 'marker' }),
      upstream: tree({}),
      includeUpstream: true,
    })
    expect(clean[1].status).toBe('pass')
  })

  it('reports upstream checks as unavailable, never as passing, when upstream was not read', () => {
    const anchored = adaptation({
      checks: [
        { kind: 'local-contains', path: 'fork/README.md', pattern: 'marker', reason: 'gone' },
        {
          kind: 'upstream-contains',
          path: 'docker-compose.yml',
          pattern: '^  app:$',
          reason: 'anchor moved',
        },
      ],
    })

    const offline = evaluateAdaptations([anchored], {
      local: tree({ 'fork/README.md': 'marker' }),
      upstream: UNAVAILABLE_TREE,
      includeUpstream: false,
    })
    expect(offline.map((r) => r.status)).toEqual(['pass', 'unavailable'])

    // Even if the caller wrongly says upstream is included, the unavailable
    // tree refuses to answer rather than reporting a pass.
    const wronglyIncluded = evaluateAdaptations([anchored], {
      local: tree({ 'fork/README.md': 'marker' }),
      upstream: UNAVAILABLE_TREE,
      includeUpstream: true,
    })
    expect(wronglyIncluded[1].status).toBe('unavailable')
  })
})

describe('pathIsOwned', () => {
  it('treats a trailing slash as a directory prefix and everything else as an exact path', () => {
    expect(pathIsOwned('fork/lib/git.ts', 'fork/')).toBe(true)
    expect(pathIsOwned('forkless/x.ts', 'fork/')).toBe(false)
    expect(pathIsOwned('package.json', 'package.json')).toBe(true)
    expect(pathIsOwned('package-lock.json', 'package.json')).toBe(false)
  })
})

describe('reconcileDrift', () => {
  const owned = adaptation()
  const untracked = adaptation({
    id: 'host-local',
    tracked: false,
    paths: ['docker-compose.override.yml'],
    checks: [
      {
        kind: 'upstream-contains',
        path: 'docker-compose.yml',
        pattern: '^  app:$',
        reason: 'anchor',
      },
    ],
  })

  it('is quiet when the diff versus upstream is exactly what the manifest declares', () => {
    const result = reconcileDrift(['fork/sync.ts', 'fork/README.md'], [owned, untracked])
    expect(result).toEqual({ undeclared: [], committedHostLocal: [], vanished: [] })
  })

  it('distinguishes a committed host-local file from ordinary undeclared drift', () => {
    const result = reconcileDrift(
      ['fork/sync.ts', 'docker-compose.override.yml', 'next.config.ts'],
      [owned, untracked],
    )

    expect(result.committedHostLocal).toEqual([
      { path: 'docker-compose.override.yml', adaptationId: 'host-local' },
    ])
    expect(result.undeclared).toEqual(['next.config.ts'])
  })

  it('flags a file that differs from upstream but no adaptation declares', () => {
    const result = reconcileDrift(['fork/sync.ts', 'lib/bookkeeping/engine.ts'], [owned])
    expect(result.undeclared).toEqual(['lib/bookkeeping/engine.ts'])
  })

  it('flags a declared adaptation that stopped differing from upstream, which is the silent-revert case', () => {
    // The whole point: an upgrade that reverts fork/ makes those paths vanish
    // from the diff. A one-directional guard would go green here.
    const result = reconcileDrift(['docs/DOCKER.md'], [owned])
    expect(result.vanished.map((a) => a.id)).toEqual(['example'])
  })

  it('never flags untracked adaptations as vanished, because they cannot appear in a git diff', () => {
    const result = reconcileDrift(['fork/sync.ts'], [owned, untracked])
    expect(result.vanished).toEqual([])
  })

  it('flags every declared adaptation as vanished when the diff is empty', () => {
    const result = reconcileDrift([], [owned, untracked])
    expect(result.vanished.map((a) => a.id)).toEqual(['example'])
    expect(result.undeclared).toEqual([])
  })
})
