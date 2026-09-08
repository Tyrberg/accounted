import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  syncLeaseToRecurringSchedule,
  pauseLeaseSchedule,
  expireLeaseIfPastEndDate,
  buildLeaseScheduleItems,
  isCampaignActive,
  type LeaseRow,
} from '../lib/lease-schedule-sync'

const COMPANY_ID = 'company-1'

function makeLease(overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    id: 'lease-1',
    company_id: COMPANY_ID,
    user_id: 'user-1',
    customer_id: '550e8400-e29b-41d4-a716-446655440000',
    property_name: 'Bohed',
    unit_description: 'Lokal 2',
    monthly_rent: 12000,
    additions: [],
    campaign_price_amount: null,
    campaign_start_date: null,
    campaign_end_date: null,
    vat_rate: 0,
    revenue_account: null,
    day_of_month: 1,
    auto_send: false,
    start_date: '2026-01-01',
    end_date: null,
    status: 'active',
    recurring_schedule_id: null,
    last_synced_at: null,
    ...overrides,
  }
}

describe('buildLeaseScheduleItems', () => {
  it('bills monthly_rent when no campaign is active', () => {
    const items = buildLeaseScheduleItems(makeLease(), new Date('2026-03-15T00:00:00Z'))
    expect(items).toHaveLength(1)
    expect(items[0].unit_price).toBe(12000)
  })

  it('bills the kampanjpris amount while its window is active', () => {
    const lease = makeLease({
      campaign_price_amount: 8000,
      campaign_start_date: '2026-02-01',
      campaign_end_date: '2026-04-30',
    })
    expect(isCampaignActive(lease, '2026-03-15')).toBe(true)
    const items = buildLeaseScheduleItems(lease, new Date('2026-03-15T00:00:00Z'))
    expect(items[0].unit_price).toBe(8000)
  })

  it('falls back to monthly_rent once the kampanjpris window has ended', () => {
    const lease = makeLease({
      campaign_price_amount: 8000,
      campaign_start_date: '2026-02-01',
      campaign_end_date: '2026-04-30',
    })
    const items = buildLeaseScheduleItems(lease, new Date('2026-05-01T00:00:00Z'))
    expect(items[0].unit_price).toBe(12000)
  })

  // Stockholm date, not UTC, drives the campaign window: 23:30 UTC on
  // 2026-02-01 is already 2026-02-02 in Stockholm (winter, UTC+1), so a
  // campaign starting 2026-02-02 must be active at that instant even though
  // the UTC calendar date is still the 1st.
  it('resolves the campaign window against the Stockholm date, not the UTC date', () => {
    const lease = makeLease({
      campaign_price_amount: 8000,
      campaign_start_date: '2026-02-02',
      campaign_end_date: '2026-02-28',
    })
    const items = buildLeaseScheduleItems(lease, new Date('2026-02-01T23:30:00Z'))
    expect(items[0].unit_price).toBe(8000)
  })

  it('adds one line per tillägg after the rent line, sharing vat_rate and revenue_account', () => {
    const lease = makeLease({
      vat_rate: 25,
      revenue_account: '3011',
      additions: [
        { description: 'El', amount: 500 },
        { description: 'Gemensamma utrymmen', amount: 300 },
      ],
    })
    const items = buildLeaseScheduleItems(lease, new Date('2026-03-15T00:00:00Z'))
    expect(items).toHaveLength(3)
    expect(items[1]).toMatchObject({ description: 'El', unit_price: 500, vat_rate: 25, revenue_account: '3011' })
    expect(items[2]).toMatchObject({
      description: 'Gemensamma utrymmen',
      unit_price: 300,
      vat_rate: 25,
      revenue_account: '3011',
    })
  })
})

/**
 * A minimal but faithful mock of the two write paths syncLeaseToRecurringSchedule
 * calls through (createRecurringSchedule, applyRecurringScheduleUpdate), so
 * these tests exercise the REAL validation composition rather than a stub.
 */
