/**
 * What counts as a purchase still missing its underlag.
 *
 * The interesting cases are the ones the column filter cannot see. A bank
 * transaction can be booked three ways, and only one of them sets
 * `journal_entry_id`: bulk-booking many transactions onto one verifikat records
 * it in transaction_voucher_links, and a payment split across invoices records
 * it in the payment tables. Both leave the column null.
 *
 * The receipt hunt tolerates those false candidates because the worst case is a
 * proposal nobody accepts. This list is shown to a person, where the same rows
 * would sit under "saknar underlag" forever, already booked, with nothing the
 * user could do to clear them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchPurchasesWithoutUnderlag, clearsPurchaseFloor } from '../purchases-without-underlag'
import { NO_MERCHANT_DESCRIPTION } from '../external-id'

const rows = vi.fn()
let lastBuild: ((range: { from: number; to: number }) => unknown) | undefined
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: async (build: (range: { from: number; to: number }) => unknown) => {
    lastBuild = build
    return rows()
  },
}))

function tx(over: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    company_id: 'company-1',
    date: '2026-08-04',
    description: 'Elgiganten',
    merchant_name: 'Elgiganten',
    amount: -21639,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    journal_entry_id: null,
    ...over,
  }
}

/** Supabase double whose link tables answer per table name. */
function db(links: { voucher?: string[]; invoice?: string[]; supplier?: string[] } = {}) {
  const calls: string[] = []
  return {
    calls,
    from(table: string) {
      calls.push(table)
      const ids =
        table === 'transaction_voucher_links'
          ? links.voucher
          : table === 'invoice_payments'
            ? links.invoice
            : links.supplier
      const data = (ids ?? []).map((id) => ({ transaction_id: id }))
      const chain = { select: () => chain, in: async () => ({ data }) }
      return chain
    },
  } as never
}

beforeEach(() => vi.clearAllMocks())

describe('fetchPurchasesWithoutUnderlag', () => {
  it('returns purchases nothing has booked', async () => {
    rows.mockReturnValue([tx()])
    const out = await fetchPurchasesWithoutUnderlag(db(), 'company-1')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('tx-1')
  })

  it('skips the link-table lookups when there is nothing to check', async () => {
    rows.mockReturnValue([])
    const supabase = db()
    const out = await fetchPurchasesWithoutUnderlag(supabase, 'company-1')
    expect(out).toEqual([])
    expect((supabase as unknown as { calls: string[] }).calls).toEqual([])
  })

  it('excludes a transaction bulk-booked through a voucher link', async () => {
    // Many transactions, one verifikat: journal_entry_id stays null on every
    // one of them, so the column filter lets them all through.
    rows.mockReturnValue([tx({ id: 'tx-bulk' })])
    const out = await fetchPurchasesWithoutUnderlag(db({ voucher: ['tx-bulk'] }), 'company-1')
    expect(out).toEqual([])
  })

  it('excludes a transaction that paid a customer invoice', async () => {
    rows.mockReturnValue([tx({ id: 'tx-pay' })])
    const out = await fetchPurchasesWithoutUnderlag(db({ invoice: ['tx-pay'] }), 'company-1')
    expect(out).toEqual([])
  })

  it('excludes a transaction that paid a supplier invoice', async () => {
    rows.mockReturnValue([tx({ id: 'tx-sup' })])
    const out = await fetchPurchasesWithoutUnderlag(db({ supplier: ['tx-sup'] }), 'company-1')
    expect(out).toEqual([])
  })

  it('keeps the unbooked ones when only some of a batch are booked', async () => {
    rows.mockReturnValue([tx({ id: 'a' }), tx({ id: 'b' }), tx({ id: 'c' })])
    const out = await fetchPurchasesWithoutUnderlag(db({ voucher: ['b'] }), 'company-1')
    expect(out.map((p) => p.id)).toEqual(['a', 'c'])
  })

  it('excludes a row that already carries a journal entry', async () => {
    // Belt and braces: the query filters this out, but the predicate is what
    // the page trusts and it must agree.
    rows.mockReturnValue([tx({ journal_entry_id: 'je-1' })])
    const out = await fetchPurchasesWithoutUnderlag(db(), 'company-1')
    expect(out).toEqual([])
  })

  it('asks for outflows plus the no-merchant card rows whatever their sign', async () => {
    rows.mockReturnValue([])
    // Recording client: every builder call returns the chain and is logged.
    const calls: Array<[string, unknown[]]> = []
    const chain: unknown = new Proxy(
      {},
      { get: (_t, name: string) => (...a: unknown[]) => { calls.push([name, a]); return chain } },
    )
    await fetchPurchasesWithoutUnderlag({ from: () => chain } as never, 'company-1')
    lastBuild!({ from: 0, to: 999 })
    const or = calls.find(([name]) => name === 'or')
    // The query keeps the label as a literal for the column scanner; it must
    // stay byte-equal to the constant the sync writes.
    expect(or?.[1][0]).toBe(`amount.lt.0,original_description.eq."${NO_MERCHANT_DESCRIPTION}"`)
    expect(calls.some(([name]) => name === 'lt')).toBe(false)
  })
})

describe('no-merchant card rows in the list', () => {
  it('applies a floor to the size of the purchase whatever its sign', () => {
    expect(clearsPurchaseFloor(-50, 0)).toBe(true)
    expect(clearsPurchaseFloor(123.45, 0)).toBe(true)
    expect(clearsPurchaseFloor(-100, 100)).toBe(false)
    expect(clearsPurchaseFloor(-100.01, 100)).toBe(true)
    expect(clearsPurchaseFloor(99, 100)).toBe(false)
    expect(clearsPurchaseFloor(123.45, 100)).toBe(true)
  })

  it('drops rows under a passed floor before the link lookups', async () => {
    rows.mockReturnValue([tx({ id: 'small', amount: -40 }), tx({ id: 'big', amount: -400 })])
    const out = await fetchPurchasesWithoutUnderlag(db(), 'company-1', { minAmountSek: 100 })
    expect(out.map((p) => p.id)).toEqual(['big'])
  })

  it('lists a positive Svea card row the query returned like any other purchase', async () => {
    rows.mockReturnValue([
      tx({ id: 'svea', amount: 123.45, description: NO_MERCHANT_DESCRIPTION, merchant_name: null }),
    ])
    const out = await fetchPurchasesWithoutUnderlag(db(), 'company-1')
    expect(out.map((p) => p.id)).toEqual(['svea'])
  })
})
