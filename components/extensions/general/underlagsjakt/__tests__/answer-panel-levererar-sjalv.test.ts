import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider, createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import fixture from '@/extensions/general/underlagsjakt/__tests__/fixtures/export-1.4.json'
import type { Post } from '@/extensions/general/underlagsjakt/lib/contract'
import type { SvarRecord } from '@/extensions/general/underlagsjakt/lib/store'
import { LevererarSjalvFields, PostAnswerPanel } from '../PostAnswerPanel'
import { answerSummary, buildAnswerInput, interpretSaveResult, type AnswerFormState, type T } from '../shared'

const BASE: AnswerFormState = {
  mode: 'levererar_sjalv',
  transactionId: 't1',
  hasCandidate: false,
  sha256: null,
  motpart: 'HI3G ACCESS AB',
  basKonto: '',
  basKontoValid: true,
  momstyp: null,
  begransaBolag: false,
  begransaBelopp: false,
}

const translator = (locale: 'sv' | 'en') =>
  createTranslator({ locale, messages: locale === 'sv' ? sv : en, namespace: 'underlagsjakt' }) as T

const provider = (locale: 'sv' | 'en', child: ReturnType<typeof createElement>) =>
  createElement(
    NextIntlClientProvider,
    { locale, messages: locale === 'sv' ? sv : en, timeZone: 'Europe/Stockholm' } as unknown as Parameters<
      typeof NextIntlClientProvider
    >[0],
    child,
  )

function fields(locale: 'sv' | 'en', gallerAlla: boolean, berordaAntal: number) {
  return renderToStaticMarkup(
    provider(
      locale,
      createElement(LevererarSjalvFields, {
        idSuffix: 't1',
        motpart: 'HI3G ACCESS AB',
        onMotpartChange: () => {},
        fallbackMotpart: 'HI3G ACCESS AB',
        gallerAlla,
        onGallerAllaChange: () => {},
        berordaAntal,
      }),
    ),
  )
}

describe('buildAnswerInput: levererar_sjalv', () => {
  it('needs only a counterparty: no candidate, category or account', () => {
    expect(buildAnswerInput({ ...BASE, motpart: ' ' })).toEqual({ missing: ['missing_motpart'] })
    expect(buildAnswerInput(BASE)).toEqual({
      input: {
        svarstyp: 'levererar_sjalv',
        transaction_id: 't1',
        motpart: 'HI3G ACCESS AB',
        galler_alla: false,
        bekrafta_antal: null,
      },
    })
  })

  it('a bulk answer carries the count the user was shown', () => {
    const result = buildAnswerInput({ ...BASE, gallerAlla: true, berordaAntal: 7 })
    expect(result.input).toMatchObject({ galler_alla: true, bekrafta_antal: 7 })
  })
})

describe('the levererar_sjalv fields', () => {
  it.each(['sv', 'en'] as const)('shows how many posts a bulk answer removes, in %s', (locale) => {
    const messages = locale === 'sv' ? sv : en
    const html = fields(locale, true, 7)
    const expected = translator(locale)('levererar_sjalv_antal', { count: 7 })
    expect(expected).toContain('7')
    expect(html).toContain(expected)
    expect(html).toContain(translator(locale)('levererar_sjalv_alla', { motpart: 'HI3G ACCESS AB' }))
    expect(html).toContain(messages.underlagsjakt.levererar_sjalv_not_no_document)
  })

  it('shows no count until the bulk tick is set', () => {
    const html = fields('sv', false, 7)
    expect(html).not.toContain(translator('sv')('levererar_sjalv_antal', { count: 7 }))
  })

  it('reports a single affected post as one, not as a bulk', () => {
    expect(translator('sv')('levererar_sjalv_antal', { count: 1 })).toContain('1 post')
  })

  it('states that one document is never linked to several payments', () => {
    expect(fields('sv', true, 3)).toContain(sv.underlagsjakt.levererar_sjalv_one_document_per_payment)
  })
})

