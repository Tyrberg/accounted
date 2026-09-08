import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  syncLeaseToRecurringSchedule,
  expireLeaseIfPastEndDate,
  type LeaseRow,
} from '@/extensions/general/propmate/lib/lease-schedule-sync'

ensureInitialized()

/**
 * GET /api/extensions/propmate/lease-resync/cron: daily. Re-derives every
 * active lease's schedule items (kampanjpris start/end transitions, tillägg
 * edits made directly in the DB) and pushes them through the SAME
 * syncLeaseToRecurringSchedule path the interactive create/update/sync
 * routes use, so a resync can never skip the revenue-account guard. A lease
 * whose end_date has passed is ended (schedule paused, lease marked 'ended')
 * instead of resynced, since this daily pass is the only place that revisits
 * every active lease on its own.
 *
 * Bounded per run (BATCH_SIZE) and ordered by last_synced_at (NULLs first)
 * with id as the tiebreaker, so a company with more leases than fit in one
 * run is picked up again on the FOLLOWING run rather than starving whichever
 * leases happen to sort last; a lease synced today sorts to the back of the
 * next run automatically once its last_synced_at is bumped.
 */
export const maxDuration = 60

// Each lease sync is several sequential round trips (day_of_month pre-check,
// header snapshot, items page, delete, insert, stamp), not one query, so 500
// implies far more headroom inside a 60s function than actually exists. 100
// keeps a full batch comfortably inside the budget even on a slow run; any
// leases left over are picked up on the FOLLOWING run via the
// last_synced_at ordering below, never starved.
const BATCH_SIZE = 100

export const GET = withCronContext('cron.propmate_lease_resync', async (_request, ctx) => {
  loadExtensions()

  if (!extensionRegistry.get('propmate')) {
    ctx.log.warn('propmate extension is not enabled; cron refused')
    return NextResponse.json(
      { error: 'Propmate extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const supabase = createServiceClientNoCookies()

  const { data: leases, error } = await supabase
    .from('leases')
    .select('*')
    .eq('status', 'active')
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .order('id', { ascending: true })
    .limit(BATCH_SIZE)
    .returns<LeaseRow[]>()

  if (error) {
    ctx.log.error('failed to load active leases for resync', error)
    return NextResponse.json({ error: 'Failed to load leases', code: 'PROPMATE_RESYNC_LOAD_FAILED' }, { status: 500 })
  }

  const summary = await ctx.forEach('lease', leases ?? [], async (lease) => {
    // A lease past its end_date must stop billing instead of being re-synced:
    // check first, since a stale active row would otherwise keep generating
    // rent invoices every month with nothing to catch it.
    const expiry = await expireLeaseIfPastEndDate(supabase, lease)
    if (expiry.expired) {
      if (!expiry.ok) throw new Error(`lease ${lease.id}: ${expiry.error}`)
      return
    }

    const result = await syncLeaseToRecurringSchedule(supabase, lease)
    if (!result.ok) {
      // 'schedule_deleted' means an operator removed the linked schedule on
      // the core recurring-invoice page: syncLeaseToRecurringSchedule already
      // refused to auto-recreate it and logged an error. Throwing here (like
      // every other failure branch) surfaces it in the cron's per-item
      // failures summary so the gap is reported daily until a human ends the
      // lease or deliberately resyncs it, instead of silently disappearing.
      const message =
        'code' in result
          ? result.code
          : 'dbError' in result
            ? result.dbError.message
            : result.stage === 'schedule_deleted'
              ? 'recurring schedule was deleted by an operator; cron will not recreate it'
              : result.error.message
      // ctx.forEach's own failure summary only carries {index, error}: name
      // the lease in the message itself so the daily gap (in particular
      // schedule_deleted) can be identified from the run's JSON response
      // alone, not just the per-item log line or the notice.
      throw new Error(`lease ${lease.id}: ${message}`)
    }
  })

  ctx.log.info('propmate lease resync complete', { ...summary })

  return NextResponse.json({ data: summary })
})
