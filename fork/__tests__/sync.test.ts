import { describe, it, expect } from 'vitest'

import type { CommandResult } from '../lib/exec'
import { ALERT_MARKER, emitAlert, EXIT, run, type SyncDeps, type SyncOptions } from '../sync'

const ROOT = '/repo'

const MANIFEST = JSON.stringify({
  upstream: { repo: 'erp-mafia/accounted', remote: 'upstream', ref: 'upstream/main' },
  maxSyncAgeDays: 10,
  adaptations: [
    {
      id: 'fork-layer',
      tier: 1,
      summary: 'The fork/ directory.',
      why: 'Maintenance layer.',
      paths: ['fork/'],
      tracked: true,
      upstream: { status: 'not-applicable' },
      checks: [
        {
          kind: 'local-contains',
          path: 'fork/README.md',
          pattern: '^# Fork maintenance',
          reason: 'The fork documentation is gone.',
        },
      ],
    },
    {
      id: 'compose-override',
      tier: 1,
      summary: 'Host-local compose override.',
      why: 'Per-host deployment settings.',
      paths: ['docker-compose.override.yml'],
      tracked: false,
      upstream: { status: 'not-applicable' },
      checks: [
        {
          kind: 'upstream-contains',
          path: 'docker-compose.yml',
          pattern: '^  app:$',
          reason: 'Compose merges overrides by service name.',
        },
      ],
    },
  ],
})

const HEALTHY_TREE: Record<string, string> = {
  '/repo/fork/adaptations.json': MANIFEST,
  '/repo/fork/README.md': '# Fork maintenance\n',
  '/repo/node_modules/vitest': '',
  '/repo/node_modules/eslint': '',
  '/repo/node_modules/typescript': '',
}

const HEALTHY_COMMANDS: Record<string, CommandResult> = {
  'git remote': { code: 0, stdout: 'origin\nupstream\n', stderr: '' },
  'git remote get-url upstream': { code: 0, stdout: 'https://github.com/erp-mafia/accounted.git\n', stderr: '' },
  'git fetch --no-tags upstream': { code: 0, stdout: '', stderr: '' },
  'git rev-parse upstream/main': { code: 0, stdout: 'abc1234\n', stderr: '' },
  'git log -1 --format=%cI upstream/main': { code: 0, stdout: '2026-08-20T09:00:00Z\n', stderr: '' },
  'git rev-list --count HEAD..upstream/main': { code: 0, stdout: '0\n', stderr: '' },
  'git rev-list --count upstream/main..HEAD': { code: 0, stdout: '1\n', stderr: '' },
  'git diff --name-only upstream/main...HEAD': { code: 0, stdout: 'fork/README.md\nfork/sync.ts\n', stderr: '' },
  'git show upstream/main:docker-compose.yml': { code: 0, stdout: 'services:\n  app:\n', stderr: '' },
}

interface Harness {
  deps: SyncDeps
  written: Record<string, string>
  calls: string[]
}

function harness(overrides: {
  files?: Record<string, string>
  commands?: Record<string, CommandResult>
  env?: Record<string, string | undefined>
  now?: string
} = {}): Harness {
  const files = { ...HEALTHY_TREE, ...(overrides.files ?? {}) }
  for (const [path, value] of Object.entries(overrides.files ?? {})) {
    if (value === '__missing__') delete files[path]
  }
  const commands = { ...HEALTHY_COMMANDS, ...(overrides.commands ?? {}) }
  const written: Record<string, string> = {}
  const calls: string[] = []

  const deps: SyncDeps = {
    root: ROOT,
    runner: (command, args) => {
      const key = [command, ...args].join(' ')
      calls.push(key)
      return commands[key] ?? { code: 0, stdout: '', stderr: '' }
    },
    fs: {
      exists: (path) => path in files || path in written,
      readFile: (path) => written[path] ?? files[path] ?? null,
      writeFile: (path, content) => {
        written[path] = content
      },
      mkdirp: () => {},
    },
    resolve: (base, relative) => `${base}/${relative}`,
    now: () => new Date(overrides.now ?? '2026-08-22T12:00:00Z'),
    env: overrides.env ?? {},
    scratchDir: '/tmp/scratch',
  }

  return { deps, written, calls }
}

function options(mode: SyncOptions['mode'], extra: Partial<SyncOptions> = {}): SyncOptions {
  return { mode, upstreamGates: false, skipGates: false, json: false, ...extra }
}

