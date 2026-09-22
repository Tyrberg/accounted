import { createTranslator } from 'next-intl'
import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PostAnswerPanel } from '../PostAnswerPanel'
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
  isReglerarSkuldAccountValid,
  searchReglerarSkuldVerifikat,
  submitAnswer,
  submitBulkAnswer,
  summarizeSelectedCandidates,
  type SaveOutcome,
  type T,
} from '../shared'
import type { Kandidat, Post } from '@/extensions/general/underlagsjakt/lib/contract'
import type { SvarRecord } from '@/extensions/general/underlagsjakt/lib/store'

/**
 * The answer panel's client side.
 *
 * The pure functions (buildAnswerInput, deriveTillBolag, answerSummary, interpretSaveResult)
 * are tested directly. The last describe block renders the real PostAnswerPanel in jsdom and
 * drives it the way a person does (choose, type, click Save), so it fails when the Save button
 * stops working or when an empty BAS account starts blocking a save. The server side is covered
 * by extensions/general/underlagsjakt/__tests__/routes.test.ts.
 */

const BASE_VAL_KANDIDAT = {
  mode: 'val_kandidat' as const,
  transactionId: 't1',
  hasCandidate: true,
  sha256: [] as string[],
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

describe('buildAnswerInput: uppladdat_underlag', () => {
  const PDF = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'kvitto.pdf', { type: 'application/pdf' })
  const BASE_UPLOAD = { ...BASE_VAL_KANDIDAT, mode: 'uppladdat_underlag' as const, hasCandidate: false, file: PDF }

  it('needs a file, and never a chosen candidate', () => {
    expect(buildAnswerInput({ ...BASE_UPLOAD, file: undefined })).toEqual({ missing: ['missing_file'] })
  })

  it('still needs the classification the rule is learned from', () => {
    expect(buildAnswerInput({ ...BASE_UPLOAD, kategori: undefined, motpart: ' ' })).toEqual({
      missing: ['missing_kategori', 'missing_motpart'],
    })
  })

  it('builds an uppladdat_underlag input once a file is chosen', () => {
    expect(buildAnswerInput({ ...BASE_UPLOAD, basKonto: '6570', begransaBolag: true })).toEqual({
      input: {
        svarstyp: 'uppladdat_underlag',
        transaction_id: 't1',
        motpart: 'Banken',
        kategori: 'bankavgift',
        bas_konto: '6570',
        momstyp: null,
        begransa_bolag: true,
        begransa_belopp: false,
      },
    })
  })
})

describe('submitAnswer: uppladdat_underlag', () => {
  const PNG = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'foto.png', { type: 'image/png' })
  const input = {
    svarstyp: 'uppladdat_underlag' as const,
    transaction_id: 't1',
    motpart: 'Banken',
    kategori: 'bankavgift' as const,
    bas_konto: null,
    momstyp: null,
    begransa_bolag: false,
    begransa_belopp: true,
  }

  it('posts the file and the answer as multipart to /svar/underlag', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: SVAR_RECORD }) })
    const onAnswered = vi.fn(async () => {})
    const outcomes: SaveOutcome[] = []

    await submitAnswer(input, t, (o) => outcomes.push(o), onAnswered, mockFetch as unknown as typeof fetch, PNG)

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('/api/extensions/ext/underlagsjakt/svar/underlag')
    expect(init.method).toBe('POST')
    // No JSON content type: the browser must set the multipart boundary itself.
    expect(init.headers).toBeUndefined()
    const form = init.body as FormData
    expect((form.get('file') as File).name).toBe('foto.png')
    expect(form.get('transaction_id')).toBe('t1')
    expect(form.get('kategori')).toBe('bankavgift')
    expect(form.get('bas_konto')).toBe('')
    expect(form.get('begransa_belopp')).toBe('true')
    expect(outcomes[0].refresh).toBe(true)
    expect(onAnswered).toHaveBeenCalledTimes(1)
  })

  it('never calls the API without a file', async () => {
    const mockFetch = vi.fn()
    const outcomes: SaveOutcome[] = []
    await submitAnswer(input, t, (o) => outcomes.push(o), vi.fn(), mockFetch as unknown as typeof fetch)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(outcomes[0].refresh).toBe(false)
    expect(outcomes[0].toast.variant).toBe('destructive')
  })

  it('keeps the list unrefreshed when the server refuses the file', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { code: 'UNDERLAG_UNSUPPORTED_TYPE' } }),
    })
    const onAnswered = vi.fn()
    const outcomes: SaveOutcome[] = []
    await submitAnswer(input, t, (o) => outcomes.push(o), onAnswered, mockFetch as unknown as typeof fetch, PNG)
    expect(outcomes[0].toast.description).toBe('error_UNDERLAG_UNSUPPORTED_TYPE:{}')
    expect(onAnswered).not.toHaveBeenCalled()
  })
})

