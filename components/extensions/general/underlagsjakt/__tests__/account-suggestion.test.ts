import { describe, expect, it } from 'vitest'
import { findMatchingTemplates, getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { getDefaultAccountForCategory } from '@/lib/bookkeeping/category-mapping'
import { makeTransaction } from '@/tests/helpers'
import { suggestAnswerAccount, suggestSkuldkontoFromVerifikat } from '../account-suggestion'

describe('answer account suggestions from core templates', () => {
  it('uses the bank fee template for fees and refunds', () => {
    for (const amount of [-100, 100]) {
      expect(suggestAnswerAccount('bankavgift', amount, 'SEB')).toBe(getTemplateById('bank_fees')!.debit_account)
    }
  })
  it('distinguishes interest received from interest paid', () => {
    expect(suggestAnswerAccount('ranta', -100, '')).toBe(getTemplateById('bank_interest_expense')!.debit_account)
    expect(suggestAnswerAccount('ranta', 100, '')).toBe(getTemplateById('bank_interest_income')!.credit_account)
  })
  it('reuses supplier template matching and the core fallback', () => {
    expect(suggestAnswerAccount('leverantor', -100, 'bredband')).toBe('6230')
    expect(suggestAnswerAccount('leverantor', -100, 'Unknown supplier')).toBe(getDefaultAccountForCategory('expense_other'))
  })
  it.each(['GOOGLE*WORKSPACE', 'MOANK AVIZION', 'SEB MÅNADSAVG', 'Överföring via internet GOOGLE*WORKSPACE'])(
    'uses the core ranked match for %s', (motpart) => {
      const matches = findMatchingTemplates(makeTransaction({ amount: -100, description: motpart, merchant_name: motpart, mcc_code: null }))
      const match = matches.find(({ template }) => template.entity_applicability === 'all'
        && !template.debit_account_ab && !template.credit_account_ab)
      expect(suggestAnswerAccount('leverantor', -100, motpart)).toBe(
        match?.template.debit_account ?? getDefaultAccountForCategory('expense_other'),
      )
    },
  )
  it('uses the existing repayment template', () => {
    expect(suggestAnswerAccount('lan', -100, '')).toBe(getTemplateById('financial_loan_repayment')!.debit_account)
  })
  it('does not invent accounts when the export lacks the necessary context', () => {
    for (const kategori of ['lon', 'utlagg', 'intern_overforing', 'skatt', undefined] as const) {
      expect(suggestAnswerAccount(kategori, -100, 'SEB')).toBe('')
    }
    expect(suggestAnswerAccount('lan', 100, '')).toBe('')
    expect(suggestAnswerAccount('bankavgift', 0, '')).toBe('')
  })
})

describe('suggestSkuldkontoFromVerifikat', () => {
  it('reads the liability account out of the referenced verifikat, e.g. an avräkningskonto like 2893', () => {
    // Mattias's own booking pattern (Tyrberg Group AB, task 1482): 7210 debit / 2893 credit.
    expect(
      suggestSkuldkontoFromVerifikat([
        { account_number: '7210' },
        { account_number: '2893' },
      ]),
    ).toEqual(['2893'])
  })
  it('does not hardcode an account list: whatever BAS class 2 account the verifikat carries is suggested', () => {
    expect(suggestSkuldkontoFromVerifikat([{ account_number: '1930' }, { account_number: '2840' }])).toEqual(['2840'])
  })
  it('returns every class 2 candidate, deduplicated, when a verifikat carries more than one', () => {
    expect(
      suggestSkuldkontoFromVerifikat([
        { account_number: '2893' },
        { account_number: '2990' },
        { account_number: '2893' },
      ]),
    ).toEqual(['2893', '2990'])
  })
  it('returns nothing for a verifikat with no BAS class 2 line', () => {
    expect(suggestSkuldkontoFromVerifikat([{ account_number: '1930' }, { account_number: '7210' }])).toEqual([])
  })
})
