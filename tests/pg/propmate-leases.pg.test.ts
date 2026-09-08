import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260907120000_propmate_lease_and_schedule_revenue_account:
// leases RLS (member read, stranger blind, viewer denied writes), the
// campaign-triple/date-order/end-after-start CHECKs, the class-3-only
// revenue_account CHECK on leases (narrower than the general class 1-3 shape
// check added on recurring_invoice_schedule_items in the same migration).

async function seedCustomer(companyId: string, userId: string): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Hyresgäst AB', 'swedish_business')`,
    [customerId, userId, companyId],
  )
  return customerId
}

async function seedLease(
  companyId: string,
  userId: string,
  customerId: string,
  overrides: Partial<{
    monthlyRent: number
    campaignAmount: number | null
    campaignStart: string | null
    campaignEnd: string | null
    revenueAccount: string | null
    startDate: string
    endDate: string | null
  }> = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.leases
       (id, company_id, user_id, customer_id, property_name, monthly_rent,
        campaign_price_amount, campaign_start_date, campaign_end_date,
        revenue_account, start_date, end_date)
     VALUES ($1, $2, $3, $4, 'Bohed', $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      companyId,
      userId,
      customerId,
      overrides.monthlyRent ?? 12000,
      overrides.campaignAmount ?? null,
      overrides.campaignStart ?? null,
      overrides.campaignEnd ?? null,
      overrides.revenueAccount ?? null,
      overrides.startDate ?? '2026-01-01',
      overrides.endDate ?? null,
    ],
  )
  return id
}

