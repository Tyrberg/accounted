import type { SupabaseClient } from '@supabase/supabase-js'
import type { PostgrestError } from '@supabase/supabase-js'
import { createRecurringSchedule, type CreateRecurringScheduleResult } from '@/lib/invoices/create-recurring-schedule'
import {
  applyRecurringScheduleUpdate,
  type ApplyRecurringScheduleUpdateResult,
  type RecurringScheduleItemInput,
} from '@/lib/invoices/apply-recurring-schedule-update'
import { createLogger } from '@/lib/logger'
import {
  computeInitialRunDate,
  computeNextRunDate,
  getStockholmDateHour,
} from '@/lib/invoices/recurring-schedule-service'
import type { LeaseAddition } from './schemas'

const log = createLogger('propmate/lease-schedule-sync')

export interface LeaseRow {
  id: string
  company_id: string
  user_id: string
  customer_id: string
  property_name: string
  unit_description: string | null
  monthly_rent: number
  additions: LeaseAddition[]
  campaign_price_amount: number | null
  campaign_start_date: string | null
  campaign_end_date: string | null
  vat_rate: 0 | 25
  revenue_account: string | null
  day_of_month: number
  auto_send: boolean
  start_date: string
  end_date: string | null
  status: 'active' | 'ended'
  recurring_schedule_id: string | null
  /**
   * Set by createRecurringSchedule's link write or stampSynced() on every
   * successful sync; NEVER cleared once set (the schedule's own FK is what
   * goes NULL on delete, not this). That asymmetry is what lets
   * syncLeaseToRecurringSchedule tell "never synced" (both NULL) apart from
   * "was synced, schedule since deleted by an operator" (this set,
   * recurring_schedule_id NULL): see the last-synced-but-unlinked check
   * there.
   */
  last_synced_at: string | null
}

/**
 * True when `today` (yyyy-mm-dd) falls within the lease's active kampanjpris
 * window. The campaign fields are all-or-nothing (DB CHECK
 * leases_campaign_triple), so checking one is enough once it's non-null.
 */
export function isCampaignActive(lease: LeaseRow, todayIso: string): boolean {
  return (
    lease.campaign_price_amount != null &&
    !!lease.campaign_start_date &&
    !!lease.campaign_end_date &&
    todayIso >= lease.campaign_start_date &&
    todayIso <= lease.campaign_end_date
  )
}

/**
 * Build the recurring-schedule line items for a lease's CURRENT state: the
 * base rent line (kampanjpris overrides monthly_rent while its window is
 * active, otherwise monthly_rent) followed by one line per tillägg
 * (addition), so each supplement stays individually visible on the invoice
 * and in the ledger rather than folded into a lump sum.
 *
 * Every line shares the lease's vat_rate and revenue_account: propmate never
 * generates a per-addition VAT rate or account, only per-lease ones.
 */
export function buildLeaseScheduleItems(lease: LeaseRow, today: Date): RecurringScheduleItemInput[] {
  // Stockholm date, not UTC: campaign windows are calendar-day boundaries in
  // the tenant's local time, and next_run_date elsewhere in this file is
  // already derived via getStockholmDateHour. Using UTC here would put an
  // interactive sync just after Stockholm midnight one day behind, shifting
  // a campaign start/end by a day.
  const todayIso = getStockholmDateHour(today).date
  const rentAmount = isCampaignActive(lease, todayIso) ? lease.campaign_price_amount! : lease.monthly_rent

  const items: RecurringScheduleItemInput[] = [
    {
      description: lease.unit_description ? `Hyra: ${lease.unit_description}` : 'Hyra',
      quantity: 1,
      unit: 'mån',
      unit_price: rentAmount,
      vat_rate: lease.vat_rate,
      revenue_account: lease.revenue_account,
    },
  ]

  for (const addition of lease.additions) {
    items.push({
      description: addition.description,
      quantity: 1,
      unit: 'mån',
      unit_price: addition.amount,
      vat_rate: lease.vat_rate,
      revenue_account: lease.revenue_account,
    })
  }

  return items
}

