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

  it('declares the host-local compose override as untracked, since it is never committed', () => {
    const override = manifest.adaptations.find((adaptation) =>
      adaptation.paths.includes('docker-compose.override.yml'),
    )
    expect(override).toBeDefined()
    expect(override?.tracked).toBe(false)
    expect(existsSync(join(REPO_ROOT, 'fork/templates/docker-compose.override.example.yml'))).toBe(true)
  })

  it('modifies no file upstream owns: every declared tracked path lives under fork/', () => {
    // The strategy in fork/README.md is "tier 1 first, and keep the merge
    // surface at zero". If a tracked adaptation ever needs a path outside
    // fork/, that is a tier 2 patch and has to be a deliberate, reviewed change
    // to this expectation, not something that slips in.
    const trackedPaths = manifest.adaptations
      .filter((adaptation) => adaptation.tracked)
      .flatMap((adaptation) => adaptation.paths)

    expect(trackedPaths.filter((path) => !path.startsWith('fork/'))).toEqual([])
  })
})
