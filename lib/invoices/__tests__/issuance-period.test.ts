import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase, makeCompanySettings, makeInvoice } from '@/tests/helpers'
import { invoiceIssuancePeriodError } from '../issuance-period'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const invoice = makeInvoice({
  status: 'draft',
  document_type: 'invoice',
  invoice_date: '2026-09-10',
})
const settings = makeCompanySettings({ accounting_method: 'accrual' })

describe('invoiceIssuancePeriodError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('requires an open period belonging to this company and covering the invoice date inclusively', async () => {
    enqueue({ data: [{ id: 'period-1' }], error: null })
    enqueue({ data: { bookkeeping_locked_through: null }, error: null })
    expect(await invoiceIssuancePeriodError(supabase as never, 'company-1', invoice, settings)).toBeNull()
    expect(findCalls('fiscal_periods', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['is_closed', false],
    ])
    expect(findCalls('fiscal_periods', 'lte')).toEqual([['period_start', '2026-09-10']])
    expect(findCalls('fiscal_periods', 'gte')).toEqual([['period_end', '2026-09-10']])
  })

  it.each([[], null])('blocks when no matching open period is returned (%j)', async (data) => {
    enqueue({ data, error: null })
    expect(await invoiceIssuancePeriodError(supabase as never, 'company-1', invoice, settings))
      .toBe('INVOICE_ISSUE_NO_FISCAL_PERIOD')
  })

  it('distinguishes lookup failures from missing periods, even if data is also returned', async () => {
    enqueue({ data: [{ id: 'period-1' }], error: { message: 'connection reset' } })
    expect(await invoiceIssuancePeriodError(supabase as never, 'company-1', invoice, settings))
      .toBe('INVOICE_ISSUE_PERIOD_LOOKUP_FAILED')
  })

  it.each([
    { accounting_method: 'cash' as const },
    { accounting_method: 'accrual' as const, defer_invoice_booking: true },
  ])('does not require a period when booking is deferred: %j', async (overrides) => {
    expect(await invoiceIssuancePeriodError(
      supabase as never, 'company-1', invoice, { ...settings, ...overrides },
    )).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it.each(['proforma', 'delivery_note'] as const)('does not book a %s at issue', async (document_type) => {
    expect(await invoiceIssuancePeriodError(
      supabase as never, 'company-1', { ...invoice, document_type }, settings,
    )).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('does not prevent delivery retries of an already-issued credit note', async () => {
    expect(await invoiceIssuancePeriodError(
      supabase as never, 'company-1', { ...invoice, status: 'sent' }, settings,
    )).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })
})


describe('issuance locks', () => {
  beforeEach(() => { vi.clearAllMocks(); reset() })

  it('blocks an open but locked fiscal period', async () => {
    enqueue({ data: [{ id: 'period-1', locked_at: '2026-09-01' }], error: null })
    expect(await invoiceIssuancePeriodError(supabase as never, 'company-1', invoice, settings)).toBe('PERIOD_LOCKED')
  })

  it.each(['2026-09-10', '2026-09-30'])('blocks dates on or behind the company lock %s', async (bookkeeping_locked_through) => {
    enqueue({ data: [{ id: 'period-1', locked_at: null }], error: null })
    enqueue({ data: { bookkeeping_locked_through }, error: null })
    expect(await invoiceIssuancePeriodError(supabase as never, 'company-1', invoice, settings)).toBe('PERIOD_LOCKED')
  })

  it('allows the day after the company lock', async () => {
    enqueue({ data: [{ id: 'period-1', locked_at: null }], error: null })
    enqueue({ data: { bookkeeping_locked_through: '2026-09-09' }, error: null })
    expect(await invoiceIssuancePeriodError(supabase as never, 'company-1', invoice, settings)).toBeNull()
  })

  it('fails closed when the company lock cannot be read', async () => {
    enqueue({ data: [{ id: 'period-1' }], error: null })
    enqueue({ data: null, error: { message: 'offline' } })
    expect(await invoiceIssuancePeriodError(supabase as never, 'company-1', invoice, settings)).toBe('INVOICE_ISSUE_PERIOD_LOOKUP_FAILED')
  })

  it('checks cash credit notes when their original requires a journal entry', async () => {
    enqueue({ data: [], error: null })
    expect(await invoiceIssuancePeriodError(supabase as never, 'company-1', invoice,
      { ...settings, accounting_method: 'cash' }, true)).toBe('INVOICE_ISSUE_NO_FISCAL_PERIOD')
  })
})