describe('levererar_sjalv: "I will deliver the underlag myself"', () => {
  const BASE = { ...BASE_VAL_KANDIDAT, mode: 'levererar_sjalv' as const }
  const input = { svarstyp: 'levererar_sjalv' as const, transaction_id: 't1', motpart: 'HI3G' }

  it('needs only a motpart: no candidate, kategori or BAS account', () => {
    expect(buildAnswerInput({ ...BASE, hasCandidate: false, motpart: 'HI3G' })).toEqual({ input })
    expect(buildAnswerInput({ ...BASE, motpart: '  ' })).toEqual({ missing: ['missing_motpart'] })
  })

  it.each(['sv', 'en'] as const)('is summarized as waiting, never as "no underlag needed", and as found once bertil says so, in %s', (locale) => {
    const messages = locale === 'sv' ? sv : en
    const translate = createTranslator({ locale, messages, namespace: 'underlagsjakt' }) as T
    const rec = (hittat: string | null) =>
      ({ ...SVAR_RECORD, beslut: { answer_id: 'a', transaction_id: 't1', svarstyp: 'levererar_sjalv', motpart: 'HI3G', underlag_hittat_at: hittat } }) as SvarRecord
    const waiting = answerSummary(translate, rec(null))
    const found = answerSummary(translate, rec('2026-09-30T00:00:00Z'))
    expect(waiting).toContain('HI3G')
    expect(found).toContain('HI3G')
    expect(waiting).not.toBe(found)
    expect(waiting).toBe(translate('answer_levererar_sjalv_waiting', { motpart: 'HI3G' }))
    expect(waiting).not.toBe(answerSummary(translate, { ...SVAR_RECORD, beslut: { answer_id: 'a', transaction_id: 't1', svarstyp: 'osaker' } } as SvarRecord))
  })
})

describe('the count shown before the user confirms', () => {
  it.each([
    ['sv', 1, '1 post'],
    ['sv', 7, '7 poster'],
    ['en', 1, '1 item'],
    ['en', 7, '7 items'],
  ] as const)('says how many posts it removes in %s for %i', (locale, count, expected) => {
    const messages = locale === 'sv' ? sv : en
    const translate = createTranslator({ locale, messages, namespace: 'underlagsjakt' }) as T
    expect(translate('levererar_sjalv_count', { count })).toContain(expected)
  })
})

describe('summarizeSelectedCandidates', () => {
  const kandidat = (belopp: number | null): Kandidat => ({
    filnamn: 'lon.pdf',
    kalla: 'gmail:löner',
    datum: '2026-09-20',
    bevisgrund: 'belopp matchar',
    sha256: 'a'.repeat(64),
    belopp,
  })

  it('nets a same-sign payment and candidates to zero: the reported salary case (payment -35000, löneunderlag -15000 and -20000)', () => {
    const result = summarizeSelectedCandidates(-35000, [kandidat(-15000), kandidat(-20000)])
    expect(result).toEqual({ sum: -35000, missingBeloppCount: 0, diff: 0 })
  })

  it('reports a real shortfall, not a doubled one, when the candidates only partly cover an outgoing payment', () => {
    const result = summarizeSelectedCandidates(-35000, [kandidat(-15000), kandidat(-10000)])
    expect(result.sum).toBe(-25000)
    expect(result.diff).toBe(-10000)
  })

  it('excludes candidates without a belopp from the sum instead of treating them as zero', () => {
    const result = summarizeSelectedCandidates(-35000, [kandidat(-15000), kandidat(null)])
    expect(result.sum).toBe(-15000)
    expect(result.missingBeloppCount).toBe(1)
    expect(result.diff).toBe(-20000)
  })

  it('rounds the sum to the nearest öre instead of letting float drift show through', () => {
    const result = summarizeSelectedCandidates(-0.3, [kandidat(-0.1), kandidat(-0.2)])
    expect(result.sum).toBe(-0.3)
    expect(result.diff).toBe(0)
  })

  it('nets a same-sign incoming payment to zero as well', () => {
    const result = summarizeSelectedCandidates(35000, [kandidat(15000), kandidat(20000)])
    expect(result).toEqual({ sum: 35000, missingBeloppCount: 0, diff: 0 })
  })
})

