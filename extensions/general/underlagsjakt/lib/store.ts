/**
 * Workspace state for underlagsjakt, kept in `extension_data` (no own tables).
 *
 *   key `export`:   the last export read from bertil, as parsed.
 *   key `svar`:     answers by transaction_id, including when consumption was confirmed
 *                   by bertil (`levererad_at`).
 *   key `leverans`: what the machine path has actually carried; see
 *                   LeveransJournal.
 *
 * The functions below are pure so the rules can be tested without a database;
 * `loadState` / `saveSvar` / `saveExport` are the only I/O.
 */
import type { ExtensionSettings } from '@/lib/extensions/types'
import { motpartRegelNyckel, type Beslut, type ParsedExport, type Post, type Reglering, type Sammanstallning } from './contract'

export const EXPORT_KEY = 'export'
export const SVAR_KEY = 'svar'
export const LEVERANS_KEY = 'leverans'
/** Machine-only ingestion evidence, retained when answered posts are reconciled. */
export const KVITTENS_KEY = 'svar_kvittens'

/** How the stored export got here: bertil delivered it, or a human uploaded the file. */
export type ImportKalla = 'leverans' | 'fil'

export interface StoredExport extends ParsedExport {
  imported_at: string
  /** Absent on exports stored before the machine path existed: read as 'fil'. */
  imported_via?: ImportKalla
}

export type PostSnapshot = Pick<
  Post,
  'bolag' | 'period' | 'datum' | 'belopp' | 'valuta' | 'motpart' | 'konto_identitet' | 'typ'
>

export interface SvarRecord {
  beslut: Beslut
  /** Not in contract 1.1; see REGLERINGAR in contract.ts. */
  reglering: Reglering | null
  post: PostSnapshot
  besvarad_at: string
  besvarad_av: string
  /** Unique identity for this version of the answer. Used to match acknowledgements. */
  answer_id: string
  /** When the answer was first offered to bertil via GET /svar. Blocks withdrawal if set. */
  erbjudet_at: string | null
  /** When bertil acknowledged receiving and ingesting the answer via POST /svar/kvittens. */
  levererad_at: string | null
}

export type SvarMap = Record<string, SvarRecord>

export interface State {
  export: StoredExport | null
  svar: SvarMap
}

/**
 * What the machine path has carried, written by `GET /svar` on every call.
 *
 * The stored export records the incoming direction (`imported_via`,
 * `imported_at`). This journal records polling activity, not consumption:
 * repeated offers count again and only an acknowledgement sets levererad_at.
 * Empty polls still show that bertil is running, making silence observable.
 */
export interface LeveransJournal {
  /** When bertil last called `GET /svar`, whether or not anything was waiting. */
  senast_hamtad_at: string
  /** How many answers that call carried. */
  senast_antal: number
}

export function recordSvarHandover(
  journal: LeveransJournal | null,
  count: number,
  now: string,
): LeveransJournal {
  return {
    senast_hamtad_at: now,
    senast_antal: count,
  }
}

export async function loadLeveransJournal(settings: ExtensionSettings): Promise<LeveransJournal | null> {
  return (await settings.get<LeveransJournal>(LEVERANS_KEY)) ?? null
}

export async function loadState(settings: ExtensionSettings): Promise<State> {
  const [exp, svar] = await Promise.all([
    settings.get<StoredExport>(EXPORT_KEY),
    settings.get<SvarMap>(SVAR_KEY),
  ])
  return { export: exp ?? null, svar: svar ?? {} }
}

export function allPosts(exp: StoredExport | null): Post[] {
  return exp ? exp.sammanstallningar.flatMap((s: Sammanstallning) => s.posts) : []
}

export function findPost(exp: StoredExport | null, transactionId: string): Post | null {
  return allPosts(exp).find((p) => p.transaction_id === transactionId) ?? null
}

/** Unanswered posts: no answer record exists. */
export function openPosts(exp: StoredExport | null, svar: SvarMap): Post[] {
  return allPosts(exp).filter((p) => !svar[p.transaction_id])
}

/**
 * The posts one "I will deliver it myself" answer covers when applied to a whole
 * motpart, given the currently open posts and the post being answered.
 *
 * The single definition, called by the browser (to show the count) and by the
 * server (to recount before writing): a post is covered when its motpart has
 * the same rule key (`motpartRegelNyckel`) as the anchor's. A `fel_bolag` post
 * is never swept in, and a blank motpart matches nothing but the anchor.
 * Undercounting is safe, clearing a post the rule does not cover is not. The
 * anchor itself counts when it is still open.
 */