function makeSupabase(opts: {
  activeChartAccounts: string[]
  existingDayOfMonth?: number
  /** Injected into the leases.update() back-link write on first sync. */
  linkError?: { message: string; code: string }
  /** Injected into the orphan-schedule delete() when linkError also fires. */
  cleanupError?: { message: string; code: string }
  /** Simulates the back-link UPDATE matching zero rows: a concurrent sync won the race. */
  claimLost?: boolean
}) {
  const scheduleUpdates: Record<string, unknown>[] = []
  const leaseUpdates: Record<string, unknown>[] = []
  const itemInserts: Array<Array<Record<string, unknown>>> = []
  const scheduleDeletes: Record<string, unknown>[] = []

  const from = vi.fn((table: string) => {
    if (table === 'chart_of_accounts') {
      return {
        select: () => ({
          eq: () => ({
            gte: () => ({
              lte: () => ({
                eq: () => ({
                  in: (_col: string, accounts: string[]) =>
                    Promise.resolve({
                      data: accounts
                        .filter((a) => opts.activeChartAccounts.includes(a))
                        .map((a) => ({ account_number: a })),
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        }),
      }
    }
    if (table === 'recurring_invoice_schedules') {
      return {
        // createRecurringSchedule's insert().select('id').single()
        insert: (row: Record<string, unknown>) => {
          scheduleUpdates.push(row)
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: 'schedule-new' }, error: null }),
            }),
          }
        },
        // Shared by two call shapes: syncLeaseToRecurringSchedule's own
        // .select('day_of_month').eq(id).eq(companyId).maybeSingle() pre-check,
        // and applyRecurringScheduleUpdate's header snapshot
        // .select('*').eq('id', ...).eq('company_id', ...).maybeSingle().
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    id: 'schedule-existing',
                    company_id: COMPANY_ID,
                    name: 'old name',
                    day_of_month: opts.existingDayOfMonth ?? 1,
                    updated_at: '2026-01-01T00:00:00Z',
                  },
                  error: null,
                }),
            }),
          }),
        }),
        // applyRecurringScheduleUpdate's header write:
        // .update(fields).eq('id', ...).eq('company_id', ...).select('updated_at').maybeSingle()
        update: (row: Record<string, unknown>) => {
          scheduleUpdates.push(row)
          return {
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: { updated_at: '2026-03-15T00:00:00Z' }, error: null }),
                }),
              }),
            }),
          }
        },
        // The rollback path: delete the orphan schedule when the leases
        // back-link write fails.
        delete: () => ({
          eq: (col: string, value: unknown) => {
            scheduleDeletes.push({ [col]: value })
            return { eq: () => Promise.resolve({ error: opts.cleanupError ?? null }) }
          },
        }),
      }
    }
    if (table === 'recurring_invoice_schedule_items') {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              range: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: (rows: Array<Record<string, unknown>>) => {
          itemInserts.push(rows)
          return Promise.resolve({ error: null })
        },
      }
    }
    if (table === 'leases') {
      return {
        update: (row: Record<string, unknown>) => {
          leaseUpdates.push(row)
          // Only the FIRST leases.update() call is the back-link write (first
          // sync); a resync's stampSynced() call never carries recurring_schedule_id.
          const isLinkWrite = 'recurring_schedule_id' in row
          return {
            eq: () => ({
              eq: () => {
                if (isLinkWrite) {
                  // The atomic claim: .is('recurring_schedule_id', null).select('id').
                  return {
                    is: () => ({
                      select: () =>
                        Promise.resolve(
                          opts.linkError
                            ? { data: null, error: opts.linkError }
                            : opts.claimLost
                              ? { data: [], error: null }
                              : { data: [{ id: 'lease-1' }], error: null },
                        ),
                    }),
                  }
                }
                // stampSynced() and the schedule_deleted refusal's bump are
                // directly awaited with no further chaining.
                return Promise.resolve({ error: null })
              },
            }),
          }
        },
      }
    }
    throw new Error(`unexpected table ${table}`)
  })

  return {
    supabase: { from } as unknown as SupabaseClient,
    scheduleUpdates,
    leaseUpdates,
    itemInserts,
    scheduleDeletes,
  }
}