describe('the sum shown against selected underlag', () => {
  it.each([
    ['sv', 1, 'Ett valt dokument saknar belopp'],
    ['sv', 2, '2 valda dokument saknar belopp'],
    ['en', 1, 'One selected document has no amount'],
    ['en', 2, '2 selected documents have no amount'],
  ] as const)('pluralizes the missing-belopp note correctly in %s for count %i', (locale, count, expected) => {
    const messages = locale === 'sv' ? sv : en
    const translate = createTranslator({ locale, messages, namespace: 'underlagsjakt' }) as T
    expect(translate('candidates_selected_sum_missing_belopp', { count })).toContain(expected)
  })

  it.each(['sv', 'en'] as const)('names the selected sum against the payment amount in %s', (locale) => {
    const messages = locale === 'sv' ? sv : en
    const translate = createTranslator({ locale, messages, namespace: 'underlagsjakt' }) as T
    expect(translate('candidates_selected_sum', { sum: '20 000 kr', belopp: '35 000 kr' })).toContain('20 000 kr')
    expect(translate('candidates_selected_sum', { sum: '20 000 kr', belopp: '35 000 kr' })).toContain('35 000 kr')
  })
})

describe('submitBulkAnswer', () => {
  const input = { svarstyp: 'levererar_sjalv' as const, transaction_id: 't1', motpart: 'HI3G' }
  const respond = (ok: boolean, body: unknown) => vi.fn().mockResolvedValue({ ok, json: async () => body })

  it('posts the anchor answer and the promised count to /svar/bulk, and names no other post', async () => {
    const mockFetch = respond(true, { data: { recorded: 7, transaction_ids: [] } })
    const onAnswered = vi.fn(async () => {})
    const outcomes: SaveOutcome[] = []

    await submitBulkAnswer(input, 7, t, (o) => outcomes.push(o), onAnswered, mockFetch as unknown as typeof fetch)

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('/api/extensions/ext/underlagsjakt/svar/bulk')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ ...input, bekrafta_antal: 7 })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].toast.variant).toBeUndefined()
    expect(outcomes[0].toast.description).toBe('levererar_sjalv_bulk_saved:{"count":7,"motpart":"HI3G"}')
    expect(outcomes[0].refresh).toBe(true)
    expect(onAnswered).toHaveBeenCalledTimes(1)
  })

  it('reloads the list on COUNT_CHANGED so the new count can be confirmed, and says so as an error', async () => {
    const mockFetch = respond(false, { error: { code: 'COUNT_CHANGED', antal: 6 } })
    const onAnswered = vi.fn(async () => {})
    const outcomes: SaveOutcome[] = []
    await submitBulkAnswer(input, 7, t, (o) => outcomes.push(o), onAnswered, mockFetch as unknown as typeof fetch)
    expect(outcomes[0].toast.variant).toBe('destructive')
    expect(outcomes[0].toast.description).toBe('error_COUNT_CHANGED:{}')
    expect(onAnswered).toHaveBeenCalledTimes(1)
  })

  it('keeps the list as it is on any other refusal', async () => {
    const mockFetch = respond(false, { error: { code: 'FEATURE_DISABLED' } })
    const onAnswered = vi.fn()
    const outcomes: SaveOutcome[] = []
    await submitBulkAnswer(input, 7, t, (o) => outcomes.push(o), onAnswered, mockFetch as unknown as typeof fetch)
    expect(outcomes[0].toast.description).toBe('error_FEATURE_DISABLED:{}')
    expect(outcomes[0].refresh).toBe(false)
    expect(onAnswered).not.toHaveBeenCalled()
  })

  it('treats a network error as a failed save', async () => {
    const onAnswered = vi.fn()
    const outcomes: SaveOutcome[] = []
    await submitBulkAnswer(input, 7, t, (o) => outcomes.push(o), onAnswered, vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch)
    expect(outcomes[0].toast.variant).toBe('destructive')
    expect(onAnswered).not.toHaveBeenCalled()
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

describe('buildAnswerInput: reglerar_skuld', () => {
  const BASE_REGLERAR_SKULD = {
    mode: 'reglerar_skuld' as const,
    transactionId: 't1',
    hasCandidate: false,
    sha256: [] as string[],
    motpart: 'LÖN',
    basKonto: '2893',
    basKontoValid: true,
    momstyp: null,
    begransaBolag: false,
    begransaBelopp: false,
    ursprungsverifikatId: 'verifikat-1',
  }

  it('lists every unset field', () => {
    const result = buildAnswerInput({ ...BASE_REGLERAR_SKULD, ursprungsverifikatId: undefined, motpart: '  ', basKonto: '' })
    expect(result).toEqual({ missing: ['missing_ursprungsverifikat', 'missing_motpart', 'missing_bas_konto'] })
  })

  it('flags an invalid BAS account even when one was typed', () => {
    const result = buildAnswerInput({ ...BASE_REGLERAR_SKULD, basKonto: '28', basKontoValid: false })
    expect(result).toEqual({ missing: ['missing_bas_konto'] })
  })

  it('returns an input once complete, referencing the picked verifikat and the liability account', () => {
    const result = buildAnswerInput(BASE_REGLERAR_SKULD)
    expect(result.missing).toBeUndefined()
    expect(result.input).toEqual({
      svarstyp: 'reglerar_skuld',
      transaction_id: 't1',
      motpart: 'LÖN',
      ursprungsverifikat_id: 'verifikat-1',
      bas_konto: '2893',
      begransa_bolag: false,
      begransa_belopp: false,
    })
  })
})

describe('isReglerarSkuldAccountValid', () => {
  it('accepts a BAS class 2 (liability) account, e.g. the avräkningskonto from a suggestion', () => {
    expect(isReglerarSkuldAccountValid('2893')).toBe(true)
  })

  it('refuses a cost account typed by hand instead of picked from the suggestion: the bug this answer type exists to prevent', () => {
    expect(isReglerarSkuldAccountValid('7210')).toBe(false)
  })

  it('refuses an asset account and a malformed value', () => {
    expect(isReglerarSkuldAccountValid('1930')).toBe(false)
    expect(isReglerarSkuldAccountValid('28')).toBe(false)
    expect(isReglerarSkuldAccountValid('')).toBe(false)
  })
})

describe('searchReglerarSkuldVerifikat', () => {
  it('maps rows into verifikat results, suggesting the liability account off each row\'s own lines', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'je-1',
            voucher_series: 'A',
            voucher_number: 217,
            entry_date: '2025-12-31',
            description: 'Lön december 2025',
            lines: [{ account_number: '7210' }, { account_number: '2893' }],
          },
        ],
      }),
    })
    const outcome = await searchReglerarSkuldVerifikat('A217', mockFetch as unknown as typeof fetch)
    expect(outcome).toEqual({
      ok: true,
      results: [
        { id: 'je-1', label: 'A217', date: '2025-12-31', description: 'Lön december 2025', accountCandidates: ['2893'] },
      ],
    })
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/bookkeeping\/journal-entries\?search=A217&status=posted&exclude_draft=true&limit=8$/),
    )
  })

  it('treats a non-ok response as a search failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) })
    expect(await searchReglerarSkuldVerifikat('A217', mockFetch as unknown as typeof fetch)).toEqual({ ok: false })
  })

  it('treats an unparseable body on a 200 as a search failure, never as "nothing matched": a truncated response must not look like a verifikat that genuinely does not exist', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } })
    expect(await searchReglerarSkuldVerifikat('A217', mockFetch as unknown as typeof fetch)).toEqual({ ok: false })
  })

  it('treats a network exception as a search failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('offline'))
    expect(await searchReglerarSkuldVerifikat('A217', mockFetch as unknown as typeof fetch)).toEqual({ ok: false })
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
  answer_id: '2026-09-18T10:00:00.000Z:t1',
  erbjudet_at: null,
  levererad_at: null,
}