export type SyncLeaseResult =
  | { ok: true; scheduleId: string }
  | (Extract<CreateRecurringScheduleResult, { ok: false }>)
  | (Extract<ApplyRecurringScheduleUpdateResult, { ok: false }>)
  | { ok: false; stage: 'link'; error: PostgrestError }
  | { ok: false; stage: 'schedule_deleted' }

export interface SyncLeaseOptions {
  /**
   * Resume a schedule pauseLeaseSchedule previously paused: a re-let unit
   * (PATCH status: 'ended' then later 'active') must be able to undo that
   * pause, or the schedule stays paused forever with no error anywhere
   * (app/api/invoices/recurring/cron/route.ts only ever selects
   * status: 'active' schedules). Defaults to false so every OTHER caller of
   * this function, in particular the daily resync cron and the manual /sync
   * route, cannot un-pause a schedule an operator deliberately paused on the
   * core recurring-invoice page: that pause has no lease-level counterpart
   * (leases have no 'paused' status, only 'active'/'ended'), so forcing
   * status: 'active' on every sync of every active lease resumed billing a
   * tenant the operator had just stopped billing. Callers must set this
   * ONLY when they have positively observed the lease's own status transition
   * from 'ended' to 'active' (see the PATCH /leases/:id handler), never from
   * a lease's steady-state 'active' value alone.
   */
  resumeSchedule?: boolean
  /**
   * Deliberately provision a NEW schedule for a lease whose linked schedule
   * was deleted (recurring_schedule_id NULL via the FK's ON DELETE SET NULL,
   * last_synced_at NOT NULL because it WAS synced before: see the
   * last-synced-but-unlinked check below). Defaults to false so an operator
   * who deletes a lease's schedule on the core recurring-invoice page has
   * that decision actually stick: the daily resync cron and every other
   * automatic caller must never treat "schedule deleted" the same as "never
   * synced yet" and silently re-provision a second schedule that resumes
   * billing (and, with auto_send, re-emails the tenant) a lease the operator
   * had just stopped. Only POST /leases/:id/sync sets this, since a human
   * hitting that endpoint after a deletion is the one action that IS a
   * deliberate "recreate the schedule" decision. See CLAUDE.md decision log,
   * 2026-09-07 operator answer on this exact question.
   */
  allowRecreateAfterDelete?: boolean
  /**
   * Push lease.auto_send onto an EXISTING schedule's header. Defaults to
   * false so every automatic caller (the daily resync cron, in particular)
   * cannot undo an operator's auto_send toggle on the core recurring-invoice
   * page: that toggle has no lease-level counterpart the operator edits, so
   * without this guard every unattended resync (kampanjpris transitions,
   * tillägg edits) would silently write the lease's OWN auto_send back over
   * whatever the operator last set directly on the schedule, exactly the
   * failure class this same function already refuses for `status` via
   * resumeSchedule above. Only PATCH /leases/:id sets this, and only when the
   * request itself actually changed auto_send (input.auto_send !== undefined):
   * that is the one call site where the new value being written IS the
   * operator's own just-made decision, not a stale echo of the lease row.
   * Irrelevant on first sync (createRecurringSchedule below always sets the
   * header's initial auto_send from the lease, which is provisioning, not an
   * overwrite of anything).
   */
  syncAutoSend?: boolean
}

/**
 * Create or update the recurring invoice schedule linked to a lease.
 *
 * Single write path, deliberately: this calls the SAME
 * createRecurringSchedule / applyRecurringScheduleUpdate functions the manual
 * recurring-invoice UI routes use (lib/invoices/create-recurring-schedule.ts,
 * apply-recurring-schedule-update.ts), rather than writing schedule/item rows
 * itself. That is what guarantees validate-schedule-revenue-accounts.ts runs
 * on every lease sync, including the FIRST one (before recurring_schedule_id
 * exists): there is no second, propmate-only insert path that could validate
 * a revenue_account override differently (or not at all).
 *
 * Called from the create/update API routes (interactive) and from the daily
 * resync cron (kampanjpris start/end transitions, tillägg edits) alike.
 */
