/**
 * The fork sync routine.
 *
 * One job, run weekly on the box that hosts the clone: fetch upstream, prove
 * that every adaptation this fork declares is still intact, prove that nothing
 * undeclared has crept in, run the gates in both trees, and make noise when any
 * of that fails. The single requirement it is built around is that OUR FIXES
 * MUST NEVER DISAPPEAR SILENTLY when we take an upstream upgrade.
 *
 * Everything is injected through {@link SyncDeps}, so the whole decision tree
 * is unit-tested without touching git, the network or the filesystem.
 * fork/cli.ts is the only entry point that binds the real implementations.
 */

import {
  evaluateAdaptations,
  reconcileDrift,
  UNAVAILABLE_TREE,
  type CheckResult,
  type Tree,
} from './lib/checks'
import type { Runner } from './lib/exec'
import {
  changedVersusUpstream,
  countAhead,
  countBehind,
  describeRef,
  fetchUpstream,
  readRemotes,
  readRemoteUrl,
  remoteMatchesRepo,
  upstreamTree,
} from './lib/git'
import { runGates, runUpstreamGates, type FsProbe, type GateResult } from './lib/gates'
import { ManifestError, parseManifest, type ForkManifest } from './lib/manifest'

export const MANIFEST_PATH = 'fork/adaptations.json'
export const STATE_PATH = 'fork/state/last-sync.json'
export const REPORT_PATH = 'fork/state/last-report.md'
/** Title marker that lets a later run find and update its own open alarm. */
export const ALERT_MARKER = 'fork-sync-alarm'

/**
 * Exit codes. 1 is reserved for the launcher (bad flags, an unhandled throw),
 * so a crashed process is never mistaken for a clean adaptation alarm.
 *
 * The code is the HIGHEST-priority category that fired, but the report always
 * carries one line per category, so nothing is hidden by the ranking.
 */
export const EXIT = {
  ok: 0,
  usage: 1,
  /** A declared adaptation broke, vanished, or something undeclared appeared. */
  adaptation: 2,
  /** A gate went red. */
  gate: 3,
  /** The run could not look: no remote, fetch failed, worktree failed. */
  plumbing: 4,
} as const

export interface SyncFs extends FsProbe {
  readFile(path: string): string | null
  writeFile(path: string, content: string): void
  mkdirp(path: string): void
}

export interface SyncDeps {
  root: string
  runner: Runner
  fs: SyncFs
  /** Join a base directory with a repo-relative path. */
  resolve: (base: string, relative: string) => string
  now: () => Date
  env: Record<string, string | undefined>
  /** Where the scratch worktree for upstream gates is created. Must be outside root. */
  scratchDir: string
}

export interface SyncOptions {
  mode: 'verify' | 'sync' | 'status'
  /** Run the gates against upstream's tip in a scratch worktree (sync only). */
  upstreamGates: boolean
  /** Skip the gates entirely; anchors and drift only. */
  skipGates: boolean
  json: boolean
}

export interface SyncOutcome {
  mode: SyncOptions['mode']
  exitCode: number
  /** Everything that means "a fix of ours is at risk". Never empty when exitCode is 2. */
  adaptationAlarms: string[]
  gateFailures: string[]
  plumbingProblems: string[]
  /**
   * Things this run deliberately did not do because it was asked not to.
   * Always printed, never part of the exit code: a documented choice is not an
   * alarm, but it must still be impossible to read the report as "all checked".
   */
  notes: string[]
  checks: CheckResult[]
  gates: GateResult[]
  report: string
}

interface UpstreamSnapshot {
  available: boolean
  tree: Tree
  sha?: string
  committedAt?: string
  behind?: number | null
  ahead?: number | null
  changedPaths?: string[]
}

function loadManifest(deps: SyncDeps): { manifest: ForkManifest } | { error: string } {
  const source = deps.fs.readFile(deps.resolve(deps.root, MANIFEST_PATH))
  if (source === null) {
    return { error: `${MANIFEST_PATH} is missing: this checkout cannot say what our adaptations are` }
  }
  try {
    return { manifest: parseManifest(source) }
  } catch (error) {
    if (error instanceof ManifestError) {
      return { error: `${MANIFEST_PATH} is invalid: ${error.message}` }
    }
    throw error
  }
}

