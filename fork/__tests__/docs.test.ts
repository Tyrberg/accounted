/**
 * The two artefacts in this layer that a human copies onto a box verbatim: the
 * compose override template and the `/etc/cron.d` entry in fork/README.md.
 *
 * Neither is executed by anything in CI, so a mistake in them is invisible
 * until it is a production mistake: a crontab line cron silently refuses to
 * run, or a template that turns authentication off on the host that copied it.
 * These assertions are what makes them fail here instead of there.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8')

const TEMPLATE_PATH = 'fork/templates/docker-compose.override.example.yml'
const template = read(TEMPLATE_PATH)

const templateLines = template.split('\n')
const uncommented = templateLines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))

describe('the compose override template', () => {
  it('sets no feature toggle that upstream reads to weaken authentication', () => {
    // Derived from upstream's own source rather than hard-coded, so a rename
    // upstream cannot leave this test guarding a variable nobody reads.
    // Upstream flyttade NEXT_PUBLIC_SELF_HOSTED fran mfa/bankid till
    // require-auth/session-timeout i lyftet 2026-09-05; listan foljer med
    // sa att kanariefageln nedan fortsatter vaka over ratt filer.
    const authSources = [
      'lib/auth/mfa.ts',
      'lib/auth/bankid.ts',
      'lib/auth/require-auth.ts',
      'lib/auth/session-timeout.ts',
    ].map(read).join('\n')
    // Upstream laser numera toggles bade som process.env.X och via sitt
    // validerade env-objekt (env.X); regexen fangar bada formerna.
    const toggles = [...authSources.matchAll(/\benv\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)].map((match) => match[1])

    expect(toggles).toContain('NEXT_PUBLIC_SELF_HOSTED')

    const offenders = uncommented.filter((line) => toggles.some((toggle) => line.includes(toggle)))
    expect(offenders).toEqual([])
  })

  it('keeps every port example tagged `!override`, since Compose appends lists', () => {
    // Without the tag the base 127.0.0.1:${PORT:-3000}:3000 binding survives
    // alongside the override and the two collide on the host port. Commented
    // examples count: they exist to be uncommented.
    const portLines = templateLines.filter((line) => /(^|#\s*)ports:/.test(line))

    expect(portLines.length).toBeGreaterThan(0)
    expect(portLines.filter((line) => !line.includes('!override'))).toEqual([])
  })

  it('leaves every service a non-empty mapping, so the file stays valid with the examples commented out', () => {
    // A service key with nothing but comments under it parses as null, which
    // Compose rejects. Every example in this file is commented by design, so
    // each service needs at least one real key.
    const services = uncommented
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^ {2}\w[\w-]*:$/.test(line))

    expect(services.length).toBeGreaterThan(0)

    const empty = services.filter(({ index }) => {
      const rest = uncommented.slice(index + 1)
      const next = rest.find((line) => /^ {2}\S/.test(line) || /^\S/.test(line))
      const body = next ? rest.slice(0, rest.indexOf(next)) : rest
      return body.length === 0
    })

    expect(empty.map(({ line }) => line.trim())).toEqual([])
  })

  it('names only services upstream actually declares, since Compose merges by service name', () => {
    const compose = read('docker-compose.yml')
    const names = uncommented
      .filter((line) => /^ {2}\w[\w-]*:$/.test(line))
      .map((line) => line.trim().replace(/:$/, ''))

    expect(names).toContain('app')
    expect(names.filter((name) => !new RegExp(`^ {2}${name}:$`, 'm').test(compose))).toEqual([])
  })
})

describe('the /etc/cron.d entry in fork/README.md', () => {
  const readme = read('fork/README.md')
  const block = readme.match(/```cron\n([\s\S]*?)```/)

  const lines = (block?.[1] ?? '').split('\n')
  const isComment = (line: string) => line.trim().startsWith('#')
  const isBlank = (line: string) => line.trim() === ''
  const isAssignment = (line: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)
  const scheduleLines = lines.filter((line) => !isComment(line) && !isBlank(line) && !isAssignment(line))

  it('is present and holds exactly one schedule line', () => {
    expect(block).not.toBeNull()
    expect(scheduleLines.length).toBe(1)
  })

  it('uses no line continuation, which crontab does not support', () => {
    expect(lines.filter((line) => line.trimEnd().endsWith('\\'))).toEqual([])
  })

  it('gives the schedule line a user field, which /etc/cron.d requires', () => {
    // Field 6 is the user. Get it wrong and cron reads the first word of the
    // command as the username, refuses the line, and the routine never fires:
    // a failure that looks exactly like "nothing to report".
    for (const line of scheduleLines) {
      const fields = line.trim().split(/\s+/)
      expect(fields.length).toBeGreaterThan(6)

      const user = fields[5]
      expect(user).toMatch(/^[a-z_][a-z0-9_-]*$/)
      expect(['cd', 'npx', 'npm', 'curl', 'sh', 'bash', 'env', 'export']).not.toContain(user)

      expect(fields.slice(6).join(' ')).toContain('fork/cli.ts sync')
    }
  })

  it('logs somewhere the cron user can actually write', () => {
    // The shell opens the redirect BEFORE running the command, as the cron
    // user. An absolute path that user cannot create (the classic /var/log
    // entry) kills the job at the redirect every week without ever running the
    // sync: silent in exactly the way this routine exists to prevent.
    for (const line of scheduleLines) {
      const target = line.match(/>>\s*(\S+)/)?.[1]
      expect(target).toBeDefined()
      expect(target?.startsWith('/')).toBe(false)
    }
  })

  it('passes the alert repo and heartbeat through the crontab environment', () => {
    // Both are documented in section 5 as the way the run makes noise; an
    // example that omits them ships a routine that alarms nowhere.
    expect(lines.some((line) => line.startsWith('FORK_SYNC_ALERT_REPO='))).toBe(true)
    expect(lines.some((line) => line.startsWith('FORK_SYNC_HEARTBEAT_URL='))).toBe(true)
  })
})
