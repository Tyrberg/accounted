import type { Kategori, Momstyp, Post, Reglering, SvarInput } from '@/extensions/general/underlagsjakt/lib/contract'
import type { FelBolagRow, SvarRecord } from '@/extensions/general/underlagsjakt/lib/store'

/** Shape of GET /api/extensions/ext/underlagsjakt/. */
export interface WorkspaceData {
  supported_export_versions: string[]
  answer_version: string
  export: {
    export_version: string
    generated_at: string
    imported_at: string
    sammanstallningar: {
      bolag: string
      period: string
      sammanfattning: {
        totalt: number
        med_underlag: number
        hittad_i_mejl: number
        sjalvforklarande: number
        inlard_regel: number
        behover_mattias: number
        tvetydig: number
        fel_bolag: number
        uppskjuten: number
        lost_svar: number
      }
    }[]
  } | null
  posts: Post[]
  answered: (SvarRecord & { transaction_id: string })[]
  pending_count: number
  fel_bolag: FelBolagRow[]
  bolag_choices: string[]
}

type T = (key: string, values?: Record<string, string | number>) => string

const KNOWN_ERROR_CODES = new Set([
  'INVALID_JSON',
  'INVALID_EXPORT',
  'UNSUPPORTED_VERSION',
  'VALIDATION_ERROR',
  'POST_NOT_FOUND',
  'CANDIDATE_NOT_FOUND',
  'CANDIDATE_WITHOUT_HASH',
  'ALREADY_DELIVERED',
  'NOT_FOUND',
])

/** Map an API error body to a translated sentence. */
export function errorText(t: T, body: unknown): string {
  const err = (body as { error?: unknown } | null)?.error
  if (err && typeof err === 'object') {
    const { code, version, supported } = err as { code?: string; version?: string | null; supported?: string[] }
    if (code === 'UNSUPPORTED_VERSION') {
      return t('error_UNSUPPORTED_VERSION', {
        version: version ?? '-',
        supported: (supported ?? []).join(', '),
      })
    }
    if (code && KNOWN_ERROR_CODES.has(code)) return t(`error_${code}`)
  }
  if (typeof err === 'string') return err
  return t('error_generic')
}

/** Sentinels for the fel_bolag radio groups: a chosen state distinct from `undefined` (nothing chosen yet). */
export const NONE = 'none'
export const EXTERNAL = '__external__'
export const UNKNOWN = '__unknown__'
export const OTHER = '__other__'
export const OTHER_COMPANY = '__other_company__'
export const PAYER = '__payer__'

export interface AnswerFormState {
  mode: 'val_kandidat' | 'fel_bolag' | 'osaker'
  transactionId: string
  hasCandidate: boolean
  sha256: string | null
  kategori?: Kategori
  motpart: string
  basKonto: string
  basKontoValid: boolean
  momstyp: Momstyp | null
  begransaBolag: boolean
  begransaBelopp: boolean
  /** Raw radio choice for "which company": a company name, EXTERNAL, UNKNOWN, or undefined (nothing picked). Only relevant in fel_bolag mode. */
  tillBolagChoice?: string
  externalBolag?: string
  /** Raw radio choice for "who's on the invoice": OTHER, PAYER, OTHER_COMPANY, or undefined (nothing picked). Only relevant in fel_bolag mode. */
  mottagareChoice?: string
  otherMottagare?: string
  /** The company that paid, used when mottagareChoice === PAYER. Only relevant in fel_bolag mode. */
  payerBolag?: string
  reglering?: Reglering
}

export type AnswerFormResult = { input: SvarInput; missing?: undefined } | { input?: undefined; missing: string[] }

/**
 * Single source for both what "Spara svar" submits and why it's disabled:
 * building the input and detecting missing fields happen in the same pass,
 * from the same raw radio/text state, as one exhaustive result, so the button
 * state and the "why disabled" hint cannot drift into disagreement, and a
 * choice made but not yet filled in (e.g. "external company" with an empty
 * name field) is never mistaken for "nothing chosen".
 */
