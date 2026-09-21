import {
  containsAccountIdentifier,
  containsTerm,
  type LinkedMatch,
  type MoveSearchTerms,
} from '@/lib/company-move/candidates'

/**
 * Links from a verifikat to a search term that do NOT go through the
 * verifikat's own text: the motpart on the underlying invoice, the bank
 * account a payment settled on, or the bank text of the transaction it was
 * booked from. Pure: the script hands in already-fetched rows.
 */

export interface PartyRow {
  id: string
  name: string
}

export interface SupplierInvoiceRow {
  id: string
  supplier_id: string
  registration_journal_entry_id: string | null
  payment_journal_entry_id: string | null
}

export interface CustomerInvoiceRow {
  id: string
  customer_id: string | null
}

export interface CashAccountRow {
  id: string
  name: string | null
  iban: string | null
  bban: string | null
  account_number: string | null
  bankgiro: string | null
  plusgiro: string | null
}

export interface TransactionRow {
  journal_entry_id: string | null
  cash_account_id: string | null
  description: string | null
  original_description: string | null
  merchant_name: string | null
}

export interface EntrySourceRow {
  id: string
  source_type: string | null
  source_id: string | null
}

export interface LinkedInput {
  suppliers: PartyRow[]
  supplierInvoices: SupplierInvoiceRow[]
  customers: PartyRow[]
  customerInvoices: CustomerInvoiceRow[]
  cashAccounts: CashAccountRow[]
  transactions: TransactionRow[]
  /** Only id, source_type, source_id: used to reach entries booked from an invoice. */
  entrySources: EntrySourceRow[]
}

export function findLinkedMatches(input: LinkedInput, terms: MoveSearchTerms): LinkedMatch[] {
  const out: LinkedMatch[] = []

  const entriesBySource = new Map<string, string[]>()
  for (const e of input.entrySources) {
    if (!e.source_id) continue
    const list = entriesBySource.get(e.source_id) ?? []
    list.push(e.id)
    entriesBySource.set(e.source_id, list)
  }

  // Motpart: a supplier/customer whose name contains a search term drags in
  // every verifikat booked from one of its invoices.
  const partyTerms: Array<['counterparty' | 'tenant', string]> = [
    ...terms.counterparties.map((t): ['counterparty', string] => ['counterparty', t]),
    ...terms.tenants.map((t): ['tenant', string] => ['tenant', t]),
  ]

  const supplierHits = new Map<string, { term: string; axis: 'counterparty' | 'tenant'; name: string }>()
  for (const s of input.suppliers) {
    for (const [axis, term] of partyTerms) {
      if (containsTerm(s.name, term)) supplierHits.set(s.id, { term, axis, name: s.name })
    }
  }
  for (const inv of input.supplierInvoices) {
    const hit = supplierHits.get(inv.supplier_id)
    if (!hit) continue
    const via = `leverantör ${hit.name}`
    const entryIds = [
      inv.registration_journal_entry_id,
      inv.payment_journal_entry_id,
      ...(entriesBySource.get(inv.id) ?? []),
    ]
    for (const entryId of entryIds) {
      if (entryId) out.push({ entryId, axis: hit.axis, term: hit.term, via })
    }
  }

  const customerHits = new Map<string, { term: string; axis: 'counterparty' | 'tenant'; name: string }>()
  for (const c of input.customers) {
    for (const [axis, term] of partyTerms) {
      if (containsTerm(c.name, term)) customerHits.set(c.id, { term, axis, name: c.name })
    }
  }
  for (const inv of input.customerInvoices) {
    const hit = inv.customer_id ? customerHits.get(inv.customer_id) : undefined
    if (!hit) continue
    for (const entryId of entriesBySource.get(inv.id) ?? []) {
      out.push({ entryId, axis: hit.axis, term: hit.term, via: `kund ${hit.name}` })
    }
  }

  // Bank account: a cash account carrying one of the identifiers pulls in the
  // verifikat booked from its transactions.
  const cashHits = new Map<string, { term: string; label: string }>()
  for (const ca of input.cashAccounts) {
    const fields = [ca.iban, ca.bban, ca.account_number, ca.bankgiro, ca.plusgiro]
    for (const term of terms.bankAccounts) {
      if (fields.some((f) => containsAccountIdentifier(f, term))) {
        cashHits.set(ca.id, { term, label: ca.name ?? term })
      }
    }
  }

  const textTerms: Array<['text' | 'property' | 'tenant' | 'counterparty', string]> = [
    ...terms.text.map((t): ['text', string] => ['text', t]),
    ...terms.properties.map((t): ['property', string] => ['property', t]),
    ...partyTerms,
  ]

  for (const t of input.transactions) {
    if (!t.journal_entry_id) continue
    const cash = t.cash_account_id ? cashHits.get(t.cash_account_id) : undefined
    if (cash) {
      out.push({
        entryId: t.journal_entry_id,
        axis: 'bank_account',
        term: cash.term,
        via: `bankkonto ${cash.label}`,
      })
    }
    // Bank text: the transaction may name the motpart or property even when the
    // verifikattext was rewritten to something generic when it was booked.
    for (const [axis, term] of textTerms) {
      const field = [t.description, t.original_description, t.merchant_name].find((f) =>
        containsTerm(f, term),
      )
      if (field !== undefined) {
        out.push({ entryId: t.journal_entry_id, axis, term, via: 'banktransaktion' })
      }
    }
  }

  return dedupe(out)
}

function dedupe(matches: LinkedMatch[]): LinkedMatch[] {
  const seen = new Set<string>()
  return matches.filter((m) => {
    const key = `${m.entryId}|${m.axis}|${m.term}|${m.via}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
