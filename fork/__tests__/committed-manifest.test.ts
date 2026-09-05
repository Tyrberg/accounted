/**
 * The wiring that makes this layer more than a script nobody runs.
 *
 * These assertions run against the real committed manifest and the real
 * checkout, and they run inside `npm test`, which core-build.yml executes on
 * every push. So if an upstream merge reverts one of our adaptations, CI goes
 * red on that merge: the guard does not depend on anyone remembering to invoke
 * it, and it does not depend on a scheduled job that could quietly stop.
 *
 * What it cannot do is check upstream: CI has no `upstream` remote. The weekly
 * `npx tsx fork/cli.ts sync` on the box does that half. The split is deliberate
 * and is stated in every assertion name below, because a check that silently
 * covered less than it appears to is the failure mode this whole directory is
 * built against.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateAdaptations, UNAVAILABLE_TREE, type Tree } from '../lib/checks'
import { parseManifest } from '../lib/manifest'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const workingTree: Tree = {
  read(path) {
    const full = join(REPO_ROOT, path)
    return existsSync(full) ? readFileSync(full, 'utf8') : null
  },
}

const manifest = parseManifest(readFileSync(join(REPO_ROOT, 'fork/adaptations.json'), 'utf8'))

// Shared by both the allowlist test and its own regression test below, so
// that reverting the filter logic (or the allowlist data) to something looser
// (e.g. keying by adaptation id alone instead of exact paths) fails both
// tests together instead of leaving a hand-copied regression test green.
const REVIEWED_OUTSIDE_FORK: Record<string, readonly string[]> = {
  'sie-migration-validation': [
    'lib/import/sie-migration-validation.ts',
    'lib/import/__tests__/sie-migration-validation.test.ts',
  ],
  'docker-cron-entrypoint-hardening': [
    'docker/cron.Dockerfile',
    'scripts/__tests__/generate-crontabs.test.ts',
  ],
}

function findUnreviewedPaths(adaptations: typeof manifest.adaptations): string[] {
  return adaptations
    .filter((adaptation) => adaptation.tracked)
    .flatMap((adaptation) =>
      adaptation.paths
        .filter((path) => !path.startsWith('fork/'))
        .filter((path) => !(REVIEWED_OUTSIDE_FORK[adaptation.id] ?? []).includes(path))
        .map((path) => `${adaptation.id}: ${path}`),
    )
}

describe('the committed manifest', () => {
  it('declares at least one adaptation, so a vacuous pass is impossible', () => {
    expect(manifest.adaptations.length).toBeGreaterThan(0)
    expect(manifest.adaptations.flatMap((a) => a.checks).length).toBeGreaterThan(0)
  })

  it('points at the real upstream project', () => {
    expect(manifest.upstream.repo).toBe('erp-mafia/accounted')
    expect(manifest.upstream.ref).toBe('upstream/main')
  })

  it('holds every local check against this working tree', () => {
    const results = evaluateAdaptations(manifest.adaptations, {
      local: workingTree,
      upstream: UNAVAILABLE_TREE,
      includeUpstream: false,
    })

    const local = results.filter((result) => result.check.kind.startsWith('local-'))
    expect(local.length).toBeGreaterThan(0)
    expect(local.filter((result) => result.status !== 'pass').map((result) => result.detail)).toEqual([])
  })

  it('holds every upstream anchor against OUR copy of those files, which is the most CI can see', () => {
    // Not a substitute for the weekly run: this proves the anchors are not
    // typos as of our own commit. Only `fork/cli.ts sync` on a checkout with an
    // `upstream` remote can prove they still hold at upstream's tip.
    //
    // Deliberately only `upstream-contains`. An `upstream-absent` check is
    // about a file we expect upstream NOT to have, and our tree does have it
    // (that is the point of the adaptation), so evaluating it here would assert
    // the opposite of what it means.
    const upstreamChecks = manifest.adaptations
      .flatMap((adaptation) => adaptation.checks.map((check) => ({ adaptation, check })))
      .filter(({ check }) => check.kind === 'upstream-contains')

    expect(upstreamChecks.length).toBeGreaterThan(0)

    const broken = upstreamChecks.filter(({ check }) => {
      const content = workingTree.read(check.path)
      return content === null || !check.pattern.test(content)
    })

    expect(broken.map(({ adaptation, check }) => `${adaptation.id}: ${check.path} /${check.patternSource}/`)).toEqual([])
  })

  it('declares the fork layer itself, so undeclared drift reconciliation is not trivially empty', () => {
    const forkLayer = manifest.adaptations.find((adaptation) => adaptation.paths.includes('fork/'))
    expect(forkLayer).toBeDefined()
    expect(forkLayer?.tracked).toBe(true)
  })

  it('guards wholly-new-file adaptations against a future upstream file landing at the same path', () => {
    // fork-maintenance-layer and sie-migration-validation both add files at
    // paths upstream does not currently use. A local-* check alone only
    // catches an accidental revert; it says nothing if upstream later creates
    // a file at that same path, which is exactly the collision each
    // adaptation's `why` claims to guard against. Every such adaptation needs
    // an `upstream-absent` check, not just a `local-*` one.
    const wholesaleNewFileIds = ['fork-maintenance-layer', 'sie-migration-validation']

    for (const id of wholesaleNewFileIds) {
      const adaptation = manifest.adaptations.find((candidate) => candidate.id === id)
      expect(adaptation, `adaptation "${id}" should exist`).toBeDefined()
      expect(
        adaptation?.checks.some((check) => check.kind === 'upstream-absent'),
        `adaptation "${id}" should carry an upstream-absent check`,
      ).toBe(true)
    }
  })

  it('gives every declared path of a multi-path adaptation its own check, not just the adaptation overall', () => {
    // sie-migration-validation declares two paths (the instrument and its
    // test file). A check that only ever looks at the instrument would leave
    // a revert of the test file, or an upstream file landing at that exact
    // test path, invisible to both this suite and the weekly sync, exactly
    // the gap a prior review round already found and fixed once for
    // docker-cron-entrypoint-hardening's guard test (scripts/__tests__/
    // generate-crontabs.test.ts). That adaptation is included here too: it
    // is not a wholesale-new-file adaptation, but it is still multi-path,
    // and this is precisely the check whose narrower scope let that guard
    // test's absence go undetected before.
    const multiPathAdaptationIds = [
      'fork-maintenance-layer',
      'sie-migration-validation',
      'docker-cron-entrypoint-hardening',
    ]

    for (const id of multiPathAdaptationIds) {
      const adaptation = manifest.adaptations.find((candidate) => candidate.id === id)
      expect(adaptation, `adaptation "${id}" should exist`).toBeDefined()
      if (!adaptation) continue

      for (const path of adaptation.paths.filter((candidate) => !candidate.endsWith('/'))) {
        expect(
          adaptation.checks.some((check) => check.path === path),
          `adaptation "${id}" should have a check anchored on "${path}"`,
        ).toBe(true)
      }
    }
  })

  it('declares the host-local compose override as untracked, since it is never committed', () => {
    const override = manifest.adaptations.find((adaptation) =>
      adaptation.paths.includes('docker-compose.override.yml'),
    )
    expect(override).toBeDefined()
    expect(override?.tracked).toBe(false)
    expect(existsSync(join(REPO_ROOT, 'fork/templates/docker-compose.override.example.yml'))).toBe(true)
  })

  it('touches no upstream-owned path outside a short, reviewed allowlist', () => {
    // The strategy in fork/README.md is "tier 1 first, and keep the merge
    // surface at zero". Most tracked adaptations live entirely under fork/.
    // A tracked adaptation that needs a path outside fork/ has to be a
    // deliberate, reviewed change, not something that slips in. Allowlisting
    // by id alone would let a future path added to either adaptation (e.g. an
    // app/api/** file dropped into sie-migration-validation's `paths`) escape
    // the check with no review signal, so this allowlists the exact path sets
    // instead: naming the paths, not just the ids, is the whole point.
    //
    // - sie-migration-validation: adds new files upstream does not have.
    //   Zero merge surface (nothing existing is modified), but the paths are
    //   outside fork/, so they need to be named here on purpose.
    // - docker-cron-entrypoint-hardening: the fork's first real tier 2 patch,
    //   which by definition modifies an upstream file (docker/cron.Dockerfile),
    //   plus the guard test added in the same commit
    //   (scripts/__tests__/generate-crontabs.test.ts) that asserts the
    //   ENTRYPOINT literal: without it declared too, a future upstream merge
    //   that drops the guard goes undetected while the Dockerfile check alone
    //   stays green.
    expect(findUnreviewedPaths(manifest.adaptations)).toEqual([])
  })

  it('would flag a new path added to an already-reviewed id, not just a new id', () => {
    // Regression check for the allowlist itself: allowlisting by id alone
    // would silently pass a future path added under a reviewed id (e.g. an
    // app/api/** file dropped into sie-migration-validation's `paths`). Reuses
    // findUnreviewedPaths/REVIEWED_OUTSIDE_FORK from module scope (not a
    // hand-copy) so a regression in either one fails this test too, and
    // simulates the addition here to confirm it still goes red.
    const withExtraPath = manifest.adaptations.map((adaptation) =>
      adaptation.id === 'sie-migration-validation'
        ? { ...adaptation, paths: [...adaptation.paths, 'app/api/import/sie-migration/route.ts'] }
        : adaptation,
    )

    expect(findUnreviewedPaths(withExtraPath)).toEqual([
      'sie-migration-validation: app/api/import/sie-migration/route.ts',
    ])
  })
})
