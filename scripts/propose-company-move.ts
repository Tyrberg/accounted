/**
 * READ-ONLY: propose which posted verifikat in other companies may belong to a
 * company that is being set up (task 1479: Mölleborgen AB).
 *
 * Writes NOTHING. Prints a Markdown list, one row per candidate verifikat with
 * date, amount, accounts, current company and why it matched, for the owner to
 * answer ja/nej row by row. Moving a verifikat changes two companies' books at
 * once; that step is deliberately not part of this script and must not run
 * until every row it would touch has an explicit ja.
 *
 * Searches by text, motpart (supplier/customer), bank account,
 * fastighetsbeteckning and hyresgäst. Repeat a flag to pass several terms.
 * "Mölleborgen" and "Molleborgen" match each other.
 *
 * .env.local points at the production database. This script only selects, but
 * confirm with the owner before pointing it at prod.
 *
 * Usage:
 *   npx tsx scripts/propose-company-move.ts \
 *     --name "Mölleborgen AB" --org-number 5565771069 \
 *     --text mölleborgen --property "<beteckning>" --tenant "<hyresgäst>" \
 *     --counterparty "<leverantör/kund>" --bank "<iban/bankgiro>"
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  buildCandidates,
  renderProposal,
  type CandidateEntry,
  type MoveSearchTerms,
} from '@/lib/company-move/candidates'
import { findLinkedMatches } from '@/lib/company-move/linked'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'

config({ path: resolve(process.cwd(), '.env.local') })

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    'org-number': { type: 'string' },
    text: { type: 'string', multiple: true },
    counterparty: { type: 'string', multiple: true },
    bank: { type: 'string', multiple: true },
    property: { type: 'string', multiple: true },
    tenant: { type: 'string', multiple: true },
  },
})

const targetName = values.name
if (!targetName || !values['org-number']) {
  console.error('Usage: npx tsx scripts/propose-company-move.ts --name "<company>" --org-number N [--text T]...')
  process.exit(1)
}

// The org number is the only key that picks out the target company, so it is
// required: without it the target would count as a source and its own
// verifikat would be proposed for moving to itself.
const targetOrg = normalizeOrgNumber(values['org-number'])
if (!targetOrg) {
  console.error(`Invalid organisationsnummer: ${values['org-number']}`)
  process.exit(1)
}

const terms: MoveSearchTerms = {
  // The company's own name is always a text term.
  text: [...new Set([targetName.replace(/\s+(AB|Aktiebolag)$/i, ''), ...(values.text ?? [])])],
  counterparties: values.counterparty ?? [],
  bankAccounts: values.bank ?? [],
  properties: values.property ?? [],
  tenants: values.tenant ?? [],
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

interface EntryRow {
  id: string
  company_id: string
  voucher_series: string | null
  voucher_number: number
  entry_date: string
  description: string
  source_type: string | null
  source_id: string | null
  lines: Array<{
    account_number: string
    debit_amount: number
    credit_amount: number
    line_description: string | null
  }>
}

async function main() {
  const { data: companies, error: companiesErr } = await supabase
    .from('companies')
    .select('id, name, org_number, archived_at')
  if (companiesErr) throw new Error(`companies: ${companiesErr.message}`)

  const targetIds = new Set(
    (companies ?? []).filter((c) => c.org_number === targetOrg).map((c) => c.id),
  )
  if (targetIds.size === 0) {
    console.error(
      `No company with organisationsnummer ${targetOrg} exists yet. Create it first ` +
        '(scripts/create-company.ts) and have the owner confirm it before proposing a move.',
    )
    process.exit(1)
  }
  // Archived companies (the ARKIV rows, "felbokad, ersatt") hold superseded
  // copies of live books: proposing to move from them would double-count.
  const sources = (companies ?? []).filter((c) => !targetIds.has(c.id) && !c.archived_at)
  const sourceIds = sources.map((c) => c.id)
  const nameById = new Map(sources.map((c) => [c.id, c.name as string]))

  // Posted, live verifikat only: cancelled/reversed entries and stornos net to
  // zero and would only add noise.
  const entryRows = await fetchAllRows<EntryRow>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select(
        'id, company_id, voucher_series, voucher_number, entry_date, description, source_type, source_id, lines:journal_entry_lines(account_number, debit_amount, credit_amount, line_description)',
      )
      .in('company_id', sourceIds)
      .eq('status', 'posted')
      // neq alone would drop rows where source_type is NULL (SQL three-valued logic).
      .or('source_type.is.null,source_type.neq.storno')
      .is('reversed_by_id', null)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: EntryRow[] | null; error: { message: string } | null }>,
  )

  const entries: CandidateEntry[] = entryRows.map((e) => ({
    id: e.id,
    company_id: e.company_id,
    company_name: nameById.get(e.company_id) ?? e.company_id,
    voucher_series: e.voucher_series ?? 'A',
    voucher_number: e.voucher_number,
    entry_date: e.entry_date,
    description: e.description,
    lines: e.lines ?? [],
  }))

  const table = <T>(name: string, columns: string) =>
    fetchAllRows<T>(({ from, to }) =>
      supabase
        .from(name)
        .select(columns)
        .in('company_id', sourceIds)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
    )

  const [suppliers, supplierInvoices, customers, customerInvoices, cashAccounts, transactions] =
    await Promise.all([
      table<{ id: string; name: string }>('suppliers', 'id, name'),
      table<{
        id: string
        supplier_id: string
        registration_journal_entry_id: string | null
        payment_journal_entry_id: string | null
      }>('supplier_invoices', 'id, supplier_id, registration_journal_entry_id, payment_journal_entry_id'),
      table<{ id: string; name: string }>('customers', 'id, name'),
      table<{ id: string; customer_id: string | null }>('invoices', 'id, customer_id'),
      table<{
        id: string
        name: string | null
        iban: string | null
        bban: string | null
        account_number: string | null
        bankgiro: string | null
        plusgiro: string | null
      }>('cash_accounts', 'id, name, iban, bban, account_number, bankgiro, plusgiro'),
      table<{
        journal_entry_id: string | null
        cash_account_id: string | null
        description: string | null
        original_description: string | null
        merchant_name: string | null
      }>('transactions', 'id, journal_entry_id, cash_account_id, description, original_description, merchant_name'),
    ])

  const linked = findLinkedMatches(
    {
      suppliers,
      supplierInvoices,
      customers,
      customerInvoices,
      cashAccounts,
      transactions,
      entrySources: entryRows.map((e) => ({ id: e.id, source_type: e.source_type, source_id: e.source_id })),
    },
    terms,
  )

  const candidates = buildCandidates(entries, linked, terms)
  process.stdout.write(renderProposal(candidates, targetName!))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
