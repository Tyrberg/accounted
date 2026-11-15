import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { seedCompany, insertTransaction } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20261115120000_svea_no_merchant_label_backfill.sql:
 * stored Svea card rows titled 'Okänd transaktion' get the no-merchant label
 * (so the underlag list asks for their receipt), and nothing else moves.
 */

const BACKFILL_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261115120000_svea_no_merchant_label_backfill.sql'),
  'utf8',
)
const LABEL = 'Kortköp, handlare saknas i bankdata'

async function runBackfill(): Promise<void> {
  await getPool().query(BACKFILL_SQL)
}

async function insertConnection(companyId: string, userId: string, bankName: string): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO public.bank_connections (company_id, user_id, provider, bank_name, status)
     VALUES ($1, $2, 'enable_banking', $3, 'active') RETURNING id`,
    [companyId, userId, bankName],
  )
  return rows[0].id as string
}

async function insertBankRow(params: {
  companyId: string
  userId: string
  connectionId: string
  description?: string
  amount?: number
  titleEditedAt?: string | null
  merchantName?: string | null
}): Promise<string> {
  const description = params.description ?? 'Okänd transaktion'
  const id = await insertTransaction({
    companyId: params.companyId,
    userId: params.userId,
    description,
    amount: params.amount ?? 194.29,
  })
  await getPool().query(
    `UPDATE public.transactions
        SET bank_connection_id = $2, import_source = 'enable_banking',
            original_description = $3, title_edited_at = $4::timestamptz,
            merchant_name = $5
      WHERE id = $1`,
    [id, params.connectionId, description, params.titleEditedAt ?? null, params.merchantName ?? null],
  )
  return id
}

async function getRow(id: string): Promise<{
  description: string
  original_description: string
  amount: string
}> {
  const { rows } = await getPool().query(
    `SELECT description, original_description, amount::text FROM public.transactions WHERE id = $1`,
    [id],
  )
  return rows[0]
}

describe('svea no-merchant label backfill', () => {
  it('relabels an empty Svea row and leaves amount and sign alone', async () => {
    const { userId, companyId } = await seedCompany()
    const svea = await insertConnection(companyId, userId, 'Svea Bank')
    const row = await insertBankRow({ companyId, userId, connectionId: svea, amount: 2837.58 })

    await runBackfill()

    expect(await getRow(row)).toEqual({
      description: LABEL,
      original_description: LABEL,
      amount: '2837.58',
    })
  })

  it('keeps a user-renamed title but still relabels the bank original', async () => {
    const { userId, companyId } = await seedCompany()
    const svea = await insertConnection(companyId, userId, 'Svea Bank')
    const row = await insertBankRow({ companyId, userId, connectionId: svea })
    await getPool().query(
      `UPDATE public.transactions SET description = 'Example AB lunch' WHERE id = $1`,
      [row],
    )
    await getPool().query(
      `UPDATE public.transactions SET title_edited_at = now() WHERE id = $1`,
      [row],
    )

    await runBackfill()

    const out = await getRow(row)
    expect(out.description).toBe('Example AB lunch')
    expect(out.original_description).toBe(LABEL)
  })

  it('leaves other banks, described rows and rows with a merchant untouched, and is idempotent', async () => {
    const { userId, companyId } = await seedCompany()
    const svea = await insertConnection(companyId, userId, 'Svea Bank')
    const other = await insertConnection(companyId, userId, 'Example Bank')
    const sveaPrefixed = await insertConnection(companyId, userId, 'Sveaexample Bank')

    const otherBank = await insertBankRow({ companyId, userId, connectionId: other })
    const notSvea = await insertBankRow({ companyId, userId, connectionId: sveaPrefixed })
    const described = await insertBankRow({ companyId, userId, connectionId: svea, description: 'Example AB' })
    const withMerchant = await insertBankRow({
      companyId,
      userId,
      connectionId: svea,
      merchantName: 'Example AB',
    })
    const target = await insertBankRow({ companyId, userId, connectionId: svea })

    await runBackfill()
    const first = await Promise.all([otherBank, notSvea, described, withMerchant, target].map(getRow))
    await runBackfill()
    const second = await Promise.all([otherBank, notSvea, described, withMerchant, target].map(getRow))

    expect(first[0].description).toBe('Okänd transaktion')
    expect(first[1].description).toBe('Okänd transaktion')
    expect(first[2].description).toBe('Example AB')
    expect(first[3].description).toBe('Okänd transaktion')
    expect(first[4].description).toBe(LABEL)
    expect(second).toEqual(first)
  })
})
