import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { validateScheduleRevenueAccounts } from '../validate-schedule-revenue-accounts'

const COMPANY_ID = 'company-1'

function chartOfAccountsClient(activeAccounts: string[]) {
  const from = vi.fn((table: string) => {
    expect(table).toBe('chart_of_accounts')
    return {
      select: () => ({
        eq: () => ({
          gte: () => ({
            lte: () => ({
              eq: () => ({
                in: (_col: string, accounts: string[]) =>
                  Promise.resolve({
                    data: accounts.filter((a) => activeAccounts.includes(a)).map((a) => ({ account_number: a })),
                    error: null,
                  }),
              }),
            }),
          }),
        }),
      }),
    }
  })
  return { from } as unknown as SupabaseClient
}

describe('validateScheduleRevenueAccounts', () => {
  it('passes without a DB call when no item carries an override', async () => {
    const from = vi.fn(() => {
      throw new Error('must not touch the DB with no overrides')
    })
    const result = await validateScheduleRevenueAccounts({ from } as unknown as SupabaseClient, COMPANY_ID, [
      { vat_rate: 25 },
      { vat_rate: 0, revenue_account: null },
    ])
    expect(result).toEqual({ ok: true })
    expect(from).not.toHaveBeenCalled()
  })

  it('rejects a class 1-2 override on a VAT-bearing line before any DB call', async () => {
    const from = vi.fn(() => {
      throw new Error('must reject before touching the DB')
    })
    const result = await validateScheduleRevenueAccounts({ from } as unknown as SupabaseClient, COMPANY_ID, [
      { vat_rate: 25, revenue_account: '2611' },
    ])
    expect(result).toEqual({
      ok: false,
      code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT',
      details: { account: '2611', vatRate: 25 },
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('rejects a class 1-2 override when vat_rate is null (unresolved, not zero)', async () => {
    const from = vi.fn(() => {
      throw new Error('must reject before touching the DB')
    })
    const result = await validateScheduleRevenueAccounts({ from } as unknown as SupabaseClient, COMPANY_ID, [
      { vat_rate: null, revenue_account: '2420' },
    ])
    expect(result).toEqual({
      ok: false,
      code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT',
      details: { account: '2420', vatRate: null },
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('rejects a class 1-2 override when vat_rate is omitted entirely', async () => {
    const from = vi.fn(() => {
      throw new Error('must reject before touching the DB')
    })
    const result = await validateScheduleRevenueAccounts({ from } as unknown as SupabaseClient, COMPANY_ID, [
      { revenue_account: '2420' },
    ])
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT' })
    expect(from).not.toHaveBeenCalled()
  })

  it('allows a class 1-2 override on a zero-VAT line', async () => {
    const supabase = chartOfAccountsClient(['1510'])
    const result = await validateScheduleRevenueAccounts(supabase, COMPANY_ID, [
      { vat_rate: 0, revenue_account: '1510' },
    ])
    expect(result).toEqual({ ok: true })
  })

  it('rejects an account absent from the company chart', async () => {
    const supabase = chartOfAccountsClient([])
    const result = await validateScheduleRevenueAccounts(supabase, COMPANY_ID, [
      { vat_rate: 0, revenue_account: '3011' },
    ])
    expect(result).toEqual({
      ok: false,
      code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID',
      details: { invalidAccounts: ['3011'] },
    })
  })

  it('accepts an active class 3 account', async () => {
    const supabase = chartOfAccountsClient(['3011'])
    const result = await validateScheduleRevenueAccounts(supabase, COMPANY_ID, [
      { vat_rate: 25, revenue_account: '3011' },
    ])
    expect(result).toEqual({ ok: true })
  })

  it('surfaces a DB error from the chart lookup', async () => {
    const dbError = { message: 'boom', code: '57014' }
    const from = vi.fn(() => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            lte: () => ({
              eq: () => ({
                in: () => Promise.resolve({ data: null, error: dbError }),
              }),
            }),
          }),
        }),
      }),
    }))
    const result = await validateScheduleRevenueAccounts({ from } as unknown as SupabaseClient, COMPANY_ID, [
      { vat_rate: 25, revenue_account: '3011' },
    ])
    expect(result).toEqual({ ok: false, dbError })
  })
})
