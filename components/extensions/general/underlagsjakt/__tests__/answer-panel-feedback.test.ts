import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { answerSummary, buildAnswerInput } from '../shared'
import type { SvarRecord } from '@/extensions/general/underlagsjakt/lib/store'

/**
 * Regression coverage for two PostAnswerPanel bugs (task: "Spara svar-knappen
 * ar slackt utan forklaring, och ingen bekraftelse nar svaret sparats"):
 *
 * 1. The Save button used to go grey with no indication of which of the four
 *    required fields (candidate, kategori, motpart, valid BAS account /
 *    till_bolag, mottagare, reglering for fel_bolag) was still missing.
 * 2. Nothing confirmed a save actually happened.
 *
 * `buildAnswerInput` is the single source for both the submitted payload and
 * the missing-field list: it returns exactly one of `{ input }` or
 * `{ missing }`, so the two cannot drift apart (a bug already reported once,
 * see PostAnswerPanel.tsx history).
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

describe('buildAnswerInput', () => {
  it('lists every unset field for val_kandidat', () => {
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

  it('returns an input once val_kandidat is complete, never both input and missing', () => {
    const result = buildAnswerInput(BASE_VAL_KANDIDAT)
    expect(result.missing).toBeUndefined()
    expect(result.input).toMatchObject({ svarstyp: 'val_kandidat', kategori: 'bankavgift', motpart: 'Banken' })
  })

  it('requires reglering for fel_bolag only once a company is chosen', () => {
    expect(
      buildAnswerInput({
        ...BASE_VAL_KANDIDAT,
        mode: 'fel_bolag',
        tillBolag: 'Annat AB',
        mottagare: 'Annat AB',
        reglering: undefined,
      }),
    ).toEqual({ missing: ['missing_reglering'] })

    const result = buildAnswerInput({
      ...BASE_VAL_KANDIDAT,
      mode: 'fel_bolag',
      tillBolag: null,
      mottagare: 'Annat AB',
      reglering: undefined,
    })
    expect(result.missing).toBeUndefined()
    expect(result.input).toMatchObject({ svarstyp: 'fel_bolag', till_bolag: null, reglering: null })
  })

  it('never blocks osaker', () => {
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

describe('answerSummary', () => {
  it('describes a val_kandidat save without a chosen document', () => {
    const rec: SvarRecord = {
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
      key === 'kategori_bankavgift' ? 'Bankavgift' : `${key}:${JSON.stringify(values)}`
    expect(answerSummary(t, rec)).toContain('Banken')
  })
})

describe('PostAnswerPanel save confirmation', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../PostAnswerPanel.tsx'), 'utf8')

  it('shows a toast confirmation after a successful save, built from the stored answer the server returns', () => {
    expect(SRC).toMatch(/toast\(\{\s*title:\s*t\('save_success'\)/)
    expect(SRC).toMatch(/answerSummary\(t,\s*json\.data\)/)
  })

  it('shows the missing-field hint whenever the save is disabled, without a redundant second condition', () => {
    expect(SRC).toContain("t('save_disabled_reason'")
    expect(SRC).toMatch(/\{!input && !saving && \(/)
  })

  it('reloads the list on save so the post leaves "Att besvara" without a page reload', () => {
    expect(SRC).toMatch(/await onAnswered\(\)/)
  })
})

describe('translations for the new copy exist in both locales', () => {
  const readNamespace = (locale: 'sv' | 'en') =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../../../messages/${locale}.json`), 'utf8'))
      .underlagsjakt

  const keys = [
    'save_success',
    'save_disabled_reason',
    'missing_candidate',
    'missing_kategori',
    'missing_motpart',
    'missing_bas_konto',
    'missing_till_bolag',
    'missing_mottagare',
    'missing_reglering',
  ]

  it.each(keys)('%s exists in sv.json and en.json', (key) => {
    expect(readNamespace('sv')[key]).toBeTruthy()
    expect(readNamespace('en')[key]).toBeTruthy()
  })
})
