import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { underlagsjaktExtension } from '@/extensions/general/underlagsjakt'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import fixture from './fixtures/export-1.1.json'

const writePermission = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...a: unknown[]) => writePermission(...a),
}))

function route(method: string, path: string) {
  const r = underlagsjaktExtension.apiRoutes!.find((x) => x.method === method && x.path === path)
  if (!r) throw new Error(`no route ${method} ${path}`)
  return r
}

let store: Map<string, unknown>
let memberships: { data: unknown; error: { message: string } | null }
const membershipQuery = { select: vi.fn(), eq: vi.fn(), is: vi.fn() }
const from = vi.fn()

function buildCtx(): ExtensionContext {
  membershipQuery.select.mockReturnValue(membershipQuery)
  membershipQuery.eq.mockReturnValue(membershipQuery)
  membershipQuery.is.mockImplementation(async () => memberships)
  from.mockReturnValue(membershipQuery)
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'underlagsjakt',
    supabase: { from } as unknown as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: {
      get: vi.fn(async (key?: string) => (store.has(key ?? 'settings') ? store.get(key ?? 'settings') : null)),
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, JSON.parse(JSON.stringify(value)))
      }),
      clear: vi.fn(async (key: string) => {
        store.delete(key)
      }),
    },
    storage: {} as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    services: {} as ExtensionContext['services'],
  } as unknown as ExtensionContext
}

const post = (path: string, body?: unknown) => createMockRequest(path, { method: 'POST', body })
const get = (path: string) => createMockRequest(path)

async function importFixture(ctx: ExtensionContext) {
  const res = await route('POST', '/export').handler(post('/export', fixture), ctx)
  expect(res.status).toBe(200)
}

const moankAnswer = {
  svarstyp: 'fel_bolag',
  transaction_id: 'tx-moank-20260821',
  fel_bolag_mottagare: 'Villa Viola AB',
  till_bolag: 'Villa Viola',
  reglering: 'vidarefakturera',
}

interface GetBody {
  data: {
    export: { export_version: string } | null
    posts: { transaction_id: string; konto_identitet: string; kandidater: { bevisgrund: string }[] }[]
    pending_count: number
    fel_bolag: { transaction_id: string; reglering: string | null }[]
    bolag_choices: string[]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  store = new Map()
  memberships = { data: [], error: null }
  writePermission.mockResolvedValue({ ok: true })
})

describe('auth', () => {
  it.each([
    ['GET', '/'],
    ['POST', '/export'],
    ['POST', '/svar'],
    ['DELETE', '/svar/:transactionId'],
    ['GET', '/svarsfil'],
    ['POST', '/svarsfil/levererad'],
  ])('%s %s returns 401 without a context', async (method, path) => {
    const res = await route(method, path).handler(createMockRequest(path, { method }))
    expect(res.status).toBe(401)
  })

  it.each([
    ['POST', '/export'],
    ['POST', '/svar'],
    ['DELETE', '/svar/:transactionId'],
    ['POST', '/svarsfil/levererad'],
  ])('%s %s is closed to read-only members', async (method, path) => {
    writePermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Du har endast läsbehörighet i detta företag.' }, { status: 403 }),
    })
    const res = await route(method, path).handler(createMockRequest(path, { method, body: {} }), buildCtx())
    expect(res.status).toBe(403)
    expect(store.size).toBe(0)
  })
})

describe('GET /', () => {
  it('reports no export before one is imported', async () => {
    const { status, body } = await parseJsonResponse<GetBody & { data: { supported_export_versions: string[] } }>(
      await route('GET', '/').handler(get('/'), buildCtx()),
    )
    expect(status).toBe(200)
    expect(body.data.export).toBeNull()
    expect(body.data.posts).toEqual([])
    expect(body.data.supported_export_versions).toEqual(['1.1'])
  })
})

