import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  EXTERNAL,
  OTHER,
  OTHER_COMPANY,
  PAYER,
  UNKNOWN,
  answerSummary,
  buildAnswerInput,
  deriveTillBolag,
  interpretSaveResult,
} from '../shared'
import type { SvarRecord } from '@/extensions/general/underlagsjakt/lib/store'

/**
 * Regression coverage for two PostAnswerPanel bugs (task: "Spara svar-knappen
 * ar slackt utan forklaring, och ingen bekraftelse nar svaret sparats"):
 *
 * 1. The Save button used to go grey with no indication of which required
 *    field (candidate, kategori, motpart, valid BAS account; or, for
 *    fel_bolag, which company / who's on the invoice / how it settles) was
 *    still missing.
 * 2. Nothing confirmed a save actually happened.
 *
 * `buildAnswerInput` is the single source for both the submitted payload and
 * the missing-field list, from the *raw* radio/text state (not a pre-derived
 * value): a choice that has been made but not yet filled in (e.g. "external
 * company" picked with an empty name field) must not be reported as "nothing
 * chosen". `interpretSaveResult` is the single source for what happens after
 * a save attempt, so the confirmation and the failure path cannot be
 * conflated.
 */

const BASE_VAL_KANDIDAT = {
  mode: 'val_kandidat' as const,
  transactionId: 't1',
  hasCandidate: true,
  sha256: null,
  kategori: 'bankavgift' as const,
  motpart: 'Banken',
  basKonto: '',
  basKontoValid: true,
  momstyp: null,
  begransaBolag: false,
  begransaBelopp: false,
}

const BASE_FEL_BOLAG = {
  ...BASE_VAL_KANDIDAT,
  mode: 'fel_bolag' as const,
  externalBolag: '',
  otherMottagare: '',
  payerBolag: 'Acme AB',
}

describe('buildAnswerInput: val_kandidat', () => {
  it('lists every unset field', () => {
    const result = buildAnswerInput({
      ...BASE_VAL_KANDIDAT,
      hasCandidate: false,
      kategori: undefined,
      motpart: '  ',
      basKontoValid: false,
    })
    expect(result).toEqual({
      missing: ['missing_candidate', 'missing_kategori', 'missing_motpart', 'missing_bas_konto'],
    })
  })

  it('flags only kategori when everything else is set (the reported case: changing kategori on a bank fee)', () => {
    const result = buildAnswerInput({ ...BASE_VAL_KANDIDAT, kategori: undefined })
    expect(result).toEqual({ missing: ['missing_kategori'] })
  })

  it('returns an input once complete, never both input and missing', () => {
    const result = buildAnswerInput(BASE_VAL_KANDIDAT)
    expect(result.missing).toBeUndefined()
    expect(result.input).toMatchObject({ svarstyp: 'val_kandidat', kategori: 'bankavgift', motpart: 'Banken' })
  })
})