describe('syncLeaseToRecurringSchedule', () => {
  it('creates a schedule on first sync and links it back onto the lease', async () => {
    const { supabase, scheduleUpdates, leaseUpdates, itemInserts } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: null })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(result).toEqual({ ok: true, scheduleId: 'schedule-new' })
    expect(scheduleUpdates).toHaveLength(1)
    expect(leaseUpdates[0]).toMatchObject({ recurring_schedule_id: 'schedule-new' })
    expect(itemInserts[0][0]).toMatchObject({ unit_price: 12000 })
  })

  // computeInitialRunDate returns an explicit start_date VERBATIM, bypassing
  // the day_of_month-based "next future occurrence" logic. Correct for a
  // contract that genuinely starts in the future; wrong for onboarding an
  // EXISTING contract whose start_date is already in the past, which would
  // otherwise stamp a next_run_date years old and have the core cron roll it
  // forward with a false last_run_warning on a brand-new lease.
  it('computes next_run_date from day_of_month, not a past start_date, when onboarding an existing contract', async () => {
    // createRecurringSchedule's own computeInitialRunDate call always anchors
    // on real wall-clock `new Date()` (it is not passed the `today` argument
    // syncLeaseToRecurringSchedule otherwise threads through), so the clamp
    // decision and the actual computation only agree under a controlled
    // clock: fake the system time to match the `today` passed below.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T00:00:00Z'))
    try {
      const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [] })
      const lease = makeLease({ recurring_schedule_id: null, start_date: '2024-01-01', day_of_month: 1 })

      await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

      // Day 1 already passed this month (today is the 15th): next occurrence
      // is the 1st of the FOLLOWING month, same as a lease with no start_date.
      expect(scheduleUpdates[0]).toMatchObject({ next_run_date: '2026-04-01' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors a genuinely future start_date verbatim', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T00:00:00Z'))
    try {
      const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [] })
      const lease = makeLease({ recurring_schedule_id: null, start_date: '2026-12-25', day_of_month: 1 })

      await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

      expect(scheduleUpdates[0]).toMatchObject({ next_run_date: '2026-12-25' })
    } finally {
      vi.useRealTimers()
    }
  })

  // The round-15 finding: the daily cron and every other automatic caller
  // never opts into syncAutoSend, so a resync must never echo the lease's own
  // auto_send back onto the schedule (that would silently undo an operator's
  // toggle on the core recurring-invoice page).
  it('does not touch auto_send on an ordinary resync (syncAutoSend not set)', async () => {
    const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', auto_send: true })

    await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(scheduleUpdates[0]).not.toHaveProperty('auto_send')
  })

  it('pushes auto_send onto the schedule only when the caller opts in via syncAutoSend', async () => {
    const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', auto_send: true })

    await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'), { syncAutoSend: true })

    expect(scheduleUpdates[0]).toMatchObject({ auto_send: true })
  })

  it('updates the existing schedule on resync (already linked)', async () => {
    const { supabase, scheduleUpdates, leaseUpdates, itemInserts } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing' })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(result).toEqual({ ok: true, scheduleId: 'schedule-existing' })
    expect(scheduleUpdates).toHaveLength(1)
    expect(leaseUpdates[0]).toMatchObject({ last_synced_at: expect.any(String) })
    expect(itemInserts[0][0]).toMatchObject({ unit_price: 12000 })
  })

  // The regression the round-8 advisory objection asked for: propmate's first
  // sync (createRecurringSchedule) and its resync (applyRecurringScheduleUpdate)
  // must reject the SAME bad revenue_account IDENTICALLY. Before this chain
  // routed both branches through the shared validator, a schema-drifted or
  // stale revenue_account (e.g. an account since deactivated in the chart)
  // could pass on whichever branch happened to skip the check.
  it('rejects the same invalid revenue_account identically on first sync and resync', async () => {
    const firstSync = makeSupabase({ activeChartAccounts: [] })
    const leaseUnsynced = makeLease({ recurring_schedule_id: null, revenue_account: '3099' })
    const firstResult = await syncLeaseToRecurringSchedule(firstSync.supabase, leaseUnsynced)

    const resync = makeSupabase({ activeChartAccounts: [] })
    const leaseSynced = makeLease({ recurring_schedule_id: 'schedule-existing', revenue_account: '3099' })
    const resyncResult = await syncLeaseToRecurringSchedule(resync.supabase, leaseSynced)

    expect(firstResult).toMatchObject({
      ok: false,
      code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID',
      details: { invalidAccounts: ['3099'] },
    })
    expect(resyncResult).toMatchObject({
      ok: false,
      code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID',
      details: { invalidAccounts: ['3099'] },
    })
    // Neither path ever reaches an insert/update once validation fails.
    expect(firstSync.scheduleUpdates).toHaveLength(0)
    expect(resync.scheduleUpdates).toHaveLength(0)
    expect(firstSync.leaseUpdates).toHaveLength(0)
    expect(resync.leaseUpdates).toHaveLength(0)
  })

  it('rejects a class 1-2 account on a VAT-bearing line identically on both branches', async () => {
    const firstSync = makeSupabase({ activeChartAccounts: [] })
    const leaseUnsynced = makeLease({ recurring_schedule_id: null, revenue_account: '2611', vat_rate: 25 })
    const firstResult = await syncLeaseToRecurringSchedule(firstSync.supabase, leaseUnsynced)

    const resync = makeSupabase({ activeChartAccounts: [] })
    const leaseSynced = makeLease({ recurring_schedule_id: 'schedule-existing', revenue_account: '2611', vat_rate: 25 })
    const resyncResult = await syncLeaseToRecurringSchedule(resync.supabase, leaseSynced)

    expect(firstResult).toMatchObject({ ok: false, code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT' })
    expect(resyncResult).toMatchObject({ ok: false, code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT' })
  })

  // The critical finding this round fixed: a failed back-link write used to
  // return ok: true and leave recurring_schedule_id NULL, so the next resync
  // (including the daily cron, which pages on that same NULL) took the first-
  // sync branch again and created a SECOND schedule, silently multiplying the
  // tenant's monthly invoices every run.
  it('rolls back the orphan schedule and reports failure when the back-link write fails', async () => {
    const linkError = { message: 'db unavailable', code: '57014' }
    const { supabase, scheduleUpdates, scheduleDeletes, leaseUpdates } = makeSupabase({
      activeChartAccounts: [],
      linkError,
    })
    const lease = makeLease({ recurring_schedule_id: null })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(result).toMatchObject({ ok: false, stage: 'link', error: linkError })
    // The schedule that createRecurringSchedule just made is torn back down...
    expect(scheduleDeletes).toEqual([{ id: 'schedule-new' }])
    // ...so a retry starts clean instead of piling up a second schedule.
    expect(scheduleUpdates).toHaveLength(1)
    expect(leaseUpdates).toHaveLength(1)
  })

  // If BOTH the back-link write and the orphan-schedule delete fail, the
  // created schedule has nothing pointing at it (the lease's
  // recurring_schedule_id was never set) and would otherwise sit 'active'
  // (and, with auto_send, keep emailing the tenant) with only a log line as
  // the record. A best-effort pause stops the billing even though the
  // orphan itself is still unresolved.
  it('pauses the orphan schedule as a best-effort fallback when delete ALSO fails', async () => {
    const linkError = { message: 'db unavailable', code: '57014' }
    const cleanupError = { message: 'delete also failed', code: '57014' }
    const { supabase, scheduleUpdates, scheduleDeletes } = makeSupabase({
      activeChartAccounts: [],
      linkError,
      cleanupError,
    })
    const lease = makeLease({ recurring_schedule_id: null })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(result).toMatchObject({ ok: false, stage: 'link', error: linkError })
    expect(scheduleDeletes).toEqual([{ id: 'schedule-new' }])
    // scheduleUpdates[0] is the original insert; the fallback pause is a
    // second write against recurring_invoice_schedules.
    expect(scheduleUpdates).toHaveLength(2)
    expect(scheduleUpdates[1]).toEqual({ status: 'paused' })
  })

  // The cross-model advisory objection: two concurrent syncs (the daily cron
  // and a manual POST /leases/:id/sync racing after an operator deletes the
  // linked schedule, or two overlapping cron runs) can both observe
  // recurring_schedule_id NULL and both create a schedule. The back-link
  // write is an atomic claim (.is('recurring_schedule_id', null)), so only
  // one of them actually links; the loser must clean up the schedule IT
  // created instead of leaving a second, unlinked, still-active schedule
  // billing the tenant.
  it('cleans up its own schedule when it loses the atomic claim race to a concurrent sync', async () => {
    const { supabase, scheduleUpdates, scheduleDeletes, leaseUpdates } = makeSupabase({
      activeChartAccounts: [],
      claimLost: true,
    })
    const lease = makeLease({ recurring_schedule_id: null })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(result.ok).toBe(false)
    if (!result.ok && 'stage' in result && result.stage === 'link') {
      expect(result.error.code).toBe('PROPMATE_CONCURRENT_SYNC_LOST')
    } else {
      expect.unreachable('expected a link-stage failure')
    }
    // This call's own orphan schedule is torn back down, not left active...
    expect(scheduleDeletes).toEqual([{ id: 'schedule-new' }])
    // The cleanup delete succeeded, so there is no best-effort pause fallback
    // write: scheduleUpdates holds only the original insert.
    expect(scheduleUpdates).toHaveLength(1)
    // ...and the winner's link write is left untouched: this loser's own
    // update attempt still shows up as an attempted write (the mock records
    // the call), but the row itself was never actually changed by it.
    expect(leaseUpdates).toHaveLength(1)
  })

  // The minor finding: a changed billing day must take effect immediately
  // rather than billing on the OLD day for one more cycle, mirroring
  // app/api/invoices/recurring/[id]/route.ts.
  it('recomputes next_run_date when day_of_month actually changes on resync', async () => {
    const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [], existingDayOfMonth: 1 })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', day_of_month: 15 })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-05T00:00:00Z'))

    expect(result).toEqual({ ok: true, scheduleId: 'schedule-existing' })
    expect(scheduleUpdates[0]).toMatchObject({ day_of_month: 15, next_run_date: '2026-03-15' })
  })

  it('leaves next_run_date untouched when day_of_month is unchanged on resync', async () => {
    const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [], existingDayOfMonth: 1 })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', day_of_month: 1 })

    await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-05T00:00:00Z'))

    expect(scheduleUpdates[0]).not.toHaveProperty('next_run_date')
  })

  // The reactivation gap round 11 fixed: PATCH status: 'ended' pauses the
  // schedule (pauseLeaseSchedule), but a later PATCH status: 'active' used to
  // resync items/customer/day_of_month without ever touching `status`, so the
  // schedule stayed 'paused' while the lease read 'active' and the general
  // recurring cron (which only selects status: 'active') silently never
  // billed the re-let unit again. Fixed via an explicit opt-in
  // (resumeSchedule) the caller sets only when it has observed the ended ->
  // active transition itself (see api-routes.ts's PATCH handler).
  it('resumes a paused schedule when the caller opts in via resumeSchedule', async () => {
    const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', status: 'active' })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'), {
      resumeSchedule: true,
    })

    expect(result).toEqual({ ok: true, scheduleId: 'schedule-existing' })
    expect(scheduleUpdates[0]).toMatchObject({ status: 'active' })
  })

  // The round-12 finding: forcing status: 'active' on every sync of every
  // active lease (the old, unconditional behaviour) meant the daily resync
  // cron silently un-paused a schedule an operator had deliberately paused on
  // the core recurring-invoice page (a tenant payment dispute, rent holiday,
  // etc.), since the lease itself stays 'active' the whole time (leases have
  // no 'paused' status) and the cron never opts into resumeSchedule. Without
  // this default, the cron would resurrect billing the very next day.
  it('does NOT resume a paused schedule by default, even when the lease is active', async () => {
    const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', status: 'active' })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(result).toEqual({ ok: true, scheduleId: 'schedule-existing' })
    expect(scheduleUpdates[0]).not.toHaveProperty('status')
  })

  // The manual /leases/:id/sync route calls syncLeaseToRecurringSchedule
  // without resumeSchedule: it must not undo a deliberate pause on an ended
  // lease's schedule just because someone triggers a resync.
  it('does not force the schedule active when syncing a lease that is ended', async () => {
    const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', status: 'ended' })

    await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'), { resumeSchedule: true })

    expect(scheduleUpdates[0]).not.toHaveProperty('status')
  })

  // The adversarial finding this round fixed: recurring_schedule_id is set
  // NULL by the leases_recurring_schedule_id_fkey's ON DELETE SET NULL when
  // an operator deletes the lease's schedule on the core recurring-invoice
  // page. Before this fix, a NULL recurring_schedule_id was read as "never
  // synced" unconditionally, so the daily cron (and any other caller)
  // provisioned a brand new schedule the very next run, un-doing the
  // operator's delete and (with auto_send) re-billing/re-emailing the tenant.
  it('refuses to recreate a schedule that was synced before but is now unlinked (deleted by an operator)', async () => {
    const { supabase, scheduleUpdates, leaseUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({
      recurring_schedule_id: null,
      last_synced_at: '2026-02-01T08:00:00.000Z',
    })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(result).toEqual({ ok: false, stage: 'schedule_deleted' })
    // No new schedule is provisioned, but last_synced_at IS bumped: the daily
    // cron pages leases oldest-last_synced_at-first, and leaving it untouched
    // here would keep a permanently-refusing lease at the front of every
    // future run, starving every other lease once enough of them accumulate
    // (round-15 finding). The gap itself stays reported every run regardless.
    expect(scheduleUpdates).toHaveLength(0)
    expect(leaseUpdates).toEqual([{ last_synced_at: expect.any(String) }])
  })

  it('still treats a genuinely first-ever sync (last_synced_at NULL) as create, not schedule_deleted', async () => {
    const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: null, last_synced_at: null })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(result).toEqual({ ok: true, scheduleId: 'schedule-new' })
    expect(scheduleUpdates).toHaveLength(1)
  })

  it('recreates the schedule when the caller explicitly opts in via allowRecreateAfterDelete', async () => {
    const { supabase, scheduleUpdates, leaseUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({
      recurring_schedule_id: null,
      last_synced_at: '2026-02-01T08:00:00.000Z',
    })

    const result = await syncLeaseToRecurringSchedule(supabase, lease, new Date('2026-03-15T00:00:00Z'), {
      allowRecreateAfterDelete: true,
    })

    expect(result).toEqual({ ok: true, scheduleId: 'schedule-new' })
    expect(scheduleUpdates).toHaveLength(1)
    expect(leaseUpdates[0]).toMatchObject({ recurring_schedule_id: 'schedule-new' })
  })
})