describe('POST /export', () => {
  it('returns 400 for a body that is not JSON', async () => {
    const req = new Request('http://localhost/export', { method: 'POST', body: '{nope' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/export').handler(req, buildCtx()),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVALID_JSON')
  })

  it('returns 400 UNSUPPORTED_VERSION and stores nothing for an unknown contract version', async () => {
    const ctx = buildCtx()
    const { status, body } = await parseJsonResponse<{ error: { code: string; version: string } }>(
      await route('POST', '/export').handler(post('/export', { ...fixture, export_version: '1.0' }), ctx),
    )
    expect(status).toBe(400)
    expect(body.error).toMatchObject({ code: 'UNSUPPORTED_VERSION', version: '1.0' })
    expect(store.size).toBe(0)
  })

  it('returns 400 INVALID_EXPORT for a 1.1 file that breaks the schema', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/export').handler(post('/export', { export_version: '1.1', posts: 'x' }), buildCtx()),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVALID_EXPORT')
  })

  it('stores the export and shows each post with readable account and evidence', async () => {
    const ctx = buildCtx()
    const res = await route('POST', '/export').handler(post('/export', fixture), ctx)
    const { status, body: imported } = await parseJsonResponse<{ data: { posts: number } }>(res)
    expect(status).toBe(200)
    expect(imported.data.posts).toBe(3)

    const { body } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(body.data.export?.export_version).toBe('1.1')
    const moank = body.data.posts.find((p) => p.transaction_id === 'tx-moank-20260821')!
    expect(moank.konto_identitet).toBe('SEB Företagskonto 5609 11 241 10')
    expect(moank.kandidater[0].bevisgrund).toContain('belopp exakt på beloppsraden')
    expect(body.data.bolag_choices).toEqual(['Tyrberg Fastigheter', 'Tyrberg Group'])
  })

  it("offers all of the user's companies, not only those in the export", async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    memberships = {
      data: [
        { company_id: 'c1', companies: { name: 'Tyrberg Group AB', archived_at: null } },
        { company_id: 'c2', companies: { name: 'Marblechain AB', archived_at: null } },
        { company_id: 'c3', companies: { name: 'Villa Viola AB', archived_at: null } },
      ],
      error: null,
    }
    const { body } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(from).toHaveBeenCalledWith('company_members')
    expect(membershipQuery.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(membershipQuery.is).toHaveBeenCalledWith('companies.archived_at', null)
    expect(body.data.bolag_choices).toEqual(['Marblechain AB', 'Tyrberg Fastigheter', 'Tyrberg Group', 'Villa Viola AB'])
  })

  it('still answers with the export companies when memberships cannot be read', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    memberships = { data: null, error: { message: 'boom' } }
    const { status, body } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(status).toBe(200)
    expect(body.data.bolag_choices).toEqual(['Tyrberg Fastigheter', 'Tyrberg Group'])
    expect(ctx.log.warn).toHaveBeenCalled()
  })
})

