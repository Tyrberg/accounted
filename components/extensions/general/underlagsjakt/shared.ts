import type { Post } from '@/extensions/general/underlagsjakt/lib/contract'
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
