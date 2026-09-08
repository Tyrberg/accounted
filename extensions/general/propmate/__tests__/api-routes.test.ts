import { describe, it, expect, vi, beforeEach } from 'vitest'

// Route-level tests isolate the routing/validation/error-mapping logic from
// the sync engine itself (covered by lease-schedule-sync.test.ts): the write
// paths are mocked here so a route test failure always points at the route,
// never at validate-schedule-revenue-accounts or the recurring-schedule
// write helpers underneath it.
const syncLeaseToRecurringSchedule = vi.fn()
const pauseLeaseSchedule = vi.fn()
vi.mock('../lib/lease-schedule-sync', () => ({
  syncLeaseToRecurringSchedule: (...args: unknown[]) => syncLeaseToRecurringSchedule(...args),
  pauseLeaseSchedule: (...args: unknown[]) => pauseLeaseSchedule(...args),
}))

import { propmateApiRoutes } from '../api-routes'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_UUID = '660e8400-e29b-41d4-a716-446655440001'
const LEASE_ROW = {
  id: 'lease-1',
  company_id: 'company-1',
  user_id: 'user-1',
  customer_id: VALID_UUID,
  property_name: 'Bohed',
  unit_description: null,
  monthly_rent: 12000,
  additions: [],
  campaign_price_amount: null,
  campaign_start_date: null,
  campaign_end_date: null,
  kpi_base_index: null,
  kpi_base_year: null,
  kpi_next_review_date: null,
  vat_rate: 0,
  revenue_account: null,
  day_of_month: 1,
  auto_send: false,
  start_date: '2026-01-01',
  end_date: null,
  status: 'active',
  recurring_schedule_id: null,
  last_synced_at: null,
}

function findRoute(method: string, path: string) {
  const route = propmateApiRoutes.find((r) => r.method === method && r.path === path)
  expect(route, `${method} ${path} must be registered`).toBeDefined()
  return route!
}

function makeRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function makeContext(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'propmate',
    requestId: 'req_test',
    supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /leases', () => {
  it('returns the company leases', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [LEASE_ROW] })
    const res = await findRoute('GET', '/leases').handler(
      makeRequest('https://test.local/x', 'GET'),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
  })
})