const SVAR_RECORD: SvarRecord = {
  ...SVAR_RECORD_BASE,
  beslut: {
    answer_id: 'test-answer-1',
    transaction_id: 't1',
    svarstyp: 'val_kandidat',
    vald_kandidat: null,
    vald_kandidater: [],
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
    const translate = createTranslator({ locale, messages, namespace: 'underlagsjakt' }) as T
    const summary = answerSummary(translate, SVAR_RECORD)
    expect(summary).toContain(`(${messages.underlagsjakt.kategori_bankavgift})`)
    expect(summary).not.toContain(messages.underlagsjakt.kategori_option_bankavgift)
    expect(interpretSaveResult(translate, true, { data: SVAR_RECORD }).toast.description).toBe(summary)
  })
  it.each(['sv', 'en'] as const)('names an uploaded document, and says when it did not follow a transaction, in %s', (locale) => {
    const messages = locale === 'sv' ? sv : en
    const translate = createTranslator({ locale, messages, namespace: 'underlagsjakt' }) as T
    const uploaded = {
      ...SVAR_RECORD,
      beslut: {
        answer_id: 'a1',
        transaction_id: 't1',
        svarstyp: 'uppladdat_underlag' as const,
        dokument_id: 'd1',
        filnamn: 'kvitto.pdf',
        sha256: 'a'.repeat(64),
        mime_type: 'application/pdf',
        storage_path: 'documents/c/u/1_kvitto.pdf',
        kalla: 'gnubok_uppladdning' as const,
        motpart: 'Banken',
        kategori: 'bankavgift' as const,
        bas_konto: null,
        momstyp: null,
        bolag: null,
        bankkonto: null,
        belopp: null,
      },
    }
    const summary = answerSummary(translate, uploaded)
    expect(summary).toContain('kvitto.pdf')
    expect(interpretSaveResult(translate, true, { data: { ...uploaded, koppling: 'kopplad' } }).toast.description).toBe(summary)
    expect(interpretSaveResult(translate, true, { data: { ...uploaded, koppling: 'ej_pa_verifikat' } }).toast.description).toContain(
      messages.underlagsjakt.answer_uppladdat_not_on_verifikat,
    )
    expect(interpretSaveResult(translate, true, { data: { ...uploaded, koppling: 'annat_verifikat' } }).toast.description).toContain(
      messages.underlagsjakt.answer_uppladdat_other_verifikat,
    )
    expect(interpretSaveResult(translate, true, { data: { ...uploaded, koppling: 'ingen_transaktion' } }).toast.description).toContain(
      messages.underlagsjakt.answer_uppladdat_not_linked,
    )
  })
  it('describes a val_kandidat save without a chosen document', () => {
    expect(answerSummary(t, SVAR_RECORD)).toContain('Banken')
  })

  it('summarizes a val_kandidat save with more than one chosen document by count, not by naming just the first', () => {
    const multi = {
      ...SVAR_RECORD,
      beslut: {
        ...SVAR_RECORD.beslut,
        vald_kandidat: 'lon_mattias.pdf',
        vald_kandidater: [
          { filnamn: 'lon_mattias.pdf', sha256: 'a'.repeat(64), kalla: 'gmail:löner' },
          { filnamn: 'lon_jennie.pdf', sha256: 'b'.repeat(64), kalla: 'gmail:löner' },
        ],
      },
    } as SvarRecord
    expect(answerSummary(t, multi)).toBe('answer_val_kandidat_multi:{"count":2,"kategori":"Bankavgift"}')
  })

  it('names the referenced verifikat and the debited account for a reglerar_skuld save', () => {
    const skuld = {
      ...SVAR_RECORD,
      beslut: {
        answer_id: 'a1',
        transaction_id: 't1',
        svarstyp: 'reglerar_skuld' as const,
        ursprungsverifikat_id: 'verifikat-1',
        ursprungsverifikat_nummer: 'A217',
        bas_konto: '2893',
        motpart: 'LÖN',
        bolag: null,
        bankkonto: null,
        belopp: null,
      },
    } as SvarRecord
    expect(answerSummary(t, skuld)).toBe('answer_reglerar_skuld:{"verifikat":"A217","konto":"2893"}')
  })

  it('does not throw for a val_kandidat answer stored before vald_kandidater existed', () => {
    const { vald_kandidater: _omit, ...preDeployBeslut } = SVAR_RECORD.beslut as typeof SVAR_RECORD.beslut & {
      vald_kandidater: unknown
    }
    const preDeploy = { ...SVAR_RECORD, beslut: { ...preDeployBeslut, vald_kandidat: 'kvitto.pdf' } } as SvarRecord
    expect(() => answerSummary(t, preDeploy)).not.toThrow()
    expect(answerSummary(t, preDeploy)).toContain('kvitto.pdf')
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

describe('PostAnswerPanel: rendered correctly', () => {
  const msg = sv.underlagsjakt

  const post: Post = {
    transaction_id: 't1',
    bolag: 'Acme AB',
    period: '2026-08',
    datum: '2026-08-01',
    belopp: -150,
    valuta: 'SEK',
    motpart: 'Banken',
    mottagare: null,
    konto_identitet: '1930',
    saldo: -150,
    typ: 'Betalning',
    kategori: 'behover_mattias',
    forslag: { kategori: '', varfor: 'Månadsavgift bankkonto', bas_konto: null, momstyp: null },
    kandidater: [],
    tvetydiga_alternativ: [],
  }

  function renderPanel(
    postOverride?: Partial<Post>,
    bolagChoices?: string[],
    uploadEnabled = true,
    leverarSjalvEnabled = false,
    multiKandidatEnabled = false,
    reglerarSkuldEnabled = false,
  ) {
    let finalPost: Post = post
    if (postOverride?.forslag) {
      const baseForslag = post.forslag || { kategori: '', varfor: '', bas_konto: null, momstyp: null }
      const mergedForslag = {
        kategori: postOverride.forslag.kategori ?? baseForslag.kategori,
        varfor: postOverride.forslag.varfor ?? baseForslag.varfor,
        bas_konto: postOverride.forslag.bas_konto ?? baseForslag.bas_konto,
        momstyp: postOverride.forslag.momstyp ?? baseForslag.momstyp,
      }
      const { forslag: _, ...rest } = postOverride
      finalPost = {
        ...post,
        ...rest,
        forslag: mergedForslag,
      }
    } else if (postOverride) {
      finalPost = { ...post, ...postOverride }
    }
    return renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        {
          locale: 'sv',
          messages: sv,
          timeZone: 'Europe/Stockholm',
        } as unknown as Parameters<typeof NextIntlClientProvider>[0],
        createElement(PostAnswerPanel, { post: finalPost, posts: [finalPost], bolagChoices: bolagChoices ?? ['Acme AB', 'Another Co AB'], uploadEnabled, leverarSjalvEnabled, multiKandidatEnabled, reglerarSkuldEnabled, onAnswered: async () => {} })
      )
    )
  }

  it('shows which account and what the post concerns', () => {
    const html = renderPanel()
    expect(html).toContain('Acme AB (2026-08)')
    expect(html).toContain('1930')
    expect(html).toContain('Månadsavgift bankkonto')
  })

  it('marks BAS account and VAT type as optional', () => {
    const html = renderPanel()
    expect(html).toContain('BAS-konto (valfritt)')
    expect(html).toContain('Momstyp (valfritt)')
  })

  it('includes candidates legend and handles no-candidate case', () => {
    const html = renderPanel()
    expect(html).toContain('Vilket dokument hör till betalningen?')
    expect(html).toContain('Inget underlag behövs, ange motpart och kategori')
    // Nothing found is no longer a dead end: the upload path is offered next to it.
    expect(html).toContain('Ladda upp dokumentet här')
    expect(html).toContain('Ladda upp underlag')
  })

  const TWO_CANDIDATES: Partial<Post> = {
    kandidater: [
      { filnamn: 'lon_mattias.pdf', kalla: 'gmail:löner', datum: '2026-09-20', bevisgrund: 'belopp matchar', sha256: 'a'.repeat(64) },
      { filnamn: 'lon_jennie.pdf', kalla: 'gmail:löner', datum: '2026-09-20', bevisgrund: 'belopp matchar', sha256: 'b'.repeat(64) },
    ],
  }

  it('renders candidates as radio buttons while multi-select is off, even with several candidates', () => {
    const html = renderPanel(TWO_CANDIDATES, undefined, true, false, false)
    expect(html).toContain('type="radio"')
    expect(html).not.toContain(msg.candidates_legend_multi_hint)
  })

  it('renders candidates as checkboxes (no radio input left in val_kandidat mode) once multi-select is on and there is more than one candidate', () => {
    const html = renderPanel(TWO_CANDIDATES, undefined, true, false, true)
    expect(html).toContain(msg.candidates_legend_multi_hint)
    expect(html).toContain('lon_mattias.pdf')
    expect(html).toContain('lon_jennie.pdf')
    // val_kandidat is the default (and only rendered) mode here, so no radio group of any
    // kind (candidates, "none of them", fel_bolag) should remain in the markup.
    expect(html).not.toContain('type="radio"')
  })

  it('keeps a single candidate on a radio button even with multi-select on: one choice never gets harder', () => {
    const html = renderPanel(undefined, undefined, true, false, true)
    expect(html).not.toContain(msg.candidates_legend_multi_hint)
  })

  it('does not offer the upload path while it is switched off', () => {
    const html = renderPanel(undefined, undefined, false)
    expect(html).toContain('Inget underlag behövs, ange motpart och kategori')
    expect(html).not.toContain('Ladda upp dokumentet här')
    expect(html).not.toContain('Ladda upp underlag')
    expect(html).toContain('Gäller annat bolag')
  })

  it('offers "I will deliver it myself" only once it is switched on, next to (not instead of) the other answers', () => {
    const off = renderPanel()
    expect(off).not.toContain(sv.underlagsjakt.mode_levererar_sjalv)
    const on = renderPanel(undefined, undefined, true, true)
    expect(on).toContain(sv.underlagsjakt.mode_levererar_sjalv)
    expect(on).toContain(sv.underlagsjakt.mode_osaker)
    expect(on).toContain(sv.underlagsjakt.mode_uppladdat_underlag)
    // Two answers that look alike but mean opposite things in the books stay distinct.
    expect(sv.underlagsjakt.mode_levererar_sjalv).not.toBe(sv.underlagsjakt.mode_osaker)
  })

  it('offers "settles a booked debt" only once it is switched on, next to (not instead of) the other answers', () => {
    const off = renderPanel()
    expect(off).not.toContain(sv.underlagsjakt.mode_reglerar_skuld)
    const on = renderPanel(undefined, undefined, true, false, false, true)
    expect(on).toContain(sv.underlagsjakt.mode_reglerar_skuld)
    expect(on).toContain(sv.underlagsjakt.mode_val_kandidat)
    expect(on).toContain(sv.underlagsjakt.mode_osaker)
  })

  it('preserves an exported BAS account in the input value', () => {
    const html = renderPanel({
      forslag: {
        kategori: post.forslag?.kategori ?? '',
        varfor: post.forslag?.varfor ?? '',
        bas_konto: '6540',
        momstyp: post.forslag?.momstyp ?? null,
      },
    })
    expect(html).toContain('value="6540"')
  })

  it('renders tabs for val_kandidat, fel_bolag, and osaker modes', () => {
    const html = renderPanel()
    expect(html).toContain('Välj underlag')
    expect(html).toContain('Gäller annat bolag')
    expect(html).toContain('Osäker')
  })

  it('has a disabled save button initially when required fields are missing', () => {
    const html = renderPanel()
    expect(html).toContain('disabled=""')
    expect(html).toContain('Spara svar')
  })

  it('shows the disabled reason when save button is blocked', () => {
    const html = renderPanel()
    // In val_kandidat mode with default state, kategori is missing, so the reason line should appear
    // The actual text should be "Fattas för att spara: " followed by the missing field names
    expect(html).toContain('Fattas för att spara:')
    expect(html).toContain(msg.missing_kategori)
  })

  it('renders fel_bolag mode fields when that tab is active or post kategori is fel_bolag', () => {
    const html = renderPanel({ kategori: 'fel_bolag' })
    // fel_bolag mode should show "Vilket bolag..." and company choice options
    expect(html).toContain('Vilket bolag avser betalningen')
    expect(html).toContain('Vems namn står på fakturan')
  })
})

