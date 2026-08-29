/**
 * Parser for fork/adaptations.json: the declaration of every way this fork
 * differs from upstream (erp-mafia/accounted).
 *
 * The manifest is the contract the whole fork layer rests on, so the parser is
 * deliberately hostile: unknown keys are rejected, every adaptation must carry
 * at least one check, and a tracked adaptation must carry at least one check
 * that looks at OUR tree. That last rule is the mechanical form of the
 * requirement behind this layer: an adaptation that only checked upstream
 * could be reverted by a merge without anything going red.
 */

export type CheckKind =
  | 'local-contains'
  | 'local-absent'
  | 'upstream-contains'
  | 'upstream-absent'

export const CHECK_KINDS: readonly CheckKind[] = [
  'local-contains',
  'local-absent',
  'upstream-contains',
  'upstream-absent',
]

export interface AdaptationCheck {
  kind: CheckKind
  /** Repo-relative path, always with forward slashes. */
  path: string
  /** Compiled at parse time so a broken regex fails loudly, not at 03:00 on a Monday. */
  pattern: RegExp
  /** The raw source, kept for reporting. */
  patternSource: string
  /** Plain-language statement of what a failure of this check means. */
  reason: string
}

export type UpstreamStatus = 'not-applicable' | 'planned' | 'proposed' | 'merged'

const UPSTREAM_STATUSES: readonly UpstreamStatus[] = [
  'not-applicable',
  'planned',
  'proposed',
  'merged',
]

export interface Adaptation {
  id: string
  /**
   * 1 = config, environment variables or an upstream extension point.
   * 2 = a thin patch that has to touch upstream source, carried on its own
   *     branch and rebased onto every upstream tag.
   */
  tier: 1 | 2
  summary: string
  why: string
  /**
   * Repo paths this adaptation owns. A trailing slash means "this directory
   * and everything under it". Used to reconcile the manifest against the real
   * diff versus upstream, in both directions.
   */
  paths: string[]
  /** false = the file lives on the host and is never committed (see README). */
  tracked: boolean
  upstream: { status: UpstreamStatus; pr?: string }
  /** Tier 2 only: the branch the patch series is rebased on. */
  branch?: string
  checks: AdaptationCheck[]
}

export interface ForkManifest {
  upstream: { repo: string; remote: string; ref: string }
  /** A sync older than this many days is itself an alarm (see `status`). */
  maxSyncAgeDays: number
  adaptations: Adaptation[]
}

export class ManifestError extends Error {}

function fail(where: string, message: string): never {
  throw new ManifestError(`${where}: ${message}`)
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(where, 'expected an object')
  }
  return value as Record<string, unknown>
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    fail(where, `"${key}" must be a non-empty string`)
  }
  return value as string
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    fail(where, `unknown key(s): ${unknown.sort().join(', ')}`)
  }
}

function parseCheck(raw: unknown, where: string): AdaptationCheck {
  const record = asRecord(raw, where)
  rejectUnknownKeys(record, ['kind', 'path', 'pattern', 'reason'], where)

  const kind = requireString(record, 'kind', where)
  if (!CHECK_KINDS.includes(kind as CheckKind)) {
    fail(where, `"kind" must be one of ${CHECK_KINDS.join(', ')} (got "${kind}")`)
  }

  const path = requireString(record, 'path', where)
  if (path.startsWith('/') || path.includes('..')) {
    fail(where, `"path" must be repo-relative without ".." (got "${path}")`)
  }

  const patternSource = requireString(record, 'pattern', where)
  let pattern: RegExp
  try {
    pattern = new RegExp(patternSource, 'm')
  } catch (error) {
    fail(where, `"pattern" is not a valid regular expression: ${(error as Error).message}`)
  }

  return {
    kind: kind as CheckKind,
    path,
    pattern,
    patternSource,
    reason: requireString(record, 'reason', where),
  }
}