describe('GET /leases/:id', () => {
  it('returns 404 for a non-UUID id without querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()
    const res = await findRoute('GET', '/leases/:id').handler(
      makeRequest('https://test.local/x?_id=not-a-uuid', 'GET'),
      makeContext(supabase),
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when the lease does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const res = await findRoute('GET', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'GET'),
      makeContext(supabase),
    )
    expect(res.status).toBe(404)
  })

  it('returns the lease when found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: LEASE_ROW })
    const res = await findRoute('GET', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'GET'),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /leases', () => {
  it('returns 400 on validation failure', async () => {
    const { supabase } = createQueuedMockSupabase()
    const res = await findRoute('POST', '/leases').handler(
      makeRequest('https://test.local/x', 'POST', { property_name: '', monthly_rent: -1 }),
      makeContext(supabase),
    )
    expect(res.status).toBe(400)
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })

  it('returns 400 when the campaign triple is partial', async () => {
    const { supabase } = createQueuedMockSupabase()
    const res = await findRoute('POST', '/leases').handler(
      makeRequest('https://test.local/x', 'POST', {
        customer_id: VALID_UUID,
        property_name: 'Bohed',
        monthly_rent: 12000,
        start_date: '2026-01-01',
        campaign_price_amount: 8000,
      }),
      makeContext(supabase),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the customer does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // customer lookup
    const res = await findRoute('POST', '/leases').handler(
      makeRequest('https://test.local/x', 'POST', {
        customer_id: VALID_UUID,
        property_name: 'Bohed',
        monthly_rent: 12000,
        start_date: '2026-01-01',
      }),
      makeContext(supabase),
    )
    expect(res.status).toBe(404)
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })

  it('creates the lease and returns 201 on a successful sync', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: VALID_UUID } }) // customer lookup
    enqueue({ data: LEASE_ROW }) // insert
    enqueue({ data: { ...LEASE_ROW, customer: { id: VALID_UUID } } }) // reselect complete
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })

    const res = await findRoute('POST', '/leases').handler(
      makeRequest('https://test.local/x', 'POST', {
        customer_id: VALID_UUID,
        property_name: 'Bohed',
        monthly_rent: 12000,
        start_date: '2026-01-01',
      }),
      makeContext(supabase),
    )
    expect(res.status).toBe(201)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledTimes(1)
  })

  it('maps a revenue-account guard rejection from the sync to a structured error response', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: VALID_UUID } }) // customer lookup
    enqueue({ data: LEASE_ROW }) // insert
    enqueue({ data: null }) // lease rollback delete
    syncLeaseToRecurringSchedule.mockResolvedValue({
      ok: false,
      code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID',
      details: { invalidAccounts: ['2611'] },
    })

    const res = await findRoute('POST', '/leases').handler(
      makeRequest('https://test.local/x', 'POST', {
        customer_id: VALID_UUID,
        property_name: 'Bohed',
        monthly_rent: 12000,
        start_date: '2026-01-01',
        revenue_account: '3011',
      }),
      makeContext(supabase),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREATE_REVENUE_ACCOUNT_INVALID')
  })

  // The round-13 finding: leaving the inserted lease row in place on a failed
  // first sync let a client's retry create a SECOND lease (no unique
  // constraint on the table), which the daily cron then turned into a second
  // schedule and double-billed the tenant every month.
  it('rolls back the inserted lease row when the first sync fails', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: VALID_UUID } }) // customer lookup
    enqueue({ data: LEASE_ROW }) // insert
    enqueue({ data: null }) // lease rollback delete
    syncLeaseToRecurringSchedule.mockResolvedValue({
      ok: false,
      code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID',
      details: { invalidAccounts: ['2611'] },
    })

    const res = await findRoute('POST', '/leases').handler(
      makeRequest('https://test.local/x', 'POST', {
        customer_id: VALID_UUID,
        property_name: 'Bohed',
        monthly_rent: 12000,
        start_date: '2026-01-01',
        revenue_account: '3011',
      }),
      makeContext(supabase),
    )
    expect(res.status).toBe(400)
    expect(findCall('leases', 'delete')).toBeDefined()
  })

  // The round-18 finding: propmate was a fourth write path into
  // recurring_invoice_schedules that skipped the auto_send-requires-email
  // backstop every other path enforces (app/api/invoices/recurring/route.ts,
  // its [id] counterpart, and the MCP staged-op executor). Without it, a
  // lease created with auto_send: true against an email-less customer
  // creates a schedule that silently degrades to a monthly draft + warning
  // at cron time and the tenant never receives the avisering.
  it('rejects auto_send when the customer has no email', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: VALID_UUID, email: null } }) // customer lookup
    const res = await findRoute('POST', '/leases').handler(
      makeRequest('https://test.local/x', 'POST', {
        customer_id: VALID_UUID,
        property_name: 'Bohed',
        monthly_rent: 12000,
        start_date: '2026-01-01',
        auto_send: true,
      }),
      makeContext(supabase),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.type).toBe('validation_error')
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })

  it('allows auto_send when the customer has an email', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: VALID_UUID, email: 'tenant@example.com' } }) // customer lookup
    enqueue({ data: { ...LEASE_ROW, auto_send: true } }) // insert
    enqueue({ data: { ...LEASE_ROW, auto_send: true, customer: { id: VALID_UUID } } }) // reselect complete
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })

    const res = await findRoute('POST', '/leases').handler(
      makeRequest('https://test.local/x', 'POST', {
        customer_id: VALID_UUID,
        property_name: 'Bohed',
        monthly_rent: 12000,
        start_date: '2026-01-01',
        auto_send: true,
      }),
      makeContext(supabase),
    )
    expect(res.status).toBe(201)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledTimes(1)
  })

  it('still reports the sync failure when the rollback delete itself fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: VALID_UUID } }) // customer lookup
    enqueue({ data: LEASE_ROW }) // insert
    enqueue({ data: null, error: { message: 'db down' } }) // lease rollback delete fails
    syncLeaseToRecurringSchedule.mockResolvedValue({
      ok: false,
      code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID',
      details: { invalidAccounts: ['2611'] },
    })

    const ctx = makeContext(supabase)
    const res = await findRoute('POST', '/leases').handler(
      makeRequest('https://test.local/x', 'POST', {
        customer_id: VALID_UUID,
        property_name: 'Bohed',
        monthly_rent: 12000,
        start_date: '2026-01-01',
        revenue_account: '3011',
      }),
      ctx,
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREATE_REVENUE_ACCOUNT_INVALID')
    expect(ctx.log.error).toHaveBeenCalledWith(
      'lease sync failed and the lease row could not be rolled back',
      expect.anything(),
      expect.objectContaining({ leaseId: LEASE_ROW.id }),
    )
  })
})

