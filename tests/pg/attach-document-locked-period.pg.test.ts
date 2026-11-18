import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'

// attach_document_to_locked_period_entry (migration 20261116120000): the one
// audited path that archives underlag against a verifikat in a closed/locked
// period. These tests pin the contract the backoffice client is built on:
// the new path succeeds, the ordinary path still raises, the verifikat is
// untouched, a duplicate sha256 is an idempotent no-op, and the audit trail
// lands on the verifikat.

const PERIOD_LOCK_ERROR = /locked\/closed fiscal period/i

function sha(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64)
}

async function seedLockedEntry(mode: 'closed' | 'locked' = 'locked') {
  const seed = await seedCompany()
  const entryId = await insertPostedJournalEntry({
    userId: seed.userId,
    companyId: seed.companyId,
    fiscalPeriodId: seed.fiscalPeriodId,
    voucherNumber: 1,
  })
  if (mode === 'closed') {
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [seed.fiscalPeriodId],
    )
  } else {
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [
      seed.fiscalPeriodId,
    ])
  }
  return { ...seed, entryId }
}

interface AttachArgs {
  companyId: string
  entryId: string
  userId: string
  sha256: string
  storagePath?: string
  reason?: string
  apiKeyId?: string | null
  /** Skip seeding the unlinked upload row that holds the storage object. */
  noSourceRow?: boolean
}

function defaultPath(companyId: string, userId: string): string {
  return `documents/${companyId}/${userId}/1700000000000_underlag.pdf`
}

/** The ordinary upload: an unlinked document row holding the object. */
async function seedSourceDocument(
  companyId: string,
  userId: string,
  storagePath: string,
  sha256: string,
): Promise<string> {
  const { rows: [doc] } = await getPool().query<{ id: string }>(
    `INSERT INTO public.document_attachments
       (user_id, company_id, storage_path, file_name, sha256_hash)
     VALUES ($1, $2, $3, 'underlag.pdf', $4) RETURNING id`,
    [userId, companyId, storagePath, sha256],
  )
  return doc.id
}

async function attach(args: AttachArgs): Promise<Record<string, unknown>> {
  const storagePath = args.storagePath ?? defaultPath(args.companyId, args.userId)
  if (!args.noSourceRow) {
    const { rows } = await getPool().query(
      `SELECT 1 FROM public.document_attachments WHERE company_id = $1 AND storage_path = $2`,
      [args.companyId, storagePath],
    )
    if (rows.length === 0) {
      await seedSourceDocument(args.companyId, args.userId, storagePath, args.sha256.toLowerCase())
    }
  }
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ result: Record<string, unknown> }>(
      `SELECT public.attach_document_to_locked_period_entry(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS result`,
      [
        args.companyId,
        args.entryId,
        storagePath,
        'underlag.pdf',
        2048,
        'application/pdf',
        args.sha256,
        args.reason ?? 'Underlag till stängt år',
        args.userId,
        args.apiKeyId ?? null,
        'backoffice',
      ],
    )
    return rows[0].result
  })
}

async function entrySnapshot(entryId: string) {
  const { rows: [entry] } = await getPool().query(
    `SELECT to_jsonb(je) - 'updated_at' AS row FROM public.journal_entries je WHERE id = $1`,
    [entryId],
  )
  const { rows: lines } = await getPool().query(
    `SELECT to_jsonb(l) AS row FROM public.journal_entry_lines l
      WHERE journal_entry_id = $1 ORDER BY id`,
    [entryId],
  )
  return { entry: entry.row, lines: lines.map((l) => l.row) }
}