function localTree(deps: SyncDeps): Tree {
  return { read: (path) => deps.fs.readFile(deps.resolve(deps.root, path)) }
}

function collectUpstream(deps: SyncDeps, manifest: ForkManifest, plumbing: string[]): UpstreamSnapshot {
  const { repo, remote, ref } = manifest.upstream

  const remotes = readRemotes(deps.runner, deps.root, remote)
  if (!remotes.hasRemote) {
    plumbing.push(
      `no "${remote}" remote in this checkout (found: ${remotes.remotes.join(', ') || 'none'}), so nothing upstream was inspected`,
    )
    return { available: false, tree: UNAVAILABLE_TREE }
  }

  // The remote's NAME is not evidence of its identity. Without this check a
  // repointed or inherited "upstream" would be fetched, diffed and gated
  // against, and the run would report a clean sync of the wrong repository.
  const remoteUrl = readRemoteUrl(deps.runner, deps.root, remote)
  if (remoteUrl === null) {
    plumbing.push(`could not read the URL of the "${remote}" remote, so nothing upstream was inspected`)
    return { available: false, tree: UNAVAILABLE_TREE }
  }
  if (!remoteMatchesRepo(remoteUrl, repo)) {
    plumbing.push(
      `the "${remote}" remote points at ${remoteUrl}, not the declared upstream ${repo}, so nothing upstream was inspected`,
    )
    return { available: false, tree: UNAVAILABLE_TREE }
  }

  const fetched = fetchUpstream(deps.runner, deps.root, remote)
  if (fetched.code !== 0) {
    plumbing.push(
      `git fetch ${remote} failed (exit ${fetched.code}: ${fetched.stderr.trim() || 'no stderr'}), so nothing upstream was inspected`,
    )
    return { available: false, tree: UNAVAILABLE_TREE }
  }

  const described = describeRef(deps.runner, deps.root, ref)
  if (described === null) {
    plumbing.push(`${ref} does not resolve after fetching ${remote}, so nothing upstream was inspected`)
    return { available: false, tree: UNAVAILABLE_TREE }
  }

  const diff = changedVersusUpstream(deps.runner, deps.root, ref)
  if (!diff.ok) {
    plumbing.push(`could not diff against ${ref}: ${diff.error}`)
    return {
      available: true,
      tree: upstreamTree(deps.runner, deps.root, ref),
      sha: described.sha,
      committedAt: described.committedAt,
      behind: countBehind(deps.runner, deps.root, ref),
      ahead: countAhead(deps.runner, deps.root, ref),
    }
  }

  return {
    available: true,
    tree: upstreamTree(deps.runner, deps.root, ref),
    sha: described.sha,
    committedAt: described.committedAt,
    behind: countBehind(deps.runner, deps.root, ref),
    ahead: countAhead(deps.runner, deps.root, ref),
    changedPaths: diff.paths,
  }
}

function severityExit(outcome: {
  adaptationAlarms: string[]
  gateFailures: string[]
  plumbingProblems: string[]
}): number {
  if (outcome.adaptationAlarms.length > 0) return EXIT.adaptation
  if (outcome.gateFailures.length > 0) return EXIT.gate
  if (outcome.plumbingProblems.length > 0) return EXIT.plumbing
  return EXIT.ok
}

