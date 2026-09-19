#!/usr/bin/env -S npx tsx
/**
 * Is the automatic delivery actually carrying anything?
 *
 * Run on the Accounted box:
 *
 *   npx tsx extensions/general/underlagsjakt/leverans-status.ts
 *
 * The delivery is switched on in four steps across two machines
 * (fork/README.md section 11), and only one of them happens in this
 * repository. Everything that can go wrong with the other three looks
 * identical from here: no export, no questions, a workspace that quietly
 * keeps saying "import the file". This command is what separates them, and
 * it is what step 4 of the switch-on checks instead of reading a page by eye.
 *
 * It answers with the exit code, because the only durable protection against
 * "built but never initiated" is a check something else can run:
 *
 *   0  both directions have carried real data, and recently.
 *   2  configured, but a direction has never run or has gone quiet. The
 *      delivery is not working; the lines say which half.
 *   4  nothing to check: the box is not configured, or the configured org
 *      number does not name exactly one active company, so every delivery
 *      would be refused with 503.
 *
 * It writes nothing. In particular it does not call `GET /svar`, which hands
 * each answer over exactly once: an answer collected by a probe is an answer
 * bertil never receives.
 */
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { ORGNR_ENV, TOKEN_ENV, openLeveransContext, readLeveransConfig } from './lib/leverans'
import {
  loadLeveransJournal,
  loadState,
  pendingBeslut,
  type ImportKalla,
  type LeveransJournal,
} from './lib/store'

/**
 * bertil's crontab runs the export client daily (fork/README.md section 11,
 * step 3), so two days of silence is a schedule that never got installed, a
 * client that dies at its redirect, or a box that is off. One day would alarm
 * on a run that merely slipped past midnight.
 */
export const MAX_QUIET_DAYS = 2

export interface LeveransEvidence {
  /** Both environment variables present and well-formed. */
  configured: boolean
  /** Why the configured org number names no single active company, if so. */
  companyProblem: string | null
  /** The company the delivery resolves to, when it resolves. */
  companyId: string | null
  /** The stored export: when it was read, and whether it arrived by itself. */
  export: { imported_at: string; via: ImportKalla } | null
  journal: LeveransJournal | null
  /** Answers waiting in the surface for bertil's next call. */
  pendingAnswers: number
}

export type CheckState = 'ok' | 'alarm' | 'blocked'

export interface LeveransCheck {
  label: string
  state: CheckState
  line: string
}

export interface LeveransStatusReport {
  exitCode: 0 | 2 | 4
  headline: string
  checks: LeveransCheck[]
}

function daysSince(iso: string, now: Date): number | null {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return null
  return (now.getTime() - then) / 86_400_000
}

/** The newest moment the machine path is known to have been used. */
function lastContact(evidence: LeveransEvidence): string | null {
  const moments = [
    evidence.export?.via === 'leverans' ? evidence.export.imported_at : null,
    evidence.journal?.senast_hamtad_at ?? null,
  ].filter((value): value is string => value !== null)
  return moments.length === 0 ? null : moments.sort().at(-1)!
}

/**
 * The whole verdict, as a pure function of what the box can see.
 *
 * Every check prints, whatever the exit code: the ranking decides the code,
 * never what is shown, so a stale delivery does not hide a direction that has
 * never run at all.
 */