export async function syncLeaseToRecurringSchedule(
  supabase: SupabaseClient,
  lease: LeaseRow,
  today: Date = new Date(),
  options: SyncLeaseOptions = {},
): Promise<SyncLeaseResult> {
  const items = buildLeaseScheduleItems(lease, today)
  const name = lease.unit_description
    ? `Hyra: ${lease.property_name} - ${lease.unit_description}`
    : `Hyra: ${lease.property_name}`

  if (lease.recurring_schedule_id) {
    const fields: Record<string, unknown> = {
      customer_id: lease.customer_id,
      name,
      day_of_month: lease.day_of_month,
    }

    if (lease.status === 'active' && options.resumeSchedule) {
      fields.status = 'active'
    }

    if (options.syncAutoSend) {
      fields.auto_send = lease.auto_send
    }

    // Recompute next_run_date when the billing day actually changed, same as
    // app/api/invoices/recurring/[id]/route.ts, so a changed day_of_month
    // takes effect immediately instead of billing on the old day for one more
    // cycle. Lease schedules are always monthly (interval_months: 1, set at
    // creation below), so this only needs the interval-1 branch of that route.
    const { data: existingSchedule } = await supabase
      .from('recurring_invoice_schedules')
      .select('day_of_month')
      .eq('id', lease.recurring_schedule_id)
      .eq('company_id', lease.company_id)
      .maybeSingle()
    if (existingSchedule && existingSchedule.day_of_month !== lease.day_of_month) {
      const { date: todayStockholm } = getStockholmDateHour(today)
      const stockholmToday = new Date(`${todayStockholm}T00:00:00Z`)
      const rolled = computeInitialRunDate(stockholmToday, lease.day_of_month)
      fields.next_run_date =
        rolled === todayStockholm ? computeNextRunDate(stockholmToday, lease.day_of_month) : rolled
    }

    const result = await applyRecurringScheduleUpdate(supabase, {
      scheduleId: lease.recurring_schedule_id,
      companyId: lease.company_id,
      fields,
      items,
      log,
    })
    if (!result.ok) return result

    await stampSynced(supabase, lease)
    return { ok: true, scheduleId: lease.recurring_schedule_id }
  }

  // recurring_schedule_id is NULL here. That is ambiguous on its own: it is
  // both the "never synced yet" state (fresh lease, last_synced_at also NULL)
  // AND the "an operator deleted the linked schedule on the core
  // recurring-invoice page" state (the FK is ON DELETE SET NULL, but
  // last_synced_at survives the delete since nothing here touches it).
  // last_synced_at is what tells the two apart: it is only ever set by a
  // successful sync (createRecurringSchedule's link write, or stampSynced
  // above), so a NULL schedule id alongside a NON-NULL last_synced_at can
  // only mean the second case. Treat it as "billing intentionally stopped",
  // not "provision one": the cron and every other automatic caller must
  // never undo an operator's delete.
  if (lease.last_synced_at && !options.allowRecreateAfterDelete) {
    log.error('lease schedule was deleted; refusing to auto-recreate', {
      leaseId: lease.id,
      companyId: lease.company_id,
      lastSyncedAt: lease.last_synced_at,
    })
    // Bump last_synced_at even on this refusal: the daily cron pages active
    // leases ordered by last_synced_at ASC NULLS FIRST (oldest/never-synced
    // first), and this branch otherwise never reaches stampSynced. Left
    // untouched, a schedule_deleted lease keeps today's (or an even older)
    // sort key forever, so it re-sorts to the FRONT of every future run; once
    // >= BATCH_SIZE such leases accumulate, no other lease is ever picked up
    // again. The gap itself is still reported every run (the caller's
    // per-item failure summary, and the lease_schedule_gap notice), just no
    // longer at the cost of starving the rest of the batch.
    await stampSynced(supabase, lease)
    return { ok: false, stage: 'schedule_deleted' }
  }

  // computeInitialRunDate returns an explicit start_date VERBATIM as
  // next_run_date, bypassing the day_of_month-based "next future occurrence"
  // logic entirely. That is correct for a lease whose contract genuinely
  // starts in the future (bill exactly on that date), but wrong for
  // onboarding an EXISTING contract whose start_date is already in the past:
  // the schedule would get a next_run_date years in the past, which the core
  // recurring cron then rolls forward while stamping a last_run_warning
  // ("Ingen faktura skapades den ...") on a lease that was never actually
  // overdue. Only pass start_date through when it is strictly in the future;
  // otherwise fall back to the same day_of_month-based computation a
  // brand-new lease with no start_date gets.
  const { date: todayIsoForStart } = getStockholmDateHour(today)
  const created = await createRecurringSchedule(supabase, {
    companyId: lease.company_id,
    userId: lease.user_id,
    input: {
      customer_id: lease.customer_id,
      name,
      day_of_month: lease.day_of_month,
      interval_months: 1,
      send_hour: 8,
      payment_terms_days: 30,
      currency: 'SEK',
      auto_send: lease.auto_send,
      start_date: lease.start_date > todayIsoForStart ? lease.start_date : undefined,
      items,
    },
  })
  if (!created.ok) return created

  // Atomic claim, not a plain write: two concurrent callers can both observe
  // recurring_schedule_id NULL and both reach this point (the daily cron and
  // a manual POST /leases/:id/sync racing after an operator delete is the
  // realistic case, since nothing serializes them). Filtering the update on
  // .is('recurring_schedule_id', null) makes Postgres itself the arbiter:
  // only the request whose UPDATE still finds the row unlinked actually
  // writes it, same compare-and-swap idea as the rest of the codebase's
  // optimistic-concurrency writes. The loser's UPDATE matches zero rows
  // (returned via .select(), since PostgREST reports "no matching rows" as
  // an empty array, not an error) and must clean up the schedule it already
  // created instead of leaving a second, unlinked, still-active schedule
  // billing the tenant.
  const { data: linkedRows, error: linkError } = await supabase
    .from('leases')
    .update({ recurring_schedule_id: created.scheduleId, last_synced_at: new Date().toISOString() })
    .eq('id', lease.id)
    .eq('company_id', lease.company_id)
    .is('recurring_schedule_id', null)
    .select('id')

  const claimLost = !linkError && (!linkedRows || linkedRows.length === 0)

  if (linkError || claimLost) {
    // The schedule was created but the back-link write failed (or lost the
    // atomic claim above): leaving recurring_schedule_id NULL would make
    // every later sync (including the daily cron, which pages leases with
    // recurring_schedule_id/last_synced_at still NULL) take the "first sync"
    // branch again and create a SECOND schedule, multiplying the tenant's
    // invoices. Delete the orphan schedule instead so a retry starts clean,
    // and surface this as a real failure rather than swallowing it as ok: true.
    const { error: cleanupError } = await supabase
      .from('recurring_invoice_schedules')
      .delete()
      .eq('id', created.scheduleId)
      .eq('company_id', lease.company_id)
    let pauseError: PostgrestError | undefined
    if (cleanupError) {
      // The delete ALSO failed: the orphan schedule (nothing pointing at it,
      // since the back-link write is what just failed) would otherwise sit
      // 'active' and, with auto_send, keep emailing the tenant, with only
      // this log line as the record. Best-effort pause it instead so at
      // minimum it stops billing; still reported as a failure below either
      // way, since neither the lease nor an operator has a working link to
      // the schedule to resync or delete it properly.
      const pauseResult = await applyRecurringScheduleUpdate(supabase, {
        scheduleId: created.scheduleId,
        companyId: lease.company_id,
        fields: { status: 'paused' },
        log,
      })
      if (!pauseResult.ok && 'error' in pauseResult) pauseError = pauseResult.error
    }
    const effectiveError: PostgrestError =
      linkError ??
      Object.assign(new Error('lease already has a linked schedule: a concurrent sync claimed it first'), {
        code: 'PROPMATE_CONCURRENT_SYNC_LOST',
        details: '',
        hint: '',
      } as Omit<PostgrestError, 'message' | 'name'>) as unknown as PostgrestError
    log.error('lease created a schedule but failed to store the back-link; schedule rolled back', effectiveError, {
      leaseId: lease.id,
      scheduleId: created.scheduleId,
      claimLost,
      cleanupError: cleanupError ?? undefined,
      pauseError: pauseError ?? undefined,
    })
    return { ok: false, stage: 'link', error: effectiveError }
  }

  return { ok: true, scheduleId: created.scheduleId }
}

