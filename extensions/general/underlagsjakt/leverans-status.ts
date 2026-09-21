#!/usr/bin/env -S npx tsx
/**
 * Is the automatic delivery actually carrying anything?
 *
 * Run on the Accounted box:
 *
 *   npx tsx extensions/general/underlagsjakt/leverans-status.ts
 *
 * The delivery is switched on in five steps across two machines
 * (fork/README.md section 11), and only two of them happen on this box.
 * Everything that can go wrong with the other three looks identical from
 * here: no export, no questions, a workspace that quietly keeps saying
 * "import the file". This command is what separates them, and it is what step
 * 4 of the switch-on checks instead of reading a page by eye. Step 5 puts it
 * in /etc/cron.d on this box, pinging an external heartbeat only on exit 0,
 * so the answer keeps being taken after the day somebody last asked for it.
 *
 * It answers with the exit code, because the only durable protection against
 * "built but never initiated" is a check something else can run:
 *
 *   0  both directions have carried real data, and each of them recently.
 *   2  configured, but a direction has never run or has gone quiet. The
 *      delivery is not working; the lines say which half. Recency is measured
 *      per direction, so a half that stopped cannot hide behind the half that
 *      still runs: either one going quiet takes the exit code off 0, and with
 *      it the heartbeat ping in step 5.
 *   4  nothing to check: the box is not configured, or the configured org
 *      number does not name exactly one active company, so every delivery
 *      would be refused with 503.
 *
 * It writes nothing and does not poll or acknowledge answers.
 *
 * It reads its configuration from the deployment's `.env`, because that is
 * where the configuration is: `docker-compose.yml` hands that file to the app
 * through `env_file`, and it never reaches the operator's shell. A check that
 * read only `process.env` would answer "not switched on" on a box that is
 * switched on perfectly, which is worse than not existing.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { config as dotenv } from 'dotenv'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  ORGNR_ENV,
  TOKEN_ENV,
  describeLeveransProblems,
  inspectLeveransConfig,
  openLeveransContext,
  type LeveransConfigProblem,
} from './lib/leverans'
import {
  KVITTENS_KEY,
  MAX_WAITING_DAYS,
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

// The limit on a promised (`levererar_sjalv`) document lives in lib/store.ts so
// the workspace marks overdue posts by the same number; re-exported for callers.
export { MAX_WAITING_DAYS }

export interface LeveransEvidence {
  /** The `.env` the configuration was read from, or null when none was found. */
  envFile: string | null
  /**
   * Why the two environment variables do not add up to a configuration, empty
   * when they do. A set-but-malformed variable reports itself here rather than
   * as "not switched on": the operator who just wrote both lines must be told
   * which line to edit, not to write them again. The problems keep their kind
   * all the way out here so the headline can say the same thing the detail
   * line does.
   */
  configProblems: LeveransConfigProblem[]
  /** Why the configured org number names no single active company, if so. */
  companyProblem: string | null
  /** The company the delivery resolves to, when it resolves. */
  companyId: string | null
  /** The stored export: when it was read, and whether it arrived by itself. */
  export: { imported_at: string; via: ImportKalla } | null
  journal: LeveransJournal | null
  /** Answers waiting in the surface for bertil's next call. */
  pendingAnswers: number
  /** Last confirmed machine ingestion, independent of retained answers. */
  lastAcknowledgedAt: string | null
  oldestPendingAt: string | null
  /** Promises to deliver documents waiting for bertil to confirm receipt. */
  promisedDocuments: number
  /** Oldest promised document awaiting confirmation, if any. */
  oldestPromisedAt: string | null
}

/** Label of the promised-documents check; it is judged apart from the delivery's own checks. */
const PROMISED_LABEL = 'promised documents'

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

interface DirectionContact {
  at: string
  days: number | null
  /** How the line reads while this direction is still being used. */
  fresh: string
  /** How it reads once this direction has gone quiet. */
  stopped: string
}

/**
 * When each direction was last used, one entry per direction that has ever
 * been used at all.
 *
 * Deliberately not a maximum across the two. bertil calling `GET /svar` every
 * morning says nothing about whether it still delivers exports, and the two
 * halves stop independently: a client whose export call started failing keeps
 * collecting answers, and a collection that broke leaves exports arriving. A
 * single newest-moment would let the live half hold the dead half green, and
 * on the schedule in fork/README.md section 11 step 5 that means a heartbeat
 * pinging healthy every morning over a direction that has been down for weeks,
 * which is the exact silence this check exists to break.
 */
