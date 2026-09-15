import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { isBalanceSheetAccount } from '@/lib/invoices/posting-account'

/**
 * Shared revenue-account guard for recurring invoice schedule items. Mirrors
 * the two checks build-invoice-write.ts applies to a manually created
 * invoice's per-line posting-account override, so the two write paths cannot
 * silently drift apart on what counts as a valid override:
 *
 *  1. A class 1-2 (balance-sheet) override is only lawful on a zero-VAT line
 *     (deposits, advances, outlays). On a VAT-bearing line it would divert
 *     the tax base away from a 3xxx account and understate ruta 05/overstate
 *     ruta 10-12 of the momsdeklaration every time the schedule fires
 *     (ML 17 kap 24 §). `vat_rate: null`/omitted means "use the customer's
 *     default rate at spawn time" (RecurringScheduleItemSchema,
 *     executeRecurringSchedule), which resolves non-zero for almost every
 *     domestic customer: this validator cannot know that resolved rate
 *     without a customer lookup, so it treats an unresolved rate as unsafe
 *     rather than assuming 0. A deposit/advance line must declare
 *     `vat_rate: 0` explicitly to use a class 1-2 override.
 *  2. Any override must be an ACTIVE class 1-3 account that actually exists
 *     in the company's chart: never trust the client (or a caller further up
 *     the stack, e.g. an extension's own sync job).
 *
 * MUST be called by every write path that can persist an item's
 * revenue_account onto recurring_invoice_schedule_items (createRecurringSchedule,
 * applyRecurringScheduleUpdate, and any extension that creates or edits a
 * schedule directly), so a second write path can never reintroduce the gap
 * a single call site would have closed.
 */
export interface ScheduleRevenueAccountItem {
  revenue_account?: string | null
  vat_rate?: number | null
}

export type ValidateScheduleRevenueAccountsResult =
  | { ok: true }
  | {
      ok: false
      code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT'
      details: { account: string; vatRate: number | null }
    }
  | {
      ok: false
      code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID'
      details: { invalidAccounts: string[] }
    }
  | { ok: false; dbError: PostgrestError }

export async function validateScheduleRevenueAccounts(
  supabase: SupabaseClient,
  companyId: string,
  items: ScheduleRevenueAccountItem[],
): Promise<ValidateScheduleRevenueAccountsResult> {
  for (const item of items) {
    // item.vat_rate == null (not just 0) must fail the guard: it is not "this
    // line is zero-VAT", it is "unresolved, decide at spawn time" and almost
    // always resolves non-zero. Only an EXPLICIT 0 clears a class 1-2 override.
    if (
      item.revenue_account &&
      isBalanceSheetAccount(item.revenue_account) &&
      (item.vat_rate == null || item.vat_rate > 0)
    ) {
      return {
        ok: false,
        code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT',
        details: { account: item.revenue_account, vatRate: item.vat_rate ?? null },
      }
    }
  }

  const overrideAccounts = Array.from(
    new Set(items.map((item) => item.revenue_account).filter((a): a is string => !!a)),
  )
  if (overrideAccounts.length === 0) return { ok: true }

  const { data: validAccounts, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .gte('account_class', 1)
    .lte('account_class', 3)
    .eq('is_active', true)
    .in('account_number', overrideAccounts)

  if (error) return { ok: false, dbError: error }

  const validSet = new Set((validAccounts ?? []).map((a) => a.account_number))
  const invalid = overrideAccounts.filter((a) => !validSet.has(a))
  if (invalid.length > 0) {
    return { ok: false, code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID', details: { invalidAccounts: invalid } }
  }
  return { ok: true }
}