export type PauseLeaseScheduleResult =
  | { ok: true }
  | (Extract<ApplyRecurringScheduleUpdateResult, { ok: false }>)

/**
 * Pause the recurring schedule linked to an ended lease, so the fakturamotor
 * stops billing a departed tenant. A lease with status 'ended' but no
 * recurring_schedule_id yet (never synced) has nothing to pause.
 *
 * Uses the same applyRecurringScheduleUpdate write path as an interactive
 * pause on the recurring-invoice page, header-only (no items argument), so it
 * cannot drift from that behaviour.
 */
export async function pauseLeaseSchedule(
  supabase: SupabaseClient,
  lease: LeaseRow,
): Promise<PauseLeaseScheduleResult> {
  if (!lease.recurring_schedule_id) return { ok: true }

  const result = await applyRecurringScheduleUpdate(supabase, {
    scheduleId: lease.recurring_schedule_id,
    companyId: lease.company_id,
    fields: { status: 'paused' },
    log,
  })
  if (!result.ok) return result
  return { ok: true }
}

export type ExpireLeaseResult =
  | { expired: false }
  | { expired: true; ok: true }
  | { expired: true; ok: false; error: string }

/**
 * Stop billing a lease whose end_date has passed. `leases.end_date` is stored
 * and DB CHECK/schema validated (leases_end_after_start) but nothing else
 * reads it: an active lease left past its end_date would otherwise keep
 * generating rent invoices every month, the same "billing a departed tenant"
 * failure pauseLeaseSchedule targets for an explicit status: 'ended' PATCH,
 * reached instead through the field the data model advertises for it. Called
 * by the daily resync cron before syncing, since that is the only place that
 * revisits every active lease on its own.
 *
 * Marks the lease 'ended' (not just the schedule 'paused') so it drops out of
 * the cron's own `status = 'active'` query and is never re-evaluated here
 * again, matching what a manual PATCH {status: 'ended'} does.
 */
export async function expireLeaseIfPastEndDate(
  supabase: SupabaseClient,
  lease: LeaseRow,
  today: Date = new Date(),
): Promise<ExpireLeaseResult> {
  const todayIso = getStockholmDateHour(today).date
  if (!lease.end_date || lease.end_date >= todayIso) return { expired: false }

  const paused = await pauseLeaseSchedule(supabase, lease)
  if (!paused.ok) {
    const message =
      'code' in paused ? paused.code : 'dbError' in paused ? paused.dbError.message : paused.error.message
    return { expired: true, ok: false, error: message }
  }

  const { error } = await supabase
    .from('leases')
    .update({ status: 'ended' })
    .eq('id', lease.id)
    .eq('company_id', lease.company_id)
  if (error) return { expired: true, ok: false, error: error.message }

  return { expired: true, ok: true }
}

async function stampSynced(supabase: SupabaseClient, lease: LeaseRow): Promise<void> {
  const { error } = await supabase
    .from('leases')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', lease.id)
    .eq('company_id', lease.company_id)
  if (error) {
    log.error('failed to stamp lease last_synced_at', error, { leaseId: lease.id })
  }
}
