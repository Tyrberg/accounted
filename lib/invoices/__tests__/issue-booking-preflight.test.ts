import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockFindFiscalPeriod = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: (...args: unknown[]) => mockFindFiscalPeriod(...args),
}))

import { hasOpenPeriodForIssueBooking } from '@/lib/invoices/issue-booking-preflight'

const supabase = {} as SupabaseClient
const invoice = { document_type: 'invoice', invoice_date: '2026-09-10' }

describe('hasOpenPeriodForIssueBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false when the invoice books at issue and no open period covers invoice_date', async () => {
    mockFindFiscalPeriod.mockResolvedValue(null)

    const ok = await hasOpenPeriodForIssueBooking(supabase, 'company-1', invoice, {
      accounting_method: 'accrual',
    })

    expect(ok).toBe(false)
    expect(mockFindFiscalPeriod).toHaveBeenCalledWith(supabase, 'company-1', '2026-09-10')
  })

  it('returns true when an open period covers invoice_date', async () => {
    mockFindFiscalPeriod.mockResolvedValue('fp-1')

    expect(
      await hasOpenPeriodForIssueBooking(supabase, 'company-1', invoice, { accounting_method: 'accrual' }),
    ).toBe(true)
  })

  it('defaults to booking at issue when there is no settings row', async () => {
    mockFindFiscalPeriod.mockResolvedValue(null)

    expect(await hasOpenPeriodForIssueBooking(supabase, 'company-1', invoice, null)).toBe(false)
  })

  it.each([
    ['kontantmetoden', { document_type: 'invoice' }, { accounting_method: 'cash' }],
    ['deferred booking (#967)', { document_type: 'invoice' }, { accounting_method: 'accrual', defer_invoice_booking: true }],
    ['a proforma', { document_type: 'proforma' }, { accounting_method: 'accrual' }],
    ['a delivery note', { document_type: 'delivery_note' }, { accounting_method: 'accrual' }],
  ])('skips the check for %s (nothing is booked at issue)', async (_label, doc, settings) => {
    const ok = await hasOpenPeriodForIssueBooking(
      supabase,
      'company-1',
      { ...doc, invoice_date: '2026-09-10' },
      settings,
    )

    expect(ok).toBe(true)
    expect(mockFindFiscalPeriod).not.toHaveBeenCalled()
  })
})
