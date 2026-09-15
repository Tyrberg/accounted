import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRecurringSchedule, type CreateRecurringScheduleInput } from '../create-recurring-schedule'

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'

function baseInput(overrides: Partial<CreateRecurringScheduleInput> = {}): CreateRecurringScheduleInput {
  return {
    customer_id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Hyra',
    day_of_month: 1,
    interval_months: 1,
    send_hour: 8,
    payment_terms_days: 30,
    currency: 'SEK',
    auto_send: false,
    items: [{ description: 'Rent', quantity: 1, unit: 'mån', unit_price: 10000 }],
    ...overrides,
  }
}

describe('createRecurringSchedule', () => {
  it('rejects a class 1-2 revenue_account override on a VAT-bearing line before any insert', async () => {
    const from = vi.fn(() => {
      throw new Error('must reject before touching the DB')
    })
    const result = await createRecurringSchedule({ from } as unknown as SupabaseClient, {
      companyId: COMPANY_ID,
      userId: USER_ID,
      input: baseInput({
        items: [{ description: 'Rent', quantity: 1, unit: 'mån', unit_price: 10000, vat_rate: 25, revenue_account: '2611' }],
      }),
    })
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT' })
    expect(from).not.toHaveBeenCalled()
  })

  it('rejects a class 1-2 override when vat_rate is omitted, since it resolves to the customer default at spawn time, not zero', async () => {
    const from = vi.fn(() => {
      throw new Error('must reject before touching the DB')
    })
    const result = await createRecurringSchedule({ from } as unknown as SupabaseClient, {
      companyId: COMPANY_ID,
      userId: USER_ID,
      input: baseInput({
        items: [{ description: 'Deposition', quantity: 1, unit: 'st', unit_price: 10000, revenue_account: '2420' }],
      }),
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT',
      details: { account: '2420', vatRate: null },
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('inserts the schedule and items, carrying revenue_account through', async () => {
    const inserted: Record<string, unknown[]> = {}
    const from = vi.fn((table: string) => {
      if (table === 'chart_of_accounts') {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lte: () => ({
                  eq: () => ({
                    in: () => Promise.resolve({ data: [{ account_number: '3011' }], error: null }),
                  }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'recurring_invoice_schedules') {
        return {
          insert: (row: Record<string, unknown>) => {
            ;(inserted[table] ??= []).push(row)
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id: 'schedule-1' }, error: null }),
              }),
            }
          },
        }
      }
      if (table === 'recurring_invoice_schedule_items') {
        return {
          insert: (rows: Record<string, unknown>[]) => {
            ;(inserted[table] ??= []).push(rows)
            return Promise.resolve({ error: null })
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    })

    const result = await createRecurringSchedule({ from } as unknown as SupabaseClient, {
      companyId: COMPANY_ID,
      userId: USER_ID,
      input: baseInput({
        items: [{ description: 'Rent', quantity: 1, unit: 'mån', unit_price: 10000, vat_rate: 0, revenue_account: '3011' }],
      }),
    })

    expect(result).toEqual({ ok: true, scheduleId: 'schedule-1' })
    const itemRows = inserted['recurring_invoice_schedule_items'][0] as Array<Record<string, unknown>>
    expect(itemRows[0]).toMatchObject({ revenue_account: '3011', vat_rate: 0 })
  })

  it('rolls back the schedule when the items insert fails', async () => {
    const deleted: unknown[] = []
    const from = vi.fn((table: string) => {
      if (table === 'recurring_invoice_schedules') {
        return {
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: 'schedule-1' }, error: null }),
            }),
          }),
          delete: () => ({
            eq: () => ({
              eq: (...args: unknown[]) => {
                deleted.push(args)
                return Promise.resolve({ error: null })
              },
            }),
          }),
        }
      }
      return {
        insert: () => Promise.resolve({ error: { message: 'insert boom' } }),
      }
    })

    const result = await createRecurringSchedule({ from } as unknown as SupabaseClient, {
      companyId: COMPANY_ID,
      userId: USER_ID,
      input: baseInput(),
    })

    expect(result).toMatchObject({ ok: false, dbError: { message: 'insert boom' } })
    expect(deleted).toEqual([['company_id', COMPANY_ID]])
  })
})