describe('buildAnswerInput: fel_bolag', () => {
  it('flags nothing chosen yet as missing_till_bolag / missing_mottagare', () => {
    const result = buildAnswerInput({ ...BASE_FEL_BOLAG, tillBolagChoice: undefined, mottagareChoice: undefined })
    expect(result).toEqual({ missing: ['missing_till_bolag', 'missing_mottagare'] })
  })

  it('reports the empty name field, not "nothing chosen", once external company is picked but unnamed', () => {
    const result = buildAnswerInput({
      ...BASE_FEL_BOLAG,
      tillBolagChoice: EXTERNAL,
      externalBolag: '   ',
      mottagareChoice: PAYER,
    })
    expect(result).toEqual({ missing: ['missing_external_bolag_namn'] })
  })

  it('accepts external company once named', () => {
    const result = buildAnswerInput({
      ...BASE_FEL_BOLAG,
      tillBolagChoice: EXTERNAL,
      externalBolag: 'Externt AB',
      mottagareChoice: PAYER,
      reglering: 'mellanhavande',
    })
    expect(result.missing).toBeUndefined()
    expect(result.input).toMatchObject({ svarstyp: 'fel_bolag', till_bolag: 'Externt AB' })
  })

  it('reports the empty name field, not "nothing chosen", once "someone else" is picked as recipient but unnamed', () => {
    const result = buildAnswerInput({
      ...BASE_FEL_BOLAG,
      tillBolagChoice: UNKNOWN,
      mottagareChoice: OTHER,
      otherMottagare: '  ',
    })
    expect(result).toEqual({ missing: ['missing_mottagare_namn'] })
  })

  it('resolves "other company" as recipient to the chosen company', () => {
    const result = buildAnswerInput({
      ...BASE_FEL_BOLAG,
      tillBolagChoice: 'Annat AB',
      mottagareChoice: OTHER_COMPANY,
      reglering: 'mellanhavande',
    })
    expect(result.missing).toBeUndefined()
    expect(result.input).toMatchObject({ till_bolag: 'Annat AB', fel_bolag_mottagare: 'Annat AB' })
  })

  it('requires reglering only once a company is chosen (unknown company needs no settlement)', () => {
    expect(
      buildAnswerInput({
        ...BASE_FEL_BOLAG,
        tillBolagChoice: 'Annat AB',
        mottagareChoice: PAYER,
        reglering: undefined,
      }),
    ).toEqual({ missing: ['missing_reglering'] })

    const result = buildAnswerInput({
      ...BASE_FEL_BOLAG,
      tillBolagChoice: UNKNOWN,
      mottagareChoice: PAYER,
      reglering: undefined,
    })
    expect(result.missing).toBeUndefined()
    expect(result.input).toMatchObject({ svarstyp: 'fel_bolag', till_bolag: null, reglering: null })
  })
})

describe('deriveTillBolag', () => {
  it('is undefined when nothing is chosen yet', () => {
    expect(deriveTillBolag(undefined, '')).toBeUndefined()
  })

  it('is null for the unknown-company choice', () => {
    expect(deriveTillBolag(UNKNOWN, '')).toBeNull()
  })

  it('is undefined for external once picked but not yet named', () => {
    expect(deriveTillBolag(EXTERNAL, '   ')).toBeUndefined()
  })

  it('is the trimmed name once external is named', () => {
    expect(deriveTillBolag(EXTERNAL, ' Externt AB ')).toBe('Externt AB')
  })

  it('is the picked company name for a direct choice', () => {
    expect(deriveTillBolag('Annat AB', '')).toBe('Annat AB')
  })
})

describe('buildAnswerInput: osaker', () => {
  it('never blocks', () => {
    const result = buildAnswerInput({ ...BASE_VAL_KANDIDAT, mode: 'osaker' })
    expect(result.missing).toBeUndefined()
    expect(result.input).toEqual({ svarstyp: 'osaker', transaction_id: 't1' })
  })
})

const SVAR_RECORD_BASE = {
  reglering: null,
  post: {
    bolag: 'Acme AB',
    period: '2026-08',
    datum: '2026-08-01',
    belopp: -150,
    valuta: 'SEK',
    motpart: 'Banken',
    konto_identitet: '1930',
    typ: 'bankavgift',
  },
  besvarad_at: '2026-09-18T10:00:00.000Z',
  besvarad_av: 'mattias@meme.com',
  levererad_at: null,
}

const SVAR_RECORD: SvarRecord = {
  ...SVAR_RECORD_BASE,
  beslut: {
    transaction_id: 't1',
    svarstyp: 'val_kandidat',
    vald_kandidat: null,
    motpart: 'Banken',
    kategori: 'bankavgift',
    bas_konto: null,
    momstyp: null,
    bolag: null,
    bankkonto: null,
    belopp: null,
  },
}

const t = (key: string, values?: Record<string, string | number>) =>
  key === 'kategori_bankavgift' ? 'Bankavgift' : `${key}:${JSON.stringify(values ?? {})}`

describe('answerSummary', () => {
  it.each(['sv', 'en'] as const)('keeps option examples out of summaries and toasts in %s', (locale) => {
    const messages = locale === 'sv' ? sv : en
    const translate = createTranslator({ locale, messages, namespace: 'underlagsjakt' })
    const summary = answerSummary(translate, SVAR_RECORD)
    expect(summary).toContain(`(${messages.underlagsjakt.kategori_bankavgift})`)
    expect(summary).not.toContain(messages.underlagsjakt.kategori_option_bankavgift)
    expect(interpretSaveResult(translate, true, { data: SVAR_RECORD }).toast.description).toBe(summary)
  })
  it('describes a val_kandidat save without a chosen document', () => {
    expect(answerSummary(t, SVAR_RECORD)).toContain('Banken')
  })
})

