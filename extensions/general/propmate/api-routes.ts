import type { ApiRouteDefinition, ExtensionLogger } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { CreateLeaseSchema, UpdateLeaseSchema, checkCampaignAndDates } from './lib/schemas'
import { syncLeaseToRecurringSchedule, pauseLeaseSchedule, type LeaseRow } from './lib/lease-schedule-sync'

/** Matches UUID_RE across the codebase; a non-UUID path id is a 404, not a 500 from Postgres. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Every column UpdateLeaseSchema can carry, in the exact shape leases.update() needs. */
function leaseUpdateRow(input: {
  customer_id?: string
  property_name?: string
  unit_description?: string | null
  monthly_rent?: number
  additions?: unknown[]
  campaign_price_amount?: number | null
  campaign_start_date?: string | null
  campaign_end_date?: string | null
  kpi_base_index?: number | null
  kpi_base_year?: number | null
  kpi_next_review_date?: string | null
  vat_rate?: 0 | 25
  revenue_account?: string | null
  day_of_month?: number
  auto_send?: boolean
  start_date?: string
  end_date?: string | null
  status?: 'active' | 'ended'
}): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  if (input.customer_id !== undefined) row.customer_id = input.customer_id
  if (input.property_name !== undefined) row.property_name = input.property_name
  if (input.unit_description !== undefined) row.unit_description = input.unit_description
  if (input.monthly_rent !== undefined) row.monthly_rent = input.monthly_rent
  if (input.additions !== undefined) row.additions = input.additions
  if (input.campaign_price_amount !== undefined) row.campaign_price_amount = input.campaign_price_amount
  if (input.campaign_start_date !== undefined) row.campaign_start_date = input.campaign_start_date
  if (input.campaign_end_date !== undefined) row.campaign_end_date = input.campaign_end_date
  if (input.kpi_base_index !== undefined) row.kpi_base_index = input.kpi_base_index
  if (input.kpi_base_year !== undefined) row.kpi_base_year = input.kpi_base_year
  if (input.kpi_next_review_date !== undefined) row.kpi_next_review_date = input.kpi_next_review_date
  if (input.vat_rate !== undefined) row.vat_rate = input.vat_rate
  if (input.revenue_account !== undefined) row.revenue_account = input.revenue_account
  if (input.day_of_month !== undefined) row.day_of_month = input.day_of_month
  if (input.auto_send !== undefined) row.auto_send = input.auto_send
  if (input.start_date !== undefined) row.start_date = input.start_date
  if (input.end_date !== undefined) row.end_date = input.end_date
  if (input.status !== undefined) row.status = input.status
  return row
}

/**
 * syncLeaseToRecurringSchedule/pauseLeaseSchedule can fail several shapes: a
 * revenue-account guard rejection (`code` + `details`, from either
 * createRecurringSchedule's own checks or applyRecurringScheduleUpdate's
 * 'validation' stage), a raw DB error surfaced without a code (`dbError`), the
 * refused-auto-recreate report (`stage: 'schedule_deleted'`, no error at all:
 * an operator deleted the linked schedule and this sync did not opt into
 * allowRecreateAfterDelete), or a PostgrestError from one of
 * applyRecurringScheduleUpdate's non-validation failure stages (`error`,
 * header/items_delete/items_insert/link) - the last two of which carry
 * `itemsRestored`/`headerRestored` when a compensation may not have applied,
 * reported as a partial-save failure rather than a clean one.
 */
function syncFailureResponse(
  result: Exclude<Awaited<ReturnType<typeof syncLeaseToRecurringSchedule>>, { ok: true }>,
  log: ExtensionLogger,
) {
  if ('code' in result) {
    return errorResponseFromCode(result.code, log, { details: result.details })
  }
  if ('dbError' in result) {
    return errorResponse(result.dbError, log, {})
  }
  if ('stage' in result && result.stage === 'schedule_deleted') {
    // Not a bug to log loudly here: syncLeaseToRecurringSchedule already
    // logged it. This is the expected, reported response for an operator who
    // deleted the schedule and hasn't yet ended the lease or deliberately
    // resynced it.
    return errorResponseFromCode('LEASE_SCHEDULE_DELETED', log, {})
  }
  if ('itemsRestored' in result && (!result.itemsRestored || !result.headerRestored)) {
    // Mirrors app/api/invoices/recurring/[id]/route.ts: a compensation did not
    // apply, so the schedule may be half-saved. Reporting this as a clean
    // failure would tell the caller nothing changed when it may have.
    log.error('lease schedule update left a partial state', result.error, {
      stage: result.stage,
      itemsRestored: result.itemsRestored,
      headerRestored: result.headerRestored,
    })
    return errorResponseFromCode('INVOICE_RECURRING_UPDATE_PARTIAL', log, {
      details: {
        pgCode: result.error.code,
        stage: result.stage,
        itemsRestored: result.itemsRestored,
        headerRestored: result.headerRestored,
      },
    })
  }
  return errorResponse(result.error, log, {})
}