describe('verify (offline)', () => {
  it('passes when every local marker is still in the tree, and says what it did not look at', () => {
    const { deps, calls } = harness()

    const outcome = run(deps, options('verify'))

    expect(outcome.exitCode).toBe(EXIT.ok)
    expect(outcome.adaptationAlarms).toEqual([])
    expect(calls).toEqual([])
    expect(outcome.notes.join(' ')).toContain('offline mode')
    expect(outcome.report).toContain('NOT CHECKED')
    expect(outcome.report).toContain('Upstream tip: NOT READ this run')
  })

  it('alarms with the adaptation reason when an upgrade reverted one of our files', () => {
    const { deps } = harness({ files: { '/repo/fork/README.md': 'upstream text\n' } })

    const outcome = run(deps, options('verify'))

    expect(outcome.exitCode).toBe(EXIT.adaptation)
    expect(outcome.adaptationAlarms).toHaveLength(1)
    expect(outcome.adaptationAlarms[0]).toContain('fork-layer')
    expect(outcome.adaptationAlarms[0]).toContain('The fork documentation is gone.')
  })

  it('alarms rather than passing when the manifest itself is missing', () => {
    const { deps } = harness({ files: { '/repo/fork/adaptations.json': '__missing__' } })

    const outcome = run(deps, options('verify'))

    expect(outcome.exitCode).toBe(EXIT.adaptation)
    expect(outcome.adaptationAlarms[0]).toContain('is missing')
  })

  it('alarms when the manifest is present but invalid', () => {
    const { deps } = harness({ files: { '/repo/fork/adaptations.json': '{"upstream":{}}' } })

    const outcome = run(deps, options('verify'))

    expect(outcome.exitCode).toBe(EXIT.adaptation)
    expect(outcome.adaptationAlarms[0]).toContain('is invalid')
  })
})

