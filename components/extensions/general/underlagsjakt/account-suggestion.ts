import { findMatchingTemplates, getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { getDefaultAccountForCategory } from '@/lib/bookkeeping/category-mapping'
import { accountClass } from '@/lib/invariants/account-number'
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

/** The lines of a referenced verifikat, as much as suggesting a skuldkonto needs. */
export interface VerifikatLineForSuggestion {
  account_number: string
}

/**
 * Suggest which liability account a `reglerar_skuld` answer should debit,
 * read from the referenced verifikat's own lines: the BAS class 2 accounts
 * already posted there. Never from the cost templates above (this payment is
 * not a cost, the cost was booked once already, when the debt was) and never
 * a hardcoded account list: every company's real skuldkonton differ, so the
 * only trustworthy source is the verifikat the user themselves pointed at
 * (task 1482). Usually one match; more than one (e.g. a verifikat crediting
 * both 2893 and 2990) is left for the user to pick between.
 */
export function suggestSkuldkontoFromVerifikat(lines: VerifikatLineForSuggestion[]): string[] {
  return [...new Set(lines.map((l) => l.account_number).filter((n) => accountClass(n) === 2))]
}
