import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { kopplaTillTransaktion } from '../lib/koppla'

const completeInboxItems = vi.fn()
const resolveVoucherLinked = vi.fn()
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  completeInboxItemsForBookedTransaction: (...a: unknown[]) => completeInboxItems(...a),
  resolveVoucherLinkedEntryIds: (...a: unknown[]) => resolveVoucherLinked(...a),
}))

type Tx = { id: string; document_id: string | null; journal_entry_id: string | null }

const TX_UUID = '11111111-1111-4111-8111-111111111111'

/** A transactions table that answers the lookups and records the pin, nothing else. */
function fakeSupabase(opts: { byExternalId?: Tx[]; byId?: Tx[]; lookupError?: boolean; pinError?: boolean; pinLost?: { document_id: string | null }; docEntryIds?: (string | null)[]; docError?: boolean }) {
  const updates: Record<string, unknown>[] = []
  const filters: Array<Record<string, unknown>> = []
  // journal_entry_id of the document on each successive read; the last one repeats.
  const docReads = [...(opts.docEntryIds ?? [null])]
  const from = vi.fn((table: string) => {
    if (table === 'document_attachments') {
      const doc: Record<string, unknown> = {}
      doc.select = () => doc
      doc.eq = () => doc
      doc.maybeSingle = async () =>
        opts.docError
          ? { data: null, error: { message: 'boom' } }
          : { data: { journal_entry_id: docReads.length > 1 ? docReads.shift() : docReads[0] }, error: null }
      return doc
    }
    if (table !== 'transactions') throw new Error(`unexpected table ${table}`)
    const f: Record<string, unknown> = {}
    filters.push(f)
    let mode: 'select' | 'update' = 'select'
    let selectedCols = ''
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn((cols: string) => {
      selectedCols = cols
      return chain
    })
    chain.update = vi.fn((patch: Record<string, unknown>) => {
      mode = 'update'
      updates.push(patch)
      return chain
    })
    for (const op of ['eq', 'is']) {
      chain[op] = vi.fn((col: string, val: unknown) => {
        f[`${op}:${col}`] = val
        return chain
      })
    }
    const resolve = () => {
      if (mode === 'update') {
        return opts.pinError
          ? { data: null, error: { message: 'boom' } }
          : { data: opts.pinLost ? [] : [{ id: f['eq:id'] }], error: null }
      }
      if (opts.lookupError) return { data: null, error: { message: 'boom' } }
      if (selectedCols === 'document_id') return { data: opts.pinLost ?? null, error: null }
      return { data: f['eq:external_id'] !== undefined ? (opts.byExternalId ?? []) : (opts.byId ?? []), error: null }
    }
    chain.maybeSingle = vi.fn(async () => resolve())
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(resolve()).then(ok)
    return chain
  })
  return { client: { from } as unknown as SupabaseClient, updates, filters }
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveVoucherLinked.mockResolvedValue(new Map())
  completeInboxItems.mockResolvedValue(null)
})