describe('sync', () => {
  it('is green when upstream is reachable, the anchors hold and the declared drift matches', () => {
    const { deps } = harness()

    const outcome = run(deps, options('sync'))

    expect(outcome.adaptationAlarms).toEqual([])
    expect(outcome.gateFailures).toEqual([])
    expect(outcome.plumbingProblems).toEqual([])
    expect(outcome.exitCode).toBe(EXIT.ok)
    expect(outcome.report).toContain('Upstream tip: abc1234')
    expect(outcome.report).toContain('0 commit(s) behind, 1 ahead')
  })

  it('alarms on undeclared drift in an upstream-owned file', () => {
    const { deps } = harness({
      commands: {
        'git diff --name-only upstream/main...HEAD': {
          code: 0,
          stdout: 'fork/README.md\nlib/bookkeeping/engine.ts\n',
          stderr: '',
        },
      },
    })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.adaptation)
    expect(outcome.adaptationAlarms.join('\n')).toContain('undeclared drift: lib/bookkeeping/engine.ts')
  })

  it('alarms specifically when the host-local override was committed by mistake', () => {
    const { deps } = harness({
      commands: {
        'git diff --name-only upstream/main...HEAD': {
          code: 0,
          stdout: 'fork/README.md\ndocker-compose.override.yml\n',
          stderr: '',
        },
      },
    })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.adaptation)
    expect(outcome.adaptationAlarms.join('\n')).toContain('declared host-local and must never be committed')
  })

  it('alarms when a declared adaptation has silently stopped differing from upstream', () => {
    // This is the requirement the whole layer exists for: an upgrade that
    // reverts our change makes it vanish from the diff, and a guard that only
    // looked for undeclared files would go green.
    const { deps } = harness({
      commands: {
        'git diff --name-only upstream/main...HEAD': { code: 0, stdout: '', stderr: '' },
      },
    })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.adaptation)
    expect(outcome.adaptationAlarms.join('\n')).toContain('[fork-layer]')
    expect(outcome.adaptationAlarms.join('\n')).toContain('none of it differs from upstream/main any more')
  })

  it('alarms when upstream refactored away the anchor a host-local override depends on', () => {
    const { deps } = harness({
      commands: {
        'git show upstream/main:docker-compose.yml': { code: 0, stdout: 'services:\n  web:\n', stderr: '' },
      },
    })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.adaptation)
    expect(outcome.adaptationAlarms.join('\n')).toContain('Compose merges overrides by service name.')
  })

  it('reports plumbing, not silence, when the upstream remote is not configured', () => {
    const { deps } = harness({ commands: { 'git remote': { code: 0, stdout: 'origin\n', stderr: '' } } })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.plumbing)
    expect(outcome.plumbingProblems.join('\n')).toContain('no "upstream" remote')
    expect(outcome.plumbingProblems.join('\n')).toContain('undeclared drift was not checked')
    expect(outcome.report).toContain('NOT CHECKED')
  })

  it('reports plumbing, not silence, when the remote named upstream points somewhere else', () => {
    // A remote can be repointed by hand or inherited from another clone. If
    // only the name were checked, the routine would fetch, diff and gate a
    // stranger's repository and report a clean sync.
    const { deps } = harness({
      commands: {
        'git remote get-url upstream': {
          code: 0, stdout: 'https://github.com/Tyrberg/accounted.git\n', stderr: '',
        },
      },
    })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.plumbing)
    expect(outcome.plumbingProblems.join('\n')).toContain('not the declared upstream erp-mafia/accounted')
    expect(outcome.checks.find((c) => c.adaptationId === 'compose-override')?.status).toBe('unavailable')
  })

  it('reports plumbing when the upstream remote URL cannot be read', () => {
    const { deps } = harness({
      commands: { 'git remote get-url upstream': { code: 2, stdout: '', stderr: 'No such remote' } },
    })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.plumbing)
    expect(outcome.plumbingProblems.join('\n')).toContain('could not read the URL of the "upstream" remote')
  })

  it('reports plumbing when the fetch fails, and does not report upstream anchors as passing', () => {
    const { deps } = harness({
      commands: { 'git fetch --no-tags upstream': { code: 128, stdout: '', stderr: 'network unreachable' } },
    })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.plumbing)
    expect(outcome.plumbingProblems.join('\n')).toContain('network unreachable')
    const upstreamCheck = outcome.checks.find((c) => c.adaptationId === 'compose-override')
    expect(upstreamCheck?.status).toBe('unavailable')
  })

  it('exits on the gate code when only a gate is red', () => {
    const { deps } = harness({ commands: { 'npm test': { code: 1, stdout: '3 failed', stderr: '' } } })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.gate)
    expect(outcome.gateFailures.join('\n')).toContain('npm test failed in the fork tree')
  })

  it('ranks an adaptation alarm above a red gate but still reports both, in the report and in the fields', () => {
    const { deps } = harness({
      files: { '/repo/fork/README.md': 'reverted\n' },
      commands: { 'npm test': { code: 1, stdout: 'boom', stderr: '' } },
    })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.adaptation)
    expect(outcome.adaptationAlarms).toHaveLength(1)
    expect(outcome.gateFailures).toHaveLength(1)
    expect(outcome.report).toContain('adaptations: 1 ALARM(S)')
    expect(outcome.report).toContain('gates: 1 FAILURE(S)')
  })

  it('says which tree each gate ran in, and does not claim to have checked upstream health by default', () => {
    const { deps } = harness()

    const outcome = run(deps, options('sync'))

    expect(outcome.gates.every((gate) => gate.tree === 'fork tree')).toBe(true)
    expect(outcome.notes.join('\n')).toContain('says nothing about whether upstream is green at its own tip')
  })

  it('runs the gates in both trees when --upstream-gates is passed', () => {
    const { deps, calls } = harness({
      files: {
        '/tmp/scratch/node_modules/vitest': '',
        '/tmp/scratch/node_modules/eslint': '',
        '/tmp/scratch/node_modules/typescript': '',
      },
    })

    const outcome = run(deps, options('sync', { upstreamGates: true }))

    expect(outcome.gates.filter((g) => g.tree === 'fork tree')).toHaveLength(3)
    expect(outcome.gates.filter((g) => g.tree === 'upstream tip')).toHaveLength(3)
    expect(calls).toContain('git worktree add --detach /tmp/scratch upstream/main')
    expect(calls).toContain('git worktree remove --force /tmp/scratch')
    expect(outcome.exitCode).toBe(EXIT.ok)
  })

  it('turns a red upstream gate into a gate failure that names the upstream tree', () => {
    const { deps } = harness({
      files: {
        '/tmp/scratch/node_modules/vitest': '',
        '/tmp/scratch/node_modules/eslint': '',
        '/tmp/scratch/node_modules/typescript': '',
      },
      commands: { 'npm test': { code: 1, stdout: 'upstream is red', stderr: '' } },
    })

    const outcome = run(deps, options('sync', { upstreamGates: true }))

    expect(outcome.gateFailures.some((f) => f.includes('upstream tip'))).toBe(true)
    expect(outcome.gateFailures.some((f) => f.includes('fork tree'))).toBe(true)
  })

  it('treats missing dev tooling as plumbing per gate, naming each one it could not run', () => {
    const { deps } = harness({
      files: { '/repo/node_modules/eslint': '__missing__', '/repo/node_modules/typescript': '__missing__' },
    })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.plumbing)
    const text = outcome.plumbingProblems.join('\n')
    expect(text).toContain('npm run check:lint')
    expect(text).toContain('npm run check:guards')
    expect(text).not.toContain('npm test not run')
  })

  it('records a note, not a plumbing alarm, when the operator asked to skip the gates', () => {
    const { deps, calls } = harness()

    const outcome = run(deps, options('sync', { skipGates: true }))

    expect(outcome.exitCode).toBe(EXIT.ok)
    expect(outcome.notes.join('\n')).toContain('--skip-gates')
    expect(calls.some((call) => call.startsWith('npm'))).toBe(false)
  })

  it('persists the run so a later status check can tell a dead schedule from a quiet one', () => {
    const { deps, written } = harness()

    run(deps, options('sync'))

    const state = JSON.parse(written['/repo/fork/state/last-sync.json'])
    expect(state.ranAt).toBe('2026-08-22T12:00:00.000Z')
    expect(state.exitCode).toBe(EXIT.ok)
    expect(state.upstreamSha).toBe('abc1234')
    expect(written['/repo/fork/state/last-report.md']).toContain('# Fork sync report')
  })

  it('persists an unreadable manifest as a failed run, so status can carry the alarm forward', () => {
    const { deps, written } = harness({ files: { '/repo/fork/adaptations.json': '__missing__' } })

    const outcome = run(deps, options('sync'))

    expect(outcome.exitCode).toBe(EXIT.adaptation)
    const state = JSON.parse(written['/repo/fork/state/last-sync.json'])
    expect(state.exitCode).toBe(EXIT.adaptation)
    expect(state.adaptationAlarms[0]).toContain('is missing')
  })

  it('never issues a git command that could move HEAD or touch a branch', () => {
    const { deps, calls } = harness({
      files: {
        '/tmp/scratch/node_modules/vitest': '',
        '/tmp/scratch/node_modules/eslint': '',
        '/tmp/scratch/node_modules/typescript': '',
      },
    })

    run(deps, options('sync', { upstreamGates: true }))

    const mutating = ['merge', 'rebase', 'checkout', 'reset', 'pull', 'push', 'commit', 'add', 'clean', 'stash']
    for (const call of calls.filter((c) => c.startsWith('git '))) {
      const verb = call.split(' ')[1]
      expect(mutating).not.toContain(verb)
    }
  })
})