describe('pauseLeaseSchedule', () => {
  it('is a no-op when the lease was never synced (no recurring_schedule_id)', async () => {
    const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: null })

    const result = await pauseLeaseSchedule(supabase, lease)

    expect(result).toEqual({ ok: true })
    expect(scheduleUpdates).toHaveLength(0)
  })

  // The other critical finding this round fixed: ending a lease must stop the
  // fakturamotor by pausing its linked schedule, not just close out the lease row.
  it('pauses the linked schedule for an ended lease', async () => {
    const { supabase, scheduleUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', status: 'ended' })

    const result = await pauseLeaseSchedule(supabase, lease)

    expect(result).toEqual({ ok: true })
    expect(scheduleUpdates).toEqual([{ status: 'paused' }])
  })
})

describe('expireLeaseIfPastEndDate', () => {
  it('is a no-op when the lease has no end_date', async () => {
    const { supabase, scheduleUpdates, leaseUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', end_date: null })

    const result = await expireLeaseIfPastEndDate(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(result).toEqual({ expired: false })
    expect(scheduleUpdates).toHaveLength(0)
    expect(leaseUpdates).toHaveLength(0)
  })

  it('is a no-op when end_date has not yet passed', async () => {
    const { supabase, scheduleUpdates, leaseUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', end_date: '2026-06-30' })

    const result = await expireLeaseIfPastEndDate(supabase, lease, new Date('2026-03-15T00:00:00Z'))

    expect(result).toEqual({ expired: false })
    expect(scheduleUpdates).toHaveLength(0)
    expect(leaseUpdates).toHaveLength(0)
  })

  // The finding this round fixed: a lease left 'active' past its end_date
  // kept generating rent invoices every month because nothing ever compared
  // end_date to today. The cron must catch this itself, since it is the only
  // place that revisits every active lease on its own.
  it('pauses the schedule and marks the lease ended once end_date has passed', async () => {
    const { supabase, scheduleUpdates, leaseUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', end_date: '2026-06-30' })

    const result = await expireLeaseIfPastEndDate(supabase, lease, new Date('2026-07-01T00:00:00Z'))

    expect(result).toEqual({ expired: true, ok: true })
    expect(scheduleUpdates).toEqual([{ status: 'paused' }])
    expect(leaseUpdates).toEqual([{ status: 'ended' }])
  })

  it('expires a lease on its end_date itself (end_date is the last billable day)', async () => {
    const { supabase, leaseUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: 'schedule-existing', end_date: '2026-06-30' })

    const result = await expireLeaseIfPastEndDate(supabase, lease, new Date('2026-06-30T00:00:00Z'))

    expect(result).toEqual({ expired: false })
    expect(leaseUpdates).toHaveLength(0)
  })

  it('is a no-op with no schedule to pause (never synced)', async () => {
    const { supabase, leaseUpdates } = makeSupabase({ activeChartAccounts: [] })
    const lease = makeLease({ recurring_schedule_id: null, end_date: '2026-06-30' })

    const result = await expireLeaseIfPastEndDate(supabase, lease, new Date('2026-07-01T00:00:00Z'))

    expect(result).toEqual({ expired: true, ok: true })
    expect(leaseUpdates).toEqual([{ status: 'ended' }])
  })
})
