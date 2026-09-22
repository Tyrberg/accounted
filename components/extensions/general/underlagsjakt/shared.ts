import type { Kategori, Momstyp, Post, Reglering, SvarInput, UppladdatInput } from '@/extensions/general/underlagsjakt/lib/contract'
import type { FelBolagRow, SvarRecord, WaitingRow } from '@/extensions/general/underlagsjakt/lib/store'

/** Shape of GET /api/extensions/ext/underlagsjakt/. */
export interface WorkspaceData {
  supported_export_versions: string[]
  answer_version: string
  /** Whether the "I have the document" answer is switched on (bertil reads answer version 1.5). */
  underlag_upload_enabled: boolean
  /** Whether the "I'll deliver it myself" answer is switched on (bertil understands levererar_sjalv). */
  levererar_sjalv_enabled: boolean
  /** Whether a val_kandidat answer may choose more than one document (bertil understands vald_kandidater). */
  multi_kandidat_enabled: boolean
  /** Whether bertil's delivery lands in the company being viewed, not merely somewhere on this box. */
  leverans: { till_detta_bolag: boolean }
  export: {
    export_version: string
    generated_at: string
    imported_at: string
    imported_via: 'leverans' | 'fil'
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
  waiting: WaitingRow[]
  bolag_choices: string[]
}

export type T = (key: string, values?: Record<string, string | number>) => string

const KNOWN_ERROR_CODES = new Set([
  'INVALID_JSON',
  'INVALID_EXPORT',
  'UNSUPPORTED_VERSION',
  'VALIDATION_ERROR',
  'POST_NOT_FOUND',
  'CANDIDATE_NOT_FOUND',
  'CANDIDATE_WITHOUT_HASH',
  'UNDERLAG_FILE_MISSING',
  'UNDERLAG_UNSUPPORTED_TYPE',
  'UNDERLAG_TOO_LARGE',
  'UNDERLAG_INVALID_CONTENT',
  'UNDERLAG_UPLOAD_FAILED',
  'ALREADY_DELIVERED',
  'NOT_FOUND',
  'COUNT_CHANGED',
  'FEATURE_DISABLED',
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

/**
 * Resolves the raw "which company" radio choice to the value the answer actually carries:
 * undefined (nothing picked yet), null (unknown company), the typed external name (once
 * non-empty), or the picked company. The single definition, so the panel's render decisions
 * (which recipient option to show, whether the settlement fieldset is enabled) and
 * `buildAnswerInput`'s validation read the same fact instead of two copies that could drift.
 */
export function deriveTillBolag(tillBolagChoice: string | undefined, externalBolag: string): string | null | undefined {
  return tillBolagChoice === undefined
    ? undefined
    : tillBolagChoice === UNKNOWN
      ? null
      : tillBolagChoice === EXTERNAL
        ? externalBolag.trim() || undefined
        : tillBolagChoice
}

export interface AnswerFormState {
  mode: 'val_kandidat' | 'uppladdat_underlag' | 'fel_bolag' | 'levererar_sjalv' | 'osaker'
  transactionId: string
  /** The file chosen in uppladdat_underlag mode; undefined until one is picked. */
  file?: File
  /** Whether the user has made an explicit choice: some candidate(s), or "none of them". */
  hasCandidate: boolean
  /** sha256 of every chosen candidate. Empty when nothing is chosen yet, or "none of them" is chosen. */
  sha256: string[]
  kategori?: Kategori
  motpart: string
  basKonto: string
  basKontoValid: boolean
  momstyp: Momstyp | null
  begransaBolag: boolean
  begransaBelopp: boolean
  /** Apply the levererar_sjalv answer to all posts from this vendor. Only relevant in levererar_sjalv mode. */
  applyToAllVendor?: boolean
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

export type AnswerFormResult =
  | { input: SvarInput | UppladdatInput; missing?: undefined }
  | { input?: undefined; missing: string[] }

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

  if (state.mode === 'levererar_sjalv') {
    if (!state.motpart.trim()) return { missing: ['missing_motpart'] }
    return {
      input: {
        svarstyp: 'levererar_sjalv',
        transaction_id,
        motpart: state.motpart.trim(),
      },
    }
  }

  if (state.mode === 'fel_bolag') {
    const tillBolag = deriveTillBolag(state.tillBolagChoice, state.externalBolag ?? '')

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

  const uploading = state.mode === 'uppladdat_underlag'
  const missing: string[] = []
  if (uploading) {
    if (!state.file) missing.push('missing_file')
  } else if (!state.hasCandidate) missing.push('missing_candidate')
  if (!state.kategori) missing.push('missing_kategori')
  if (!state.motpart.trim()) missing.push('missing_motpart')
  if (!state.basKontoValid) missing.push('missing_bas_konto')
  if (missing.length > 0) return { missing }
  if (uploading) {
    return {
      input: {
        svarstyp: 'uppladdat_underlag',
        transaction_id,
        motpart: state.motpart.trim(),
        kategori: state.kategori!,
        bas_konto: state.basKonto.trim() || null,
        momstyp: state.momstyp,
        begransa_bolag: state.begransaBolag,
        begransa_belopp: state.begransaBelopp,
      },
    }
  }
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
  if (b.svarstyp === 'levererar_sjalv') {
    return b.underlag_hittat_at
      ? t('answer_levererar_sjalv_delivered', { motpart: b.motpart })
      : t('answer_levererar_sjalv_waiting', { motpart: b.motpart })
  }
  if (b.svarstyp === 'fel_bolag') {
    return t('answer_fel_bolag', { bolag: b.till_bolag ?? t('unknown_company'), mottagare: b.fel_bolag_mottagare })
  }
  const kategori = t(`kategori_${b.kategori}`)
  if (b.svarstyp === 'uppladdat_underlag') return t('answer_uppladdat_underlag', { filnamn: b.filnamn, kategori })
  const valdKandidater = b.vald_kandidater ?? []
  if (valdKandidater.length > 1) {
    return t('answer_val_kandidat_multi', { count: valdKandidater.length, kategori })
  }
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
export function interpretSaveResult(t: T, ok: boolean, body: unknown): SaveOutcome {
  if (!ok) {
    return { toast: { title: t('save_failed'), description: errorText(t, body), variant: 'destructive' }, refresh: false }
  }
  const data = (body as { data?: (SvarRecord & { koppling?: string }) } | null)?.data
  // An uploaded underlag is always filed; whether it also followed a transaction is worth saying.
  const unlinked = data?.beslut.svarstyp === 'uppladdat_underlag' && data.koppling !== 'kopplad'
  const unlinkedKey =
    data?.koppling === 'ej_pa_verifikat'
      ? 'answer_uppladdat_not_on_verifikat'
      : data?.koppling === 'annat_verifikat'
        ? 'answer_uppladdat_other_verifikat'
        : 'answer_uppladdat_not_linked'
  return {
    toast: {
      title: t('save_success'),
      description: data ? [answerSummary(t, data), unlinked ? t(unlinkedKey) : null].filter(Boolean).join('. ') : undefined,
    },
    refresh: true,
  }
}

const SVAR_URL = '/api/extensions/ext/underlagsjakt/svar'
const BULK_SVAR_URL = '/api/extensions/ext/underlagsjakt/svar/bulk'

/**
 * An uploaded underlag travels as multipart, the file next to the answer's own
 * fields, so the server can refuse or record both together.
 */
export function buildUppladdatForm(input: UppladdatInput, file: File): FormData {
  const form = new FormData()
  form.set('file', file)
  form.set('transaction_id', input.transaction_id)
  form.set('motpart', input.motpart)
  form.set('kategori', input.kategori)
  form.set('bas_konto', input.bas_konto ?? '')
  form.set('momstyp', input.momstyp ?? '')
  form.set('begransa_bolag', String(input.begransa_bolag))
  form.set('begransa_belopp', String(input.begransa_belopp))
  return form
}

/**
 * Apply "I will deliver it myself" to every payment from the answered post's
 * motpart. `promisedCount` is the number the user saw and confirmed
 * (`bulkTargets(...).length`); the server recounts and refuses on a mismatch,
 * in which case the list is reloaded so the new count can be confirmed again.
 */
export async function submitBulkAnswer(
  input: Extract<SvarInput, { svarstyp: 'levererar_sjalv' }>,
  promisedCount: number,
  t: T,
  onOutcome: (outcome: SaveOutcome) => void,
  onAnswered: () => Promise<void>,
  fetchFn?: typeof fetch,
): Promise<void> {
  try {
    const res = await (fetchFn || fetch)(BULK_SVAR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, bekrafta_antal: promisedCount }),
    })
    const json: unknown = await res.json().catch(() => null)
    if (res.ok) {
      const recorded = (json as { data?: { recorded?: number } } | null)?.data?.recorded ?? promisedCount
      onOutcome({
        toast: { title: t('save_success'), description: t('levererar_sjalv_bulk_saved', { count: recorded, motpart: input.motpart }) },
        refresh: true,
      })
      await onAnswered()
      return
    }
    onOutcome(interpretSaveResult(t, false, json))
    const code = (json as { error?: { code?: unknown } } | null)?.error?.code
    if (code === 'COUNT_CHANGED') await onAnswered()
  } catch {
    onOutcome(interpretSaveResult(t, false, null))
  }
}

/**
 * Submit an answer to the API and handle the outcome. Extracted for testability.
 * `file` is required for (and only read by) an `uppladdat_underlag` input.
 */
export async function submitAnswer(
  input: SvarInput | UppladdatInput,
  t: T,
  onOutcome: (outcome: SaveOutcome) => void,
  onAnswered: () => Promise<void>,
  fetchFn?: typeof fetch,
  file?: File,
): Promise<void> {
  const uploading = input.svarstyp === 'uppladdat_underlag'
  if (uploading && !file) {
    onOutcome(interpretSaveResult(t, false, { error: { code: 'UNDERLAG_FILE_MISSING' } }))
    return
  }
  try {
    const res = await (fetchFn || fetch)(
      uploading ? `${SVAR_URL}/underlag` : SVAR_URL,
      uploading
        ? { method: 'POST', body: buildUppladdatForm(input as UppladdatInput, file!) }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    )
    const json: unknown = await res.json().catch(() => null)
    const outcome = interpretSaveResult(t, res.ok, json)
    onOutcome(outcome)
    if (outcome.refresh) await onAnswered()
  } catch {
    onOutcome(interpretSaveResult(t, false, null))
  }
}