describe('interpretSaveResult', () => {
  it('confirms and refreshes the list on success, summarizing the stored answer', () => {
    const outcome = interpretSaveResult(t, true, { data: SVAR_RECORD })
    expect(outcome.refresh).toBe(true)
    expect(outcome.toast.title).toBe('save_success:{}')
    expect(outcome.toast.description).toContain('Banken')
    expect(outcome.toast.variant).toBeUndefined()
  })

  it('does not refresh the list on failure, and marks the toast destructive', () => {
    const outcome = interpretSaveResult(t, false, null)
    expect(outcome.refresh).toBe(false)
    expect(outcome.toast.title).toBe('save_failed:{}')
    expect(outcome.toast.variant).toBe('destructive')
  })

  it('maps a structured error code from the response body to its translated sentence on failure', () => {
    const outcome = interpretSaveResult(t, false, { error: { code: 'ALREADY_DELIVERED' } })
    expect(outcome.toast.description).toBe('error_ALREADY_DELIVERED:{}')
  })

  it('falls back to the generic error sentence for an unrecognized body shape', () => {
    const outcome = interpretSaveResult(t, false, { unexpected: true })
    expect(outcome.toast.description).toBe('error_generic:{}')
  })
})

describe('PostAnswerPanel wiring', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../PostAnswerPanel.tsx'), 'utf8')

  it('routes the fetch response through interpretSaveResult and shows the returned hint whenever save is disabled', () => {
    expect(SRC).toMatch(/interpretSaveResult\(t,\s*res\.ok,\s*json\)/)
    expect(SRC).toContain("t('save_disabled_reason'")
  })

  it('always renders the reason line (never unmounted), following the BookDirectlyDialog disabledReason/canSubmit pattern: attn tone plus aria-live while blocked, muted "ready" text otherwise', () => {
    expect(SRC).toMatch(/const ready = missingReasons\.length === 0/)
    expect(SRC).toMatch(/const disabledReason = saving \|\| ready \? null : t\('save_disabled_reason'/)
    expect(SRC).toMatch(/<p className=\{cn\('text-xs', disabledReason \? 'text-attn' : 'text-muted-foreground'\)\} aria-live="polite">/)
    expect(SRC).toMatch(/\{disabledReason \?\? t\('save_ready'\)\}/)
  })

  it('derives the button disabled state from the same `ready` flag as the hint line, not a separately-computed `input` check, so the two cannot disagree', () => {
    expect(SRC).toMatch(/const canSubmit = ready && !saving/)
    expect(SRC).toMatch(/<Button onClick=\{\(\) => void submit\(\)\} disabled=\{!canSubmit\}>/)
  })

  it('reloads the list only when interpretSaveResult says so, so an answered post leaves "Att besvara" without a page reload', () => {
    expect(SRC).toMatch(/if\s*\(outcome\.refresh\)\s*await onAnswered\(\)/)
  })

  it('catches a rejected fetch (offline, connection reset) or malformed response and still shows the failure toast', () => {
    const submitBody = SRC.slice(SRC.indexOf('const submit = async'), SRC.indexOf('return (', SRC.indexOf('const submit = async')))
    expect(submitBody).toMatch(/catch\s*\{/)
    expect(submitBody).toMatch(/toast\(interpretSaveResult\(t,\s*false,\s*null\)\.toast\)/)
  })
})

describe('translations for the new copy exist in both locales', () => {
  const readNamespace = (locale: 'sv' | 'en') =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../../../messages/${locale}.json`), 'utf8'))
      .underlagsjakt

  const keys = [
    'save_success',
    'save_disabled_reason',
    'save_ready',
    'missing_candidate',
    'missing_kategori',
    'missing_motpart',
    'missing_bas_konto',
    'missing_till_bolag',
    'missing_external_bolag_namn',
    'missing_mottagare',
    'missing_mottagare_namn',
    'missing_reglering',
  ]

  it.each(keys)('%s exists in sv.json and en.json', (key) => {
    expect(readNamespace('sv')[key]).toBeTruthy()
    expect(readNamespace('en')[key]).toBeTruthy()
  })
})
