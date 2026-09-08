import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { UpdateRecurringScheduleSchema } from '@/lib/api/schemas'
import { applyRecurringScheduleUpdate } from '@/lib/invoices/apply-recurring-schedule-update'
import {
  computeInitialRunDate,
  computeNextRunDate,
  rollNextRunDateForward,
  getStockholmDateHour,
} from '@/lib/invoices/recurring-schedule-service'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

ensureInitialized()

export const GET = withRouteContext(
  'recurring_invoice.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log } = ctx
    const { data, error } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, customer:customers(*), items:recurring_invoice_schedule_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !data) {
      log.warn('recurring schedule not found', { scheduleId: id })
      return NextResponse.json(
        { error: 'Schedule not found', type: 'not_found' },
        { status: 404 },
      )
    }
    return NextResponse.json({ data })
  },
)

export const PATCH = withRouteContext(
  'recurring_invoice.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', type: 'validation_error' },
        { status: 400 },
      )
    }

    const parsed = UpdateRecurringScheduleSchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          type: 'validation_error',
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        },
        { status: 400 },
      )
    }
    const input = parsed.data
    const { items, ...scheduleFields } = input

    // A lease-managed schedule is rebuilt from the lease row every night by
    // the propmate resync cron (extensions/general/propmate/lib/lease-schedule-sync.ts),
    // which always wins because it runs unattended after this route would
    // have run. That resync (syncLeaseToRecurringSchedule) unconditionally
    // rewrites customer_id/name/day_of_month (and, with items, the rent/
    // tillägg lines) on every pass, so an edit to any of those here would
    // look like it worked and then get silently reverted before the next
    // invoice goes out. status/auto_send are NOT at risk: the resync only
    // touches them via an explicit opt-in the cron never sets (resumeSchedule/
    // syncAutoSend, PATCH /leases/:id only), so a header-only status toggle
    // (the pause button on this page) is safe to let through. Refuse instead
    // of letting the unsafe fields race: the operator edits the lease (PATCH
    // /leases/:id), which pushes the same change through the one write path
    // both routes share. Core must not import from @/extensions/, so this is
    // a direct table read gated on the extension actually being enabled,
    // same pattern as lib/notices/categories.ts's detectLeaseScheduleGap.
    const LEASE_MANAGED_FIELDS = ['customer_id', 'name', 'day_of_month'] as const
    const touchesLeaseManagedField =
      items !== undefined || LEASE_MANAGED_FIELDS.some((field) => field in scheduleFields)
    if (touchesLeaseManagedField && ENABLED_EXTENSION_IDS.has('propmate')) {
      const { data: managingLease, error: leaseError } = await supabase
        .from('leases')
        .select('id')
        .eq('recurring_schedule_id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (leaseError) {
        // Fail closed, not open: a PostgREST error here (including "more than
        // one row" if a data bug ever links two leases to one schedule) must
        // not be read as "no managing lease" and let the exact silent
        // override through that this guard exists to stop.
        log.error('failed to check lease-managed guard', leaseError)
        return errorResponse(leaseError, log, { requestId })
      }
      if (managingLease) {
        return errorResponseFromCode('SCHEDULE_MANAGED_BY_LEASE', log, {
          requestId,
          details: { leaseId: managingLease.id },
        })
      }
    }

    // Only forward fields the user actually supplied.
    const updateRow: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(scheduleFields)) {
      if (v !== undefined) updateRow[k] = v
    }

    // Turning auto_send on (or moving the schedule to another customer while
    // it is on) requires the customer to have an email address; otherwise
    // every cron run degrades to a draft + warning. Mirrors the create
    // route's guard.
    if (input.auto_send === true || input.customer_id !== undefined) {
      const { data: current } = await supabase
        .from('recurring_invoice_schedules')
        .select('auto_send, customer_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()

      if (!current) {
        return NextResponse.json(
          { error: 'Schedule not found', type: 'not_found' },
          { status: 404 },
        )
      }

      const effectiveAutoSend = input.auto_send ?? current.auto_send
      if (effectiveAutoSend) {
        const { data: customer } = await supabase
          .from('customers')
          .select('email')
          .eq('id', input.customer_id ?? current.customer_id)
          .eq('company_id', companyId)
          .maybeSingle()

        if (!customer?.email) {
          return NextResponse.json(
            {
              error: 'Customer has no email address: automatic sending requires one',
              type: 'validation_error',
            },
            { status: 400 },
          )
        }
      }
    }

    // Recompute next_run_date when either the schedule is being reactivated
    // (from a stale date) or its day-of-month actually changed via an edit.
    if (input.status === 'active' || input.day_of_month !== undefined) {
      const { data: existing } = await supabase
        .from('recurring_invoice_schedules')
        .select('next_run_date, day_of_month, interval_months')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()

      if (!existing) {
        return NextResponse.json(
          { error: 'Schedule not found', type: 'not_found' },
          { status: 404 },
        )
      }

      const reactivating = input.status === 'active'
      const dayChanged =
        input.day_of_month !== undefined && input.day_of_month !== existing.day_of_month
      const effectiveDay = input.day_of_month ?? existing.day_of_month
      const effectiveInterval = input.interval_months ?? existing.interval_months ?? 1
      const { date: todayStockholm } = getStockholmDateHour(new Date())
      const stockholmToday = new Date(`${todayStockholm}T00:00:00Z`)

      // Recompute to the next STRICTLY-future occurrence (never today, so an
      // edit or reactivation can't trigger a same-hour surprise send; today's
      // invoice is the explicit run-now action instead) when either:
      //   - reactivating a schedule whose date already passed (e.g. the safety
      //     pause when the send-hour cron shipped), or
      //   - the day-of-month changed, so "Nästa körning" follows the new day.
      // Editing other fields (name, items, time, interval) leaves
      // next_run_date alone, so an unrelated edit never skips an imminent
      // send; a changed interval applies from the next run onward.
      const staleOnReactivate = reactivating && existing.next_run_date <= todayStockholm
      if (staleOnReactivate || dayChanged) {
        if (effectiveInterval === 1) {
          // Monthly keeps its long-standing semantics: re-anchor on today so
          // a day edit lands on the new day's nearest future occurrence.
          const rolled = computeInitialRunDate(stockholmToday, effectiveDay)
          updateRow.next_run_date =
            rolled === todayStockholm
              ? computeNextRunDate(stockholmToday, effectiveDay)
              : rolled
        } else {
          // Interval schedules roll on their own month grid so a day edit or
          // reactivation cannot shift a quarterly schedule off its
          // Jan/Apr/Jul/Oct phase (or bill a quarter early).
          updateRow.next_run_date = rollNextRunDateForward(
            existing.next_run_date,
            stockholmToday,
            effectiveDay,
            effectiveInterval,
          )
        }
      }

      // A conscious reactivation invalidates any lingering warning (the
      // safety-pause note, or a stale failure from months ago).
      if (reactivating) {
        updateRow.last_run_warning = null
      }
    }

    // Existence check BEFORE any write: with items in the payload the request
    // writes two tables, so a 404 must not leave a header update behind.
    if (items) {
      const { data: existing } = await supabase
        .from('recurring_invoice_schedules')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()

      if (!existing) {
        return NextResponse.json(
          { error: 'Schedule not found', type: 'not_found' },
          { status: 404 },
        )
      }
    }

    // Items are replaced wholesale. Cheaper than diffing for a small list and
    // matches how the UI form sends the full list back on every save. Both
    // writes are compensated on failure inside the shared helper.
    const result = await applyRecurringScheduleUpdate(supabase, {
      scheduleId: id,
      companyId,
      fields: updateRow,
      items,
      log,
    })

    if (!result.ok) {
      if (result.stage === 'validation') {
        if ('dbError' in result) {
          log.error('recurring schedule item revenue-account check failed on a DB lookup', result.dbError as Error)
          return errorResponse(result.dbError, log, { requestId })
        }
        return errorResponseFromCode(result.code, log, { requestId, details: result.details })
      }
      if (result.stage === 'header') {
        log.error('failed to update recurring schedule', result.error)
        return errorResponse(result.error, log, { requestId })
      }
      if (!result.itemsRestored || !result.headerRestored) {
        // A compensation did not apply, so the schedule may be half-saved: say
        // so instead of reporting a clean failure. Logged here with the repair
        // context (errorResponseFromCode only records the code itself), which
        // the clean-rollback path below does not need.
        log.error('recurring schedule update left a partial state', result.error, {
          scheduleId: id,
          stage: result.stage,
          itemsRestored: result.itemsRestored,
          headerRestored: result.headerRestored,
        })
        return errorResponseFromCode('INVOICE_RECURRING_UPDATE_PARTIAL', log, {
          requestId,
          // camelCase throughout, matching the pgCode key errorResponse itself
          // merges into details for Postgres failures.
          details: {
            pgCode: result.error.code,
            stage: result.stage,
            itemsRestored: result.itemsRestored,
            headerRestored: result.headerRestored,
          },
        })
      }
      // Clean rollback: keep the PG-mapped error so a CHECK violation still
      // surfaces its specific Swedish message. errorResponse logs it, so no
      // second log line here.
      return errorResponse(result.error, log, { requestId })
    }

    const { data: complete } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, customer:customers(*), items:recurring_invoice_schedule_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    return NextResponse.json({ data: complete })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'recurring_invoice.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    // Items cascade-delete via FK ON DELETE CASCADE.
    const { error } = await supabase
      .from('recurring_invoice_schedules')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      log.error('failed to delete recurring schedule', error)
      return errorResponse(error, log, { requestId })
    }
    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
