import type { SupabaseClient } from '@supabase/supabase-js'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'

/**
 * Fiscal-period pre-flight shared by every path that issues an invoice
 * (backoffice#94): v1 :mark-sent and :send, the dashboard send route, the MCP
 * mark_invoice_sent/send_invoice executors, and recurring auto-send.
 *
 * When issuing will book the invoice (a real invoice, faktureringsmetoden
 * without defer_invoice_booking), createInvoiceJournalEntry needs an open
 * fiscal period covering invoice_date and returns null without one. Checking
 * AFTER the F-series allocation and status flip is what let invoices go out
 * 'sent' with no verifikat, so every issuing path calls this BEFORE any side
 * effect and refuses to issue when it returns false.
 *
 * Returns true when issuing may proceed: either nothing will be booked at
 * issue (proforma, delivery note, kontantmetoden, deferred booking), or an
 * open period covers invoice_date. Credit notes book through their own flow;
 * callers that handle them exempt them before calling.
 */
export async function hasOpenPeriodForIssueBooking(
  supabase: SupabaseClient,
  companyId: string,
  invoice: { document_type?: string | null; invoice_date: string },
  settings: Parameters<typeof booksInvoicesOnIssue>[0],
): Promise<boolean> {
  const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
  if (!isRealInvoice || !booksInvoicesOnIssue(settings)) return true
  return (await findFiscalPeriod(supabase, companyId, invoice.invoice_date)) !== null
}
