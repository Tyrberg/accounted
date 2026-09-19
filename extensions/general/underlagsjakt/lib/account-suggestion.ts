/**
 * Suggests a BAS account for a val_kandidat answer so the owner never has to
 * know a BAS account number to answer bertil: the kategori they already
 * picked (in plain Swedish) plus the counterparty text is enough.
 *
 * Every suggestion resolves through lib/bookkeeping/booking-templates.ts, the
 * same template data the categorization UI uses elsewhere: this never
 * invents an account number of its own.
 */
import { BOOKING_TEMPLATES, getTemplateById, stripBankNoise, type BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import type { Kategori } from './contract'

/**
 * Categories where the kategori choice alone reliably implies one BAS
 * account, by amount direction. Left out on purpose when the right account
 * genuinely depends on what was bought/who was paid (leverantor, utlagg,
 * intern_overforing): a wrong static default there would be worse than none.
 * `lon` is also left out: its only template (personnel_salary, 7210) is
 * aktiebolag-only, and this module has no signal for the company's legal
 * form; for an enskild firma the same payment is 2013 Egna uttag instead.
 */
const KATEGORI_TEMPLATE_IDS: Partial<Record<Kategori, { negative?: string; positive?: string }>> = {
  bankavgift: { negative: 'bank_fees' },
  ranta: { negative: 'bank_interest_expense', positive: 'bank_interest_income' },
  lan: { negative: 'financial_loan_repayment' },
  skatt: { negative: 'financial_tax_account' },
}

function accountFromTemplate(template: BookingTemplate, beloppNegative: boolean): string {
  return beloppNegative ? template.debit_account : template.credit_account
}

/**
 * Whether `keyword` occurs in `text` as a whole word/phrase, not as a
 * substring of a longer word. Plain `includes()` would match the keyword
 * "el" inside "mellan": motpart text is short and noisy compared to a full
 * transaction description, so that false positive is common enough to guard
 * against explicitly.
 */
function containsKeyword(text: string, keyword: string): boolean {
  const idx = text.indexOf(keyword)
  if (idx === -1) return false
  const isWordChar = (c: string) => /[a-zåäö0-9]/i.test(c)
  const before = idx === 0 ? '' : text[idx - 1]
  const after = idx + keyword.length >= text.length ? '' : text[idx + keyword.length]
  return !isWordChar(before) && !isWordChar(after)
}

/**
 * Suggest a BAS account. The kategori-specific template wins when one
 * exists (it reflects what the owner just told us in their own words), so a
 * stray keyword in `motpart` can never override an explicit "Bankavgift"
 * choice: for a kategori we do have an opinion on, "no template for this
 * direction" means genuinely ambiguous (e.g. money coming in under "lan"
 * could be a new loan or a repaid one) and stays unsuggested rather than
 * falling through to a keyword guess. Only categories with no opinion at
 * all (leverantor, utlagg, intern_overforing) fall through to a keyword
 * match against the same templates used elsewhere in the app (e.g. "Google"
 * -> Programvaror). A match resolving to the bank account itself (1930) is
 * discarded: it means the template's other leg fits this amount's
 * direction, not this one, so it carries no real information.
 */
export function suggestBasKonto(kategori: Kategori, motpart: string, belopp: number): string | null {
  const beloppNegative = belopp < 0
  const ids = KATEGORI_TEMPLATE_IDS[kategori]
  if (ids) {
    const templateId = beloppNegative ? ids.negative : ids.positive
    const kategoriTemplate = templateId ? getTemplateById(templateId) : undefined
    if (!kategoriTemplate || kategoriTemplate.entity_applicability !== 'all') return null
    return accountFromTemplate(kategoriTemplate, beloppNegative)
  }

  const direction = beloppNegative ? 'expense' : 'income'
  const searchText = stripBankNoise(motpart.toLowerCase())
  if (!searchText) return null

  const keywordMatch = BOOKING_TEMPLATES.find((t) => {
    // leverantor, utlagg and intern_overforing are never sales revenue: a
    // positive amount here is a refund or repayment, not income. Without
    // this, a positive belopp searches 'income' templates by keyword and a
    // stray match (e.g. "taxi" in the reduced-VAT sales template, "faktura"
    // in the standard-VAT one) suggests a revenue account like 3001/3003 for
    // an expense-shaped post, which then gets learned as a rule in bertil.
    if (t.direction === 'income') return false
    if (t.direction !== direction && t.direction !== 'transfer') return false
    // No signal here for which legal form `post.bolag` is, so an EF-only or
    // AB-only template (e.g. private_withdrawal_ef, shareholder_loan_received)
    // is never suggested: a wrong entity-specific account would become a
    // learned rule in bertil, which is worse than no suggestion. Some
    // `entity_applicability: 'all'` templates (e.g. private_expense) still
    // book to a different account for AB via debit_account_ab/
    // credit_account_ab: those are entity-specific too on the leg this
    // amount direction resolves to, so they're excluded the same way.
    if (t.entity_applicability !== 'all') return false
    if (beloppNegative ? t.debit_account_ab : t.credit_account_ab) return false
    if (accountFromTemplate(t, beloppNegative) === '1930') return false
    return t.keywords.some((kw) => containsKeyword(searchText, kw.toLowerCase()))
  })
  return keywordMatch ? accountFromTemplate(keywordMatch, beloppNegative) : null
}

/**
 * A recognizable Swedish OCR/reference number: digits only, long enough that
 * it isn't a short code. bertil's learned rules match on `motpart` text, so
 * when the counterparty is really a reference number that changes every
 * period, the rule won't recognize next period's post either (task 1438
 * will let bertil match on the reference pattern instead).
 */
export function looksLikeReferenceNumber(motpart: string): boolean {
  return /^\d{6,}$/.test(motpart.trim())
}
