import { describe, it, expect } from 'vitest'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import type { Kategori } from '../lib/contract'
import { looksLikeReferenceNumber, suggestBasKonto } from '../lib/account-suggestion'

describe('suggestBasKonto', () => {
  it('suggests Bankavgifter for bankavgift regardless of what motpart says (the Mattias case)', () => {
    // 2026-08-04, -130 kr, motpart is a reference number, konto SEB Företagskonto, typ Annan.
    expect(suggestBasKonto('bankavgift', '100004305786', -130)).toBe('6570')
  })

  it('never lets a stray motpart keyword override the kategori-specific account', () => {
    // "Google" collides with the it_saas templates' keywords, but bankavgift already answers the question.
    expect(suggestBasKonto('bankavgift', 'Google Pay avgift', -19)).toBe('6570')
  })

  it('picks interest income vs expense by the sign of belopp', () => {
    expect(suggestBasKonto('ranta', 'Sparränta', 42)).toBe('8310')
    expect(suggestBasKonto('ranta', 'Låneränta', -42)).toBe('8410')
  })

  it('suggests the loan repayment account by direction', () => {
    expect(suggestBasKonto('lan', 'Amortering billån', -3000)).toBe('2350')
    // No template for receiving loan proceeds: no confident default either way.
    expect(suggestBasKonto('lan', 'Nytt lån utbetalt', 50000)).toBeNull()
  })

  it('never suggests an entity-specific account for lon: personnel_salary is aktiebolag-only and this module has no way to know the company is one', () => {
    expect(suggestBasKonto('lon', 'Löneutbetalning', -25000)).toBeNull()
  })

  it('never lets a keyword reach an entity-specific template (F2): a wrong EF/AB-only account would become a learned rule', () => {
    // "privat" matches private_withdrawal_ef (EF-only, skipped) and
    // private_expense (entity_applicability 'all', but its debit account is
    // 2013 for EF and 2893 for AB via debit_account_ab: this module has no
    // entity-type signal, so it must be skipped too rather than guessing EF).
    expect(suggestBasKonto('utlagg', 'Privat utlägg', -500)).toBeNull()
    // "tillskott" only collides with EF-only private_deposit_ef and AB-only
    // shareholder_loan_received: both are skipped and nothing else matches.
    expect(suggestBasKonto('intern_overforing', 'Tillskott från ägare', 60000)).toBeNull()
  })

  it('never suggests an AB-variant account for a nominally entity-neutral template (F2)', () => {
    // education_course is entity_applicability 'all' but debit_account_ab
    // (7610) differs from debit_account (6991): without an entity-type
    // signal, resolving to either would risk being wrong for the other form.
    expect(suggestBasKonto('leverantor', 'Udemy', -1500)).toBeNull()
  })

  it('suggests the tax account only for outgoing payments', () => {
    expect(suggestBasKonto('skatt', 'Skatteverket', -3120)).toBe('1630')
    expect(suggestBasKonto('skatt', 'Skatteåterbäring', 3120)).toBeNull()
  })

  it('falls back to a motpart keyword match for categories with no fixed account', () => {
    expect(suggestBasKonto('leverantor', 'GOOGLE*WORKSPACE', -299)).toBe('5420')
  })

  it('never suggests a revenue account for a positive belopp under leverantor/utlagg/intern_overforing (F1): a refund or repayment on an expense-shaped category is not sales income', () => {
    // "taxi" collides with revenue_reduced_6's keywords; a positive amount
    // under utlagg is a reimbursement, not ticket sales income.
    expect(suggestBasKonto('utlagg', 'Taxi Stockholm', 450)).toBeNull()
    // "faktura" collides with revenue_standard_25's keywords.
    expect(suggestBasKonto('leverantor', 'Faktura 4456', 4456)).toBeNull()
    expect(suggestBasKonto('intern_overforing', 'Konsultfaktura', 1000)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(suggestBasKonto('leverantor', '100004305786', -500)).toBeNull()
    expect(suggestBasKonto('utlagg', '', -500)).toBeNull()
    expect(suggestBasKonto('intern_overforing', 'Överföring mellan egna konton', -1000)).toBeNull()
  })
})

describe('display names for kategori-template suggestions', () => {
  it('has a display name for every account the kategori-template suggester path can reach', () => {
    // account-suggestion.ts's KATEGORI_TEMPLATE_IDS path (bankavgift/ranta/lan/skatt) skips
    // the AB-override and 1930 checks the keyword path applies, so it is exercised directly
    // here via suggestBasKonto rather than re-derived, to actually cover that branch.
    const kategorier: Array<[Kategori, number]> = [
      ['bankavgift', -100],
      ['bankavgift', 100],
      ['ranta', -100],
      ['ranta', 100],
      ['lan', -100],
      ['lan', 100],
      ['skatt', -100],
      ['skatt', 100],
    ]
    const unnamed = kategorier
      .map(([kategori, belopp]) => suggestBasKonto(kategori, 'test', belopp))
      .filter((account): account is string => account !== null)
      .filter((account) => formatAccountWithName(account) === account)
    expect(unnamed).toEqual([])
  })
})

describe('looksLikeReferenceNumber', () => {
  it('recognizes long all-digit motpart strings as reference numbers', () => {
    expect(looksLikeReferenceNumber('100004305786')).toBe(true)
    expect(looksLikeReferenceNumber('  100003645765  ')).toBe(true)
  })

  it('does not flag short numbers or names', () => {
    expect(looksLikeReferenceNumber('12345')).toBe(false)
    expect(looksLikeReferenceNumber('GOOGLE*WORKSPACE')).toBe(false)
    expect(looksLikeReferenceNumber('SEB Företagskonto')).toBe(false)
    expect(looksLikeReferenceNumber('')).toBe(false)
  })
})