function directionContacts(evidence: LeveransEvidence, now: Date): DirectionContact[] {
  const contacts: DirectionContact[] = []

  // Only an export that arrived by itself counts: a hand-uploaded one is not
  // the machine path being used, however recent it is.
  const exportAt = evidence.export?.via === 'leverans' ? evidence.export.imported_at : null
  if (exportAt !== null) {
    contacts.push({
      at: exportAt,
      days: daysSince(exportAt, now),
      fresh: `last export ${exportAt}`,
      stopped: `no export has arrived since ${exportAt}`,
    })
  }

  // Any call counts here, including one that carried no answers: it is the
  // only evidence the box gets that bertil is still running.
  const collectedAt = evidence.journal?.senast_hamtad_at ?? null
  if (collectedAt !== null) {
    contacts.push({
      at: collectedAt,
      days: daysSince(collectedAt, now),
      fresh: `last collection ${collectedAt}`,
      stopped: `bertil has not collected answers since ${collectedAt}`,
    })
  }

  return contacts
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

  // Naming the file it read is what keeps "not switched on" honest: on a box
  // where the variables are in the deployment's .env, this line is the
  // difference between "you never set them" and "I looked somewhere else".
  const source = evidence.envFile ?? 'no .env found; only this shell\'s environment was read'

  if (evidence.configProblems.length > 0) {
    const missing = evidence.configProblems.filter((problem) => problem.kind === 'missing')
    const invalid = evidence.configProblems.filter((problem) => problem.kind === 'invalid')
    const mixed = missing.length > 0 && invalid.length > 0
    const state = mixed
      ? 'configuration is partly missing and partly invalid'
      : invalid.length > 0 ? 'set, but not usable' : 'not switched on'
    // Keep the action tied to each variable, including partially configured boxes.
    const advice = evidence.configProblems.map((problem) =>
      `${problem.kind === 'missing' ? 'Add' : 'Correct'} ${problem.variable} in the deployment's .env.`,
    ).join(' ')
    checks.push({
      label: 'configuration',
      state: 'blocked',
      line: `${state}: ${describeLeveransProblems(evidence.configProblems)} ${advice} See fork/README.md section 11, step 2. ${evidence.envFile ? `Read ${source}` : source}.`,
    })
    return {
      exitCode: 4,
      headline: mixed
        ? 'The automatic delivery configuration is partly missing and partly invalid.'
        : invalid.length > 0
          ? 'The automatic delivery is configured wrong on this box.'
          : 'The automatic delivery is not switched on on this box.',
      checks,
    }
  }
  checks.push({
    label: 'configuration',
    state: 'ok',
    line: `${TOKEN_ENV} and ${ORGNR_ENV} are set (read ${source}).`,
  })

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
  } else if (evidence.lastAcknowledgedAt === null) {
    checks.push({
      label: 'answers (Accounted -> bertil)',
      state: 'alarm',
      line: `bertil collects (last ${evidence.journal.senast_hamtad_at}) but no answer has been acknowledged via POST /svar/kvittens. Verify ingestion and POST /svar/kvittens on bertil.`,
    })
  } else {
    checks.push({
      label: 'answers (Accounted -> bertil)',
      state: 'ok',
      line: `last machine acknowledgement ${evidence.lastAcknowledgedAt}, last collection ${evidence.journal.senast_hamtad_at} carrying ${evidence.journal.senast_antal}.`,
    })
  }

  if (evidence.pendingAnswers > 0) {
    checks.push({
      label: 'waiting',
      state: evidence.oldestPendingAt === null ||
        (daysSince(evidence.oldestPendingAt, now) ?? Infinity) > MAX_QUIET_DAYS ? 'alarm' : 'ok',
      line: `${evidence.pendingAnswers} answer(s) awaiting acknowledgement, oldest ${evidence.oldestPendingAt ?? 'unknown'}. Acknowledgement is required within ${MAX_QUIET_DAYS} days; check ingestion and POST /svar/kvittens on bertil.`,
    })
  }

  // One line for all promised documents, never one per post. It is an alarm
  // (exit 2) so an unkept promise cannot go unnoticed, but it says nothing about
  // whether the delivery itself works.
  if (evidence.promisedDocuments > 0) {
    const oldestDays = evidence.oldestPromisedAt === null ? null : daysSince(evidence.oldestPromisedAt, now)
    const overdueDays = oldestDays !== null && oldestDays > MAX_WAITING_DAYS ? Math.floor(oldestDays) : null
    checks.push({
      label: PROMISED_LABEL,
      state: overdueDays !== null ? 'alarm' : 'ok',
      line: `${evidence.promisedDocuments} document(s) promised with "I will deliver it myself" and not yet found by bertil, oldest answered ${evidence.oldestPromisedAt ?? 'unknown'}${overdueDays !== null ? `: ${overdueDays} days, over the ${MAX_WAITING_DAYS} allowed` : ''}. Deliver them or ask bertil to look again; the posts are listed under "Väntar på underlag".`,
    })
  }

  // Freshness, measured per direction. Only meaningful for a direction that
  // has been used at all; before that the two checks above already say so, and
  // "quiet" would be noise.
  const contacts = directionContacts(evidence, now)
  const stale = contacts.filter((c) => c.days !== null && c.days > MAX_QUIET_DAYS)
  if (stale.length > 0) {
    checks.push({
      label: 'freshness',
      state: 'alarm',
      line: `${stale
        .map((c) => `${c.stopped} (${Math.floor(c.days!)} days)`)
        .join('; ')}. Each direction is measured on its own, so the other one still running does not cover for this one. The schedule on bertil is not installed, is failing, or the box is off.`,
    })
  } else if (contacts.length > 0) {
    checks.push({
      label: 'freshness',
      state: 'ok',
      line: `${contacts.map((c) => c.fresh).join(', ')}; each within ${MAX_QUIET_DAYS} days.`,
    })
  }

  const alarms = checks.filter((check) => check.state === 'alarm')
  const deliveryAlarms = alarms.filter((check) => check.label !== PROMISED_LABEL)
  return {
    exitCode: alarms.length === 0 ? 0 : 2,
    headline:
      alarms.length === 0
        ? 'The automatic delivery has received an export and recorded an acknowledged answer; polls are recent and no acknowledgement is overdue.'
        : deliveryAlarms.length === 0
          ? 'The automatic delivery works, but promised documents are overdue.'
          : `The automatic delivery is not working: ${deliveryAlarms.length} of ${checks.length} checks failed.`,
    checks,
  }
}

