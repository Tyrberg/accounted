import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveUserLabelsFromProfiles } from '@/lib/reports/behandlingshistorik'

/**
 * GET /api/bookkeeping/journal-entries/[id]/locked-attach-log
 *
 * The entry's audit trail for underlag archived into a locked/closed period
 * through attach_document_to_locked_period_entry() (audit_log action
 * LOCKED_PERIOD_ATTACH, record_id = the verifikat), newest first. Each row
 * says who (user + API key name), when, which file, its sha256 and why, so
 * the verifikat history shows the full trail and not just the attachment.
 */
type AuditRow = {
  id: string
  actor_id: string | null
  created_at: string
  new_state: Record<string, unknown> | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.locked_attach_log',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Ownership gate: 404 for entries outside the caller's company.
    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (entryError) {
      return NextResponse.json({ error: 'Kunde inte hämta arkiveringshistorik' }, { status: 500 })
    }
    if (!entry) {
      return NextResponse.json({ error: 'Verifikatet hittades inte' }, { status: 404 })
    }

    // The RPC puts no cap on attachments per verifikat, so the trail is read in
    // full: a bare query would be silently capped at PostgREST's 1000 rows and
    // drop the oldest records. (created_at, id) is a stable total order, so
    // the range pages neither skip nor repeat rows on a timestamp tie.
    let rows: AuditRow[]
    try {
      rows = await fetchAllRows<AuditRow>(
        ({ from, to }) =>
          supabase
            .from('audit_log')
            .select('id, actor_id, created_at, new_state')
            .eq('company_id', companyId)
            .eq('action', 'LOCKED_PERIOD_ATTACH')
            .eq('table_name', 'journal_entries')
            .eq('record_id', id)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to),
        { dedupeBy: (r) => r.id },
      )
    } catch {
      return NextResponse.json({ error: 'Kunde inte hämta arkiveringshistorik' }, { status: 500 })
    }

    // Who: profiles RLS is self-only, so the label lookup uses the service
    // client scoped to the actor ids already in this company's audit rows
    // (same precedent as the rättelse log). Best-effort.
    const actorIds = Array.from(new Set(rows.map((r) => r.actor_id).filter((a): a is string => !!a)))
    let labels = new Map<string, string>()
    if (actorIds.length > 0) {
      try {
        labels = await resolveUserLabelsFromProfiles(createServiceClient(), actorIds)
      } catch {
        labels = new Map()
      }
    }

    return NextResponse.json({
      data: rows.map((row) => {
        const s = row.new_state ?? {}
        return {
          id: row.id,
          created_at: row.created_at,
          actor: row.actor_id,
          actor_label: row.actor_id ? (labels.get(row.actor_id) ?? null) : null,
          api_key_name: str(s.api_key_name),
          document_id: str(s.document_id),
          file_name: str(s.file_name),
          sha256_hash: str(s.sha256_hash),
          reason: str(s.reason),
        }
      }),
    })
  },
)