export function bulkTargets(open: Post[], anchor: Post): Post[] {
  const key = motpartRegelNyckel(anchor.motpart)
  const blank = anchor.motpart.trim() === ''
  return open.filter(
    (p) =>
      p.transaction_id === anchor.transaction_id ||
      (!blank && p.kategori !== 'fel_bolag' && motpartRegelNyckel(p.motpart) === key),
  )
}

/**
 * Reconcile stored answers with a newly read export.
 *
 * An answer that bertil already received and that bertil nonetheless asks
 * about again in a LATER export is stale (an `osaker` whose 7-day deferral
 * ran out, or an answer bertil rejected): drop it so the post shows again.
 * Answers not yet handed over are always kept, and an older export read back
 * in never resurrects a post that was answered after it was generated.
 */
export function reconcileWithExport(svar: SvarMap, exp: ParsedExport): SvarMap {
  const generated = Date.parse(exp.generated_at)
  const asked = new Set(exp.sammanstallningar.flatMap((s) => s.posts.map((p) => p.transaction_id)))
  const next: SvarMap = {}
  for (const [id, rec] of Object.entries(svar)) {
    const deliveredBefore =
      rec.levererad_at !== null && !Number.isNaN(generated) && Date.parse(rec.levererad_at) < generated
    if (asked.has(id) && deliveredBefore) continue
    next[id] = rec
  }
  return next
}

export type RecordAnswerResult = { ok: true; svar: SvarMap } | { ok: false; code: 'ALREADY_DELIVERED' }

export function recordAnswer(
  svar: SvarMap,
  post: Post,
  beslut: Beslut,
  reglering: Reglering | null,
  userId: string,
  now: string,
): RecordAnswerResult {
  const existing = svar[post.transaction_id]
  if (existing?.levererad_at || existing?.erbjudet_at) {
    return { ok: false, code: 'ALREADY_DELIVERED' }
  }
  const answerId = `${now}:${post.transaction_id}`
  return {
    ok: true,
    svar: {
      ...svar,
      [post.transaction_id]: {
        beslut,
        reglering,
        post: {
          bolag: post.bolag,
          period: post.period,
          datum: post.datum,
          belopp: post.belopp,
          valuta: post.valuta,
          motpart: post.motpart,
          konto_identitet: post.konto_identitet,
          typ: post.typ,
        },
        besvarad_at: now,
        besvarad_av: userId,
        answer_id: answerId,
        erbjudet_at: null,
        levererad_at: null,
      },
    },
  }
}

export type WithdrawResult =
  | { ok: true; svar: SvarMap }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_DELIVERED' }

export function withdrawAnswer(svar: SvarMap, transactionId: string): WithdrawResult {
  const existing = svar[transactionId]
  if (!existing) return { ok: false, code: 'NOT_FOUND' }
  if (existing.levererad_at) return { ok: false, code: 'ALREADY_DELIVERED' }
  if (existing.erbjudet_at !== null) {
    return { ok: false, code: 'ALREADY_DELIVERED' }
  }
  const next = { ...svar }
  delete next[transactionId]
  return { ok: true, svar: next }
}

/** Answers not yet acknowledged by bertil, oldest first. */
export function pendingBeslut(svar: SvarMap): Beslut[] {
  return Object.values(svar)
    .filter((r) => r.levererad_at === null)
    .sort((a, b) => a.besvarad_at.localeCompare(b.besvarad_at))
    .map((r) => r.beslut)
}

export function markOffered(svar: SvarMap, transactionIds: string[], now: string): SvarMap {
  const next = { ...svar }
  for (const id of transactionIds) {
    const rec = next[id]
    if (rec && rec.erbjudet_at === null) next[id] = { ...rec, erbjudet_at: now }
  }
  return next
}

export function markDelivered(
  svar: SvarMap,
  transactionIds: Array<{ id: string; answerId: string }>,
  now: string,
): SvarMap {
  const next = { ...svar }
  for (const entry of transactionIds) {
    const rec = next[entry.id]
    if (rec && rec.levererad_at === null && rec.answer_id === entry.answerId) {
      next[entry.id] = { ...rec, levererad_at: now }
    }
  }
  return next
}

