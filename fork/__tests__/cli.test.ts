import { describe, it, expect, vi, afterEach } from 'vitest'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNodeDeps, main, parseArgs, UsageError } from '../cli'
import { EXIT } from '../sync'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseArgs', () => {
  it('accepts the three commands', () => {
    expect(parseArgs(['verify']).mode).toBe('verify')
    expect(parseArgs(['sync']).mode).toBe('sync')
    expect(parseArgs(['status']).mode).toBe('status')
  })

  it('defaults to the cheap, honest options', () => {
    expect(parseArgs(['sync'])).toEqual({
      mode: 'sync',
      upstreamGates: false,
      skipGates: false,
      json: false,
    })
  })

  it('accepts the documented sync flags', () => {
    expect(parseArgs(['sync', '--upstream-gates', '--json']).upstreamGates).toBe(true)
    expect(parseArgs(['sync', '--skip-gates']).skipGates).toBe(true)
  })

  it('rejects an unknown flag instead of quietly doing something else', () => {
    // A scheduled run that silently ignored "--verify_only" and did a full
    // fetch is a run that did not do what the crontab asked for.
    expect(() => parseArgs(['sync', '--verify_only'])).toThrow(UsageError)
    expect(() => parseArgs(['sync', '--verify_only'])).toThrow(/unknown flag "--verify_only"/)
  })

  it('rejects an unknown command', () => {
    expect(() => parseArgs(['upgrade'])).toThrow(/unknown command "upgrade"/)
  })

  it('requires exactly one command', () => {
    expect(() => parseArgs([])).toThrow(/expected exactly one command/)
    expect(() => parseArgs(['verify', 'sync'])).toThrow(/expected exactly one command/)
  })

  it('rejects contradictory gate flags', () => {
    expect(() => parseArgs(['sync', '--upstream-gates', '--skip-gates'])).toThrow(/contradict/)
  })

  it('rejects gate flags on commands that have no gates', () => {
    expect(() => parseArgs(['verify', '--upstream-gates'])).toThrow(/only apply to "sync"/)
    expect(() => parseArgs(['status', '--skip-gates'])).toThrow(/only apply to "sync"/)
  })
})

describe('createNodeDeps', () => {
  it('puts the scratch worktree outside the checkout, where vitest and eslint will not walk it', () => {
    const deps = createNodeDeps(REPO_ROOT)
    expect(deps.scratchDir.startsWith(`${REPO_ROOT}/`)).toBe(false)
  })

  it('reads a real file through the fs seam and returns null for a missing one', () => {
    const deps = createNodeDeps(REPO_ROOT)
    expect(deps.fs.readFile(deps.resolve(REPO_ROOT, 'fork/adaptations.json'))).toContain('erp-mafia/accounted')
    expect(deps.fs.readFile(deps.resolve(REPO_ROOT, 'fork/does-not-exist'))).toBeNull()
  })
})

describe('main', () => {
  it('returns the usage code and explains itself on a bad flag, without running anything', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    expect(main(['sync', '--nope'], REPO_ROOT)).toBe(EXIT.usage)
    expect(String(stderr.mock.calls[0][0])).toContain('unknown flag "--nope"')
  })

  it('runs verify end to end against this checkout and exits clean', () => {
    // The entry point itself, not just the functions under it: a CLI that
    // parses and then never calls anything would still exit 0 in silence.
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    const code = main(['verify'], REPO_ROOT)

    expect(stdout).toHaveBeenCalled()
    const printed = stdout.mock.calls.map((call) => String(call[0])).join('')
    expect(printed).toContain('# Fork sync report (verify)')
    expect(printed).toContain('## Adaptations')
    expect(code).toBe(EXIT.ok)
  })
})