function renderReport(params: {
  mode: SyncOptions['mode']
  manifestRef: string
  upstream: UpstreamSnapshot
  checks: CheckResult[]
  gates: GateResult[]
  adaptationAlarms: string[]
  gateFailures: string[]
  plumbingProblems: string[]
  notes: string[]
  exitCode: number
  timestamp: string
}): string {
  const lines: string[] = []
  lines.push(`# Fork sync report (${params.mode})`)
  lines.push('')
  lines.push(`Run at: ${params.timestamp}`)
  lines.push(`Upstream ref: ${params.manifestRef}`)
  if (params.upstream.available) {
    lines.push(
      `Upstream tip: ${params.upstream.sha ?? 'unknown'} (${params.upstream.committedAt ?? 'unknown'})`,
    )
    lines.push(
      `Distance: ${params.upstream.behind ?? 'unknown'} commit(s) behind, ${params.upstream.ahead ?? 'unknown'} ahead`,
    )
  } else {
    lines.push('Upstream tip: NOT READ this run')
  }
  lines.push('')

  lines.push('## Adaptations')
  if (params.checks.length === 0) {
    lines.push('- no checks were evaluated')
  }
  for (const result of params.checks) {
    const mark = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : 'NOT CHECKED'
    lines.push(`- ${mark} [${result.adaptationId}] ${result.detail}`)
  }
  lines.push('')

  lines.push('## Gates')
  if (params.gates.length === 0) {
    lines.push('- no gates ran this run')
  }
  for (const gate of params.gates) {
    lines.push(`- ${gate.status.toUpperCase()} ${gate.gate} (${gate.tree}): ${gate.detail}`)
  }
  lines.push('')

  lines.push('## Verdict')
  lines.push(
    params.adaptationAlarms.length === 0
      ? '- adaptations: no alarm'
      : `- adaptations: ${params.adaptationAlarms.length} ALARM(S)`,
  )
  for (const alarm of params.adaptationAlarms) lines.push(`  - ${alarm}`)
  lines.push(
    params.gateFailures.length === 0 ? '- gates: no failure' : `- gates: ${params.gateFailures.length} FAILURE(S)`,
  )
  for (const failure of params.gateFailures) lines.push(`  - ${failure}`)
  lines.push(
    params.plumbingProblems.length === 0
      ? '- plumbing: nothing blocked this run'
      : `- plumbing: ${params.plumbingProblems.length} PROBLEM(S)`,
  )
  for (const problem of params.plumbingProblems) lines.push(`  - ${problem}`)
  lines.push(
    params.notes.length === 0
      ? '- deliberately skipped: nothing'
      : `- deliberately skipped: ${params.notes.length} item(s), which this run therefore says nothing about`,
  )
  for (const note of params.notes) lines.push(`  - ${note}`)
  lines.push('')
  lines.push(`Exit code: ${params.exitCode}`)

  return lines.join('\n')
}

/** The offline half: manifest validity plus every local check. Needs no network. */
export function runVerify(deps: SyncDeps, options: SyncOptions): SyncOutcome {
  const loaded = loadManifest(deps)
  const timestamp = deps.now().toISOString()

  if ('error' in loaded) {
    const adaptationAlarms = [loaded.error]
    return {
      mode: options.mode,
      exitCode: EXIT.adaptation,
      adaptationAlarms,
      gateFailures: [],
      plumbingProblems: [],
      notes: [],
      checks: [],
      gates: [],
      report: renderReport({
        mode: options.mode,
        manifestRef: 'unknown (manifest unreadable)',
        upstream: { available: false, tree: UNAVAILABLE_TREE },
        checks: [],
        gates: [],
        adaptationAlarms,
        gateFailures: [],
        plumbingProblems: [],
        notes: [],
        exitCode: EXIT.adaptation,
        timestamp,
      }),
    }
  }

  const { manifest } = loaded
  const notes = [
    'offline mode: upstream anchors, undeclared drift and the gates were not inspected. Run "sync" for those',
  ]
  const checks = evaluateAdaptations(manifest.adaptations, {
    local: localTree(deps),
    upstream: UNAVAILABLE_TREE,
    includeUpstream: false,
  })
  const adaptationAlarms = checks
    .filter((result) => result.status === 'fail')
    .map((result) => `[${result.adaptationId}] ${result.detail} (${result.check.reason})`)

  const exitCode = severityExit({ adaptationAlarms, gateFailures: [], plumbingProblems: [] })
  return {
    mode: options.mode,
    exitCode,
    adaptationAlarms,
    gateFailures: [],
    plumbingProblems: [],
    notes,
    checks,
    gates: [],
    report: renderReport({
      mode: options.mode,
      manifestRef: manifest.upstream.ref,
      upstream: { available: false, tree: UNAVAILABLE_TREE },
      checks,
      gates: [],
      adaptationAlarms,
      gateFailures: [],
      plumbingProblems: [],
      notes,
      exitCode,
      timestamp,
    }),
  }
}

