/**
 * Evaluation of adaptation checks and reconciliation of the manifest against
 * the real diff versus upstream.
 *
 * Everything here is pure: it reads through the two {@link Tree} seams (our
 * working tree, upstream's tree at the tracked ref) and never touches the
 * filesystem or git directly, so the whole decision surface is unit-testable.
 */

import type { Adaptation, AdaptationCheck } from './manifest'

/**
 * A source of file contents. `null` means "no such file in this tree", which
 * is a distinct outcome from "file exists but does not match".
 */
export interface Tree {
  read(path: string): string | null
}

export type CheckStatus = 'pass' | 'fail' | 'unavailable'

export interface CheckResult {
  adaptationId: string
  check: AdaptationCheck
  status: CheckStatus
  /** One line, phrased so it is readable on its own in an alert. */
  detail: string
}

/**
 * A tree that is not reachable this run (no upstream remote, fetch failed).
 * Upstream checks against it come back `unavailable`, never `pass`: a report
 * must not claim more than it inspected.
 */
export const UNAVAILABLE_TREE: Tree = {
  read() {
    throw new TreeUnavailableError('upstream tree was not read this run')
  },
}

export class TreeUnavailableError extends Error {}

function evaluate(check: AdaptationCheck, tree: Tree, treeName: string): { status: CheckStatus; detail: string } {
  let content: string | null
  try {
    content = tree.read(check.path)
  } catch (error) {
    if (error instanceof TreeUnavailableError) {
      return {
        status: 'unavailable',
        detail: `${treeName} not read this run, so ${check.path} /${check.patternSource}/ was not inspected`,
      }
    }
    throw error
  }

  const wantsPresence = check.kind === 'local-contains' || check.kind === 'upstream-contains'

  if (content === null) {
    return wantsPresence
      ? { status: 'fail', detail: `${check.path} is missing from ${treeName}` }
      : { status: 'pass', detail: `${check.path} does not exist in ${treeName}` }
  }

  const matched = check.pattern.test(content)
  if (wantsPresence) {
    return matched
      ? { status: 'pass', detail: `${treeName}:${check.path} still matches /${check.patternSource}/` }
      : { status: 'fail', detail: `${treeName}:${check.path} no longer matches /${check.patternSource}/` }
  }
  return matched
    ? { status: 'fail', detail: `${treeName}:${check.path} now matches /${check.patternSource}/, which it must not` }
    : { status: 'pass', detail: `${treeName}:${check.path} still does not match /${check.patternSource}/` }
}

export interface EvaluateOptions {
  local: Tree
  upstream: Tree
  /** Skip upstream checks entirely (offline `verify`). They report as unavailable. */
  includeUpstream: boolean
}

/** Run every check of every adaptation. Order is manifest order, stable for diffing reports. */
export function evaluateAdaptations(
  adaptations: readonly Adaptation[],
  options: EvaluateOptions,
): CheckResult[] {
  const results: CheckResult[] = []
  for (const adaptation of adaptations) {
    for (const check of adaptation.checks) {
      const isUpstream = check.kind.startsWith('upstream-')
      if (isUpstream && !options.includeUpstream) {
        results.push({
          adaptationId: adaptation.id,
          check,
          status: 'unavailable',
          detail: `upstream checks are skipped in offline mode, so ${check.path} /${check.patternSource}/ was not inspected`,
        })
        continue
      }
      const tree = isUpstream ? options.upstream : options.local
      const treeName = isUpstream ? 'upstream' : 'working tree'
      const { status, detail } = evaluate(check, tree, treeName)
      results.push({ adaptationId: adaptation.id, check, status, detail })
    }
  }
  return results
}

/** True when `changed` is `owned` itself, or lives under it when `owned` names a directory. */
export function pathIsOwned(changed: string, owned: string): boolean {
  if (owned.endsWith('/')) return changed.startsWith(owned)
  return changed === owned
}

export interface DriftReconciliation {
  /** Files that differ from upstream but no adaptation declares. */
  undeclared: string[]
  /**
   * Paths an UNTRACKED adaptation declares that nevertheless show up in the
   * diff, which means a host-local file got committed. Split out from
   * `undeclared` so the alarm can say what actually happened.
   */
  committedHostLocal: { path: string; adaptationId: string }[]
  /**
   * Tracked adaptations whose declared paths no longer differ from upstream at
   * all. Either upstream adopted the change (retire the entry) or a merge
   * silently reverted it. Both need a human; neither may pass quietly.
   */
  vanished: Adaptation[]
}

/**
 * Reconcile the manifest against `changedPaths` (the real `git diff --name-only
 * <upstreamRef>...HEAD`) in BOTH directions.
 *
 * The reverse direction is the point: a one-directional check that only flags
 * undeclared files goes green precisely when an upgrade wipes one of our
 * adaptations, because a reverted file stops appearing in the diff.
 *
 * Untracked adaptations (host-local files, never committed) are excluded: they
 * cannot appear in a git diff. Their protection is the mandatory `local-*`
 * check enforced by the manifest parser.
 */
export function reconcileDrift(
  changedPaths: readonly string[],
  adaptations: readonly Adaptation[],
): DriftReconciliation {
  const tracked = adaptations.filter((adaptation) => adaptation.tracked)
  const owned = tracked.flatMap((adaptation) => adaptation.paths)

  const committedHostLocal: { path: string; adaptationId: string }[] = []
  for (const changed of changedPaths) {
    if (owned.some((path) => pathIsOwned(changed, path))) continue
    const hostLocal = adaptations.find(
      (adaptation) =>
        !adaptation.tracked && adaptation.paths.some((path) => pathIsOwned(changed, path)),
    )
    if (hostLocal) committedHostLocal.push({ path: changed, adaptationId: hostLocal.id })
  }

  const claimedHostLocal = new Set(committedHostLocal.map((entry) => entry.path))
  const undeclared = changedPaths
    .filter(
      (changed) =>
        !owned.some((path) => pathIsOwned(changed, path)) && !claimedHostLocal.has(changed),
    )
    .sort()

  const vanished = tracked.filter(
    (adaptation) =>
      !changedPaths.some((changed) => adaptation.paths.some((path) => pathIsOwned(changed, path))),
  )

  return { undeclared, committedHostLocal, vanished }
}
