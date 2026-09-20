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

const isComment = (line: string) => line.trim().startsWith('#')
const isBlank = (line: string) => line.trim() === ''
const isAssignment = (line: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)

interface CronBlock {
  where: string
  lines: string[]
  scheduleLines: string[]
}

/** Every ```cron fence in a document, in order. */
function cronBlocks(path: string): CronBlock[] {
  const source = read(path)
  return [...source.matchAll(/```cron\n([\s\S]*?)```/g)].map((match, index) => {
    const lines = match[1].split('\n')
    return {
      where: `${path} block ${index + 1}`,
      lines,
      scheduleLines: lines.filter((line) => !isComment(line) && !isBlank(line) && !isAssignment(line)),
    }
  })
}

const readmeCron = cronBlocks('fork/README.md')
// Every schedule a human installs on a box: the fork sync (section 5),
// bertil's export delivery and the standing check that watches it (section
// 11). The delivery one is why the hand-off is nobody's daily chore, so a
// line cron silently refuses there means the chain quietly goes back to
// Mattias uploading a file by hand, and the watcher is what makes that
// noticed.
const everyCronBlock = [...readmeCron, ...cronBlocks('docs/underlagsjakt-export-schema.md')]

describe.each(everyCronBlock)('the /etc/cron.d entry in $where', (block) => {
  it('holds exactly one schedule line', () => {
    expect(block.scheduleLines.length).toBe(1)
  })

  it('uses no line continuation, which crontab does not support', () => {
    expect(block.lines.filter((line) => line.trimEnd().endsWith('\\'))).toEqual([])
  })

  it('gives the schedule line a user field, which /etc/cron.d requires', () => {
    // Field 6 is the user. Get it wrong and cron reads the first word of the
    // command as the username, refuses the line, and the routine never fires:
    // a failure that looks exactly like "nothing to report".
    for (const line of block.scheduleLines) {
      const fields = line.trim().split(/\s+/)
      expect(fields.length).toBeGreaterThan(6)

      const user = fields[5]
      expect(user).toMatch(/^[a-z_][a-z0-9_-]*$/)
      expect(['cd', 'npx', 'npm', 'curl', 'sh', 'bash', 'env', 'export', 'python', 'python3']).not.toContain(user)
    }
  })

  it('logs somewhere the cron user can actually write', () => {
    // The shell opens the redirect BEFORE running the command, as the cron
    // user. An absolute path that user cannot create (the classic /var/log
    // entry) kills the job at the redirect every week without ever running the
    // command: silent in exactly the way these routines exist to prevent.
    for (const line of block.scheduleLines) {
      const target = line.match(/>>\s*(\S+)/)?.[1]
      expect(target).toBeDefined()
      expect(target?.startsWith('/')).toBe(false)
    }
  })
})

describe('the fork sync crontab in fork/README.md section 5', () => {
  const block = readmeCron[0]

  it('is present and runs the sync', () => {
    expect(block).toBeDefined()
    expect(block.scheduleLines[0]).toContain('fork/cli.ts sync')
  })

  it('passes the alert repo and heartbeat through the crontab environment', () => {
    // Both are documented in section 5 as the way the run makes noise; an
    // example that omits them ships a routine that alarms nowhere.
    expect(block.lines.some((line) => line.startsWith('FORK_SYNC_ALERT_REPO='))).toBe(true)
    expect(block.lines.some((line) => line.startsWith('FORK_SYNC_HEARTBEAT_URL='))).toBe(true)
  })
})

describe("the underlagsjakt delivery crontab, which is what makes the delivery automatic", () => {
  const schedules = everyCronBlock
    .flatMap((block) => block.scheduleLines)
    .filter((line) => line.includes('underlagsjakt_export_client.py'))

  it('is documented on both sides of the hand-off', () => {
    // fork/README.md section 11 is the operator order; the export schema doc
    // is what bertil's side is built against. Requirement 6 of the task is
    // this schedule, so a repository that stopped documenting it ships a
    // delivery nobody starts.
    expect(schedules.length).toBe(2)
  })

  it('is the same line in both places, so the two copies cannot drift', () => {
    expect(new Set(schedules.map((line) => line.trim())).size).toBe(1)
  })

  it('runs daily, which is what leverans-status.ts calls fresh', () => {
    // MAX_QUIET_DAYS in extensions/general/underlagsjakt/leverans-status.ts is
    // 2: a schedule sparser than daily would alarm on every healthy run.
    const [minute, hour, dayOfMonth, month, dayOfWeek] = schedules[0].trim().split(/\s+/)
    expect(minute).toMatch(/^\d+$/)
    expect(hour).toMatch(/^\d+$/)
    expect([dayOfMonth, month, dayOfWeek]).toEqual(['*', '*', '*'])
  })
})