export const propmateApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/leases',
    handler: async (_req, ctx) => {
      // PostgREST silently caps a plain select at 1000 rows; paginate with a
      // stable total order (created_at is not unique on its own, so id breaks
      // ties) rather than risk truncating a company's lease list.
      let data: unknown[]
      try {
        data = await fetchAllRows(({ from, to }) =>
          ctx!.supabase
            .from('leases')
            .select('*, customer:customers(id,name,email)')
            .eq('company_id', ctx!.companyId)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to),
        )
      } catch (error) {
        return errorResponse(error, ctx!.log, {})
      }
      return NextResponse.json({ data })
    },
  },
  {
    method: 'GET',
    path: '/leases/:id',
    handler: async (req, ctx) => {
      const id = new URL(req.url).searchParams.get('_id')
      if (!id || !UUID_RE.test(id)) {
        return NextResponse.json({ error: 'Lease not found', type: 'not_found' }, { status: 404 })
      }
      const { data, error } = await ctx!.supabase
        .from('leases')
        .select('*, customer:customers(id,name,email)')
        .eq('id', id)
        .eq('company_id', ctx!.companyId)
        .maybeSingle()
      if (error) return errorResponse(error, ctx!.log, {})
      if (!data) return NextResponse.json({ error: 'Lease not found', type: 'not_found' }, { status: 404 })
      return NextResponse.json({ data })
    },
  },
  {
    method: 'POST',
    path: '/leases',
    handler: async (req, ctx) => {
      const { supabase, companyId, userId, log } = ctx!
      let rawBody: unknown
      try {
        rawBody = await req.json()
      } catch {
        return NextResponse.json({ error: 'Invalid JSON in request body', type: 'validation_error' }, { status: 400 })
      }
      const parsed = CreateLeaseSchema.safeParse(rawBody)
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: 'Validation failed',
            type: 'validation_error',
            errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
          },
          { status: 400 },
        )
      }
      const input = parsed.data
      const campaignIssues = checkCampaignAndDates(input)
      if (campaignIssues.length > 0) {
        return NextResponse.json(
          { error: 'Validation failed', type: 'validation_error', errors: campaignIssues },
          { status: 400 },
        )
      }

      const { data: customer } = await supabase
        .from('customers')
        .select('id, email')
        .eq('id', input.customer_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!customer) {
        return NextResponse.json({ error: 'Customer not found', type: 'not_found' }, { status: 404 })
      }

      // Mirrors app/api/invoices/recurring/route.ts: auto_send without a
      // customer email would silently degrade to a monthly draft + warning at
      // cron time. Reject it up front instead of letting the schedule write
      // path drift from the core route's guard.
      if (input.auto_send && !customer.email) {
        return NextResponse.json(
          {
            error: 'Customer has no email address: automatic sending requires one',
            type: 'validation_error',
          },
          { status: 400 },
        )
      }

      const { data: lease, error: insertError } = await supabase
        .from('leases')
        .insert({
          company_id: companyId,
          user_id: userId,
          customer_id: input.customer_id,
          property_name: input.property_name,
          unit_description: input.unit_description ?? null,
          monthly_rent: input.monthly_rent,
          additions: input.additions,
          campaign_price_amount: input.campaign_price_amount ?? null,
          campaign_start_date: input.campaign_start_date ?? null,
          campaign_end_date: input.campaign_end_date ?? null,
          kpi_base_index: input.kpi_base_index ?? null,
          kpi_base_year: input.kpi_base_year ?? null,
          kpi_next_review_date: input.kpi_next_review_date ?? null,
          vat_rate: input.vat_rate,
          revenue_account: input.revenue_account ?? null,
          day_of_month: input.day_of_month,
          auto_send: input.auto_send,
          start_date: input.start_date,
          end_date: input.end_date ?? null,
        })
        .select('*')
        .single<LeaseRow>()

      if (insertError || !lease) {
        log.error('failed to insert lease', insertError)
        return errorResponse(insertError, log, {})
      }

      const synced = await syncLeaseToRecurringSchedule(supabase, lease)
      if (!synced.ok) {
        // First sync failed (typically an invalid revenue_account, caught
        // here even though the schema already narrows to class 3, since the
        // chart-membership check needs the DB): the lease row exists but is
        // not billable and never will be without another sync. Leaving it in
        // place would make a client's natural reaction - retry the POST -
        // create a SECOND lease (no unique constraint on this table), which
        // the daily resync cron then turns into a second schedule and double
        // bills the tenant every month: the same failure class round 9 fixed
        // one layer down for the schedule back-link write. Roll the lease
        // back so a retry starts clean instead of piling up duplicates.
        const { error: cleanupError } = await supabase
          .from('leases')
          .delete()
          .eq('id', lease.id)
          .eq('company_id', companyId)
        if (cleanupError) {
          log.error('lease sync failed and the lease row could not be rolled back', cleanupError, {
            leaseId: lease.id,
          })
        }
        return syncFailureResponse(synced, log)
      }

      const { data: complete } = await supabase
        .from('leases')
        .select('*, customer:customers(id,name,email)')
        .eq('id', lease.id)
        .eq('company_id', companyId)
        .single()

      return NextResponse.json({ data: complete }, { status: 201 })
    },
  },
  {
    method: 'PATCH',
    path: '/leases/:id',
    handler: async (req, ctx) => {
      const id = new URL(req.url).searchParams.get('_id')
      const { supabase, companyId, log } = ctx!
      if (!id || !UUID_RE.test(id)) {
        return NextResponse.json({ error: 'Lease not found', type: 'not_found' }, { status: 404 })
      }
      let rawBody: unknown
      try {
        rawBody = await req.json()
      } catch {
        return NextResponse.json({ error: 'Invalid JSON in request body', type: 'validation_error' }, { status: 400 })
      }
      const parsed = UpdateLeaseSchema.safeParse(rawBody)
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: 'Validation failed',
            type: 'validation_error',
            errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
          },
          { status: 400 },
        )
      }
      const input = parsed.data

      const { data: existing } = await supabase
        .from('leases')
        .select('*')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle<LeaseRow>()
      if (!existing) {
        return NextResponse.json({ error: 'Lease not found', type: 'not_found' }, { status: 404 })
      }

      // Merge onto the EXISTING row before checking the campaign triple: a
      // PATCH that only changes campaign_end_date must be validated against
      // the lease's current campaign_price_amount/campaign_start_date, not
      // against "undefined" for the fields this request didn't touch.
      const merged: LeaseRow = { ...existing, ...input }
      const campaignIssues = checkCampaignAndDates(merged)
      if (campaignIssues.length > 0) {
        return NextResponse.json(
          { error: 'Validation failed', type: 'validation_error', errors: campaignIssues },
          { status: 400 },
        )
      }

      // A single lookup covers both checks: the customer_id existence check,
      // and the auto_send-requires-email backstop. Only runs when THIS PATCH
      // actually turns auto_send on or changes the customer, mirroring
      // app/api/invoices/recurring/[id]/route.ts exactly: an unrelated edit
      // (rent, day_of_month) on a lease whose auto_send was already true must
      // not start failing just because the customer's email was removed
      // sometime after that was set.
      if (input.customer_id !== undefined || input.auto_send === true) {
        const { data: customer } = await supabase
          .from('customers')
          .select('id, email')
          .eq('id', merged.customer_id)
          .eq('company_id', companyId)
          .maybeSingle()
        if (!customer) {
          return NextResponse.json({ error: 'Customer not found', type: 'not_found' }, { status: 404 })
        }
        const effectiveAutoSend = input.auto_send ?? existing.auto_send
        if (effectiveAutoSend && !customer.email) {
          return NextResponse.json(
            {
              error: 'Customer has no email address: automatic sending requires one',
              type: 'validation_error',
            },
            { status: 400 },
          )
        }
      }

      const updateRow = leaseUpdateRow(input)

      const { data: updated, error: updateError } = await supabase
        .from('leases')
        .update(updateRow)
        .eq('id', id)
        .eq('company_id', companyId)
        .select('*')
        .single<LeaseRow>()

      if (updateError || !updated) {
        log.error('failed to update lease', updateError)
        return errorResponse(updateError, log, {})
      }

      // Mirrors the POST /leases rollback (round 13) one write path up: PATCH
      // persists the lease row BEFORE syncing, so a rejected revenue_account
      // (or any other sync/pause failure) must not leave the row showing
      // values the schedule was never actually updated to reflect. Left in
      // place, that is a silent under/over-billing gap - worse than a plain
      // failed request, since nothing in the 4xx response tells the caller
      // their PATCH partially "succeeded". Revert exactly the columns this
      // PATCH touched (including a status transition) back to their
      // pre-request values so a retry starts from the row the caller was
      // actually told they have.
      const revertPatchOnFailure = async () => {
        const revertRow: Record<string, unknown> = {}
        for (const key of Object.keys(updateRow)) {
          revertRow[key] = (existing as unknown as Record<string, unknown>)[key]
        }
        const { error: rollbackError } = await supabase
          .from('leases')
          .update(revertRow)
          .eq('id', id)
          .eq('company_id', companyId)
        if (rollbackError) {
          log.error('lease sync failed and the lease row could not be rolled back', rollbackError, { leaseId: id })
        }
      }

      if (updated.status === 'active') {
        // Only resume a schedule pauseLeaseSchedule paused when THIS request
        // is the ended -> active re-let transition itself: an unrelated PATCH
        // to an already-active lease (or the daily resync cron, which never
        // sets this option) must not un-pause a schedule an operator
        // deliberately paused on the core recurring-invoice page.
        const resumeSchedule = existing.status === 'ended'
        // Only push auto_send onto the schedule when THIS request actually
        // changed it: an unrelated PATCH (rent, tillägg, day_of_month) must
        // not echo the lease's own auto_send back over whatever an operator
        // last set directly on the core recurring-invoice page.
        const syncAutoSend = input.auto_send !== undefined
        // Also opt into recreating a deleted schedule, but ONLY on this same
        // observed ended -> active transition: LEASE_SYNC_ENDED's remediation
        // tells the caller to reactivate the lease here, and without this an
        // ended lease whose schedule was also deleted had no way back at all
        // (POST /sync refuses while status is 'ended'; this PATCH used to
        // refuse with LEASE_SCHEDULE_DELETED and revert the status right back
        // to 'ended', a closed loop with no stated recovery). Reactivating an
        // ended lease is at least as deliberate a "recreate it" decision as
        // calling /sync directly, and this can never fire from the daily cron
        // or an unrelated field edit: only resumeSchedule's own condition.
        const synced = await syncLeaseToRecurringSchedule(supabase, updated, undefined, {
          resumeSchedule,
          syncAutoSend,
          allowRecreateAfterDelete: resumeSchedule,
        })
        if (!synced.ok) {
          await revertPatchOnFailure()
          return syncFailureResponse(synced, log)
        }
      } else if (updated.status === 'ended') {
        // Stop the fakturamotor: a departed tenant must not keep receiving
        // rent invoices just because the lease row itself was closed out.
        const paused = await pauseLeaseSchedule(supabase, updated)
        if (!paused.ok) {
          await revertPatchOnFailure()
          return syncFailureResponse(paused, log)
        }
      }

      const { data: complete } = await supabase
        .from('leases')
        .select('*, customer:customers(id,name,email)')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()

      return NextResponse.json({ data: complete })
    },
  },
  {
    method: 'POST',
    path: '/leases/:id/sync',
    handler: async (req, ctx) => {
      const id = new URL(req.url).searchParams.get('_id')
      const { supabase, companyId } = ctx!
      if (!id || !UUID_RE.test(id)) {
        return NextResponse.json({ error: 'Lease not found', type: 'not_found' }, { status: 404 })
      }
      const { data: lease } = await supabase
        .from('leases')
        .select('*')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle<LeaseRow>()
      if (!lease) {
        return NextResponse.json({ error: 'Lease not found', type: 'not_found' }, { status: 404 })
      }
      // Refuse before the sync engine ever runs: an ended lease must never
      // get a new active schedule, and allowRecreateAfterDelete below would
      // otherwise happily provision one for an ended lease whose schedule
      // was also deleted (recurring_schedule_id NULL), resuming billing for
      // a tenant the operator already ended.
      if (lease.status === 'ended') {
        return errorResponseFromCode('LEASE_SYNC_ENDED', ctx!.log, {})
      }
      // A human explicitly calling /sync after a schedule was deleted (rather
      // than the daily cron reaching the same lease unattended) IS the
      // deliberate "recreate it" decision the operator-answered question
      // requires: this is the only call site that sets this option.
      const synced = await syncLeaseToRecurringSchedule(supabase, lease, undefined, {
        allowRecreateAfterDelete: true,
      })
      if (!synced.ok) return syncFailureResponse(synced, ctx!.log)
      return NextResponse.json({ data: { scheduleId: synced.scheduleId } })
    },
  },
]
