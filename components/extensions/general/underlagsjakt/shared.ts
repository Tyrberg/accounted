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
  tillBolag?: string | null
  mottagare?: string
  reglering?: Reglering
}

export type AnswerFormResult = { input: SvarInput; missing?: undefined } | { input?: undefined; missing: string[] }

/**
 * Single source for both what "Spara svar" submits and why it's disabled:
 * building the input and detecting missing fields happen in the same pass,
 * as one exhaustive result, so the button state and the "why disabled" hint
 * cannot drift into disagreement.
 */
export function buildAnswerInput(state: AnswerFormState): AnswerFormResult {
  const transaction_id = state.transactionId
  if (state.mode === 'osaker') return { input: { svarstyp: 'osaker', transaction_id } }

  if (state.mode === 'fel_bolag') {
    const missing: string[] = []
    if (state.tillBolag === undefined) missing.push('missing_till_bolag')
    if (!state.mottagare) missing.push('missing_mottagare')
    if (state.tillBolag !== null && state.tillBolag !== undefined && !state.reglering) {
      missing.push('missing_reglering')
    }
    if (missing.length > 0) return { missing }
    return {
      input: {
        svarstyp: 'fel_bolag',
        transaction_id,
        till_bolag: state.tillBolag ?? null,
        fel_bolag_mottagare: state.mottagare!,
        reglering: state.tillBolag === null ? null : (state.reglering ?? null),
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