/** The full weekly routine. */
export function runSync(deps: SyncDeps, options: SyncOptions): SyncOutcome {
  const loaded = loadManifest(deps)
  if ('error' in loaded) {
    // Still persisted: a run that could not read the manifest is the loudest
    // possible alarm, and `status` has to be able to carry it forward.
    const outcome = runVerify(deps, options)
    writeState(deps, {
      ranAt: deps.now().toISOString(),
      exitCode: outcome.exitCode,
      upstreamSha: null,
      adaptationAlarms: outcome.adaptationAlarms,
      gateFailures: outcome.gateFailures,
      plumbingProblems: outcome.plumbingProblems,
    })
    writeReport(deps, outcome.report)
    return outcome
  }
  const { manifest } = loaded
  const timestamp = deps.now().toISOString()

  const plumbingProblems: string[] = []
  const notes: string[] = []
  const upstream = collectUpstream(deps, manifest, plumbingProblems)

  const checks = evaluateAdaptations(manifest.adaptations, {
    local: localTree(deps),
    upstream: upstream.tree,
    includeUpstream: upstream.available,
  })

  const adaptationAlarms = checks
    .filter((result) => result.status === 'fail')
    .map((result) => `[${result.adaptationId}] ${result.detail} (${result.check.reason})`)

  if (upstream.changedPaths !== undefined) {
    const drift = reconcileDrift(upstream.changedPaths, manifest.adaptations)
    for (const path of drift.undeclared) {
      adaptationAlarms.push(
        `undeclared drift: ${path} differs from ${manifest.upstream.ref} but no adaptation declares it. Either revert it or add it to ${MANIFEST_PATH}`,
      )
    }
    for (const entry of drift.committedHostLocal) {
      adaptationAlarms.push(
        `[${entry.adaptationId}] ${entry.path} is declared host-local and must never be committed, but it is in the diff against ${manifest.upstream.ref}. Remove it from the index and keep it untracked on the box`,
      )
    }
    for (const adaptation of drift.vanished) {
      adaptationAlarms.push(
        `[${adaptation.id}] declares ${adaptation.paths.join(', ')} but none of it differs from ${manifest.upstream.ref} any more. Either an upgrade reverted our change, or upstream adopted it and the entry should be retired`,
      )
    }
  } else if (upstream.available) {
    plumbingProblems.push('the diff against upstream was not read, so undeclared drift was not checked')
  } else {
    plumbingProblems.push('upstream was not reachable, so undeclared drift was not checked')
  }

  const gates: GateResult[] = []
  if (options.skipGates) {
    notes.push('--skip-gates was passed, so this run says nothing about test health in either tree')
  } else {
    gates.push(
      ...runGates({
        runner: deps.runner,
        fs: deps.fs,
        cwd: deps.root,
        tree: 'fork tree',
        resolve: deps.resolve,
      }),
    )
    if (options.upstreamGates) {
      if (!upstream.available) {
        plumbingProblems.push(
          'upstream gates were requested but upstream was not reachable, so upstream health is unknown',
        )
      } else {
        const outcome = runUpstreamGates({
          runner: deps.runner,
          fs: deps.fs,
          root: deps.root,
          worktreePath: deps.scratchDir,
          ref: manifest.upstream.ref,
          resolve: deps.resolve,
        })
        gates.push(...outcome.results)
        if (!outcome.ok) plumbingProblems.push(outcome.reason)
      }
    } else {
      notes.push(
        'upstream gates were not requested (--upstream-gates), so this run says nothing about whether upstream is green at its own tip. The weekly schedule in fork/README.md passes the flag',
      )
    }
  }

  const gateFailures = gates
    .filter((gate) => gate.status === 'fail')
    .map((gate) => `${gate.gate} failed in the ${gate.tree}: ${gate.detail}`)
  for (const gate of gates) {
    if (gate.status === 'skipped') plumbingProblems.push(`${gate.gate} ${gate.detail}`)
  }

  const exitCode = severityExit({ adaptationAlarms, gateFailures, plumbingProblems })
  const report = renderReport({
    mode: options.mode,
    manifestRef: manifest.upstream.ref,
    upstream,
    checks,
    gates,
    adaptationAlarms,
    gateFailures,
    plumbingProblems,
    notes,
    exitCode,
    timestamp,
  })

  writeState(deps, {
    ranAt: timestamp,
    exitCode,
    upstreamSha: upstream.sha ?? null,
    adaptationAlarms,
    gateFailures,
    plumbingProblems,
  })
  writeReport(deps, report)

  return {
    mode: options.mode,
    exitCode,
    adaptationAlarms,
    gateFailures,
    plumbingProblems,
    notes,
    checks,
    gates,
    report,
  }
}