describe('PATCH /leases/:id', () => {
  it('returns 404 for a non-UUID id without querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()
    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest('https://test.local/x?_id=not-a-uuid', 'PATCH', { monthly_rent: 13000 }),
      makeContext(supabase),
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 on validation failure', async () => {
    const { supabase } = createQueuedMockSupabase()
    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', {}),
      makeContext(supabase),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the lease does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // existing lookup
    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { monthly_rent: 13000 }),
      makeContext(supabase),
    )
    expect(res.status).toBe(404)
  })

  it('validates the campaign triple against the MERGED row, not the raw patch', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Existing lease already has a full, valid campaign triple.
    enqueue({
      data: {
        ...LEASE_ROW,
        campaign_price_amount: 8000,
        campaign_start_date: '2026-02-01',
        campaign_end_date: '2026-04-30',
      },
    })
    enqueue({ data: { ...LEASE_ROW, campaign_end_date: '2026-05-31' } }) // update
    enqueue({ data: LEASE_ROW }) // reselect complete
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })

    // Patching ONLY campaign_end_date must validate against the lease's
    // EXISTING campaign_price_amount/campaign_start_date, not against
    // "undefined" for the fields this request didn't touch.
    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { campaign_end_date: '2026-05-31' }),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
  })

  it('re-syncs the schedule when the patched lease stays active', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: LEASE_ROW }) // existing lookup
    enqueue({ data: { ...LEASE_ROW, monthly_rent: 13000 } }) // update
    enqueue({ data: LEASE_ROW }) // reselect complete
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { monthly_rent: 13000 }),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledTimes(1)
    expect(pauseLeaseSchedule).not.toHaveBeenCalled()
  })

  // The round-12 finding: an unrelated PATCH to a lease that was ALREADY
  // active (no status transition) must not tell syncLeaseToRecurringSchedule
  // to resume a schedule. Otherwise every ordinary edit (rent change, tillägg
  // edit) on a lease whose schedule an operator had deliberately paused would
  // silently un-pause it.
  it('does not opt into resumeSchedule for an unrelated edit on an already-active lease', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: LEASE_ROW }) // existing lookup (status: 'active')
    enqueue({ data: { ...LEASE_ROW, monthly_rent: 13000 } }) // update
    enqueue({ data: LEASE_ROW }) // reselect complete
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { monthly_rent: 13000 }),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ monthly_rent: 13000 }),
      undefined,
      { resumeSchedule: false, syncAutoSend: false, allowRecreateAfterDelete: false },
    )
  })

  // The round-15 finding: the daily cron (and any PATCH that didn't touch
  // auto_send) must never echo the lease's own auto_send back onto the
  // schedule, or an operator's toggle on the core recurring-invoice page gets
  // silently undone on the next unrelated edit/resync.
  it('opts into syncAutoSend only when the request itself changed auto_send', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: LEASE_ROW }) // existing lookup
    enqueue({ data: { id: VALID_UUID, email: 'tenant@example.com' } }) // auto_send email backstop
    enqueue({ data: { ...LEASE_ROW, auto_send: true } }) // update
    enqueue({ data: { ...LEASE_ROW, auto_send: true } }) // reselect complete
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { auto_send: true }),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ auto_send: true }),
      undefined,
      { resumeSchedule: false, syncAutoSend: true, allowRecreateAfterDelete: false },
    )
  })

  // The round-18 finding, PATCH side: turning auto_send on via PATCH must
  // hit the same backstop as POST and the core recurring-invoice route.
  it('rejects turning auto_send on when the customer has no email', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: LEASE_ROW }) // existing lookup
    enqueue({ data: { id: VALID_UUID, email: null } }) // auto_send email backstop

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { auto_send: true }),
      makeContext(supabase),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.type).toBe('validation_error')
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })

  // Switching a lease that already has auto_send: true onto a new customer
  // must re-check the NEW customer's email, not skip the guard because
  // auto_send itself did not change in this request.
  it('rejects switching customer_id when the lease has auto_send on and the new customer has no email', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const autoSendLease = { ...LEASE_ROW, auto_send: true }
    enqueue({ data: autoSendLease }) // existing lookup
    enqueue({ data: { id: OTHER_UUID, email: null } }) // auto_send email backstop

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { customer_id: OTHER_UUID }),
      makeContext(supabase),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.type).toBe('validation_error')
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })

  // An unrelated edit on a lease whose auto_send was already true must not
  // start failing just because the customer's email was removed sometime
  // after auto_send was turned on: mirrors the core route's exact gating
  // (only re-checks when THIS request touches auto_send or customer_id).
  it('does not re-check auto_send/email on an unrelated edit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const autoSendLease = { ...LEASE_ROW, auto_send: true }
    enqueue({ data: autoSendLease }) // existing lookup
    enqueue({ data: { ...autoSendLease, monthly_rent: 13000 } }) // update
    enqueue({ data: { ...autoSendLease, monthly_rent: 13000 } }) // reselect complete
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { monthly_rent: 13000 }),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
  })

  // The re-let case resumeSchedule exists for: a lease PATCHed 'ended' then
  // later 'active' must resume its paused schedule, driven by the OBSERVED
  // transition (existing.status === 'ended'), not by the lease's new status
  // alone.
  it('opts into resumeSchedule when the lease transitions from ended to active', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const endedLease = { ...LEASE_ROW, status: 'ended' as const, recurring_schedule_id: 'schedule-1' }
    enqueue({ data: endedLease }) // existing lookup (status: 'ended')
    enqueue({ data: { ...endedLease, status: 'active' } }) // update
    enqueue({ data: { ...endedLease, status: 'active' } }) // reselect complete
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { status: 'active' }),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ status: 'active' }),
      undefined,
      { resumeSchedule: true, syncAutoSend: false, allowRecreateAfterDelete: true },
    )
  })

  // The F1 finding: LEASE_SYNC_ENDED's remediation tells the caller to
  // reactivate the lease here, but this PATCH used to always refuse with
  // LEASE_SCHEDULE_DELETED (and revert the status straight back to 'ended')
  // when the schedule had also been deleted, since it never opted into
  // allowRecreateAfterDelete. That closed the loop with no stated recovery:
  // POST /sync refuses while 'ended', and this PATCH refused too. Reactivating
  // an ended lease must be able to provision a fresh schedule.
  it('recreates a deleted schedule when reactivating an ended lease, closing the LEASE_SYNC_ENDED loop', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const endedLease = { ...LEASE_ROW, status: 'ended' as const, recurring_schedule_id: null }
    enqueue({ data: endedLease }) // existing lookup (status: 'ended', schedule deleted)
    enqueue({ data: { ...endedLease, status: 'active' } }) // update
    enqueue({ data: { ...endedLease, status: 'active', recurring_schedule_id: 'schedule-new' } }) // reselect complete
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-new' })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { status: 'active' }),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ status: 'active' }),
      undefined,
      { resumeSchedule: true, syncAutoSend: false, allowRecreateAfterDelete: true },
    )
  })

  it('does not opt into allowRecreateAfterDelete for an unrelated edit on an already-active lease', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const activeLease = { ...LEASE_ROW, status: 'active' as const, recurring_schedule_id: null }
    enqueue({ data: activeLease }) // existing lookup
    enqueue({ data: { ...activeLease, monthly_rent: 15000 } }) // update
    enqueue({ data: activeLease }) // rollback update (revertPatchOnFailure)
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: false, stage: 'schedule_deleted' })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { monthly_rent: 15000 }),
      makeContext(supabase),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('LEASE_SCHEDULE_DELETED')
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ monthly_rent: 15000 }),
      undefined,
      { resumeSchedule: false, syncAutoSend: false, allowRecreateAfterDelete: false },
    )
  })

  it('pauses the linked schedule instead of re-syncing when the lease ends', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const linkedLease = { ...LEASE_ROW, recurring_schedule_id: 'schedule-1' }
    enqueue({ data: linkedLease }) // existing lookup
    enqueue({ data: { ...linkedLease, status: 'ended' } }) // update
    enqueue({ data: { ...linkedLease, status: 'ended' } }) // reselect complete
    pauseLeaseSchedule.mockResolvedValue({ ok: true })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { status: 'ended' }),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
    expect(pauseLeaseSchedule).toHaveBeenCalledTimes(1)
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })

  // The round-14 finding: PATCH persists the lease row BEFORE syncing, unlike
  // POST which only inserts once the sync succeeds. A rejected
  // revenue_account left the row showing the new (unbilled) values while the
  // schedule kept the old ones, and every later daily resync failed on the
  // same invalid account: silent under-billing plus a permanently broken
  // cron item. The row must be rolled back to its pre-PATCH values.
  it('rolls back the updated lease row when the re-sync fails', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: LEASE_ROW }) // existing lookup
    enqueue({ data: { ...LEASE_ROW, monthly_rent: 15000, revenue_account: '3911' } }) // update
    enqueue({ data: null }) // rollback update
    syncLeaseToRecurringSchedule.mockResolvedValue({
      ok: false,
      code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID',
      details: { invalidAccounts: ['3911'] },
    })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', {
        monthly_rent: 15000,
        revenue_account: '3911',
      }),
      makeContext(supabase),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREATE_REVENUE_ACCOUNT_INVALID')

    // Two update() calls on leases: the PATCH write, then the rollback.
    const updateCalls = findCalls('leases', 'update')
    expect(updateCalls).toHaveLength(2)
    expect(updateCalls[1][0]).toEqual({
      monthly_rent: LEASE_ROW.monthly_rent,
      revenue_account: LEASE_ROW.revenue_account,
    })
  })

  it('still reports the sync failure when the PATCH rollback update itself fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: LEASE_ROW }) // existing lookup
    enqueue({ data: { ...LEASE_ROW, monthly_rent: 15000, revenue_account: '3911' } }) // update
    enqueue({ data: null, error: { message: 'db down' } }) // rollback update fails
    syncLeaseToRecurringSchedule.mockResolvedValue({
      ok: false,
      code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID',
      details: { invalidAccounts: ['3911'] },
    })

    const ctx = makeContext(supabase)
    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', {
        monthly_rent: 15000,
        revenue_account: '3911',
      }),
      ctx,
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREATE_REVENUE_ACCOUNT_INVALID')
    expect(ctx.log.error).toHaveBeenCalledWith(
      'lease sync failed and the lease row could not be rolled back',
      expect.anything(),
      expect.objectContaining({ leaseId: VALID_UUID }),
    )
  })

  // Rollback must also cover the pause branch (lease ending) and must revert
  // the status transition itself, not just the other touched fields, or a
  // failed pause leaves the lease row 'ended' with an active, still-billing
  // schedule.
  it('rolls back the status transition when pausing the schedule fails', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const linkedLease = { ...LEASE_ROW, recurring_schedule_id: 'schedule-1' }
    enqueue({ data: linkedLease }) // existing lookup
    enqueue({ data: { ...linkedLease, status: 'ended' } }) // update
    enqueue({ data: null }) // rollback update
    pauseLeaseSchedule.mockResolvedValue({
      ok: false,
      stage: 'header',
      error: { name: 'PostgrestError', message: 'db down', details: '', hint: '', code: '500' },
    })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { status: 'ended' }),
      makeContext(supabase),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    const updateCalls = findCalls('leases', 'update')
    expect(updateCalls).toHaveLength(2)
    expect(updateCalls[1][0]).toEqual({ status: 'active' })
  })

  it('surfaces a pause failure instead of reporting the lease as cleanly updated', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const linkedLease = { ...LEASE_ROW, recurring_schedule_id: 'schedule-1' }
    enqueue({ data: linkedLease }) // existing lookup
    enqueue({ data: { ...linkedLease, status: 'ended' } }) // update
    pauseLeaseSchedule.mockResolvedValue({
      ok: false,
      stage: 'header',
      error: { name: 'PostgrestError', message: 'db down', details: '', hint: '', code: '500' },
    })

    const res = await findRoute('PATCH', '/leases/:id').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'PATCH', { status: 'ended' }),
      makeContext(supabase),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('POST /leases/:id/sync', () => {
  it('returns 404 for a non-UUID id without querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()
    const res = await findRoute('POST', '/leases/:id/sync').handler(
      makeRequest('https://test.local/x?_id=not-a-uuid', 'POST'),
      makeContext(supabase),
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when the lease does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const res = await findRoute('POST', '/leases/:id/sync').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'POST'),
      makeContext(supabase),
    )
    expect(res.status).toBe(404)
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })

  it('returns the scheduleId on a successful sync', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: LEASE_ROW })
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })
    const res = await findRoute('POST', '/leases/:id/sync').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'POST'),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.scheduleId).toBe('schedule-1')
  })

  // This route is the ONE deliberate "recreate it" action per the operator's
  // answer: a human hitting /sync after an operator deleted the linked
  // schedule on the core recurring-invoice page is explicit intent, unlike
  // the daily cron or an unrelated PATCH edit.
  it('opts into allowRecreateAfterDelete, unlike every other caller', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: LEASE_ROW })
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })
    await findRoute('POST', '/leases/:id/sync').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'POST'),
      makeContext(supabase),
    )
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledWith(
      supabase,
      LEASE_ROW,
      undefined,
      { allowRecreateAfterDelete: true },
    )
  })

  // The adversarial finding this round fixed: a stale sync attempt on a
  // lease whose schedule was deleted must report the gap, not paper over it.
  it('maps a schedule_deleted refusal to the reported 409 error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: LEASE_ROW })
    syncLeaseToRecurringSchedule.mockResolvedValue({ ok: false, stage: 'schedule_deleted' })
    const res = await findRoute('POST', '/leases/:id/sync').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'POST'),
      makeContext(supabase),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('LEASE_SCHEDULE_DELETED')
  })

  // Status guard: an ended lease must never be handed a new active
  // schedule. Without this, a lease ended AND whose schedule was later
  // deleted would let allowRecreateAfterDelete provision a fresh active
  // schedule here, resuming billing for a tenant the operator already ended.
  it('refuses to sync an ended lease and never calls the sync engine', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...LEASE_ROW, status: 'ended' } })
    const res = await findRoute('POST', '/leases/:id/sync').handler(
      makeRequest(`https://test.local/x?_id=${VALID_UUID}`, 'POST'),
      makeContext(supabase),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('LEASE_SYNC_ENDED')
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })
})