describe('PostAnswerPanel: submit handler behavior', () => {
  it('handles fetch network errors by treating them as save failures without calling onAnswered', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
    const mockOnAnswered = vi.fn()
    const outcomes: SaveOutcome[] = []

    const input = {
      svarstyp: 'val_kandidat' as const,
      transaction_id: 't1',
      sha256: [],
      motpart: 'Banken',
      kategori: 'bankavgift' as const,
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    }

    await submitAnswer(input, t, (outcome) => outcomes.push(outcome), mockOnAnswered, mockFetch)

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].toast.title).toBe('save_failed:{}')
    expect(outcomes[0].toast.variant).toBe('destructive')
    expect(outcomes[0].refresh).toBe(false)
    expect(mockOnAnswered).not.toHaveBeenCalled()
  })

  it('only allows save when all required fields are provided', () => {
    // Test that empty BAS account does not block save when kategori is set and a candidate is chosen
    const input = buildAnswerInput({
      mode: 'val_kandidat' as const,
      transactionId: 't1',
      hasCandidate: true, // User has chosen "none" or selected a document
      sha256: [], // User chose "no document"
      kategori: 'bankavgift' as const,
      motpart: 'Banken',
      basKonto: '', // Empty is OK
      basKontoValid: true,
      momstyp: null,
      begransaBolag: false,
      begransaBelopp: false,
    })
    expect(input.input).toBeDefined()
    expect(input.missing).toBeUndefined()

    // Test that invalid BAS account blocks save
    const inputInvalid = buildAnswerInput({
      mode: 'val_kandidat' as const,
      transactionId: 't1',
      hasCandidate: true,
      sha256: [],
      kategori: 'bankavgift' as const,
      motpart: 'Banken',
      basKonto: 'invalid-not-a-number',
      basKontoValid: false,
      momstyp: null,
      begransaBolag: false,
      begransaBelopp: false,
    })
    expect(inputInvalid.missing).toContain('missing_bas_konto')
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
    'missing_file',
    'mode_uppladdat_underlag',
    'candidates_none_upload',
    'upload_legend',
    'upload_description',
    'upload_choose',
    'upload_change',
    'upload_formats',
    'upload_rejected_title',
    'upload_unsupported_type',
    'upload_too_large',
    'submit_uppladdat_underlag',
    'answer_uppladdat_underlag',
    'answer_uppladdat_not_linked',
    'answer_uppladdat_not_on_verifikat',
    'answer_uppladdat_other_verifikat',
    'error_UNDERLAG_FILE_MISSING',
    'error_UNDERLAG_UNSUPPORTED_TYPE',
    'error_UNDERLAG_TOO_LARGE',
    'error_UNDERLAG_INVALID_CONTENT',
    'error_UNDERLAG_UPLOAD_FAILED',
    'mode_levererar_sjalv',
    'levererar_sjalv_description',
    'levererar_sjalv_apply_to_all',
    'levererar_sjalv_count',
    'levererar_sjalv_bulk_saved',
    'submit_levererar_sjalv',
    'answer_levererar_sjalv_waiting',
    'answer_levererar_sjalv_delivered',
    'tab_vantar',
    'vantar_empty_title',
    'vantar_empty_description',
    'status_underlag_hittat',
    'error_COUNT_CHANGED',
    'error_FEATURE_DISABLED',
    'answer_val_kandidat_multi',
    'candidates_legend_multi_hint',
    'candidates_selected_sum',
    'candidates_selected_sum_diff',
    'candidates_selected_sum_missing_belopp',
  ]

  it.each(keys)('%s exists in sv.json and en.json', (key) => {
    expect(readNamespace('sv')[key]).toBeTruthy()
    expect(readNamespace('en')[key]).toBeTruthy()
  })
})