export interface SyncState {
  ranAt: string
  exitCode: number
  upstreamSha: string | null
  adaptationAlarms: string[]
  gateFailures: string[]
  plumbingProblems: string[]
}

function writeState(deps: SyncDeps, state: SyncState): void {
  const target = deps.resolve(deps.root, STATE_PATH)
  deps.fs.mkdirp(deps.resolve(deps.root, 'fork/state'))
  deps.fs.writeFile(target, `${JSON.stringify(state, null, 2)}\n`)
}

function writeReport(deps: SyncDeps, report: string): void {
  deps.fs.mkdirp(deps.resolve(deps.root, 'fork/state'))
  deps.fs.writeFile(deps.resolve(deps.root, REPORT_PATH), `${report}\n`)
}

export function readState(deps: SyncDeps): SyncState | null {
  const raw = deps.fs.readFile(deps.resolve(deps.root, STATE_PATH))
  if (raw === null) return null
  try {
    return JSON.parse(raw) as SyncState
  } catch {
    return null
  }
}

/**
 * "Is the routine actually running?"
 *
 * A scheduled job that quietly stopped looks exactly like a scheduled job with
 * nothing to report, so staleness is itself an alarm. This is the half that a
 * human (or a second, dumber cron) can call cheaply; the README also describes
 * the external dead-man's switch, which is the only thing that can catch the
 * case where the whole box is down.
 */
export function runStatus(deps: SyncDeps, options: SyncOptions): SyncOutcome {
  const loaded = loadManifest(deps)
  const maxAgeDays = 'error' in loaded ? 10 : loaded.manifest.maxSyncAgeDays
  const state = readState(deps)
  const timestamp = deps.now().toISOString()

  const adaptationAlarms: string[] = []
  const plumbingProblems: string[] = []

  if ('error' in loaded) adaptationAlarms.push(loaded.error)

  if (state === null) {
    plumbingProblems.push(
      `no ${STATE_PATH}: the sync routine has never completed a run in this checkout, so nothing is watching upstream here`,
    )
  } else {
    const ranAt = Date.parse(state.ranAt)
    if (Number.isNaN(ranAt)) {
      plumbingProblems.push(`${STATE_PATH} has an unreadable ranAt ("${state.ranAt}")`)
    } else {
      const ageDays = (deps.now().getTime() - ranAt) / 86_400_000
      if (ageDays > maxAgeDays) {
        plumbingProblems.push(
          `the last sync finished ${ageDays.toFixed(1)} days ago, over the ${maxAgeDays}-day limit: assume the schedule is dead until proven otherwise`,
        )
      }
    }
    if (state.exitCode !== EXIT.ok) {
      adaptationAlarms.push(
        `the last sync (${state.ranAt}) exited ${state.exitCode} and the alarm has not been cleared`,
      )
      for (const alarm of state.adaptationAlarms) adaptationAlarms.push(`carried over: ${alarm}`)
    }
  }

  const exitCode = severityExit({ adaptationAlarms, gateFailures: [], plumbingProblems })
  return {
    mode: options.mode,
    exitCode,
    adaptationAlarms,
    gateFailures: [],
    plumbingProblems,
    notes: ['status only reads the last recorded run: it inspects neither the tree nor upstream'],
    checks: [],
    gates: [],
    report: renderReport({
      mode: options.mode,
      manifestRef: 'error' in loaded ? 'unknown (manifest unreadable)' : loaded.manifest.upstream.ref,
      upstream: { available: false, tree: UNAVAILABLE_TREE },
      checks: [],
      gates: [],
      adaptationAlarms,
      gateFailures: [],
      plumbingProblems,
      notes: ['status only reads the last recorded run: it inspects neither the tree nor upstream'],
      exitCode,
      timestamp,
    }),
  }
}