describe('the standing-check crontab in fork/README.md section 11, step 5', () => {
  // The check in step 2 is what tells the operator whether the delivery is
  // carrying anything, and section 11 calls it "the standing check
  // afterwards". A standing check nobody runs is the same silence it exists to
  // break, one step further out: the delivery dies, nobody remembers the
  // command, and the surface goes back to "import the file" unnoticed.
  const block = readmeCron.find((candidate) =>
    candidate.scheduleLines.some((line) => line.includes('leverans-status.ts')),
  )

  it('exists, so the alarm does not depend on somebody remembering a command', () => {
    expect(block).toBeDefined()
  })

  it('runs at least daily, which is what MAX_QUIET_DAYS assumes', () => {
    // leverans-status.ts alarms after 2 quiet days. A weekly schedule would
    // find every outage up to a week late, which is the delay the check was
    // written to remove.
    const [minute, hour, dayOfMonth, month, dayOfWeek] = block!.scheduleLines[0].trim().split(/\s+/)
    expect(minute).toMatch(/^\d+$/)
    expect(hour).toMatch(/^\d+$/)
    expect([dayOfMonth, month, dayOfWeek]).toEqual(['*', '*', '*'])
  })

  it('pings the heartbeat only on a zero exit, so an alarm is a missing ping', () => {
    // `&&` is the whole dead-man's switch: exits 2 and 4, a wiped clone and a
    // box that is off must all reach the operator from outside as silence. A
    // `;` or a `||` there would ping on failure too and report a dead delivery
    // as healthy, which is worse than no check at all.
    const line = block!.scheduleLines[0]
    const check = line.indexOf('leverans-status.ts')
    const ping = line.indexOf('curl')

    expect(ping).toBeGreaterThan(check)
    const between = line.slice(check, ping)
    expect(between).toContain('&&')
    expect(between).not.toContain('||')
    expect(between).not.toContain(';')
  })

  it('carries its own heartbeat variable, not the fork sync\'s', () => {
    // Section 5 already pings a check for the weekly sync. Sharing one URL
    // would make either routine's ping cover for the other's silence, so
    // neither outage is visible.
    const variables = block!.lines
      .filter(isAssignment)
      .map((line) => line.split('=')[0])
      .filter((name) => /HEARTBEAT/.test(name))

    expect(variables).toHaveLength(1)
    expect(variables[0]).not.toBe('FORK_SYNC_HEARTBEAT_URL')
    expect(block!.scheduleLines[0]).toContain(`$${variables[0]}`)
  })
})

describe('the upgrade walkthrough in fork/README.md', () => {
  const readme = read('fork/README.md')
  const step8 = readme.match(/8\. \*\*Push and deploy\.\*\*([\s\S]*?)(?=\n---)/)?.[1] ?? ''

  it('never tells the operator the merge-fallback path has nothing local to push', () => {
    // Steps 5-7 run on main after the PR merge and routinely produce local
    // commits there (an adaptation fix, the fork/patches rebase and its
    // manifest-entry deletion), so a blanket "nothing local to push" for the
    // merge-fallback path leaves those commits stranded on the box.
    expect(step8).not.toMatch(/nothing local\s*\n?\s*to push/)
  })

  it('tells the operator to check for and push commits left by steps 4-7', () => {
    expect(step8).toMatch(/git status/)
    expect(step8).toMatch(/git push origin main/)
  })
})

describe('the migration inventory in fork/README.md section 3', () => {
  const readme = read('fork/README.md')
  const section3 = readme.match(/## 3\. The database is the real gap([\s\S]*?)(?=\n## 4\.)/)?.[1] ?? ''

  it('regenerates the count with the .sql filter, not a bare ls', () => {
    // supabase/migrations/ also contains a __tests__/ subdirectory. String
    // comparison sorts "_" after digits, so an unfiltered
    // `ls | awk '$0 >= "20260511"'` silently counts that directory as a
    // phantom migration (it did, the first time this table was generated).
    // The printed command must filter to real migration files first.
    const commands = section3.match(/```bash\n([\s\S]*?)\n```/)?.[1] ?? ''
    for (const line of commands.split('\n').filter(Boolean)) {
      expect(line).toContain("grep '\\.sql$'")
    }
  })

  it('states a total that is consistent with the two window rows it is built from', () => {
    const total = Number(section3.match(/\*\*Total from 2026-05-11\*\*\s*\|\s*\*\*(\d+)\*\*/)?.[1])
    const monthly = [...section3.matchAll(/\|\s*2026-0\d[^|]*\|\s*(\d+)\s*\|/g)].map((match) =>
      Number(match[1]),
    )

    expect(monthly.length).toBeGreaterThan(0)
    expect(total).toBe(monthly.reduce((sum, count) => sum + count, 0))
  })

  it('quotes the same total in section 2\'s verification table, which cross-references this section', () => {
    // Section 3 was regenerated after a schema jump and this row was missed:
    // it still said "370 files" (the pre-catch-up count) while section 3 had
    // moved on to 611. A number that only lives in one place cannot drift out
    // of sync with itself, so this check ties the two together.
    const section2 = readme.match(/## 2\. Catch-up status and what was verified([\s\S]*?)(?=\n## 3\.)/)?.[1] ?? ''
    const section2Count = Number(
      section2.match(/Migration inventory 2026-05-11 to now\s*\|\s*(\d+) files, see section 3\./)?.[1],
    )
    const section3Total = Number(section3.match(/\*\*Total from 2026-05-11\*\*\s*\|\s*\*\*(\d+)\*\*/)?.[1])

    expect(section2Count).toBeGreaterThan(0)
    expect(section2Count).toBe(section3Total)
  })
})
