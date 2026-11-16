/**
 * Tests for GET /api/bookkeeping/journal-entries/[id]/locked-attach-log
 * (the LOCKED_PERIOD_ATTACH audit trail shown in the verifikat history).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const service = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const createServiceClientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: (...args: unknown[]) => createServiceClientMock(...args),
}))

import { GET } from '../route'

const params = () => createMockRouteParams({ id: 'entry-1' })
const makeGet = () =>
  createMockRequest('/api/bookkeeping/journal-entries/entry-1/locked-attach-log', { method: 'GET' })

const auditRow = (id: string, actor: string | null, created_at: string) => ({
  id,
  actor_id: actor,
  created_at,
  new_state: {
    document_id: `doc-${id}`,
    journal_entry_id: 'entry-1',
    file_name: 'kvitto.pdf',
    storage_path: 'company-1/kvitto.pdf',
    sha256_hash: 'a'.repeat(64),
    reason: 'Arkivering av underlag för stängt år',
    api_key_id: 'key-1',
    api_key_name: 'Backoffice',
  },
})

type LogRow = {
  id: string
  actor: string | null
  actor_label: string | null
  api_key_name: string | null
  document_id: string | null
  file_name: string | null
  sha256_hash: string | null
  reason: string | null
  created_at: string
}

describe('GET /api/bookkeeping/journal-entries/[id]/locked-attach-log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    service.reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    createServiceClientMock.mockReturnValue(service.supabase)
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(makeGet(), params())
    expect(response.status).toBe(401)
  })

  it('returns 404 when the entry belongs to another company', async () => {
    enqueue({ data: null, error: null })

    const response = await GET(makeGet(), params())
    expect(response.status).toBe(404)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('returns the archive trail with who, key, file, sha256 and reason', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null })
    enqueue({ data: [auditRow('log-1', 'user-1', '2026-11-16T10:00:00Z')], error: null })
    service.enqueue({ data: [{ id: 'user-1', email: 'user@example.com', full_name: null }], error: null })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: LogRow[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toEqual([
      {
        id: 'log-1',
        created_at: '2026-11-16T10:00:00Z',
        actor: 'user-1',
        actor_label: 'user@example.com',
        api_key_name: 'Backoffice',
        document_id: 'doc-log-1',
        file_name: 'kvitto.pdf',
        sha256_hash: 'a'.repeat(64),
        reason: 'Arkivering av underlag för stängt år',
      },
    ])
    // Scoped to this company, this verifikat and only the locked-attach action.
    const eqCalls = findCalls('audit_log', 'eq')
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['action', 'LOCKED_PERIOD_ATTACH'],
        ['table_name', 'journal_entries'],
        ['record_id', 'entry-1'],
      ]),
    )
  })

  it('returns an empty list and skips the profile lookup when there is no trail', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null })
    enqueue({ data: [], error: null })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: LogRow[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toEqual([])
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('still returns 200 with actor_label null when the profiles lookup fails', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null })
    enqueue({ data: [auditRow('log-2', 'user-2', '2026-11-16T10:00:00Z')], error: null })
    service.enqueue({ data: null, error: { message: 'permission denied' } })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: LogRow[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data[0].actor_label).toBeNull()
    expect(body.data[0].api_key_name).toBe('Backoffice')
  })

  it('returns the full trail past the 1000-row PostgREST cap, in stable order', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, i) =>
      auditRow(`log-${String(1000 - i).padStart(4, '0')}`, 'user-1', '2026-11-16T10:00:00Z'),
    )
    const secondPage = [auditRow('log-0000', 'user-1', '2026-11-15T10:00:00Z')]
    enqueue({ data: { id: 'entry-1' }, error: null })
    enqueue({ data: firstPage, error: null })
    enqueue({ data: secondPage, error: null })
    service.enqueue({ data: [{ id: 'user-1', email: 'user@example.com', full_name: null }], error: null })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: LogRow[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(1001)
    // The oldest record (on the second page) is not silently dropped.
    expect(body.data[1000].id).toBe('log-0000')
    expect(findCalls('audit_log', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    // Paging needs a total order: created_at alone ties, so id breaks it.
    expect(findCalls('audit_log', 'order')).toEqual(
      expect.arrayContaining([
        ['created_at', { ascending: false }],
        ['id', { ascending: false }],
      ]),
    )
  })

  it('returns 500 when the audit query fails', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null })
    enqueue({ data: null, error: { message: 'boom' } })

    const response = await GET(makeGet(), params())
    expect(response.status).toBe(500)
  })
})
