import { describe, it, expect } from 'vitest'
import {
  buildCandidates,
  containsAccountIdentifier,
  containsTerm,
  foldForMatch,
  matchEntryText,
  renderProposal,
  type CandidateEntry,
  type MoveSearchTerms,
} from '@/lib/company-move/candidates'
import { findLinkedMatches } from '@/lib/company-move/linked'

const noTerms: MoveSearchTerms = {
  text: [],
  counterparties: [],
  bankAccounts: [],
  properties: [],
  tenants: [],
}

function entry(over: Partial<CandidateEntry> = {}): CandidateEntry {
  return {
    id: 'e1',
    company_id: 'c1',
    company_name: 'Tyrberg Fastigheter',
    voucher_series: 'A',
    voucher_number: 12,
    entry_date: '2025-03-01',
    description: 'Hyra kontorshotell',
    lines: [
      { account_number: '1930', debit_amount: 1000.1, credit_amount: 0, line_description: null },
      { account_number: '3010', debit_amount: 0.2, credit_amount: 1000.3, line_description: 'Hyra' },
    ],
    ...over,
  }
}

describe('foldForMatch / containsTerm', () => {
  it('treats Mölleborgen and Molleborgen as the same name', () => {
    expect(foldForMatch('MÖLLEBORGEN AB')).toBe('molleborgen ab')
    expect(containsTerm('Hyra Molleborgen jan', 'Mölleborgen')).toBe(true)
    expect(containsTerm('Hyra Mölleborgen jan', 'molleborgen')).toBe(true)
  })

  it('never matches an empty term or empty text', () => {
    expect(containsTerm('anything', '')).toBe(false)
    expect(containsTerm(null, 'x')).toBe(false)
  })
})

describe('containsAccountIdentifier', () => {
  it('ignores spaces and hyphens', () => {
    expect(containsAccountIdentifier('Betalning 5555-1234', '5555 1234')).toBe(true)
  })

  it('refuses short identifiers that would match by accident', () => {
    expect(containsAccountIdentifier('Betalning 12345', '1234')).toBe(false)
  })
})

describe('matchEntryText', () => {
  it('reports the axis, term and field of each hit', () => {
    const e = entry({ description: 'Hyra Mölleborgen', lines: [
      { account_number: '3010', debit_amount: 0, credit_amount: 1, line_description: 'Mollen 4' },
    ] })
    const matches = matchEntryText(e, {
      ...noTerms,
      text: ['molleborgen'],
      properties: ['Mollen 4'],
    })
    expect(matches).toEqual([
      { axis: 'text', term: 'molleborgen', via: 'verifikattext' },
      { axis: 'property', term: 'Mollen 4', via: 'rad 1' },
    ])
  })
})

describe('buildCandidates', () => {
  it('drops entries without any match and rounds the amount to öre', () => {
    const hit = entry({ id: 'a', description: 'Mölleborgen hyra' })
    const miss = entry({ id: 'b', description: 'Kontorsmaterial' })
    const result = buildCandidates([hit, miss], [], { ...noTerms, text: ['Mölleborgen'] })
    expect(result.map((c) => c.entry.id)).toEqual(['a'])
    expect(result[0].amount).toBe(1000.3)
  })

  it('merges linked matches into the same candidate', () => {
    const e = entry({ id: 'a', description: 'Generisk text', lines: [] })
    const result = buildCandidates(
      [e],
      [{ entryId: 'a', axis: 'counterparty', term: 'Foo', via: 'leverantör Foo AB' }],
      noTerms,
    )
    expect(result).toHaveLength(1)
    expect(result[0].matches[0].via).toBe('leverantör Foo AB')
  })

  it('sorts by company, then date, then voucher', () => {
    const t = { ...noTerms, text: ['x'] }
    const a = entry({ id: '1', company_name: 'B', entry_date: '2025-01-01', description: 'x' })
    const b = entry({ id: '2', company_name: 'A', entry_date: '2025-02-01', description: 'x' })
    const c = entry({ id: '3', company_name: 'A', entry_date: '2025-01-01', description: 'x' })
    expect(buildCandidates([a, b, c], [], t).map((x) => x.entry.id)).toEqual(['3', '2', '1'])
  })
})