describe('attach-document-locked-period.pg: audited attach in a locked period', () => {
  it('links a document to a verifikat in a LOCKED period via the new path', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const hash = sha()

    const result = await attach({ companyId, entryId, userId, sha256: hash })
    expect(result.created).toBe(true)
    expect(result.journal_entry_id).toBe(entryId)

    const { rows } = await getPool().query(
      `SELECT journal_entry_id, sha256_hash, upload_source, uploaded_by
         FROM public.document_attachments WHERE id = $1`,
      [result.document_id],
    )
    expect(rows[0]).toMatchObject({
      journal_entry_id: entryId,
      sha256_hash: hash,
      upload_source: 'api',
      uploaded_by: userId,
    })
  })

  it('links a document to a verifikat in a CLOSED period via the new path', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('closed')
    const result = await attach({ companyId, entryId, userId, sha256: sha() })
    expect(result.created).toBe(true)
  })

  it('does not unlock the period and the ordinary path still raises afterwards', async () => {
    const { userId, companyId, entryId, fiscalPeriodId } = await seedLockedEntry('locked')
    await attach({ companyId, entryId, userId, sha256: sha() })

    const { rows: [period] } = await getPool().query(
      `SELECT is_closed, locked_at FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(period.locked_at).not.toBeNull()

    await expect(
      getPool().query(
        `INSERT INTO public.document_attachments
           (user_id, company_id, storage_path, file_name, sha256_hash, journal_entry_id)
         VALUES ($1, $2, $3, 'x.pdf', $4, $5)`,
        [userId, companyId, `documents/${companyId}/${userId}/x.pdf`, sha(), entryId],
      ),
    ).rejects.toThrow(PERIOD_LOCK_ERROR)
  })

  it('the carve-out GUC never permits re-linking an existing document (UPDATE)', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const { rows: [doc] } = await getPool().query<{ id: string }>(
      `INSERT INTO public.document_attachments
         (user_id, company_id, storage_path, file_name, sha256_hash)
       VALUES ($1, $2, $3, 'loose.pdf', $4) RETURNING id`,
      [userId, companyId, `documents/${companyId}/${userId}/loose.pdf`, sha()],
    )
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_locked_period_attach', $1, true)`, [entryId])
      await expect(
        client.query(`UPDATE public.document_attachments SET journal_entry_id = $1 WHERE id = $2`, [
          entryId,
          doc.id,
        ]),
      ).rejects.toThrow()
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('leaves the verifikat unchanged: no lines, amounts, date, number or status change', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const before = await entrySnapshot(entryId)
    await attach({ companyId, entryId, userId, sha256: sha() })
    const after = await entrySnapshot(entryId)
    expect(after).toEqual(before)
  })

  it('rejects a duplicate sha256 on the same verifikat idempotently', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const hash = sha()

    const first = await attach({ companyId, entryId, userId, sha256: hash })
    const second = await attach({ companyId, entryId, userId, sha256: hash.toUpperCase() })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.document_id).toBe(first.document_id)

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.document_attachments
        WHERE journal_entry_id = $1 AND sha256_hash = $2`,
      [entryId, hash],
    )
    expect(rows[0].n).toBe(1)

    const { rows: audits } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.audit_log
        WHERE action = 'LOCKED_PERIOD_ATTACH' AND record_id = $1`,
      [entryId],
    )
    expect(audits[0].n).toBe(1)
  })

  it('writes the audit trail on the verifikat: who, key, file, sha256, reason', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const hash = sha()
    const apiKeyId = randomUUID()
    const result = await attach({
      companyId,
      entryId,
      userId,
      sha256: hash,
      apiKeyId,
      reason: 'Arkivering av underlag för stängt år',
    })

    const { rows } = await getPool().query(
      `SELECT user_id, actor_id, company_id, table_name, record_id, new_state, created_at
         FROM public.audit_log
        WHERE action = 'LOCKED_PERIOD_ATTACH' AND record_id = $1`,
      [entryId],
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toMatchObject({
      user_id: userId,
      actor_id: userId,
      company_id: companyId,
      table_name: 'journal_entries',
      record_id: entryId,
    })
    expect(row.created_at).toBeInstanceOf(Date)
    expect(row.new_state).toMatchObject({
      document_id: result.document_id,
      journal_entry_id: entryId,
      file_name: 'underlag.pdf',
      sha256_hash: hash,
      reason: 'Arkivering av underlag för stängt år',
      api_key_id: apiKeyId,
      api_key_name: 'backoffice',
    })
  })

  it('refuses an open period: the ordinary link path applies there', async () => {
    const seed = await seedCompany()
    const entryId = await insertPostedJournalEntry({
      userId: seed.userId,
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      voucherNumber: 1,
    })
    await expect(
      attach({ companyId: seed.companyId, entryId, userId: seed.userId, sha256: sha() }),
    ).rejects.toThrow(/LOCKED_ATTACH_PERIOD_OPEN/)
  })

  it('refuses a verifikat belonging to another company', async () => {
    const { entryId } = await seedLockedEntry('locked')
    const other = await seedCompany()
    await expect(
      attach({ companyId: other.companyId, entryId, userId: other.userId, sha256: sha() }),
    ).rejects.toThrow(/LOCKED_ATTACH_NOT_FOUND/)
  })

  it('refuses a storage path outside the company prefix', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const other = await seedCompany()
    await expect(
      attach({
        companyId,
        entryId,
        userId,
        sha256: sha(),
        storagePath: `documents/${other.companyId}/${userId}/x.pdf`,
        noSourceRow: true,
      }),
    ).rejects.toThrow(/LOCKED_ATTACH_INVALID/)
  })

  it('refuses a storage path with a .. traversal segment', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    await expect(
      attach({
        companyId,
        entryId,
        userId,
        sha256: sha(),
        storagePath: `documents/${companyId}/../other/x.pdf`,
        noSourceRow: true,
      }),
    ).rejects.toThrow(/LOCKED_ATTACH_INVALID/)
  })

  it('accepts a file name with consecutive dots (not a traversal segment)', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const result = await attach({
      companyId,
      entryId,
      userId,
      sha256: sha(),
      storagePath: `documents/${companyId}/${userId}/1700000000000_receipt..pdf`,
    })
    expect(result.created).toBe(true)
  })

  it('refuses an actor who is not a writing member of the company', async () => {
    const { companyId, entryId } = await seedLockedEntry('locked')
    const outsider = await seedCompany()
    await expect(
      attach({ companyId, entryId, userId: outsider.userId, sha256: sha() }),
    ).rejects.toThrow(/LOCKED_ATTACH_FORBIDDEN/)
  })

  it('is not callable by an authenticated JWT caller', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `SELECT public.attach_document_to_locked_period_entry(
             $1, $2, $3, 'x.pdf', 1, 'application/pdf', $4, 'r', $5)`,
          [companyId, entryId, `documents/${companyId}/${userId}/x.pdf`, sha(), userId],
        ),
      ),
    ).rejects.toThrow(/permission denied|LOCKED_ATTACH_FORBIDDEN/)
  })
})