export function buildAnswerInput(state: AnswerFormState): AnswerFormResult {
  const transaction_id = state.transactionId
  if (state.mode === 'osaker') return { input: { svarstyp: 'osaker', transaction_id } }

  if (state.mode === 'fel_bolag') {
    const tillBolag: string | null | undefined =
      state.tillBolagChoice === undefined
        ? undefined
        : state.tillBolagChoice === UNKNOWN
          ? null
          : state.tillBolagChoice === EXTERNAL
            ? (state.externalBolag ?? '').trim() || undefined
            : state.tillBolagChoice

    const mottagare =
      state.mottagareChoice === OTHER
        ? (state.otherMottagare ?? '').trim() || undefined
        : state.mottagareChoice === PAYER
          ? state.payerBolag
          : state.mottagareChoice === OTHER_COMPANY && typeof tillBolag === 'string'
            ? tillBolag
            : undefined

    const missing: string[] = []
    if (tillBolag === undefined) {
      missing.push(state.tillBolagChoice === EXTERNAL ? 'missing_external_bolag_namn' : 'missing_till_bolag')
    }
    if (!mottagare) {
      missing.push(state.mottagareChoice === OTHER ? 'missing_mottagare_namn' : 'missing_mottagare')
    }
    if (tillBolag !== null && tillBolag !== undefined && !state.reglering) {
      missing.push('missing_reglering')
    }
    if (missing.length > 0) return { missing }
    return {
      input: {
        svarstyp: 'fel_bolag',
        transaction_id,
        till_bolag: tillBolag ?? null,
        fel_bolag_mottagare: mottagare!,
        reglering: tillBolag === null ? null : (state.reglering ?? null),
      },
    }
  }

  const missing: string[] = []
  if (!state.hasCandidate) missing.push('missing_candidate')
  if (!state.kategori) missing.push('missing_kategori')
  if (!state.motpart.trim()) missing.push('missing_motpart')
  if (!state.basKontoValid) missing.push('missing_bas_konto')
  if (missing.length > 0) return { missing }
  return {
    input: {
      svarstyp: 'val_kandidat',
      transaction_id,
      sha256: state.sha256,
      motpart: state.motpart.trim(),
      kategori: state.kategori!,
      bas_konto: state.basKonto.trim() || null,
      momstyp: state.momstyp,
      begransa_bolag: state.begransaBolag,
      begransa_belopp: state.begransaBelopp,
    },
  }
}

export function answerSummary(t: T, rec: SvarRecord): string {
  const b = rec.beslut
  if (b.svarstyp === 'osaker') return t('answer_osaker')
  if (b.svarstyp === 'fel_bolag') {
    return t('answer_fel_bolag', { bolag: b.till_bolag ?? t('unknown_company'), mottagare: b.fel_bolag_mottagare })
  }
  const kategori = t(`kategori_${b.kategori}`)
  return b.vald_kandidat
    ? t('answer_val_kandidat', { filnamn: b.vald_kandidat, kategori })
    : t('answer_ingen_kandidat', { motpart: b.motpart, kategori })
}

export interface SaveOutcome {
  toast: { title: string; description?: string; variant?: 'destructive' }
  /** Whether the answered list should be reloaded: only on a confirmed save. */
  refresh: boolean
}

/**
 * The decision behind the post-save toast and list refresh, isolated from the
 * fetch call so it can be tested without a DOM: success and failure must
 * produce different outcomes, and only success refreshes the list.
 */
export function interpretSaveResult(t: T, ok: boolean, body: { data: SvarRecord } | null): SaveOutcome {
  if (!ok) {
    return { toast: { title: t('save_failed'), description: errorText(t, body), variant: 'destructive' }, refresh: false }
  }
  return {
    toast: { title: t('save_success'), description: body?.data ? answerSummary(t, body.data) : undefined },
    refresh: true,
  }
}
