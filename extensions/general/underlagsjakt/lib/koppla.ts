/**
 * Pinning an uploaded underlag to the Accounted bank transaction it belongs to.
 *
 * bertil's `transaction_id` is bertil's own identity for the payment. When it
 * is also an Accounted identity (the transaction's id, or the `external_id`
 * the bank import stamped) the document is pinned to that transaction, so it
 * follows the verifikat exactly like any other attached underlag. When it is
 * not, or when the match is not unique, nothing is pinned: guessing a
 * transaction from date and amount would attach a receipt to the wrong
 * verifikat, and a wrong underlag is worse than one that is filed and not yet
 * linked. The document is archived in both cases and the answer to bertil
 * carries it either way.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  completeInboxItemsForBookedTransaction,
  resolveVoucherLinkedEntryIds,
} from '@/lib/transactions/inbox-underlag'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * - `kopplad`: pinned to the Accounted transaction, and, when it is booked, the
 *   document verifiably references the verifikat.
 * - `har_underlag`: the transaction already carries another document; left as it is.
 * - `annat_verifikat`: the document (found again by content) already backs a
 *   different verifikat; nothing is pinned, exactly as attach-document refuses it.
 * - `ej_pa_verifikat`: pinned to the transaction, but the booked verifikat does not
 *   reference it (closed or locked period, or the link failed). The pin stays, as in
 *   attach-document; the verifikat still lacks its underlag.
 * - `ingen_transaktion`: no single Accounted transaction answers to bertil's id.
 * - `misslyckades`: the transaction was found but the pin could not be written.
 */
export type KopplingResultat =
  | 'kopplad'
  | 'har_underlag'
  | 'annat_verifikat'
  | 'ej_pa_verifikat'
  | 'ingen_transaktion'
  | 'misslyckades'

async function readDocumentEntryId(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
): Promise<{ ok: true; journalEntryId: string | null } | { ok: false }> {
  const { data, error } = await supabase
    .from('document_attachments')
    .select('journal_entry_id')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !data) return { ok: false }
  return { ok: true, journalEntryId: (data.journal_entry_id as string | null) ?? null }
}

export async function kopplaTillTransaktion(
  supabase: SupabaseClient,
  companyId: string,
  bertilTransactionId: string,
  documentId: string,
): Promise<KopplingResultat> {
  const matches = new Map<string, { id: string; document_id: string | null; journal_entry_id: string | null }>()
  const lookups = [supabase.from('transactions').select('id, document_id, journal_entry_id').eq('company_id', companyId).eq('external_id', bertilTransactionId)]
  if (UUID_RE.test(bertilTransactionId)) {
    lookups.push(
      supabase.from('transactions').select('id, document_id, journal_entry_id').eq('company_id', companyId).eq('id', bertilTransactionId),
    )
  }
  for (const lookup of lookups) {
    const { data, error } = await lookup
    if (error) return 'misslyckades'
    for (const row of (data ?? []) as { id: string; document_id: string | null; journal_entry_id: string | null }[]) {
      matches.set(row.id, row)
    }
  }
  if (matches.size !== 1) return 'ingen_transaktion'

  const tx = [...matches.values()][0]
  if (tx.document_id && tx.document_id !== documentId) return 'har_underlag'

  // Same guard as attach-document: a document that already backs a DIFFERENT
  // verifikat (the upload dedupes by content, so a receipt archived against an
  // earlier booking comes back as that document) is never pinned here. A
  // bulk-booked transaction is anchored through transaction_voucher_links, so
  // that anchoring counts as the same verifikat.
  const before = await readDocumentEntryId(supabase, companyId, documentId)
  if (!before.ok) return 'misslyckades'
  if (before.journalEntryId && before.journalEntryId !== tx.journal_entry_id) {
    const voucherLinked = await resolveVoucherLinkedEntryIds(supabase, companyId, [tx.id])
    if (before.journalEntryId !== voucherLinked.get(tx.id)) return 'annat_verifikat'
  }

  // Only ever fills an empty pin: never replaces a document already attached.
  const { data: pinned, error: pinError } = await supabase
    .from('transactions')
    .update({ document_id: documentId })
    .eq('id', tx.id)
    .eq('company_id', companyId)
    .is('document_id', null)
    .select('id')
  if (pinError) return 'misslyckades'
  if (!pinned || pinned.length === 0) {
    // Lost a race, or the same document was pinned by an earlier attempt.
    const { data: fresh } = await supabase
      .from('transactions')
      .select('document_id')
      .eq('id', tx.id)
      .eq('company_id', companyId)
      .maybeSingle()
    if ((fresh?.document_id as string | null) !== documentId) return 'har_underlag'
  }

  // Booked already: carry the document onto the verifikat. That step is best
  // effort and swallows its own failures, so the outcome is read back rather
  // than assumed: "kopplad" is only reported when the document references the
  // verifikat.
  const journalEntryId = await completeInboxItemsForBookedTransaction(supabase, companyId, tx.id, {
    directJournalEntryId: tx.journal_entry_id,
  })
  if (!journalEntryId) return 'kopplad'
  const after = await readDocumentEntryId(supabase, companyId, documentId)
  return after.ok && after.journalEntryId === journalEntryId ? 'kopplad' : 'ej_pa_verifikat'
}