describe('attach-document-locked-period.pg: archived bytes stay retained', () => {
  it('refuses a storage object that no document row in the company holds', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    await expect(
      attach({ companyId, entryId, userId, sha256: sha(), noSourceRow: true }),
    ).rejects.toThrow(/LOCKED_ATTACH_SOURCE_NOT_FOUND/)
  })

  it('refuses a source row that belongs to another company', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const other = await seedCompany()
    const path = defaultPath(companyId, userId)
    await seedSourceDocument(other.companyId, other.userId, path, sha())
    await expect(
      attach({ companyId, entryId, userId, sha256: sha(), noSourceRow: true }),
    ).rejects.toThrow(/LOCKED_ATTACH_SOURCE_NOT_FOUND/)
  })

  it('accepts a source row stored under the legacy key layout', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const hash = sha()
    await seedSourceDocument(companyId, userId, `documents/${userId}/1700000000000_underlag.pdf`, hash)
    const result = await attach({ companyId, entryId, userId, sha256: hash, noSourceRow: true })
    expect(result.created).toBe(true)
  })

  it('upload unlinked, archive, then deleting the original upload is refused', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const hash = sha()
    const path = defaultPath(companyId, userId)
    const originalId = await seedSourceDocument(companyId, userId, path, hash)

    const result = await attach({ companyId, entryId, userId, sha256: hash })
    expect(result.created).toBe(true)

    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [originalId]),
    ).rejects.toThrow(/retained underlag.*Bokföringslagen/)

    const { rows } = await getPool().query(
      `SELECT id FROM public.document_attachments WHERE storage_path = $1 ORDER BY created_at`,
      [path],
    )
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([originalId, result.document_id]))
  })

  it('also refuses deleting a legacy-layout original whose object was archived', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const hash = sha()
    const originalId = await seedSourceDocument(
      companyId,
      userId,
      `documents/${userId}/1700000000000_underlag.pdf`,
      hash,
    )
    await attach({ companyId, entryId, userId, sha256: hash, noSourceRow: true })
    await expect(
      getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [originalId]),
    ).rejects.toThrow(/Bokföringslagen/)
  })

  it('still lets an unrelated unlinked document be deleted', async () => {
    const { userId, companyId } = await seedLockedEntry('locked')
    const id = await seedSourceDocument(
      companyId,
      userId,
      `documents/${companyId}/${userId}/1700000000001_loose.pdf`,
      sha(),
    )
    await getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [id])
    const { rows } = await getPool().query(
      `SELECT 1 FROM public.document_attachments WHERE id = $1`,
      [id],
    )
    expect(rows).toHaveLength(0)
  })

  it('a delete that commits first leaves nothing to archive (concurrent race)', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const hash = sha()
    const path = defaultPath(companyId, userId)
    const originalId = await seedSourceDocument(companyId, userId, path, hash)

    const deleter = await getPool().connect()
    try {
      await deleter.query('BEGIN')
      await deleter.query(`DELETE FROM public.document_attachments WHERE id = $1`, [originalId])
      // The archive blocks on the deleted row's lock until the delete commits.
      const pending = attach({ companyId, entryId, userId, sha256: hash, noSourceRow: true })
      await new Promise((r) => setTimeout(r, 200))
      await deleter.query('COMMIT')
      await expect(pending).rejects.toThrow(/LOCKED_ATTACH_SOURCE_NOT_FOUND/)
    } finally {
      await deleter.query('ROLLBACK').catch(() => {})
      deleter.release()
    }
  })

  it('an archive that commits first makes the waiting delete fail (concurrent race)', async () => {
    const { userId, companyId, entryId } = await seedLockedEntry('locked')
    const hash = sha()
    const path = defaultPath(companyId, userId)
    const originalId = await seedSourceDocument(companyId, userId, path, hash)

    const archiver = await getPool().connect()
    try {
      await archiver.query('BEGIN')
      await archiver.query(`SET LOCAL ROLE service_role`)
      await archiver.query(
        `SELECT public.attach_document_to_locked_period_entry(
           $1, $2, $3, 'underlag.pdf', 2048, 'application/pdf', $4, 'r', $5, NULL, NULL)`,
        [companyId, entryId, path, hash, userId],
      )
      // The delete blocks on the source row's KEY SHARE lock.
      const pending = getPool().query(`DELETE FROM public.document_attachments WHERE id = $1`, [
        originalId,
      ])
      await new Promise((r) => setTimeout(r, 200))
      await archiver.query('COMMIT')
      await expect(pending).rejects.toThrow(/Bokföringslagen/)
    } finally {
      await archiver.query('ROLLBACK').catch(() => {})
      archiver.release()
    }
  })
})
