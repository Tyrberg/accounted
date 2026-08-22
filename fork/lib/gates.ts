/**
 * The test/lint/guard gates the sync routine runs, and the two trees it runs
 * them against.
 *
 * Two properties matter more than the gate list itself:
 *
 * 1. Every gate always produces a result line, including when it is skipped.
 *    A run that quietly executed one of three gates and reported "green" is
 *    the exact false all-clear this layer exists to prevent, so the preflight
 *    is per gate, never all-or-nothing.
 * 2. Every result names the tree it ran in. The gates in OUR checkout say
 *    nothing about upstream's health; the gates in a scratch worktree at
 *    upstream's tip say nothing about our adaptations. Conflating the two is
 *    how a report ends up claiming more than it inspected.
 */

import type { CommandResult, Runner } from './exec'
import { formatCommand, GATE_TIMEOUT_MS, PLUMBING_TIMEOUT_MS } from './exec'
import { runGit } from './git'

export interface FsProbe {
  exists(path: string): boolean
}

export interface GateSpec {
  id: string
  command: string
  args: readonly string[]
  /**
   * Dev dependencies the gate needs, as repo-relative paths. Absent tooling is
   * a skip with a named reason, not a red gate: a pruned production install
   * turning every Monday red is alarm fatigue, and alarm fatigue is how a real
   * alarm gets ignored.
   */
  requires: readonly { path: string; label: string }[]
}

export const GATES: readonly GateSpec[] = [
  {
    id: 'npm test',
    command: 'npm',
    args: ['test'],
    requires: [{ path: 'node_modules/vitest', label: 'vitest' }],
  },
  {
    id: 'npm run check:lint',
    command: 'npm',
    args: ['run', 'check:lint'],
    requires: [{ path: 'node_modules/eslint', label: 'eslint' }],
  },
  {
    id: 'npm run check:guards',
    command: 'npm',
    args: ['run', 'check:guards'],
    // scripts/checks/no-new-antipatterns.mjs imports typescript at runtime.
    requires: [{ path: 'node_modules/typescript', label: 'typescript' }],
  },
]

export type GateStatus = 'pass' | 'fail' | 'skipped'

export type TreeLabel = 'fork tree' | 'upstream tip'

export interface GateResult {
  gate: string
  tree: TreeLabel
  status: GateStatus
  detail: string
}

export interface RunGatesOptions {
  runner: Runner
  fs: FsProbe
  /** Absolute path of the checkout to run in. */
  cwd: string
  tree: TreeLabel
  /** Resolve a repo-relative path inside `cwd`. Injected so tests stay platform-free. */
  resolve: (cwd: string, relative: string) => string
}

function tail(result: CommandResult): string {
  const text = `${result.stdout}\n${result.stderr}`.trim()
  if (text === '') return 'no output'
  const lines = text.split('\n')
  return lines.slice(-3).join(' / ')
}

export function runGates(options: RunGatesOptions): GateResult[] {
  return GATES.map((gate) => {
    const missing = gate.requires.filter(
      (requirement) => !options.fs.exists(options.resolve(options.cwd, requirement.path)),
    )
    if (missing.length > 0) {
      return {
        gate: gate.id,
        tree: options.tree,
        status: 'skipped' as const,
        detail: `not run in the ${options.tree}: ${missing.map((m) => m.label).join(', ')} not installed`,
      }
    }
    const result = options.runner(gate.command, gate.args, {
      cwd: options.cwd,
      timeoutMs: GATE_TIMEOUT_MS,
    })
    return {
      gate: gate.id,
      tree: options.tree,
      status: result.code === 0 ? ('pass' as const) : ('fail' as const),
      detail: result.code === 0 ? `green in the ${options.tree}` : `exit ${result.code}: ${tail(result)}`,
    }
  })
}

export interface UpstreamGateOptions {
  runner: Runner
  fs: FsProbe
  /** The real checkout, which owns the git dir the worktree is attached to. */
  root: string
  /** Scratch directory for the detached worktree. Must be outside `root`. */
  worktreePath: string
  ref: string
  resolve: (cwd: string, relative: string) => string
}

export type UpstreamGateOutcome =
  | { ok: true; results: GateResult[] }
  /** Plumbing failed: the run says nothing about upstream, and must say so. */
  | { ok: false; reason: string; results: GateResult[] }

/**
 * Run the gates against upstream's tip in a throwaway detached worktree.
 *
 * This is the only way to answer "is upstream green" honestly. `npm ci` in the
 * worktree is required because the scratch checkout has no node_modules; if it
 * fails (offline box, registry outage) that is plumbing, not a red upstream,
 * and is reported as such so a network blip never reads as "upstream broke".
 */
export function runUpstreamGates(options: UpstreamGateOptions): UpstreamGateOutcome {
  if (options.worktreePath.startsWith(`${options.root}/`) || options.worktreePath === options.root) {
    return {
      ok: false,
      reason: `refusing to create the scratch worktree inside the checkout (${options.worktreePath})`,
      results: [],
    }
  }

  const added = runGit(options.runner, options.root, [
    'worktree',
    'add',
    '--detach',
    options.worktreePath,
    options.ref,
  ])
  if (added.code !== 0) {
    return {
      ok: false,
      reason: `could not create a worktree at ${options.ref}: ${tail(added)}`,
      results: [],
    }
  }

  try {
    const install = options.runner('npm', ['ci'], {
      cwd: options.worktreePath,
      timeoutMs: PLUMBING_TIMEOUT_MS,
    })
    if (install.code !== 0) {
      return {
        ok: false,
        reason: `${formatCommand('npm', ['ci'])} failed in the upstream worktree: ${tail(install)}`,
        results: [],
      }
    }
    return {
      ok: true,
      results: runGates({
        runner: options.runner,
        fs: options.fs,
        cwd: options.worktreePath,
        tree: 'upstream tip',
        resolve: options.resolve,
      }),
    }
  } finally {
    // Always removed: a leaked worktree makes the next run fail on "already
    // exists" and the alarm would then be about our own litter.
    runGit(options.runner, options.root, ['worktree', 'remove', '--force', options.worktreePath])
  }
}
