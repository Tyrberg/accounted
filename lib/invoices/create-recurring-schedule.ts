import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { CreateRecurringScheduleSchema } from '@/lib/api/schemas'
import { computeInitialRunDate } from '@/lib/invoices/recurring-schedule-service'
import {
  validateScheduleRevenueAccounts,
  type ValidateScheduleRevenueAccountsResult,
} from '@/lib/invoices/validate-schedule-revenue-accounts'

export type CreateRecurringScheduleInput = z.infer<typeof CreateRecurringScheduleSchema>

export type CreateRecurringScheduleResult =
  | { ok: true; scheduleId: string }
  | (Extract<ValidateScheduleRevenueAccountsResult, { ok: false }>)
  | { ok: false; dbError: PostgrestError }

/**
 * Create a recurring invoice schedule and its items. Single write path shared
 * by the cookie-session POST route (app/api/invoices/recurring/route.ts) and
 * any extension that provisions a schedule on the company's behalf (e.g.
 * propmate's lease-to-schedule first sync), so the revenue-account guard
 * below cannot be bypassed by a second, independently-written insert.
 *
 * Rolls the schedule header back if the items insert fails, same as the
 * inline logic this was extracted from.
 */
export async function createRecurringSchedule(
  supabase: SupabaseClient,
  opts: {
    companyId: string
    userId: string
    input: CreateRecurringScheduleInput
  },
): Promise<CreateRecurringScheduleResult> {
  const { companyId, userId, input } = opts

  const revenueAccountCheck = await validateScheduleRevenueAccounts(supabase, companyId, input.items)
  if (!revenueAccountCheck.ok) return revenueAccountCheck

  const nextRunDate = computeInitialRunDate(new Date(), input.day_of_month, input.start_date)

  const { data: schedule, error: insertError } = await supabase
    .from('recurring_invoice_schedules')
    .insert({
      company_id: companyId,
      user_id: userId,
      customer_id: input.customer_id,
      name: input.name,
      day_of_month: input.day_of_month,
      interval_months: input.interval_months,
      send_hour: input.send_hour,
      payment_terms_days: input.payment_terms_days,
      currency: input.currency,
      your_reference: input.your_reference ?? null,
      our_reference: input.our_reference ?? null,
      notes: input.notes ?? null,
      auto_send: input.auto_send,
      default_dimensions: input.default_dimensions ?? {},
      next_run_date: nextRunDate,
      status: 'active',
    })
    .select('id')
    .single()

  if (insertError || !schedule) {
    return {
      ok: false,
      dbError: insertError ?? ({ message: 'insert failed' } as PostgrestError),
    }
  }

  const itemRows = input.items.map((item, idx) => ({
    schedule_id: schedule.id,
    sort_order: idx,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    vat_rate: item.vat_rate ?? null,
    revenue_account: item.revenue_account ?? null,
    dimensions: item.dimensions ?? {},
  }))

  const { error: itemsError } = await supabase
    .from('recurring_invoice_schedule_items')
    .insert(itemRows)

  if (itemsError) {
    // Roll back the parent so a half-created schedule doesn't ship.
    await supabase.from('recurring_invoice_schedules').delete().eq('id', schedule.id).eq('company_id', companyId)
    return { ok: false, dbError: itemsError }
  }

  return { ok: true, scheduleId: schedule.id }
}