describe('status', () => {
  it('reports that nothing is watching when the routine has never run here', () => {
    const { deps } = harness()

    const outcome = run(deps, options('status'))

    expect(outcome.exitCode).toBe(EXIT.plumbing)
    expect(outcome.plumbingProblems.join('\n')).toContain('never completed a run')
  })

  it('is quiet when the last run was recent and green', () => {
    const { deps } = harness({
      files: {
        '/repo/fork/state/last-sync.json': JSON.stringify({
          ranAt: '2026-08-20T12:00:00.000Z',
          exitCode: 0,
          upstreamSha: 'abc1234',
          adaptationAlarms: [],
          gateFailures: [],
          plumbingProblems: [],
        }),
      },
    })

    expect(run(deps, options('status')).exitCode).toBe(EXIT.ok)
  })

  it('alarms when the last run is older than the manifest allows, because a dead schedule looks like a quiet one', () => {
    const { deps } = harness({
      files: {
        '/repo/fork/state/last-sync.json': JSON.stringify({
          ranAt: '2026-07-01T12:00:00.000Z',
          exitCode: 0,
          upstreamSha: 'abc1234',
          adaptationAlarms: [],
          gateFailures: [],
          plumbingProblems: [],
        }),
      },
    })

    const outcome = run(deps, options('status'))

    expect(outcome.exitCode).toBe(EXIT.plumbing)
    expect(outcome.plumbingProblems.join('\n')).toContain('over the 10-day limit')
  })

  it('carries an uncleared alarm from the last run forward', () => {
    const { deps } = harness({
      files: {
        '/repo/fork/state/last-sync.json': JSON.stringify({
          ranAt: '2026-08-20T12:00:00.000Z',
          exitCode: EXIT.adaptation,
          upstreamSha: 'abc1234',
          adaptationAlarms: ['[fork-layer] the marker is gone'],
          gateFailures: [],
          plumbingProblems: [],
        }),
      },
    })

    const outcome = run(deps, options('status'))

    expect(outcome.exitCode).toBe(EXIT.adaptation)
    expect(outcome.adaptationAlarms.join('\n')).toContain('carried over: [fork-layer] the marker is gone')
  })
})

