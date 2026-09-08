import { describe, it, expect } from 'vitest'
import { CreateLeaseSchema, checkCampaignAndDates } from '../lib/schemas'

function baseLease(overrides: Record<string, unknown> = {}) {
  return {
    customer_id: '550e8400-e29b-41d4-a716-446655440000',
    property_name: 'Bohed',
    monthly_rent: 12000,
    start_date: '2026-01-01',
    ...overrides,
  }
}

describe('CreateLeaseSchema revenue_account', () => {
  it('accepts a class 3 account', () => {
    const result = CreateLeaseSchema.safeParse(baseLease({ revenue_account: '3011' }))
    expect(result.success).toBe(true)
  })

  it('rejects a class 1 (balance-sheet) account, unlike the general invoice/schedule override', () => {
    const result = CreateLeaseSchema.safeParse(baseLease({ revenue_account: '1510' }))
    expect(result.success).toBe(false)
  })

  it('rejects a class 2 (VAT/liability) account', () => {
    const result = CreateLeaseSchema.safeParse(baseLease({ revenue_account: '2611' }))
    expect(result.success).toBe(false)
  })

  it('rejects a class 4-8 account', () => {
    const result = CreateLeaseSchema.safeParse(baseLease({ revenue_account: '7010' }))
    expect(result.success).toBe(false)
  })

  it('allows a null/omitted override (falls back to VAT-treatment-derived account downstream)', () => {
    expect(CreateLeaseSchema.safeParse(baseLease()).success).toBe(true)
    expect(CreateLeaseSchema.safeParse(baseLease({ revenue_account: null })).success).toBe(true)
  })
})

describe('CreateLeaseSchema additions', () => {
  it('accepts a zero or positive tillägg amount', () => {
    expect(
      CreateLeaseSchema.safeParse(baseLease({ additions: [{ description: 'El', amount: 0 }] })).success,
    ).toBe(true)
    expect(
      CreateLeaseSchema.safeParse(baseLease({ additions: [{ description: 'El', amount: 500 }] })).success,
    ).toBe(true)
  })

  it('rejects a negative tillägg amount, matching monthly_rent\'s own floor', () => {
    const result = CreateLeaseSchema.safeParse(baseLease({ additions: [{ description: 'El', amount: -500 }] }))
    expect(result.success).toBe(false)
  })
})

describe('CreateLeaseSchema vat_rate', () => {
  it('accepts 0 and 25 (the only lawful lokalhyra rates)', () => {
    expect(CreateLeaseSchema.safeParse(baseLease({ vat_rate: 0 })).success).toBe(true)
    expect(CreateLeaseSchema.safeParse(baseLease({ vat_rate: 25 })).success).toBe(true)
  })

  it('rejects any other rate', () => {
    expect(CreateLeaseSchema.safeParse(baseLease({ vat_rate: 12 })).success).toBe(false)
    expect(CreateLeaseSchema.safeParse(baseLease({ vat_rate: 6 })).success).toBe(false)
  })
})

describe('checkCampaignAndDates', () => {
  it('passes with no campaign fields', () => {
    expect(checkCampaignAndDates({ start_date: '2026-01-01' })).toEqual([])
  })

  it('passes with all three campaign fields set and in order', () => {
    expect(
      checkCampaignAndDates({
        campaign_price_amount: 8000,
        campaign_start_date: '2026-02-01',
        campaign_end_date: '2026-04-30',
      }),
    ).toEqual([])
  })

  it('flags a partial campaign triple', () => {
    const issues = checkCampaignAndDates({ campaign_price_amount: 8000 })
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('campaign_price_amount')
  })

  it('flags a campaign end before its start', () => {
    const issues = checkCampaignAndDates({
      campaign_price_amount: 8000,
      campaign_start_date: '2026-04-30',
      campaign_end_date: '2026-02-01',
    })
    expect(issues.some((i) => i.path === 'campaign_end_date')).toBe(true)
  })

  it('flags a lease end_date before start_date', () => {
    const issues = checkCampaignAndDates({ start_date: '2026-06-01', end_date: '2026-01-01' })
    expect(issues.some((i) => i.path === 'end_date')).toBe(true)
  })
})