export function describeLeveransStatus(evidence: LeveransEvidence, now: Date): LeveransStatusReport {
  const checks: LeveransCheck[] = []

  if (!evidence.configured) {
    checks.push({
      label: 'configuration',
      state: 'blocked',
      line: `not switched on: set ${TOKEN_ENV} and ${ORGNR_ENV} in the deployment's .env (fork/README.md section 11, step 2).`,
    })
    return { exitCode: 4, headline: 'The automatic delivery is off on this box.', checks }
  }
  checks.push({ label: 'configuration', state: 'ok', line: `${TOKEN_ENV} and ${ORGNR_ENV} are set.` })

  if (evidence.companyProblem !== null) {
    checks.push({
      label: 'company',
      state: 'blocked',
      line: `${evidence.companyProblem} Every delivery is refused with 503 until this resolves.`,
    })
    return { exitCode: 4, headline: 'The delivery has nowhere to land.', checks }
  }
  checks.push({
    label: 'company',
    state: 'ok',
    line: `deliveries land in company ${evidence.companyId}, and nowhere else.`,
  })

  // Direction 1: bertil -> Accounted.
  if (evidence.export === null) {
    checks.push({
      label: 'export (bertil -> Accounted)',
      state: 'alarm',
      line: 'no export has ever been read here. bertil has never delivered one: check GNUBOK_API_URL, GNUBOK_API_KEY and the schedule on bertil (fork/README.md section 11, step 3).',
    })
  } else if (evidence.export.via !== 'leverans') {
    checks.push({
      label: 'export (bertil -> Accounted)',
      state: 'alarm',
      line: `the stored export was uploaded by hand (${evidence.export.imported_at}). The automatic delivery has never landed one.`,
    })
  } else {
    checks.push({
      label: 'export (bertil -> Accounted)',
      state: 'ok',
      line: `last export arrived by itself ${evidence.export.imported_at}.`,
    })
  }

  // Direction 2: Accounted -> bertil.
  if (evidence.journal === null) {
    checks.push({
      label: 'answers (Accounted -> bertil)',
      state: 'alarm',
      line: 'bertil has never called GET /svar. Nothing you answer here can reach its knowledge base.',
    })
  } else if (evidence.journal.totalt_antal === 0) {
    checks.push({
      label: 'answers (Accounted -> bertil)',
      state: 'alarm',
      line: `bertil collects (last ${evidence.journal.senast_hamtad_at}) but has never been given an answer. Answer one question in the surface and let the client run again.`,
    })
  } else {
    checks.push({
      label: 'answers (Accounted -> bertil)',
      state: 'ok',
      line: `${evidence.journal.totalt_antal} answer(s) handed over, last collection ${evidence.journal.senast_hamtad_at} carrying ${evidence.journal.senast_antal}.`,
    })
  }

  if (evidence.pendingAnswers > 0) {
    checks.push({
      label: 'waiting',
      state: 'ok',
      line: `${evidence.pendingAnswers} answer(s) waiting for bertil's next call.`,
    })
  }

  // Freshness. Only meaningful once the path has been used at all; before
  // that the two checks above already say so, and "quiet" would be noise.
  const contact = lastContact(evidence)
  const quietDays = contact === null ? null : daysSince(contact, now)
  if (contact !== null && quietDays !== null && quietDays > MAX_QUIET_DAYS) {
    checks.push({
      label: 'freshness',
      state: 'alarm',
      line: `nothing has come through since ${contact} (${Math.floor(quietDays)} days). The schedule on bertil is not installed, is failing, or the box is off.`,
    })
  } else if (contact !== null) {
    checks.push({ label: 'freshness', state: 'ok', line: `last contact ${contact}.` })
  }

  const alarms = checks.filter((check) => check.state === 'alarm')
  return {
    exitCode: alarms.length === 0 ? 0 : 2,
    headline:
      alarms.length === 0
        ? 'The automatic delivery has carried an export and an answer, both recently.'
        : `The automatic delivery is not working: ${alarms.length} of ${checks.length} checks failed.`,
    checks,
  }
}

export function formatReport(report: LeveransStatusReport): string {
  const mark: Record<CheckState, string> = { ok: 'OK     ', alarm: 'ALARM  ', blocked: 'BLOCKED' }
  const lines = report.checks.map((check) => `${mark[check.state]} ${check.label}: ${check.line}`)
  return [...lines, '', report.headline].join('\n')
}

/** Everything the report needs, read from the box. Writes nothing. */
export async function gatherEvidence(): Promise<LeveransEvidence> {
  const empty: LeveransEvidence = {
    configured: false,
    companyProblem: null,
    companyId: null,
    export: null,
    journal: null,
    pendingAnswers: 0,
  }

  const config = readLeveransConfig()
  if (!config) return empty

  const opened = await openLeveransContext(createServiceClientNoCookies(), config)
  if (!opened.ok) {
    return { ...empty, configured: true, companyProblem: `${opened.code}: ${opened.message}` }
  }

  const [state, journal] = await Promise.all([
    loadState(opened.ctx.settings),
    loadLeveransJournal(opened.ctx.settings),
  ])

  return {
    configured: true,
    companyProblem: null,
    companyId: opened.ctx.companyId,
    export: state.export
      ? { imported_at: state.export.imported_at, via: state.export.imported_via ?? 'fil' }
      : null,
    journal,
    pendingAnswers: pendingBeslut(state.svar).length,
  }
}

export async function main(): Promise<number> {
  let evidence: LeveransEvidence
  try {
    evidence = await gatherEvidence()
  } catch (error) {
    // A box that cannot build a service-role client cannot receive a delivery
    // either, so this is the same category as "not configured": there is
    // nothing to check, and saying so beats a stack trace.
    process.stderr.write(`leverans-status: could not read the box: ${(error as Error).message}\n`)
    return 4
  }
  const report = describeLeveransStatus(evidence, new Date())
  process.stdout.write(`${formatReport(report)}\n`)
  return report.exitCode
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  void main().then((code) => {
    process.exitCode = code
  })
}