export function markDeliveredManual(svar: SvarMap, transactionIds: string[], now: string): SvarMap {
  const next = { ...svar }
  for (const id of transactionIds) {
    const rec = next[id]
    if (rec && rec.levererad_at === null) next[id] = { ...rec, levererad_at: now }
  }
  return next
}

export interface FelBolagRow {
  transaction_id: string
  post: PostSnapshot
  fel_bolag_mottagare: string
  till_bolag: string | null
  reglering: Reglering | null
  besvarad_at: string
  levererad_at: string | null
}

/** The "ska faktureras vidare / mellanhavande" view: every wrong-company answer, newest first. */
export function felBolagRows(svar: SvarMap): FelBolagRow[] {
  const rows: FelBolagRow[] = []
  for (const [id, rec] of Object.entries(svar)) {
    if (rec.beslut.svarstyp !== 'fel_bolag') continue
    rows.push({
      transaction_id: id,
      post: rec.post,
      fel_bolag_mottagare: rec.beslut.fel_bolag_mottagare,
      till_bolag: rec.beslut.till_bolag,
      reglering: rec.reglering,
      besvarad_at: rec.besvarad_at,
      levererad_at: rec.levererad_at,
    })
  }
  return rows.sort((a, b) => b.besvarad_at.localeCompare(a.besvarad_at))
}

/**
 * How long a promised document may stay unfound before it counts as overdue
 * (the alarm in leverans-status.ts and the marking in the workspace). One
 * constant on purpose: the right limit is still an open question, and it is
 * changed here and nowhere else.
 */
export const MAX_WAITING_DAYS = 14

/**
 * bertil found the documents of these posts on the usual place: a promised
 * (`levererar_sjalv`) post moves from waiting to "with document" by stamping
 * `underlag_hittat_at` on its answer, nobody is asked again. Ids without a
 * waiting answer, and answers already stamped, are left untouched.
 */
export function markUnderlagHittat(svar: SvarMap, transactionIds: string[], now: string): SvarMap {
  const next = { ...svar }
  for (const id of transactionIds) {
    const rec = next[id]
    if (rec && rec.beslut.svarstyp === 'levererar_sjalv' && rec.beslut.underlag_hittat_at === null) {
      next[id] = { ...rec, beslut: { ...rec.beslut, underlag_hittat_at: now } }
    }
  }
  return next
}

export interface WaitingRow {
  transaction_id: string
  post: PostSnapshot
  motpart: string
  besvarad_at: string
  underlag_hittat_at: string | null
}

/** Posts where the user promised to deliver the document themselves, waiting for bertil to confirm receipt. */
export function waitingRows(svar: SvarMap): WaitingRow[] {
  const rows: WaitingRow[] = []
  for (const [id, rec] of Object.entries(svar)) {
    if (rec.beslut.svarstyp !== 'levererar_sjalv') continue
    rows.push({
      transaction_id: id,
      post: rec.post,
      motpart: rec.beslut.motpart,
      besvarad_at: rec.besvarad_at,
      underlag_hittat_at: rec.beslut.underlag_hittat_at,
    })
  }
  return rows.sort((a, b) => b.besvarad_at.localeCompare(a.besvarad_at))
}

/** Dedupe key for a company name: case, spacing and a trailing "AB"/"(publ)" do not make a new company. */
function bolagKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(\s+\(publ\))?(\s+ab)?(\s+\(publ\))?$/, '')
    .trim()
}

/**
 * Companies to offer for "gäller annat bolag".
 *
 * An export only names the companies bertil ran for (companies without
 * payments that period, or outside a `--bolag` run, are absent), so the
 * user's Accounted company memberships are what makes the list complete.
 * bertil's own spelling (export, then earlier answers) wins over the
 * membership spelling when both name the same company, since that is the
 * name bertil's rules key on. The user can always type an external company.
 */
export function bolagChoices(exp: StoredExport | null, svar: SvarMap, memberCompanies: string[]): string[] {
  const seen = new Map<string, string>()
  const add = (name: string | null | undefined) => {
    const trimmed = name?.trim().replace(/\s+/g, ' ')
    if (!trimmed) return
    const key = bolagKey(trimmed)
    if (key && !seen.has(key)) seen.set(key, trimmed)
  }
  for (const s of exp?.sammanstallningar ?? []) add(s.bolag)
  for (const rec of Object.values(svar)) {
    if (rec.beslut.svarstyp === 'fel_bolag') add(rec.beslut.till_bolag)
  }
  for (const name of memberCompanies) add(name)
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'sv'))
}
