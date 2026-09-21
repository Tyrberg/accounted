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
  submitAnswer,
  type SaveOutcome,
  type T,
} from '../shared'
import type { Post } from '@/extensions/general/underlagsjakt/lib/contract'
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

  function renderPanel(postOverride?: Partial<Post>, bolagChoices?: string[]) {
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
        createElement(PostAnswerPanel, { post: finalPost, bolagChoices: bolagChoices ?? ['Acme AB', 'Another Co AB'], openPosts: [], onAnswered: async () => {} })
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
    expect(html).toContain('Inget dokument, ange motpart och kategori')
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
      sha256: null,
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
      sha256: null, // User chose "no document"
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
      sha256: null,
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
  ]

  it.each(keys)('%s exists in sv.json and en.json', (key) => {
    expect(readNamespace('sv')[key]).toBeTruthy()
    expect(readNamespace('en')[key]).toBeTruthy()
  })
})