describe('emitAlert', () => {
  const failing = {
    mode: 'sync' as const,
    exitCode: EXIT.adaptation,
    adaptationAlarms: ['[fork-layer] the marker is gone'],
    gateFailures: [],
    plumbingProblems: [],
    notes: [],
    checks: [],
    gates: [],
    report: '# Fork sync report',
  }

  it('does nothing, and says nothing happened, on a green run', () => {
    const { deps, calls } = harness({ env: { FORK_SYNC_ALERT_REPO: 'Tyrberg/accounted' } })

    const result = emitAlert(deps, { ...failing, exitCode: EXIT.ok, adaptationAlarms: [] })

    expect(result.sent).toBe(false)
    expect(calls).toEqual([])
  })

  it('admits that no alert went out when no alert repo is configured', () => {
    const { deps } = harness()

    const result = emitAlert(deps, failing)

    expect(result.sent).toBe(false)
    expect(result.detail).toContain('FORK_SYNC_ALERT_REPO is not set')
    expect(result.detail).toContain('fork/state/last-report.md')
  })

  it('files an issue carrying the full report when gh is available and no alarm is open', () => {
    const { deps, calls } = harness({
      env: { FORK_SYNC_ALERT_REPO: 'Tyrberg/accounted' },
      commands: {
        'gh --version': { code: 0, stdout: 'gh version 2.0.0', stderr: '' },
      },
    })

    const result = emitAlert(deps, failing)

    expect(result.sent).toBe(true)
    expect(calls.some((c) => c.startsWith('gh issue create --repo Tyrberg/accounted'))).toBe(true)
    expect(calls.some((c) => c.includes(`[${ALERT_MARKER}] 1 adaptation alarm(s)`))).toBe(true)
    expect(calls.some((c) => c.includes('# Fork sync report'))).toBe(true)
  })

  it('updates the open alarm instead of filing a new issue every week', () => {
    const { deps, calls } = harness({
      env: { FORK_SYNC_ALERT_REPO: 'Tyrberg/accounted' },
      commands: {
        'gh --version': { code: 0, stdout: 'gh version 2.0.0', stderr: '' },
        [`gh issue list --repo Tyrberg/accounted --state open --search ${ALERT_MARKER} --json number --jq .[0].number`]:
          { code: 0, stdout: '42\n', stderr: '' },
      },
    })

    const result = emitAlert(deps, failing)

    expect(result.sent).toBe(true)
    expect(result.detail).toContain('Tyrberg/accounted#42')
    expect(calls.some((c) => c.startsWith('gh issue comment 42 --repo Tyrberg/accounted'))).toBe(true)
    expect(calls.some((c) => c.startsWith('gh issue create'))).toBe(false)
  })

  it('admits failure instead of reporting a sent alert when gh is missing', () => {
    const { deps } = harness({
      env: { FORK_SYNC_ALERT_REPO: 'Tyrberg/accounted' },
      commands: { 'gh --version': { code: 127, stdout: '', stderr: 'command not found' } },
    })

    const result = emitAlert(deps, failing)

    expect(result.sent).toBe(false)
    expect(result.detail).toContain('gh CLI is not usable')
  })

  it('admits failure when gh runs but the issue is rejected', () => {
    const { deps } = harness({
      env: { FORK_SYNC_ALERT_REPO: 'Tyrberg/accounted' },
      commands: {
        'gh --version': { code: 0, stdout: 'gh version 2.0.0', stderr: '' },
        [`gh issue create --repo Tyrberg/accounted --title [${ALERT_MARKER}] 1 adaptation alarm(s) --body # Fork sync report`]:
          { code: 1, stdout: '', stderr: 'HTTP 403' },
      },
    })

    const result = emitAlert(deps, failing)

    expect(result.sent).toBe(false)
    expect(result.detail).toContain('HTTP 403')
  })
})