describe('POST /svar', () => {
  it('returns 400 for an incomplete answer', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar').handler(post('/svar', { ...moankAnswer, reglering: null }), ctx),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 for a transaction that is not in the imported export', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const res = await route('POST', '/svar').handler(post('/svar', { ...moankAnswer, transaction_id: 'nope' }), ctx)
    expect(res.status).toBe(404)
  })

  it('returns 400 when the chosen document is not a candidate', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar').handler(
        post('/svar', {
          svarstyp: 'val_kandidat',
          transaction_id: 'tx-google-20260803',
          sha256: 'f'.repeat(64),
          motpart: 'GOOGLE*WORKSPACE',
          kategori: 'leverantor',
          bas_konto: null,
          momstyp: null,
          begransa_bolag: false,
          begransa_belopp: false,
        }),
        ctx,
      ),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('CANDIDATE_NOT_FOUND')
  })

  it('MOANK: answered with company, addressee and settlement, it leaves the list and lands in the re-billing view and the answer file', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)

    const res = await route('POST', '/svar').handler(post('/svar', moankAnswer), ctx)
    expect(res.status).toBe(200)

    const { body } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(body.data.posts.map((p) => p.transaction_id)).not.toContain('tx-moank-20260821')
    expect(body.data.pending_count).toBe(1)
    expect(body.data.fel_bolag).toEqual([
      expect.objectContaining({ transaction_id: 'tx-moank-20260821', reglering: 'vidarefakturera' }),
    ])

    const file = await route('GET', '/svarsfil').handler(get('/svarsfil'), ctx)
    expect(file.headers.get('Content-Disposition')).toMatch(/attachment; filename="underlagsjakt-svar-.*\.json"/)
    expect(await file.json()).toEqual({
      version: '1.1',
      beslut: [
        {
          transaction_id: 'tx-moank-20260821',
          svarstyp: 'fel_bolag',
          fel_bolag_mottagare: 'Villa Viola AB',
          till_bolag: 'Villa Viola',
        },
      ],
    })
  })

  it('all answer types: chosen document, none of them, osaker', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const svar = route('POST', '/svar')
    expect(
      (
        await svar.handler(
          post('/svar', {
            svarstyp: 'val_kandidat',
            transaction_id: 'tx-google-20260803',
            sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
            motpart: 'GOOGLE*WORKSPACE',
            kategori: 'leverantor',
            bas_konto: '5420',
            momstyp: 'eu_reverse_charge',
            begransa_bolag: false,
            begransa_belopp: false,
          }),
          ctx,
        )
      ).status,
    ).toBe(200)
    expect((await svar.handler(post('/svar', { svarstyp: 'osaker', transaction_id: 'tx-ocr-20260812' }), ctx)).status).toBe(200)

    const file = (await (await route('GET', '/svarsfil').handler(get('/svarsfil'), ctx)).json()) as {
      beslut: Record<string, unknown>[]
    }
    expect(file.beslut).toEqual([
      expect.objectContaining({
        svarstyp: 'val_kandidat',
        vald_kandidat: 'google_workspace_juli.pdf',
        sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        kalla: 'gmail:bohed',
      }),
      { transaction_id: 'tx-ocr-20260812', svarstyp: 'osaker' },
    ])

    const { body } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(body.data.posts.map((p) => p.transaction_id)).toEqual(['tx-moank-20260821'])
  })

  it('returns 409 once the answer has been handed to bertil', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    await route('POST', '/svar').handler(post('/svar', moankAnswer), ctx)
    await route('POST', '/svarsfil/levererad').handler(
      post('/svarsfil/levererad', { transaction_ids: ['tx-moank-20260821'] }),
      ctx,
    )
    const res = await route('POST', '/svar').handler(post('/svar', moankAnswer), ctx)
    expect(res.status).toBe(409)
  })
})

describe('DELETE /svar/:transactionId', () => {
  const del = (id: string) =>
    createMockRequest('/svar/x', { method: 'DELETE', searchParams: { _transactionId: id } })

  it('returns 404 for an unknown answer', async () => {
    const res = await route('DELETE', '/svar/:transactionId').handler(del('nope'), buildCtx())
    expect(res.status).toBe(404)
  })

  it('withdraws an undelivered answer so the post is asked again', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    await route('POST', '/svar').handler(post('/svar', moankAnswer), ctx)
    const res = await route('DELETE', '/svar/:transactionId').handler(del('tx-moank-20260821'), ctx)
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(body.data.posts.map((p) => p.transaction_id)).toContain('tx-moank-20260821')
  })
})

describe('POST /svarsfil/levererad', () => {
  it('returns 400 without transaction_ids', async () => {
    const res = await route('POST', '/svarsfil/levererad').handler(post('/svarsfil/levererad', {}), buildCtx())
    expect(res.status).toBe(400)
  })

  it('leaves delivered answers out of the next answer file', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    await route('POST', '/svar').handler(post('/svar', moankAnswer), ctx)
    const { body } = await parseJsonResponse<{ data: { pending_count: number } }>(
      await route('POST', '/svarsfil/levererad').handler(
        post('/svarsfil/levererad', { transaction_ids: ['tx-moank-20260821'] }),
        ctx,
      ),
    )
    expect(body.data.pending_count).toBe(0)
    const file = (await (await route('GET', '/svarsfil').handler(get('/svarsfil'), ctx)).json()) as { beslut: unknown[] }
    expect(file.beslut).toEqual([])
  })
})