describe('renderProposal', () => {
  it('states that nothing is moved and gives every row an unanswered ja / nej', () => {
    const cands = buildCandidates([entry({ description: 'Mölleborgen | hyra' })], [], {
      ...noTerms,
      text: ['Mölleborgen'],
    })
    const md = renderProposal(cands, 'Mölleborgen AB')
    expect(md).toContain('Ingenting är flyttat')
    expect(md).toContain('Tyrberg Fastigheter')
    expect(md).toContain('A12')
    expect(md).toContain('2025-03-01')
    expect(md).toContain('ja / nej')
    // A pipe in the verifikattext must not break the table.
    expect(md).toContain('Mölleborgen / hyra')
    expect(md).toContain('Totalt 1 kandidater.')
  })

  it('says so when there are no candidates', () => {
    expect(renderProposal([], 'Mölleborgen AB')).toContain('Inga kandidater hittades.')
  })
})

describe('findLinkedMatches', () => {
  const empty = {
    suppliers: [],
    supplierInvoices: [],
    customers: [],
    customerInvoices: [],
    cashAccounts: [],
    transactions: [],
    entrySources: [],
  }

  it('links a supplier to its registration, payment and source-booked verifikat', () => {
    const out = findLinkedMatches(
      {
        ...empty,
        suppliers: [{ id: 's1', name: 'Fönsterputs Mölleborgen AB' }],
        supplierInvoices: [
          { id: 'si1', supplier_id: 's1', registration_journal_entry_id: 'r', payment_journal_entry_id: 'p' },
        ],
        entrySources: [{ id: 'x', source_type: 'supplier_invoice', source_id: 'si1' }],
      },
      { ...noTerms, counterparties: ['molleborgen'] },
    )
    expect(out.map((m) => m.entryId).sort()).toEqual(['p', 'r', 'x'])
    expect(out[0].via).toBe('leverantör Fönsterputs Mölleborgen AB')
  })

  it('links a tenant customer through the entry booked from its invoice', () => {
    const out = findLinkedMatches(
      {
        ...empty,
        customers: [{ id: 'c1', name: 'Hyresgäst Nord AB' }],
        customerInvoices: [{ id: 'i1', customer_id: 'c1' }, { id: 'i2', customer_id: null }],
        entrySources: [
          { id: 'e1', source_type: 'invoice', source_id: 'i1' },
          { id: 'e2', source_type: 'invoice', source_id: 'i2' },
        ],
      },
      { ...noTerms, tenants: ['Hyresgäst Nord'] },
    )
    expect(out).toEqual([{ entryId: 'e1', axis: 'tenant', term: 'Hyresgäst Nord', via: 'kund Hyresgäst Nord AB' }])
  })

  it('links transactions on a matching cash account and by bank text', () => {
    const out = findLinkedMatches(
      {
        ...empty,
        cashAccounts: [
          { id: 'k1', name: 'Konto A', iban: 'SE45 5000 0000 0583 9825 7466', bban: null, account_number: null, bankgiro: null, plusgiro: null },
          { id: 'k2', name: 'Konto B', iban: 'SE00 1111 2222 3333 4444 5555', bban: null, account_number: null, bankgiro: null, plusgiro: null },
        ],
        transactions: [
          { journal_entry_id: 'e1', cash_account_id: 'k1', description: null, original_description: null, merchant_name: null },
          { journal_entry_id: 'e2', cash_account_id: 'k2', description: 'Hyra Molleborgen', original_description: null, merchant_name: null },
          { journal_entry_id: null, cash_account_id: 'k1', description: 'Molleborgen', original_description: null, merchant_name: null },
        ],
      },
      { ...noTerms, text: ['Mölleborgen'], bankAccounts: ['SE45 5000 0000 0583 9825 7466'] },
    )
    expect(out).toEqual([
      { entryId: 'e1', axis: 'bank_account', term: 'SE45 5000 0000 0583 9825 7466', via: 'bankkonto Konto A' },
      { entryId: 'e2', axis: 'text', term: 'Mölleborgen', via: 'banktransaktion' },
    ])
  })
})
