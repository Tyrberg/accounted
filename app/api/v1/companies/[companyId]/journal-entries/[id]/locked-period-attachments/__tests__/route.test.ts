/**
 * Tests for POST /api/v1/companies/{companyId}/journal-entries/{id}/locked-period-attachments
 *
 * The DB contract (period stays locked, entry unchanged, sha256 duplicate,
 * audit trail) is pinned by tests/pg/attach-document-locked-period.pg.test.ts.
 * These tests cover the route: auth, scope, validation, tenant pre-check,
 * server-side hashing of the stored bytes, RPC error mapping and the
 * created (201) vs already-linked (200) split.
 */
import { createHash } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DOC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const API_KEY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/journal-entries/${ENTRY_ID}/locked-period-attachments`
const STORAGE_PATH = `documents/${COMPANY_ID}/user-1/1700000000000_kvitto.pdf`
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% test fixture\n')
const PDF_SHA = createHash('sha256').update(PDF_BYTES).digest('hex')

type MockResult = { data?: unknown; error?: unknown }

function makeSupabase(opts: {
  entry?: MockResult
  download?: MockResult
  rpc?: MockResult
} = {}) {
  const tables: Record<string, MockResult> = {
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    journal_entries: opts.entry ?? { data: { id: ENTRY_ID }, error: null },
    idempotency_keys: { data: null, error: null },
  }
  const buildChain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(tables[table] ?? { data: null, error: null })
          }
          return () => buildChain(table)
        },
      },
    )
  const download = vi.fn().mockResolvedValue(
    opts.download ?? { data: new Blob([PDF_BYTES]), error: null },
  )
  const rpc = vi.fn().mockResolvedValue(
    opts.rpc ?? {
      data: {
        created: true,
        document_id: DOC_ID,
        journal_entry_id: ENTRY_ID,
        file_name: 'kvitto.pdf',
        storage_path: STORAGE_PATH,
        sha256_hash: PDF_SHA,
        created_at: '2026-11-16T10:00:00+00:00',
      },
      error: null,
    },
  )
  const supabase = {
    from: vi.fn((table: string) => buildChain(table)),
    storage: { from: vi.fn(() => ({ download })) },
    rpc,
  }
  return { supabase, download, rpc }
}

function makeRequest(body: unknown, opts: { idempotencyKey?: string | null; dryRun?: boolean } = {}): Request {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-fixture-not-a-real-key',
    'Content-Type': 'application/json',
  }
  if (opts.idempotencyKey !== null) {
    headers['Idempotency-Key'] = opts.idempotencyKey ?? 'idem1234-aaaa-4abc-8def-1234567890ab'
  }
  const url = opts.dryRun ? `${URL}?dry_run=true` : URL
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

function routeParams(id: string = ENTRY_ID) {
  return { params: Promise.resolve({ companyId: COMPANY_ID, id }) }
}

const VALID_BODY = { storage_path: STORAGE_PATH, reason: 'Underlag till stängt år' }

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: API_KEY_ID,
    apiKeyName: 'backoffice',
    scopes: ['documents:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/.../journal-entries/{id}/locked-period-attachments', () => {
  it('returns 401 without a valid bearer token', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeSupabase().supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams())
    expect(res.status).toBe(401)
  })

  it('returns 403 for a key without documents:write', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: API_KEY_ID,
      scopes: ['documents:read'],
      mode: 'live',
    })
    const { supabase, rpc } = makeSupabase()
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams())
    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('requires an Idempotency-Key (400)', async () => {
    const { supabase, rpc } = makeSupabase()
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY, { idempotencyKey: null }), routeParams())
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects a missing reason with 400 VALIDATION_ERROR', async () => {
    const { supabase, rpc } = makeSupabase()
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest({ storage_path: STORAGE_PATH }), routeParams())
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects a storage path outside the company prefix with 400', async () => {
    const { supabase, download, rpc } = makeSupabase()
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(
      makeRequest({ ...VALID_BODY, storage_path: 'documents/other-company/x.pdf' }),
      routeParams(),
    )
    expect(res.status).toBe(400)
    expect(download).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns 404 when the verifikat is not in the company', async () => {
    const { supabase, rpc } = makeSupabase({ entry: { data: null, error: null } })
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams())
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns 404 when the storage object does not exist', async () => {
    const { supabase, rpc } = makeSupabase({ download: { data: null, error: { message: 'Object not found' } } })
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams())
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects stored bytes that are not an allowed document type', async () => {
    const { supabase, rpc } = makeSupabase({
      download: { data: new Blob([new TextEncoder().encode('just some text')]), error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams())
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('hashes the stored bytes server-side and returns 201 on a new link', async () => {
    const { supabase, rpc } = makeSupabase()
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams())
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.data).toMatchObject({ created: true, document_id: DOC_ID, sha256_hash: PDF_SHA })

    expect(rpc).toHaveBeenCalledWith('attach_document_to_locked_period_entry', {
      p_company_id: COMPANY_ID,
      p_journal_entry_id: ENTRY_ID,
      p_storage_path: STORAGE_PATH,
      p_file_name: 'kvitto.pdf',
      p_file_size_bytes: PDF_BYTES.byteLength,
      p_mime_type: 'application/pdf',
      p_sha256_hash: PDF_SHA,
      p_reason: 'Underlag till stängt år',
      p_actor_user_id: 'user-1',
      p_api_key_id: API_KEY_ID,
      p_api_key_name: 'backoffice',
    })
  })

  it('returns 200 with created=false when the same bytes are already linked', async () => {
    const { supabase } = makeSupabase({
      rpc: {
        data: {
          created: false,
          document_id: DOC_ID,
          journal_entry_id: ENTRY_ID,
          file_name: 'kvitto.pdf',
          storage_path: STORAGE_PATH,
          sha256_hash: PDF_SHA,
          created_at: '2026-11-16T10:00:00+00:00',
        },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.created).toBe(false)
    expect(json.data.document_id).toBe(DOC_ID)
  })

  it('maps an open period to 409 CONFLICT (use the ordinary link path)', async () => {
    const { supabase } = makeSupabase({
      rpc: {
        data: null,
        error: { message: 'LOCKED_ATTACH_PERIOD_OPEN: the fiscal period is open; use the ordinary document link' },
      },
    })
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams())
    expect(res.status).toBe(409)
  })

  it.each([
    ['LOCKED_ATTACH_INVALID: sha256 must be 64 hex characters', 400, 'VALIDATION_ERROR'],
    ['LOCKED_ATTACH_FORBIDDEN: actor lacks write access', 403, 'FORBIDDEN'],
    ['LOCKED_ATTACH_NOT_FOUND: journal entry not found', 404, 'NOT_FOUND'],
    ['LOCKED_ATTACH_NOT_POSTED: journal entry is a draft', 409, 'CONFLICT'],
    ['LOCKED_ATTACH_SOURCE_NOT_FOUND: no document in the company holds this storage object', 404, 'NOT_FOUND'],
  ])('maps RPC error "%s" to %i %s', async (message, status, code) => {
    const { supabase } = makeSupabase({ rpc: { data: null, error: { message } } })
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams())
    expect(res.status).toBe(status)
    const json = await res.json()
    expect(json.error.code).toBe(code)
  })

  it('maps an unknown RPC error to 500 INTERNAL_ERROR', async () => {
    const { supabase } = makeSupabase({ rpc: { data: null, error: { message: 'connection reset' } } })
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error.code).toBe('INTERNAL_ERROR')
  })

  it('rejects a non-UUID verifikat id with 400 before any lookup', async () => {
    const { supabase, download, rpc } = makeSupabase()
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY), routeParams('not-a-uuid'))
    expect(res.status).toBe(400)
    expect(download).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects a storage path that escapes the company prefix with ..', async () => {
    const { supabase, download, rpc } = makeSupabase()
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(
      makeRequest({ ...VALID_BODY, storage_path: `documents/${COMPANY_ID}/../other/x.pdf` }),
      routeParams(),
    )
    expect(res.status).toBe(400)
    expect(download).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('accepts an uploaded file name with consecutive dots', async () => {
    const { supabase, rpc } = makeSupabase()
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(
      makeRequest({
        ...VALID_BODY,
        storage_path: VALID_BODY.storage_path.replace(/[^/]+$/, '1700000000000_receipt..pdf'),
      }),
      routeParams(),
    )
    expect(res.status).not.toBe(400)
    expect(rpc).toHaveBeenCalled()
  })

  it('does not call the RPC on a dry run', async () => {
    const { supabase, rpc } = makeSupabase()
    mockServiceClient.mockReturnValue(supabase)
    const res = await POST(makeRequest(VALID_BODY, { dryRun: true }), routeParams())
    expect(res.status).toBe(200)
    expect(rpc).not.toHaveBeenCalled()
  })
})
