import { describe, it, expect } from 'vitest'

import { ManifestError, parseManifest } from '../lib/manifest'

const trackedAdaptation = {
  id: 'example',
  tier: 1,
  summary: 'An example adaptation.',
  why: 'Because the tests need one.',
  paths: ['fork/'],
  tracked: true,
  upstream: { status: 'not-applicable' },
  checks: [
    {
      kind: 'local-contains',
      path: 'fork/README.md',
      pattern: '^# Fork maintenance',
      reason: 'The documentation is gone.',
    },
  ],
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    upstream: { repo: 'erp-mafia/accounted', remote: 'upstream', ref: 'upstream/main' },
    maxSyncAgeDays: 10,
    adaptations: [trackedAdaptation],
    ...overrides,
  })
}

describe('parseManifest', () => {
  it('parses a well-formed manifest and compiles patterns to regexes', () => {
    const parsed = parseManifest(manifest())

    expect(parsed.upstream).toEqual({ repo: 'erp-mafia/accounted', remote: 'upstream', ref: 'upstream/main' })
    expect(parsed.maxSyncAgeDays).toBe(10)
    expect(parsed.adaptations).toHaveLength(1)
    const check = parsed.adaptations[0].checks[0]
    expect(check.pattern).toBeInstanceOf(RegExp)
    expect(check.patternSource).toBe('^# Fork maintenance')
    expect(check.pattern.test('# Fork maintenance\nmore text')).toBe(true)
  })

  it('compiles patterns in multiline mode so anchors match individual lines', () => {
    const parsed = parseManifest(manifest())
    expect(parsed.adaptations[0].checks[0].pattern.test('intro\n# Fork maintenance')).toBe(true)
  })

  it('rejects a tracked adaptation whose checks only look at upstream', () => {
    const upstreamOnly = {
      ...trackedAdaptation,
      checks: [
        {
          kind: 'upstream-contains',
          path: 'docker-compose.yml',
          pattern: '^services:$',
          reason: 'Upstream moved.',
        },
      ],
    }

    expect(() => parseManifest(manifest({ adaptations: [upstreamOnly] }))).toThrow(
      /at least one "local-\*" check/,
    )
  })

  it('allows an untracked adaptation to carry only upstream checks', () => {
    const untracked = {
      ...trackedAdaptation,
      id: 'host-local',
      tracked: false,
      paths: ['docker-compose.override.yml'],
      checks: [
        {
          kind: 'upstream-contains',
          path: 'docker-compose.yml',
          pattern: '^  app:$',
          reason: 'Upstream renamed the service.',
        },
      ],
    }

    expect(parseManifest(manifest({ adaptations: [untracked] })).adaptations[0].tracked).toBe(false)
  })

  it('rejects an adaptation with no checks at all', () => {
    expect(() => parseManifest(manifest({ adaptations: [{ ...trackedAdaptation, checks: [] }] }))).toThrow(
      /"checks" must be a non-empty array/,
    )
  })

  it('rejects an unknown check kind', () => {
    const bad = {
      ...trackedAdaptation,
      checks: [{ kind: 'local-vibes', path: 'a', pattern: 'b', reason: 'c' }],
    }
    expect(() => parseManifest(manifest({ adaptations: [bad] }))).toThrow(/"kind" must be one of/)
  })

  it('rejects an uncompilable pattern at parse time rather than at run time', () => {
    const bad = {
      ...trackedAdaptation,
      checks: [{ kind: 'local-contains', path: 'a', pattern: '([', reason: 'c' }],
    }
    expect(() => parseManifest(manifest({ adaptations: [bad] }))).toThrow(
      /not a valid regular expression/,
    )
  })

  it('rejects unknown keys anywhere, so a typo cannot disable a check', () => {
    const typo = { ...trackedAdaptation, tracked_: true }
    expect(() => parseManifest(manifest({ adaptations: [typo] }))).toThrow(/unknown key\(s\): tracked_/)
    expect(() => parseManifest(manifest({ extra: 1 }))).toThrow(/unknown key\(s\): extra/)
  })

  it('rejects duplicate adaptation ids', () => {
    expect(() =>
      parseManifest(manifest({ adaptations: [trackedAdaptation, { ...trackedAdaptation }] })),
    ).toThrow(/duplicate adaptation id "example"/)
  })

  it('rejects paths that escape the repo', () => {
    expect(() =>
      parseManifest(manifest({ adaptations: [{ ...trackedAdaptation, paths: ['../etc/'] }] })),
    ).toThrow(/must be repo-relative without ".."/)
  })

  it('requires a PR link once a fix has been proposed or merged upstream', () => {
    const proposed = { ...trackedAdaptation, upstream: { status: 'proposed' } }
    expect(() => parseManifest(manifest({ adaptations: [proposed] }))).toThrow(
      /status "proposed" requires a "pr" link/,
    )

    const withPr = {
      ...trackedAdaptation,
      upstream: { status: 'merged', pr: 'https://github.com/erp-mafia/accounted/pull/1' },
    }
    expect(parseManifest(manifest({ adaptations: [withPr] })).adaptations[0].upstream.pr).toContain('/pull/1')
  })

  it('requires tier 2 to name the branch that carries the patch series', () => {
    const tierTwo = { ...trackedAdaptation, tier: 2 }
    expect(() => parseManifest(manifest({ adaptations: [tierTwo] }))).toThrow(/tier 2 requires "branch"/)

    const withBranch = { ...tierTwo, branch: 'fork/patches' }
    expect(parseManifest(manifest({ adaptations: [withBranch] })).adaptations[0].branch).toBe('fork/patches')
  })

  it('refuses a branch on a tier 1 adaptation', () => {
    expect(() =>
      parseManifest(manifest({ adaptations: [{ ...trackedAdaptation, branch: 'fork/patches' }] })),
    ).toThrow(/tier 1 must not set "branch"/)
  })

  it('refuses a ref that does not live on the configured remote', () => {
    expect(() =>
      parseManifest(manifest({ upstream: { repo: 'x/y', remote: 'upstream', ref: 'origin/main' } })),
    ).toThrow(/must live on "remote"/)
  })

  it('refuses a non-positive maxSyncAgeDays', () => {
    expect(() => parseManifest(manifest({ maxSyncAgeDays: 0 }))).toThrow(/positive number/)
  })

  it('reports invalid JSON as a ManifestError rather than a raw SyntaxError', () => {
    expect(() => parseManifest('{ nope')).toThrow(ManifestError)
  })
})
