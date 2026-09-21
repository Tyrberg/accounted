import { findMatchingTemplates, getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { getDefaultAccountForCategory } from '@/lib/bookkeeping/category-mapping'
import type { Transaction } from '@/types'
import type { Kategori } from '@/extensions/general/underlagsjakt/lib/contract'

/** Translate the export vocabulary to core templates, never to a separate account chart. */
export function suggestAnswerAccount(kategori: Kategori | undefined, amount: number, motpart: string): string {
  if (!kategori || amount === 0) return ''
  if (kategori === 'leverantor') {
    // The export has no entity type. Only use entity-independent matches.
    const match = findMatchingTemplates({
      amount, description: motpart, merchant_name: motpart, mcc_code: null,
    } as Transaction).find(({ template }) => template.entity_applicability === 'all'
      && !template.debit_account_ab && !template.credit_account_ab)
    if (!match) return getDefaultAccountForCategory('expense_other')
    return match.template.direction === 'income' ? match.template.credit_account : match.template.debit_account
  }
  const templateId = {
    bankavgift: 'bank_fees',
    ranta: amount > 0 ? 'bank_interest_income' : 'bank_interest_expense',
    lon: undefined,
    lan: amount < 0 ? 'financial_loan_repayment' : undefined,
    skatt: undefined,
    utlagg: undefined,
    intern_overforing: undefined,
  }[kategori]
  // These broader categories require company/account context absent from the export.
  if (!templateId) return ''
  const template = getTemplateById(templateId)
  if (!template) return ''
  return template.direction === 'income' ? template.credit_account : template.debit_account
}