/**
 * Turn a non-zero outcome into something a human will actually see.
 *
 * Exit codes only alarm if something reads them, and cron mails root, which
 * nobody reads either. When FORK_SYNC_ALERT_REPO is set and the gh CLI is
 * present, the report is filed as an issue in that repo. When it is not, the
 * function says so rather than pretending an alert went out.
 */
export function emitAlert(deps: SyncDeps, outcome: SyncOutcome): { sent: boolean; detail: string } {
  if (outcome.exitCode === EXIT.ok) return { sent: false, detail: 'nothing to alert about' }

  const repo = deps.env.FORK_SYNC_ALERT_REPO
  if (!repo) {
    return {
      sent: false,
      detail: `FORK_SYNC_ALERT_REPO is not set, so no issue was filed. The report is in ${REPORT_PATH} and the exit code is ${outcome.exitCode}`,
    }
  }

  const probe = deps.runner('gh', ['--version'], { cwd: deps.root })
  if (probe.code !== 0) {
    return {
      sent: false,
      detail: `the gh CLI is not usable here (exit ${probe.code}), so no issue was filed. The report is in ${REPORT_PATH}`,
    }
  }

  const summary =
    outcome.adaptationAlarms.length > 0
      ? `${outcome.adaptationAlarms.length} adaptation alarm(s)`
      : outcome.gateFailures.length > 0
        ? `${outcome.gateFailures.length} gate failure(s)`
        : 'the run could not complete its checks'

  // A weekly job that files a fresh issue every Monday trains everyone to
  // ignore it, so an open alarm is updated in place and only a first failure
  // opens something new.
  const existing = deps.runner(
    'gh',
    ['issue', 'list', '--repo', repo, '--state', 'open', '--search', ALERT_MARKER, '--json', 'number', '--jq', '.[0].number'],
    { cwd: deps.root },
  )
  const openIssue = existing.code === 0 ? existing.stdout.trim() : ''
  if (openIssue !== '') {
    const commented = deps.runner(
      'gh',
      ['issue', 'comment', openIssue, '--repo', repo, '--body', outcome.report],
      { cwd: deps.root },
    )
    return commented.code === 0
      ? { sent: true, detail: `updated the open alarm ${repo}#${openIssue}` }
      : {
          sent: false,
          detail: `gh issue comment on ${repo}#${openIssue} failed (exit ${commented.code}): ${commented.stderr.trim()}`,
        }
  }

  const created = deps.runner(
    'gh',
    ['issue', 'create', '--repo', repo, '--title', `[${ALERT_MARKER}] ${summary}`, '--body', outcome.report],
    { cwd: deps.root },
  )
  return created.code === 0
    ? { sent: true, detail: `filed an issue in ${repo}: ${created.stdout.trim()}` }
    : { sent: false, detail: `gh issue create failed (exit ${created.code}): ${created.stderr.trim()}` }
}

export function run(deps: SyncDeps, options: SyncOptions): SyncOutcome {
  if (options.mode === 'verify') return runVerify(deps, options)
  if (options.mode === 'status') return runStatus(deps, options)
  return runSync(deps, options)
}