describe('the mode is offered next to, and worded apart from, "no document needed"', () => {
  it.each(['sv', 'en'] as const)('lists the mode in the panel in %s', (locale) => {
    const post: Post = { ...fixture.sammanstallningar[0].posts[2], kategori: 'behover_mattias' } as Post
    const html = renderToStaticMarkup(
      provider(locale, createElement(PostAnswerPanel, { post, bolagChoices: [], openPosts: [post], onAnswered: async () => {} })),
    )
    const messages = locale === 'sv' ? sv : en
    expect(html).toContain(messages.underlagsjakt.mode_levererar_sjalv)
    expect(html).toContain(messages.underlagsjakt.candidate_none_needed)
    expect(messages.underlagsjakt.mode_levererar_sjalv).not.toBe(messages.underlagsjakt.candidate_none_needed)
  })
})

describe('answer summary and save toast', () => {
  const record = (galler_alla: boolean): SvarRecord => ({
    beslut: {
      answer_id: 'a',
      transaction_id: 't1',
      svarstyp: 'levererar_sjalv',
      motpart: 'HI3G ACCESS AB',
      galler_alla,
      bolag: null,
      bankkonto: null,
      belopp: null,
    },
    reglering: null,
    post: {
      bolag: 'Acme AB',
      period: '2026-08',
      datum: '2026-08-01',
      belopp: -499,
      valuta: 'SEK',
      motpart: 'HI3G ACCESS AB',
      konto_identitet: 'SEB',
      typ: 'Autogiro',
    },
    besvarad_at: '2026-09-21T10:00:00.000Z',
    besvarad_av: 'user-1',
    answer_id: 'a',
    erbjudet_at: null,
    levererad_at: null,
  })

  it.each(['sv', 'en'] as const)('names the promise and the scope in %s', (locale) => {
    const tr = translator(locale)
    expect(answerSummary(tr, record(false))).toContain('HI3G ACCESS AB')
    expect(answerSummary(tr, record(true))).not.toBe(answerSummary(tr, record(false)))
  })

  it('a bulk save says how many posts it moved; a single save does not', () => {
    const tr = translator('sv')
    const bulk = interpretSaveResult(tr, true, { data: record(true), antal: 4 })
    expect(bulk.toast.description).toContain(tr('save_bulk_moved', { count: 4 }))
    expect(interpretSaveResult(tr, true, { data: record(false) }).toast.description).toBe(
      answerSummary(tr, record(false)),
    )
  })

  it('explains a stale count in plain language', () => {
    const tr = translator('sv')
    expect(interpretSaveResult(tr, false, { error: { code: 'COUNT_CHANGED' } }).toast.description).toBe(
      sv.underlagsjakt.error_COUNT_CHANGED,
    )
  })
})

describe('translations for the new svarstyp and waiting list', () => {
  const svNs = sv.underlagsjakt as Record<string, string>
  const enNs = en.underlagsjakt as Record<string, string>
  const keys = Object.keys(svNs).filter((k) => /levererar_sjalv|vantar|tab_vantar|col_promised|col_waiting|COUNT_CHANGED|bulk/.test(k))

  it('has a non-empty sv and en string for every key, with the same ICU arguments', () => {
    expect(keys.length).toBeGreaterThanOrEqual(15)
    const args = (s: string) => ['count', 'days', 'motpart'].filter((a) => s.includes(`{${a}`))
    for (const key of keys) {
      expect(svNs[key], key).toBeTruthy()
      expect(enNs[key], key).toBeTruthy()
      expect(args(enNs[key]), key).toEqual(args(svNs[key]))
    }
  })

  it('uses no em or en dashes and no transliterated Swedish in the new copy', () => {
    for (const key of keys) {
      expect(svNs[key] + enNs[key]).not.toMatch(/[\u2013\u2014]/)
    }
    expect(svNs.tab_vantar).toBe('Väntar på underlag')
    expect(svNs.vantar_empty_title).toBe('Inget väntar på dig')
  })
})
