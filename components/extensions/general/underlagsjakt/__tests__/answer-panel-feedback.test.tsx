/**
 * @vitest-environment jsdom
 */
import { createTranslator } from 'next-intl'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach, type Mock } from 'vitest'
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fs from 'node:fs'
import path from 'node:path'
import { Toaster } from '@/components/ui/toaster'
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

describe('PostAnswerPanel: rendered and clicked in jsdom', () => {
  const SVAR_URL = '/api/extensions/ext/underlagsjakt/svar'
  const msg = sv.underlagsjakt
  const svT = createTranslator({ locale: 'sv', messages: sv, namespace: 'underlagsjakt' }) as T

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
    // No preselected kategori and no exported BAS account: the person has to choose.
    forslag: { kategori: '', varfor: 'Månadsavgift bankkonto', bas_konto: null, momstyp: null },
    kandidater: [],
    tvetydiga_alternativ: [],
  }

  const stubbed = ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture', 'scrollIntoView'] as const
  const original = Object.fromEntries(stubbed.map((k) => [k, Element.prototype[k]]))

  beforeAll(() => {
    // jsdom implements none of these; Radix Select calls them when it opens.
    Element.prototype.hasPointerCapture = () => false
    Element.prototype.setPointerCapture = () => {}
    Element.prototype.releasePointerCapture = () => {}
    Element.prototype.scrollIntoView = () => {}
  })

  afterAll(() => {
    Object.assign(Element.prototype, original)
  })

  let fetchMock: ReturnType<typeof vi.fn>
  let onAnswered: Mock<() => Promise<void>>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: SVAR_RECORD }) })
    vi.stubGlobal('fetch', fetchMock)
    onAnswered = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderPanel() {
    return render(
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <PostAnswerPanel post={post} bolagChoices={['Acme AB', 'Another Co AB']} onAnswered={onAnswered} />
        <Toaster />
      </NextIntlClientProvider>,
    )
  }

  const saveButton = () => screen.getByRole('button', { name: msg.submit }) as HTMLButtonElement
  const reasonLine = () => screen.getByText(/Fattas för att spara|Redo att spara/)
  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string)

  async function chooseKategori(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('combobox', { name: msg.field_kategori }))
    await user.click(await screen.findByRole('option', { name: /^Bankavgift/ }))
  }

  /** A val_kandidat answer without a document: what a person does when there is none to pick. */
  async function fillVal(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByLabelText(msg.candidate_none_needed))
    await chooseKategori(user)
  }

  const clearBas = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.clear(screen.getByLabelText(new RegExp(msg.field_bas_konto)))
  }

  async function startFelBolag(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('tab', { name: msg.mode_fel_bolag }))
  }

  it('shows which account and what the post concerns', () => {
    renderPanel()
    const fact = (label: string) => screen.getByText(label).nextElementSibling?.textContent
    expect(fact(msg.fact_company)).toBe('Acme AB (2026-08)')
    expect(fact(msg.fact_account)).toBe('1930')
    expect(fact(msg.fact_what)).toBe('Månadsavgift bankkonto')
  })

  it('starts blocked, and the reason line names what is missing', () => {
    renderPanel()
    expect(saveButton().disabled).toBe(true)
    expect(reasonLine().textContent).toBe(
      msg.save_disabled_reason.replace('{fields}', `${msg.missing_candidate}, ${msg.missing_kategori}`),
    )
  })

  it('lets a kategori with an EMPTY BAS account be saved, and the request goes out', async () => {
    const user = userEvent.setup()
    renderPanel()
    await fillVal(user)
    await clearBas(user)

    expect((screen.getByLabelText(new RegExp(msg.field_bas_konto)) as HTMLInputElement).value).toBe('')
    expect(saveButton().disabled).toBe(false)
    expect(reasonLine().textContent).toBe(msg.save_ready)

    await user.click(saveButton())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe(SVAR_URL)
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(sentBody()).toMatchObject({ transaction_id: 't1', svarstyp: 'val_kandidat', kategori: 'bankavgift', bas_konto: null })
  })

  it('blocks save on an invalid BAS account and the reason line says why', async () => {
    const user = userEvent.setup()
    renderPanel()
    await fillVal(user)
    await clearBas(user)
    await user.type(screen.getByLabelText(new RegExp(msg.field_bas_konto)), '12a')

    expect(saveButton().disabled).toBe(true)
    expect(reasonLine().textContent).toBe(msg.save_disabled_reason.replace('{fields}', msg.missing_bas_konto))
    expect(screen.getByText(msg.field_bas_konto_invalid)).toBeTruthy()

    await user.click(saveButton())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends transaction_id, decision, kategori and the chosen fields to /svar', async () => {
    const user = userEvent.setup()
    renderPanel()
    await fillVal(user)
    await clearBas(user)
    await user.type(screen.getByLabelText(new RegExp(msg.field_bas_konto)), '6570')
    await user.click(screen.getByRole('checkbox', { name: msg.restrict_bolag.replace('{bolag}', 'Acme AB') }))
    await user.click(saveButton())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe(SVAR_URL)
    expect(sentBody()).toEqual({
      svarstyp: 'val_kandidat',
      transaction_id: 't1',
      sha256: null,
      motpart: 'Banken',
      kategori: 'bankavgift',
      bas_konto: '6570',
      momstyp: null,
      begransa_bolag: true,
      begransa_belopp: false,
    })
  })

  it('shows the confirmation after a successful save, and refreshes the list', async () => {
    const user = userEvent.setup()
    renderPanel()
    await fillVal(user)
    await user.click(saveButton())

    expect(await screen.findByText(msg.save_success)).toBeTruthy()
    expect(screen.getByText(answerSummary(svT, SVAR_RECORD))).toBeTruthy()
    expect(onAnswered).toHaveBeenCalledTimes(1)
  })

  it('shows a failure instead of a confirmation when the save is rejected', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: { code: 'ALREADY_DELIVERED' } }) })
    const user = userEvent.setup()
    renderPanel()
    await fillVal(user)
    await user.click(saveButton())

    expect(await screen.findByText(msg.save_failed)).toBeTruthy()
    expect(screen.queryByText(msg.save_success)).toBeNull()
    expect(onAnswered).not.toHaveBeenCalled()
  })

  it('fel_bolag: another company, named, invoice holder and settlement chosen', async () => {
    const user = userEvent.setup()
    renderPanel()
    await startFelBolag(user)

    await user.click(screen.getByLabelText(msg.fel_bolag_external))
    // The external company has to be named before the answer is complete.
    expect(reasonLine().textContent).toContain(msg.missing_external_bolag_namn)
    await user.type(screen.getByLabelText(msg.fel_bolag_external_name), 'Externa Bolaget AB')
    await user.click(screen.getByLabelText('Acme AB (betalaren)'))
    expect(saveButton().disabled).toBe(true)
    expect(reasonLine().textContent).toBe(msg.save_disabled_reason.replace('{fields}', msg.missing_reglering))
    await user.click(screen.getByLabelText(msg.reglering_vidarefakturera))
    expect(saveButton().disabled).toBe(false)

    await user.click(saveButton())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe(SVAR_URL)
    expect(sentBody()).toEqual({
      svarstyp: 'fel_bolag',
      transaction_id: 't1',
      till_bolag: 'Externa Bolaget AB',
      fel_bolag_mottagare: 'Acme AB',
      reglering: 'vidarefakturera',
    })
  })

  it('fel_bolag: one of the other own companies, invoiced to that company', async () => {
    const user = userEvent.setup()
    renderPanel()
    await startFelBolag(user)

    await user.click(screen.getByLabelText('Another Co AB'))
    // The company now also appears as an invoice holder option, after the "which company" one.
    await user.click(screen.getAllByLabelText('Another Co AB')[1])
    await user.click(screen.getByLabelText(msg.reglering_mellanhavande))
    await user.click(saveButton())

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(sentBody()).toEqual({
      svarstyp: 'fel_bolag',
      transaction_id: 't1',
      till_bolag: 'Another Co AB',
      fel_bolag_mottagare: 'Another Co AB',
      reglering: 'mellanhavande',
    })
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
