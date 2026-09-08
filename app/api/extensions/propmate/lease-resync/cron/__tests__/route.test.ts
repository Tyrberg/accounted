import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyCronSecret = vi.fn((_request: Request) => null as unknown)
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: (request: Request) => verifyCronSecret(request),
}))

const registryGet = vi.fn()
vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/extensions/registry')>()
  return {
    ...actual,
    extensionRegistry: { ...actual.extensionRegistry, get: (...args: unknown[]) => registryGet(...args) },
  }
})

// The lease query chain ends in .limit(...).returns<LeaseRow[]>(); resolve there.
const limitResult = vi.fn()
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            order: () => ({
              limit: () => ({
                returns: () => limitResult(),
              }),
            }),
          }),
        }),
      }),
    }),
  })),
}))

const syncLeaseToRecurringSchedule = vi.fn()
const expireLeaseIfPastEndDate = vi.fn()
vi.mock('@/extensions/general/propmate/lib/lease-schedule-sync', () => ({
  syncLeaseToRecurringSchedule: (...args: unknown[]) => syncLeaseToRecurringSchedule(...args),
  expireLeaseIfPastEndDate: (...args: unknown[]) => expireLeaseIfPastEndDate(...args),
}))

const LEASE_1 = { id: 'lease-1', company_id: 'company-1' }
const LEASE_2 = { id: 'lease-2', company_id: 'company-1' }

async function callRoute() {
  const { GET } = await import('../route')
  return GET(new Request('https://example.test/api/extensions/propmate/lease-resync/cron'))
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyCronSecret.mockReturnValue(null)
  registryGet.mockReturnValue({ id: 'propmate' })
  limitResult.mockResolvedValue({ data: [LEASE_1], error: null })
  syncLeaseToRecurringSchedule.mockResolvedValue({ ok: true, scheduleId: 'schedule-1' })
  expireLeaseIfPastEndDate.mockResolvedValue({ expired: false })
})

describe('GET /api/extensions/propmate/lease-resync/cron', () => {
  it('returns 401 when the cron secret is wrong', async () => {
    verifyCronSecret.mockReturnValue({ error: 'unauthorized' })
    const res = await callRoute()
    expect(res.status).toBe(401)
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })

  it('refuses with 503 when the extension is not enabled', async () => {
    registryGet.mockReturnValue(undefined)
    const res = await callRoute()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('EXTENSION_DISABLED')
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })

  it('fails loudly when the lease query errors', async () => {
    limitResult.mockResolvedValue({ data: null, error: { message: 'boom', code: '500' } })
    const res = await callRoute()
    expect(res.status).toBe(500)
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
  })

  it('syncs each active lease and reports the summary', async () => {
    const res = await callRoute()
    expect(res.status).toBe(200)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledTimes(1)
    const body = await res.json()
    expect(body.data).toMatchObject({ total: 1, succeeded: 1, failed: 0 })
  })

  it('isolates a per-lease sync failure without aborting the run', async () => {
    limitResult.mockResolvedValue({ data: [LEASE_1, LEASE_2], error: null })
    syncLeaseToRecurringSchedule
      .mockResolvedValueOnce({ ok: false, code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID', details: {} })
      .mockResolvedValueOnce({ ok: true, scheduleId: 'schedule-2' })

    const res = await callRoute()

    expect(res.status).toBe(200)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledTimes(2)
    const body = await res.json()
    expect(body.data).toMatchObject({ total: 2, succeeded: 1, failed: 1 })
  })

  // The finding this round fixed: a lease past its end_date must stop being
  // billed instead of resynced, since this daily pass is the only place that
  // revisits every active lease on its own.
  it('expires a lease past its end_date instead of syncing it', async () => {
    expireLeaseIfPastEndDate.mockResolvedValue({ expired: true, ok: true })

    const res = await callRoute()

    expect(res.status).toBe(200)
    expect(syncLeaseToRecurringSchedule).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.data).toMatchObject({ total: 1, succeeded: 1, failed: 0 })
  })

  // The adversarial finding this round fixed: a lease whose linked schedule
  // was deleted by an operator (recurring_schedule_id NULL, last_synced_at
  // still set) must never be silently re-provisioned by this cron. The sync
  // helper itself refuses (returns stage: 'schedule_deleted'); this asserts
  // the cron surfaces that refusal as a reported per-lease failure, exactly
  // like any other sync failure, rather than swallowing it as a success.
  it('reports (never silently recreates) a lease whose schedule was deleted by an operator', async () => {
    syncLeaseToRecurringSchedule.mockResolvedValueOnce({ ok: false, stage: 'schedule_deleted' })

    const res = await callRoute()

    expect(res.status).toBe(200)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledTimes(1)
    // Cron calls with no options object at all, so allowRecreateAfterDelete
    // is never set: it can never opt into recreating a deleted schedule.
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledWith(expect.anything(), LEASE_1)
    const body = await res.json()
    expect(body.data).toMatchObject({ total: 1, succeeded: 0, failed: 1 })
    expect(body.data.failures[0].error).toMatch(/schedule was deleted/)
    // ctx.forEach's own summary only carries {index, error}: the lease id
    // must be embedded in the message itself so the daily gap can be
    // identified from the run's JSON response alone.
    expect(body.data.failures[0].error).toMatch(/^lease lease-1:/)
  })

  it('reports a per-lease failure when expiring a lease fails, without aborting the run', async () => {
    limitResult.mockResolvedValue({ data: [LEASE_1, LEASE_2], error: null })
    expireLeaseIfPastEndDate
      .mockResolvedValueOnce({ expired: true, ok: false, error: 'boom' })
      .mockResolvedValueOnce({ expired: false })

    const res = await callRoute()

    expect(res.status).toBe(200)
    expect(syncLeaseToRecurringSchedule).toHaveBeenCalledTimes(1)
    const body = await res.json()
    expect(body.data).toMatchObject({ total: 2, succeeded: 1, failed: 1 })
    expect(body.data.failures[0].error).toBe('lease lease-1: boom')
  })

  it('names the failing lease in the summary when a sync itself fails', async () => {
    limitResult.mockResolvedValue({ data: [LEASE_1, LEASE_2], error: null })
    syncLeaseToRecurringSchedule
      .mockResolvedValueOnce({ ok: false, code: 'INVOICE_CREATE_REVENUE_ACCOUNT_INVALID', details: {} })
      .mockResolvedValueOnce({ ok: true, scheduleId: 'schedule-2' })

    const res = await callRoute()

    const body = await res.json()
    expect(body.data.failures[0].error).toBe('lease lease-1: INVOICE_CREATE_REVENUE_ACCOUNT_INVALID')
  })
})