function parseAdaptation(raw: unknown, index: number): Adaptation {
  const where = `adaptations[${index}]`
  const record = asRecord(raw, where)
  rejectUnknownKeys(
    record,
    ['id', 'tier', 'summary', 'why', 'paths', 'tracked', 'upstream', 'branch', 'checks'],
    where,
  )

  const id = requireString(record, 'id', where)
  const at = `adaptations[${index}] (${id})`

  const tier = record.tier
  if (tier !== 1 && tier !== 2) {
    fail(at, '"tier" must be 1 (config/extension point) or 2 (thin patch)')
  }

  const tracked = record.tracked
  if (typeof tracked !== 'boolean') {
    fail(at, '"tracked" must be a boolean')
  }

  const rawPaths = record.paths
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    fail(at, '"paths" must be a non-empty array')
  }
  const paths = rawPaths.map((value, pathIndex) => {
    if (typeof value !== 'string' || value.trim() === '') {
      fail(at, `"paths[${pathIndex}]" must be a non-empty string`)
    }
    if (value.startsWith('/') || value.includes('..')) {
      fail(at, `"paths[${pathIndex}]" must be repo-relative without ".." (got "${value}")`)
    }
    return value
  })

  const upstreamRecord = asRecord(record.upstream, `${at}.upstream`)
  rejectUnknownKeys(upstreamRecord, ['status', 'pr'], `${at}.upstream`)
  const status = requireString(upstreamRecord, 'status', `${at}.upstream`)
  if (!UPSTREAM_STATUSES.includes(status as UpstreamStatus)) {
    fail(`${at}.upstream`, `"status" must be one of ${UPSTREAM_STATUSES.join(', ')}`)
  }
  const pr = upstreamRecord.pr
  if (pr !== undefined && (typeof pr !== 'string' || pr.trim() === '')) {
    fail(`${at}.upstream`, '"pr" must be a non-empty string when present')
  }
  if ((status === 'proposed' || status === 'merged') && pr === undefined) {
    fail(`${at}.upstream`, `status "${status}" requires a "pr" link`)
  }

  const branch = record.branch
  if (branch !== undefined && (typeof branch !== 'string' || branch.trim() === '')) {
    fail(at, '"branch" must be a non-empty string when present')
  }
  if (tier === 2 && branch === undefined) {
    fail(at, 'tier 2 requires "branch": a thin patch must say which branch carries it')
  }
  if (tier === 1 && branch !== undefined) {
    fail(at, 'tier 1 must not set "branch": config adaptations do not need a patch series')
  }

  const rawChecks = record.checks
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
    fail(at, '"checks" must be a non-empty array: an adaptation nothing verifies is not an adaptation')
  }
  const checks = rawChecks.map((check, checkIndex) =>
    parseCheck(check, `${at}.checks[${checkIndex}]`),
  )

  if (tracked && !checks.some((check) => check.kind.startsWith('local-'))) {
    fail(
      at,
      'a tracked adaptation needs at least one "local-*" check, otherwise a merge could revert it without anything going red',
    )
  }

  return {
    id,
    tier,
    summary: requireString(record, 'summary', at),
    why: requireString(record, 'why', at),
    paths,
    tracked,
    upstream: pr === undefined ? { status: status as UpstreamStatus } : { status: status as UpstreamStatus, pr: pr as string },
    ...(branch === undefined ? {} : { branch: branch as string }),
    checks,
  }
}

/** Parse and validate the manifest. Throws {@link ManifestError} on any problem. */
export function parseManifest(source: string): ForkManifest {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (error) {
    fail('manifest', `not valid JSON: ${(error as Error).message}`)
  }

  const record = asRecord(raw, 'manifest')
  rejectUnknownKeys(record, ['upstream', 'maxSyncAgeDays', 'adaptations'], 'manifest')

  const upstreamRecord = asRecord(record.upstream, 'manifest.upstream')
  rejectUnknownKeys(upstreamRecord, ['repo', 'remote', 'ref'], 'manifest.upstream')
  const remote = requireString(upstreamRecord, 'remote', 'manifest.upstream')
  const ref = requireString(upstreamRecord, 'ref', 'manifest.upstream')
  if (!ref.startsWith(`${remote}/`)) {
    fail(
      'manifest.upstream',
      `"ref" ("${ref}") must live on "remote" ("${remote}"), otherwise the fetch and the read look at different places`,
    )
  }

  const maxSyncAgeDays = record.maxSyncAgeDays
  if (typeof maxSyncAgeDays !== 'number' || !Number.isFinite(maxSyncAgeDays) || maxSyncAgeDays <= 0) {
    fail('manifest', '"maxSyncAgeDays" must be a positive number')
  }

  const rawAdaptations = record.adaptations
  if (!Array.isArray(rawAdaptations)) {
    fail('manifest', '"adaptations" must be an array')
  }
  const adaptations = rawAdaptations.map(parseAdaptation)

  const seen = new Set<string>()
  for (const adaptation of adaptations) {
    if (seen.has(adaptation.id)) {
      fail('manifest', `duplicate adaptation id "${adaptation.id}"`)
    }
    seen.add(adaptation.id)
  }

  return {
    upstream: {
      repo: requireString(upstreamRecord, 'repo', 'manifest.upstream'),
      remote,
      ref,
    },
    maxSyncAgeDays,
    adaptations,
  }
}