describe('kopplaTillTransaktion', () => {
  it('pins the document to the transaction bertil names by external_id, scoped to the company', async () => {
    const tx = { id: 'tx-1', document_id: null, journal_entry_id: null }
    const { client, updates, filters } = fakeSupabase({ byExternalId: [tx] })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-google-20260803', 'doc-1')).toBe('kopplad')
    expect(updates).toEqual([{ document_id: 'doc-1' }])
    expect(filters.every((f) => f['eq:company_id'] === 'c-1')).toBe(true)
    // Only ever fills an empty pin.
    expect(filters.some((f) => f['is:document_id'] === null)).toBe(true)
  })

  it('also resolves bertil ids that are Accounted transaction ids', async () => {
    const { client } = fakeSupabase({ byId: [{ id: TX_UUID, document_id: null, journal_entry_id: null }] })
    expect(await kopplaTillTransaktion(client, 'c-1', TX_UUID, 'doc-1')).toBe('kopplad')
  })

  it('carries the document onto the verifikat when the transaction is already booked, and reports kopplad only once it is there', async () => {
    completeInboxItems.mockResolvedValue('je-9')
    const { client } = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: 'je-9' }],
      docEntryIds: [null, 'je-9'],
    })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-x', 'doc-1')).toBe('kopplad')
    expect(completeInboxItems).toHaveBeenCalledWith(client, 'c-1', 'tx-1', { directJournalEntryId: 'je-9' })
  })

  it('does not report kopplad when the booked verifikat never got the document (locked period, failed link)', async () => {
    completeInboxItems.mockResolvedValue('je-9')
    const { client, updates } = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: 'je-9' }],
      docEntryIds: [null, null],
    })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-x', 'doc-1')).toBe('ej_pa_verifikat')
    // The pin stays, as attach-document leaves it; only the verifikat link is missing.
    expect(updates).toEqual([{ document_id: 'doc-1' }])
  })

  it('reports ej_pa_verifikat when the document ended up on a different verifikat than the booked one', async () => {
    completeInboxItems.mockResolvedValue('je-9')
    const { client } = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: 'je-9' }],
      docEntryIds: [null, 'je-other'],
    })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-x', 'doc-1')).toBe('ej_pa_verifikat')
  })

  it('reports kopplad for a bulk-booked transaction whose voucher-link verifikat now carries the document', async () => {
    completeInboxItems.mockResolvedValue('je-sam')
    const { client } = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: null }],
      docEntryIds: [null, 'je-sam'],
    })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-x', 'doc-1')).toBe('kopplad')
  })

  it('refuses a document that already backs a different verifikat, like attach-document: nothing is pinned', async () => {
    const { client, updates } = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: 'je-9' }],
      docEntryIds: ['je-old'],
    })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-x', 'doc-1')).toBe('annat_verifikat')
    expect(updates).toEqual([])
    expect(completeInboxItems).not.toHaveBeenCalled()
  })

  it('refuses the same for an unbooked transaction', async () => {
    const { client, updates } = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: null }],
      docEntryIds: ['je-old'],
    })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-x', 'doc-1')).toBe('annat_verifikat')
    expect(updates).toEqual([])
  })

  it('accepts a document already on this transaction\'s own verifikat, directly or through a voucher link', async () => {
    completeInboxItems.mockResolvedValue('je-9')
    const direct = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: 'je-9' }],
      docEntryIds: ['je-9'],
    })
    expect(await kopplaTillTransaktion(direct.client, 'c-1', 'tx-x', 'doc-1')).toBe('kopplad')

    completeInboxItems.mockResolvedValue('je-sam')
    resolveVoucherLinked.mockResolvedValue(new Map([['tx-1', 'je-sam']]))
    const linked = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: null }],
      docEntryIds: ['je-sam'],
    })
    expect(await kopplaTillTransaktion(linked.client, 'c-1', 'tx-x', 'doc-1')).toBe('kopplad')
  })

  it('reports misslyckades when the document cannot be read', async () => {
    const { client, updates } = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: null }],
      docError: true,
    })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-x', 'doc-1')).toBe('misslyckades')
    expect(updates).toEqual([])
  })

  it('does not guess: no match, or more than one, pins nothing', async () => {
    const none = fakeSupabase({})
    expect(await kopplaTillTransaktion(none.client, 'c-1', 'tx-x', 'doc-1')).toBe('ingen_transaktion')
    expect(none.updates).toEqual([])

    const two = fakeSupabase({
      byExternalId: [{ id: 'a', document_id: null, journal_entry_id: null }],
      byId: [{ id: 'b', document_id: null, journal_entry_id: null }],
    })
    expect(await kopplaTillTransaktion(two.client, 'c-1', TX_UUID, 'doc-1')).toBe('ingen_transaktion')
    expect(two.updates).toEqual([])
    expect(completeInboxItems).not.toHaveBeenCalled()
  })

  it('never replaces a document the transaction already carries', async () => {
    const { client, updates } = fakeSupabase({ byExternalId: [{ id: 'tx-1', document_id: 'other-doc', journal_entry_id: 'je-9' }] })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-x', 'doc-1')).toBe('har_underlag')
    expect(updates).toEqual([])
    expect(completeInboxItems).not.toHaveBeenCalled()
  })

  it('treats a re-run for the same document as done', async () => {
    const { client } = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: 'doc-1', journal_entry_id: null }],
      pinLost: { document_id: 'doc-1' },
    })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-x', 'doc-1')).toBe('kopplad')
  })

  it('reports a lost race as an existing underlag rather than overwriting', async () => {
    const { client } = fakeSupabase({
      byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: null }],
      pinLost: { document_id: 'someone-elses' },
    })
    expect(await kopplaTillTransaktion(client, 'c-1', 'tx-x', 'doc-1')).toBe('har_underlag')
  })

  it('reports failures instead of throwing', async () => {
    expect(await kopplaTillTransaktion(fakeSupabase({ lookupError: true }).client, 'c-1', 'tx-x', 'doc-1')).toBe('misslyckades')
    const pin = fakeSupabase({ byExternalId: [{ id: 'tx-1', document_id: null, journal_entry_id: null }], pinError: true })
    expect(await kopplaTillTransaktion(pin.client, 'c-1', 'tx-x', 'doc-1')).toBe('misslyckades')
    expect(completeInboxItems).not.toHaveBeenCalled()
  })
})