export function formatReport(report: LeveransStatusReport): string {
  const mark: Record<CheckState, string> = { ok: 'OK     ', alarm: 'ALARM  ', blocked: 'BLOCKED' }
  const lines = report.checks.map((check) => `${mark[check.state]} ${check.label}: ${check.line}`)
  return [...lines, '', report.headline].join('\n')
}

/** Repo root, from this file's own location: four levels up. */
const REPO_ROOT = resolvePath(fileURLToPath(import.meta.url), '../../../..')

/**
 * Load the deployment's `.env` into `process.env`, and say which file it was.
 * The first directory in `dirs` that holds one wins; null means none did.
 *
 * The documented invocation runs on the box, in the clone, right after the
 * operator put the two variables in `.env` and ran `docker compose up -d app`.
 * Those variables go to the container through `env_file`, so they are in the
 * file and not in the shell; the same is true of the Supabase service-role
 * credentials this check needs to read the box at all. Every other
 * env-dependent tsx script in this repository loads the file explicitly, and
 * so does this one.
 *
 * `override: true` on purpose: the question being answered is what the app
 * runs with, and the app runs with the file. A variable left exported in the
 * operator's shell from an earlier attempt must not be able to make this
 * report disagree with the deployment.
 */
export function loadDeploymentEnv(...dirs: string[]): string | null {
  for (const dir of dirs) {
    const candidate = resolvePath(dir, '.env')
    if (!existsSync(candidate)) continue
    dotenv({ path: candidate, override: true, quiet: true })
    return candidate
  }
  return null
}

/** Everything the report needs, read from the box. Writes nothing. */
export async function gatherEvidence(envFile: string | null = null): Promise<LeveransEvidence> {
  const empty: LeveransEvidence = {
    envFile,
    configProblems: [],
    companyProblem: null,
    companyId: null,
    export: null,
    journal: null,
    pendingAnswers: 0,
    lastAcknowledgedAt: null,
    oldestPendingAt: null,
    promisedDocuments: 0,
    oldestPromisedAt: null,
  }

  const inspected = inspectLeveransConfig()
  if (!inspected.ok) return { ...empty, configProblems: inspected.problems }

  const opened = await openLeveransContext(createServiceClientNoCookies(), inspected.config)
  if (!opened.ok) {
    return { ...empty, companyProblem: `${opened.code}: ${opened.message}` }
  }

  const [state, journal, lastAcknowledgedAt] = await Promise.all([
    loadState(opened.ctx.settings),
    loadLeveransJournal(opened.ctx.settings),
    opened.ctx.settings.get<string>(KVITTENS_KEY),
  ])

  const promisedDocs = Object.values(state.svar).filter(
    (r) => r.beslut.svarstyp === 'levererar_sjalv' && r.beslut.underlag_hittat_at === null
  )
  const oldestPromisedAt = promisedDocs.map((r) => r.besvarad_at).sort()[0] ?? null

  return {
    envFile,
    configProblems: [],
    companyProblem: null,
    companyId: opened.ctx.companyId,
    export: state.export
      ? { imported_at: state.export.imported_at, via: state.export.imported_via ?? 'fil' }
      : null,
    journal,
    pendingAnswers: pendingBeslut(state.svar).length,
    lastAcknowledgedAt: lastAcknowledgedAt ?? null,
    oldestPendingAt: Object.values(state.svar).filter((r) => r.levererad_at === null)
      .map((r) => r.besvarad_at).sort()[0] ?? null,
    promisedDocuments: promisedDocs.length,
    oldestPromisedAt,
  }
}

export async function main(cwd: string = process.cwd()): Promise<number> {
  // The clone root as well as the working directory, so the check answers the
  // same way wherever in the clone the operator happens to stand.
  const envFile = loadDeploymentEnv(cwd, REPO_ROOT)
  let evidence: LeveransEvidence
  try {
    evidence = await gatherEvidence(envFile)
  } catch (error) {
    // A box that cannot build a service-role client cannot receive a delivery
    // either, so this is the same category as "not configured": there is
    // nothing to check, and saying so beats a stack trace. Name the file that
    // was read, so "no Supabase credentials" is not mistaken for "wrong
    // credentials".
    const source = envFile ?? `no .env found in ${cwd} or ${REPO_ROOT}`
    process.stderr.write(
      `leverans-status: could not read the box (read ${source}): ${(error as Error).message}\n`,
    )
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