describe('leases RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    const leaseId = await seedLease(companyId, userId, customerId)
    const stranger = await insertAuthUser()

    const memberView = await withUserContext(userId, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.leases WHERE id = $1`, [leaseId]),
    )
    expect(memberView.rows).toHaveLength(1)

    const strangerView = await withUserContext(stranger, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.leases WHERE id = $1`, [leaseId]),
    )
    expect(strangerView.rows).toHaveLength(0)
  })

  it('non-members cannot write at all', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    const stranger = await insertAuthUser()

    await expect(
      withUserContext(stranger, (client) =>
        client.query(
          `INSERT INTO public.leases (company_id, user_id, customer_id, property_name, monthly_rent, start_date)
           VALUES ($1, $2, $3, 'IDOR', 5000, '2026-01-01')`,
          [companyId, stranger, customerId],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission|privilege/i)
  })

  it('a viewer member is blocked by the aa_enforce_company_writer_role gate', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.leases (company_id, user_id, customer_id, property_name, monthly_rent, start_date)
           VALUES ($1, $2, $3, 'Viewer blocked', 5000, '2026-01-01')`,
          [companyId, viewer, customerId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('leases CHECK constraints', () => {
  it('rejects a partial kampanjpris triple', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    await expect(
      seedLease(companyId, userId, customerId, { campaignAmount: 8000 }),
    ).rejects.toThrow(/leases_campaign_triple/)
  })

  it('rejects a kampanjpris end before its start', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    await expect(
      seedLease(companyId, userId, customerId, {
        campaignAmount: 8000,
        campaignStart: '2026-04-30',
        campaignEnd: '2026-02-01',
      }),
    ).rejects.toThrow(/leases_campaign_dates_order/)
  })

  it('accepts a complete, in-order kampanjpris triple', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    const leaseId = await seedLease(companyId, userId, customerId, {
      campaignAmount: 8000,
      campaignStart: '2026-02-01',
      campaignEnd: '2026-04-30',
    })
    const row = await getPool().query(`SELECT id FROM public.leases WHERE id = $1`, [leaseId])
    expect(row.rows).toHaveLength(1)
  })

  it('rejects a lease end_date before its start_date', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    await expect(
      seedLease(companyId, userId, customerId, { startDate: '2026-06-01', endDate: '2026-01-01' }),
    ).rejects.toThrow(/leases_end_after_start/)
  })

  it('rejects a class 1-2 revenue_account override, unlike the general class 1-3 shape check', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    // '1510' and '2611' are shape-valid for the general
    // recurring_invoice_schedule_items check (class 1-3) but must still be
    // refused here: a lease line is always revenue, never a deposit/advance.
    await expect(
      seedLease(companyId, userId, customerId, { revenueAccount: '1510' }),
    ).rejects.toThrow(/leases_revenue_account_check/)
    await expect(
      seedLease(companyId, userId, customerId, { revenueAccount: '2611' }),
    ).rejects.toThrow(/leases_revenue_account_check/)
  })

  it('accepts a class 3 revenue_account override', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    const leaseId = await seedLease(companyId, userId, customerId, { revenueAccount: '3011' })
    const row = await getPool().query(`SELECT revenue_account FROM public.leases WHERE id = $1`, [leaseId])
    expect(row.rows[0].revenue_account).toBe('3011')
  })

  // Defense in depth for a hand-edited additions row bypassing
  // LeaseAdditionSchema's z.number().nonnegative(): a negative tillägg would
  // become a negative invoice line on a real avisering.
  it('rejects a negative amount inside the additions array', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    await expect(
      getPool().query(
        `INSERT INTO public.leases
           (company_id, user_id, customer_id, property_name, monthly_rent, additions, start_date)
         VALUES ($1, $2, $3, 'Bohed', 12000, $4::jsonb, '2026-01-01')`,
        [companyId, userId, customerId, JSON.stringify([{ description: 'El', amount: -500 }])],
      ),
    ).rejects.toThrow(/leases_additions_amounts_nonnegative/)
  })

  it('accepts a zero or positive amount inside the additions array', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    const result = await getPool().query(
      `INSERT INTO public.leases
         (company_id, user_id, customer_id, property_name, monthly_rent, additions, start_date)
       VALUES ($1, $2, $3, 'Bohed', 12000, $4::jsonb, '2026-01-01') RETURNING id`,
      [companyId, userId, customerId, JSON.stringify([{ description: 'El', amount: 500 }])],
    )
    expect(result.rows).toHaveLength(1)
  })
})

describe('leases.recurring_schedule_id ON DELETE SET NULL', () => {
  // This is the DB-level precondition the application-level fix in
  // extensions/general/propmate/lib/lease-schedule-sync.ts depends on: an
  // operator deleting a schedule on the core recurring-invoice page
  // (DELETE FROM recurring_invoice_schedules, app/api/invoices/recurring/[id]/
  // route.ts) must null the lease's back-link WITHOUT touching
  // last_synced_at, since last_synced_at staying set is exactly what lets
  // syncLeaseToRecurringSchedule tell "schedule deleted" apart from "never
  // synced" and refuse to silently re-provision.
  it('nulls recurring_schedule_id but leaves last_synced_at set when the linked schedule is deleted', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    const leaseId = await seedLease(companyId, userId, customerId)

    const scheduleId = randomUUID()
    await getPool().query(
      `INSERT INTO public.recurring_invoice_schedules
         (id, company_id, user_id, customer_id, name, day_of_month, next_run_date)
       VALUES ($1, $2, $3, $4, 'Hyra', 1, '2026-02-01')`,
      [scheduleId, companyId, userId, customerId],
    )
    await getPool().query(
      `UPDATE public.leases SET recurring_schedule_id = $1, last_synced_at = now() WHERE id = $2`,
      [scheduleId, leaseId],
    )

    await getPool().query(`DELETE FROM public.recurring_invoice_schedules WHERE id = $1`, [scheduleId])

    const row = await getPool().query<{ recurring_schedule_id: string | null; last_synced_at: Date | null }>(
      `SELECT recurring_schedule_id, last_synced_at FROM public.leases WHERE id = $1`,
      [leaseId],
    )
    expect(row.rows[0].recurring_schedule_id).toBeNull()
    expect(row.rows[0].last_synced_at).not.toBeNull()
  })
})

describe('recurring_invoice_schedule_items.revenue_account shape check', () => {
  it('accepts class 1-3 and rejects everything else', async () => {
    const { userId, companyId } = await seedCompany()
    const customerId = await seedCustomer(companyId, userId)
    const scheduleId = randomUUID()
    await getPool().query(
      `INSERT INTO public.recurring_invoice_schedules
         (id, company_id, user_id, customer_id, name, day_of_month, next_run_date)
       VALUES ($1, $2, $3, $4, 'Hyra', 1, '2026-02-01')`,
      [scheduleId, companyId, userId, customerId],
    )

    const insertItem = (account: string | null) =>
      getPool().query(
        `INSERT INTO public.recurring_invoice_schedule_items
           (schedule_id, description, quantity, unit_price, revenue_account)
         VALUES ($1, 'Hyra', 1, 12000, $2)`,
        [scheduleId, account],
      )

    await expect(insertItem('1510')).resolves.toBeDefined()
    await expect(insertItem('3011')).resolves.toBeDefined()
    await expect(insertItem(null)).resolves.toBeDefined()
    await expect(insertItem('7010')).rejects.toThrow(/recurring_invoice_schedule_items_revenue_account_shape/)
    await expect(insertItem('123')).rejects.toThrow(/recurring_invoice_schedule_items_revenue_account_shape/)
  })
})
