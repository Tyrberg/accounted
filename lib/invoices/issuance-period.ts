import type { SupabaseClient } from '@supabase/supabase-js'
import { lookupOpenFiscalPeriod } from '@/lib/bookkeeping/fiscal-period-lookup'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import type { CompanySettings, Invoice } from '@/types'

/** Run before numbering or delivery. Cash, deferred and non-invoice documents do not book at issue. */
export async function invoiceIssuancePeriodError(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Pick<Invoice, 'document_type' | 'invoice_date' | 'status'>,
  settings: CompanySettings,
  journalEntryRequired = booksInvoicesOnIssue(settings),
): Promise<string | null> {
  if (
    invoice.status !== 'draft' ||
    (invoice.document_type && invoice.document_type !== 'invoice') ||
    !journalEntryRequired
  ) return null

  const { period, error } = await lookupOpenFiscalPeriod(supabase, companyId, invoice.invoice_date)
  if (error) return 'INVOICE_ISSUE_PERIOD_LOOKUP_FAILED'
  if (!period) return 'INVOICE_ISSUE_NO_FISCAL_PERIOD'
  if (period.locked_at) return 'PERIOD_LOCKED'

  const { data: lockSettings, error: lockError } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .single()
  if (lockError || !lockSettings) return 'INVOICE_ISSUE_PERIOD_LOOKUP_FAILED'
  if (lockSettings.bookkeeping_locked_through && invoice.invoice_date <= lockSettings.bookkeeping_locked_through) {
    return 'PERIOD_LOCKED'
  }
  return null
}
