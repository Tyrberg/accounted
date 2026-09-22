import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { underlagsjaktExtension } from '@/extensions/general/underlagsjakt'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import fixture from './fixtures/export-1.1.json'
import fixture14 from './fixtures/export-1.4.json'

const writePermission = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...a: unknown[]) => writePermission(...a),
}))

const uploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  uploadDocument: (...a: unknown[]) => uploadDocument(...a),
}))
const kopplaTillTransaktion = vi.fn()
vi.mock('../lib/koppla', () => ({
  kopplaTillTransaktion: (...a: unknown[]) => kopplaTillTransaktion(...a),
}))

function route(method: string, path: string) {
  const r = underlagsjaktExtension.apiRoutes!.find((x) => x.method === method && x.path === path)
  if (!r) throw new Error(`no route ${method} ${path}`)
  return r
}

let store: Map<string, unknown>
let memberships: { data: unknown; error: { message: string } | null }
let journalEntryLookup: { data: { voucher_series: string; voucher_number: number } | null; error: unknown }
const membershipQuery = { select: vi.fn(), eq: vi.fn(), is: vi.fn() }
const journalEntryQuery = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() }
const from = vi.fn()

function buildCtx(): ExtensionContext {
  membershipQuery.select.mockReturnValue(membershipQuery)
  membershipQuery.eq.mockReturnValue(membershipQuery)
  membershipQuery.is.mockImplementation(async () => memberships)
  journalEntryQuery.select.mockReturnValue(journalEntryQuery)
  journalEntryQuery.eq.mockReturnValue(journalEntryQuery)
  journalEntryQuery.maybeSingle.mockImplementation(async () => journalEntryLookup)
  from.mockImplementation((table: string) => (table === 'journal_entries' ? journalEntryQuery : membershipQuery))
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
  const res = await route('POST', '/export/fil').handler(post('/export/fil', fixture), ctx)
  expect(res.status).toBe(200)
}

const moankAnswer = {
  svarstyp: 'fel_bolag',
  transaction_id: 'tx-moank-20260821',
  fel_bolag_mottagare: 'Villa Viola AB',
  till_bolag: 'Villa Viola',
  reglering: 'vidarefakturera',
}

const storedDocument = {
  id: 'doc-1',
  file_name: 'kvitto.pdf',
  sha256_hash: 'b'.repeat(64),
  mime_type: 'application/pdf',
  storage_path: 'documents/company-1/user-1/1_kvitto.pdf',
}

interface GetBody {
  data: {
    export: { export_version: string } | null
    posts: { transaction_id: string; konto_identitet: string; kandidater: { bevisgrund: string }[] }[]
    pending_count: number
    fel_bolag: { transaction_id: string; reglering: string | null }[]
    waiting: { transaction_id: string; underlag_hittat_at: string | null }[]
    bolag_choices: string[]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  store = new Map()
  memberships = { data: [], error: null }
  journalEntryLookup = { data: null, error: null }
  writePermission.mockResolvedValue({ ok: true })
  uploadDocument.mockResolvedValue(storedDocument)
  kopplaTillTransaktion.mockResolvedValue('kopplad')
})

describe('auth', () => {
  it.each([
    ['GET', '/'],
    ['POST', '/export/fil'],
    ['POST', '/svar'],
    ['POST', '/svar/underlag'],
    ['POST', '/svar/bulk'],
    ['DELETE', '/svar/:transactionId'],
    ['GET', '/svarsfil'],
    ['POST', '/svarsfil/levererad'],
  ])('%s %s returns 401 without a context', async (method, path) => {
    const res = await route(method, path).handler(createMockRequest(path, { method }))
    expect(res.status).toBe(401)
  })

  it.each([
    ['POST', '/export/fil'],
    ['POST', '/svar'],
    ['POST', '/svar/underlag'],
    ['POST', '/svar/bulk'],
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
    expect(body.data.supported_export_versions).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5'])
  })
})

describe('POST /export/fil', () => {
  it('returns 400 for a body that is not JSON', async () => {
    const req = new Request('http://localhost/export/fil', { method: 'POST', body: '{nope' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/export/fil').handler(req, buildCtx()),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVALID_JSON')
  })

  it('returns 400 UNSUPPORTED_VERSION and stores nothing for an unknown contract version', async () => {
    const ctx = buildCtx()
    const { status, body } = await parseJsonResponse<{ error: { code: string; version: string; message: string } }>(
      await route('POST', '/export/fil').handler(post('/export/fil', { ...fixture, export_version: '1.0' }), ctx),
    )
    expect(status).toBe(400)
    expect(body.error).toMatchObject({ code: 'UNSUPPORTED_VERSION', version: '1.0' })
    expect(body.error.message).toContain('Exportversion 1.0 stöds inte')
    expect(body.error.message).toContain('Stödda versioner: 1.1, 1.2, 1.3, 1.4')
    expect(store.size).toBe(0)
  })

  it('returns 400 INVALID_EXPORT for a 1.1 file that breaks the schema', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/export/fil').handler(post('/export/fil', { export_version: '1.1', posts: 'x' }), buildCtx()),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVALID_EXPORT')
  })

  it('accepts a 1.4 export with new fields (reglering, leverantor_sokord)', async () => {
    const ctx = buildCtx()
    const res = await route('POST', '/export/fil').handler(post('/export/fil', fixture14), ctx)
    const { status, body: imported } = await parseJsonResponse<{ data: { posts: number; export_version: string } }>(res)
    expect(status).toBe(200)
    expect(imported.data.posts).toBe(3)
    expect(imported.data.export_version).toBe('1.4')

    const { body } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(body.data.export?.export_version).toBe('1.4')
    expect(body.data.bolag_choices).toEqual(['Tyrberg Fastigheter', 'Tyrberg Group'])
  })

  it('stores the export and shows each post with readable account and evidence', async () => {
    const ctx = buildCtx()
    const res = await route('POST', '/export/fil').handler(post('/export/fil', fixture), ctx)
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
          sha256: ['f'.repeat(64)],
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
    const fileJson = await file.json()
    expect(fileJson.version).toBe('1.4')
    expect(fileJson.beslut).toEqual([
      expect.objectContaining({
        answer_id: expect.any(String),
        transaction_id: 'tx-moank-20260821',
        svarstyp: 'fel_bolag',
        fel_bolag_mottagare: 'Villa Viola AB',
        till_bolag: 'Villa Viola',
        reglering: 'vidarefakturera',
      }),
    ])
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
            sha256: ['a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'],
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
        answer_id: expect.any(String),
        svarstyp: 'val_kandidat',
        vald_kandidat: 'google_workspace_juli.pdf',
        sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        kalla: 'gmail:bohed',
        vald_kandidater: [
          {
            filnamn: 'google_workspace_juli.pdf',
            sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
            kalla: 'gmail:bohed',
          },
        ],
      }),
      expect.objectContaining({
        answer_id: expect.any(String),
        transaction_id: 'tx-ocr-20260812',
        svarstyp: 'osaker',
      }),
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

describe('POST /svar/underlag', () => {
  const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
  const fields: Record<string, string> = {
    transaction_id: 'tx-ocr-20260812',
    motpart: 'OCR-betalning',
    kategori: 'leverantor',
    bas_konto: '',
    momstyp: '',
    begransa_bolag: 'false',
    begransa_belopp: 'false',
  }

  function upload(over: { file?: File | null; fields?: Record<string, string | undefined> } = {}) {
    const form = new FormData()
    const file = over.file === undefined ? new File([PDF_BYTES], 'kvitto.pdf', { type: 'application/pdf' }) : over.file
    if (file) form.set('file', file)
    for (const [k, v] of Object.entries({ ...fields, ...over.fields })) if (v !== undefined) form.set(k, v)
    return new Request('http://localhost:3000/svar/underlag', { method: 'POST', body: form })
  }
  const handler = () => route('POST', '/svar/underlag').handler

  // Off unless bertil reads answer version 1.5; these tests are about the switched-on path.
  beforeEach(() => {
    process.env.UNDERLAGSJAKT_UPLOAD_ENABLED = 'true'
  })
  afterEach(() => {
    delete process.env.UNDERLAGSJAKT_UPLOAD_ENABLED
  })

  it('is refused while switched off: nothing is filed and no answer is recorded', async () => {
    delete process.env.UNDERLAGSJAKT_UPLOAD_ENABLED
    const ctx = buildCtx()
    await importFixture(ctx)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await handler()(upload(), ctx))
    expect(status).toBe(403)
    expect(body.error.code).toBe('UNDERLAG_UPLOAD_DISABLED')
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(kopplaTillTransaktion).not.toHaveBeenCalled()
    const list = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(list.body.data.pending_count).toBe(0)
  })

  it('tells the workspace whether the upload answer is switched on', async () => {
    const ctx = buildCtx()
    const on = await parseJsonResponse<{ data: { underlag_upload_enabled: boolean } }>(await route('GET', '/').handler(get('/'), ctx))
    expect(on.body.data.underlag_upload_enabled).toBe(true)
    delete process.env.UNDERLAGSJAKT_UPLOAD_ENABLED
    const off = await parseJsonResponse<{ data: { underlag_upload_enabled: boolean } }>(await route('GET', '/').handler(get('/'), ctx))
    expect(off.body.data.underlag_upload_enabled).toBe(false)
  })

  it('files the document, records the answer and hands bertil the reference: the reported case', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)

    const { status, body } = await parseJsonResponse<{ data: { koppling: string; beslut: { svarstyp: string } } }>(
      await handler()(upload(), ctx),
    )
    expect(status).toBe(200)
    expect(body.data.koppling).toBe('kopplad')
    expect(body.data.beslut.svarstyp).toBe('uppladdat_underlag')

    // The upload went to the archive under this user and company, deduplicated, without AI extraction.
    expect(uploadDocument).toHaveBeenCalledWith(
      ctx.supabase,
      'user-1',
      'company-1',
      expect.objectContaining({ name: 'kvitto.pdf', type: 'application/pdf' }),
      expect.objectContaining({ dedupeByContent: true, extractionOwner: 'none' }),
    )
    // ...and was pinned to the transaction bertil is asking about.
    expect(kopplaTillTransaktion).toHaveBeenCalledWith(ctx.supabase, 'company-1', 'tx-ocr-20260812', 'doc-1')

    // The post leaves the open list and is waiting for bertil, carrying the file reference.
    const list = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(list.body.data.posts.map((p) => p.transaction_id)).not.toContain('tx-ocr-20260812')
    expect(list.body.data.pending_count).toBe(1)
    const file = await (await route('GET', '/svarsfil').handler(get('/svarsfil'), ctx)).json()
    expect(file.version).toBe('1.5')
    expect(file.beslut).toEqual([
      expect.objectContaining({
        transaction_id: 'tx-ocr-20260812',
        svarstyp: 'uppladdat_underlag',
        dokument_id: 'doc-1',
        filnamn: 'kvitto.pdf',
        sha256: 'b'.repeat(64),
        storage_path: 'documents/company-1/user-1/1_kvitto.pdf',
        kalla: 'gnubok_uppladdning',
        motpart: 'OCR-betalning',
        kategori: 'leverantor',
        bas_konto: null,
        momstyp: null,
      }),
    ])
  })

  it('is offered to bertil by the machine path like any other answer', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    await handler()(upload(), ctx)
    const { svar } = await (await import('../lib/store')).loadState(ctx.settings)
    expect((await import('../lib/store')).pendingBeslut(svar).map((b) => b.svarstyp)).toEqual(['uppladdat_underlag'])
  })

  it('accepts a phone photo (HEIC) as well as a PDF', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const res = await handler()(upload({ file: new File([new Uint8Array(16)], 'IMG_1.heic', { type: 'image/heic' }) }), ctx)
    expect(res.status).toBe(200)
  })

  it.each([
    ['no file', { file: null }, 'UNDERLAG_FILE_MISSING'],
    ['an empty file', { file: new File([], 'tom.pdf', { type: 'application/pdf' }) }, 'UNDERLAG_FILE_MISSING'],
    ['a type that is not a document or photo', { file: new File(['x'], 'a.exe', { type: 'application/x-msdownload' }) }, 'UNDERLAG_UNSUPPORTED_TYPE'],
    ['missing motpart', { fields: { motpart: '' } }, 'VALIDATION_ERROR'],
    ['an unknown kategori', { fields: { kategori: 'nonsens' } }, 'VALIDATION_ERROR'],
    ['an account number that is not four digits', { fields: { bas_konto: 'abc' } }, 'VALIDATION_ERROR'],
    ['no transaction_id', { fields: { transaction_id: undefined } }, 'VALIDATION_ERROR'],
  ])('returns 400 for %s, and stores nothing', async (_name, over, code) => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await handler()(upload(over as Parameters<typeof upload>[0]), ctx),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe(code)
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('returns 400 for a file over the size limit before it is read into the archive', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'stor.pdf', { type: 'application/pdf' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await handler()(upload({ file: big }), ctx))
    expect(status).toBe(400)
    expect(body.error.code).toBe('UNDERLAG_TOO_LARGE')
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('returns 404 for a transaction that is not in the imported export, without filing the document', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const res = await handler()(upload({ fields: { transaction_id: 'nope' } }), ctx)
    expect(res.status).toBe(404)
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('returns 409 without filing the document when bertil already has the answer', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    expect((await handler()(upload(), ctx)).status).toBe(200)
    // Offered answers cannot be replaced: mark this one offered directly.
    const svar = store.get('svar') as Record<string, { erbjudet_at: string | null }>
    svar['tx-ocr-20260812'].erbjudet_at = '2026-09-21T10:00:00.000Z'
    store.set('svar', svar)
    uploadDocument.mockClear()
    const res = await handler()(upload(), ctx)
    expect(res.status).toBe(409)
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('records no answer when the document cannot be archived, so bertil is never told about a file that is not there', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    uploadDocument.mockRejectedValue(new Error('Failed to upload document: storage down'))
    const res = await handler()(upload(), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('UNDERLAG_UPLOAD_FAILED')
    const list = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(list.body.data.posts.map((p) => p.transaction_id)).toContain('tx-ocr-20260812')
    expect(list.body.data.pending_count).toBe(0)
  })

  it('maps a file whose bytes do not match its declared type to 400', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    uploadDocument.mockRejectedValue(new Error('Filinnehållet matchar inte den angivna filtypen (förväntade application/pdf, hittade image/png).'))
    const res = await handler()(upload(), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('UNDERLAG_INVALID_CONTENT')
  })

  it('keeps the answer and reports it when no Accounted transaction could be pinned', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    kopplaTillTransaktion.mockResolvedValue('ingen_transaktion')
    const { status, body } = await parseJsonResponse<{ data: { koppling: string } }>(await handler()(upload(), ctx))
    expect(status).toBe(200)
    expect(body.data.koppling).toBe('ingen_transaktion')
  })

  it('does not accept an uploaded-underlag answer through the JSON route', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const res = await route('POST', '/svar').handler(post('/svar', { ...fields, svarstyp: 'uppladdat_underlag', begransa_bolag: false, begransa_belopp: false }), ctx)
    expect(res.status).toBe(400)
  })
})

describe('levererar_sjalv', () => {
  const sjalv = { svarstyp: 'levererar_sjalv', transaction_id: 'tx-google-20260803', motpart: 'GOOGLE*WORKSPACE' }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('POST /svar answers 403 FEATURE_DISABLED while the type is off, and stores nothing', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const before = JSON.stringify([...store.entries()])
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar').handler(post('/svar', sjalv), ctx),
    )
    expect(status).toBe(403)
    expect(body.error.code).toBe('FEATURE_DISABLED')
    expect(JSON.stringify([...store.entries()])).toBe(before)
  })

  it('POST /svar records the promise as waiting when the type is on, and the file is stamped 1.5', async () => {
    vi.stubEnv('UNDERLAGSJAKT_LEVERERAR_SJALV_ENABLED', 'true')
    const ctx = buildCtx()
    await importFixture(ctx)
    expect((await route('POST', '/svar').handler(post('/svar', sjalv), ctx)).status).toBe(200)

    const { body } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(body.data.posts.map((p) => p.transaction_id)).not.toContain('tx-google-20260803')
    expect(body.data.waiting).toEqual([
      expect.objectContaining({ transaction_id: 'tx-google-20260803', underlag_hittat_at: null }),
    ])

    const file = await parseJsonResponse<{ version: string; beslut: { svarstyp: string }[] }>(
      await route('GET', '/svarsfil').handler(get('/svarsfil'), ctx),
    )
    expect(file.body.version).toBe('1.5')
    expect(file.body.beslut.map((b) => b.svarstyp)).toEqual(['levererar_sjalv'])
  })

  it('GET / tells the workspace whether the type is switched on', async () => {
    const off = await parseJsonResponse<{ data: { levererar_sjalv_enabled: boolean } }>(
      await route('GET', '/').handler(get('/'), buildCtx()),
    )
    expect(off.body.data.levererar_sjalv_enabled).toBe(false)
    vi.stubEnv('UNDERLAGSJAKT_LEVERERAR_SJALV_ENABLED', 'true')
    const on = await parseJsonResponse<{ data: { levererar_sjalv_enabled: boolean } }>(
      await route('GET', '/').handler(get('/'), buildCtx()),
    )
    expect(on.body.data.levererar_sjalv_enabled).toBe(true)
  })

  it('an export that lists underlag_hittat moves the waiting post to "with document" and asks nothing again', async () => {
    vi.stubEnv('UNDERLAGSJAKT_LEVERERAR_SJALV_ENABLED', 'true')
    const ctx = buildCtx()
    await importFixture(ctx)
    await route('POST', '/svar').handler(post('/svar', sjalv), ctx)
    await route('POST', '/svar').handler(post('/svar', { ...sjalv, transaction_id: 'tx-ocr-20260812', motpart: 'OCR' }), ctx)

    // bertil found only the Google document. Its export must not resurrect either post.
    const later = { ...fixture, generated_at: '2000-01-01T00:00:00Z', underlag_hittat: ['tx-google-20260803', 'tx-unknown'] }
    expect((await route('POST', '/export/fil').handler(post('/export/fil', later), ctx)).status).toBe(200)

    const { body } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(body.data.posts.map((p) => p.transaction_id)).not.toContain('tx-google-20260803')
    const byId = Object.fromEntries(body.data.waiting.map((w) => [w.transaction_id, w.underlag_hittat_at]))
    expect(byId['tx-google-20260803']).toEqual(expect.any(String))
    expect(byId['tx-ocr-20260812']).toBeNull()
    expect(byId).not.toHaveProperty('tx-unknown')
    // The list of found documents is a signal, not something kept with the export.
    expect(store.get('export')).not.toHaveProperty('underlag_hittat')
  })

  it('without the list in the export, waiting posts stay waiting', async () => {
    vi.stubEnv('UNDERLAGSJAKT_LEVERERAR_SJALV_ENABLED', 'true')
    const ctx = buildCtx()
    await importFixture(ctx)
    await route('POST', '/svar').handler(post('/svar', sjalv), ctx)
    await importFixture(ctx)
    const { body } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    expect(body.data.waiting.map((w) => w.underlag_hittat_at)).toEqual([null])
  })
})

describe('reglerar_skuld', () => {
  const skuld = {
    svarstyp: 'reglerar_skuld',
    transaction_id: 'tx-google-20260803',
    motpart: 'LÖN',
    ursprungsverifikat_id: '7c3e9a2e-2b3a-4c9e-9d3a-1a2b3c4d5e6f',
    bas_konto: '2893',
    begransa_bolag: false,
    begransa_belopp: false,
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('POST /svar answers 403 FEATURE_DISABLED while the type is off, and stores nothing', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const before = JSON.stringify([...store.entries()])
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar').handler(post('/svar', skuld), ctx),
    )
    expect(status).toBe(403)
    expect(body.error.code).toBe('FEATURE_DISABLED')
    expect(JSON.stringify([...store.entries()])).toBe(before)
  })

  it('answers 400 VALIDATION_ERROR for a cost account, even sent directly to the API bypassing the form: the whole point of this answer type is never to book a new cost', async () => {
    vi.stubEnv('UNDERLAGSJAKT_REGLERAR_SKULD_ENABLED', 'true')
    const ctx = buildCtx()
    await importFixture(ctx)
    const before = JSON.stringify([...store.entries()])
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar').handler(post('/svar', { ...skuld, bas_konto: '7210' }), ctx),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(JSON.stringify([...store.entries()])).toBe(before)
  })

  it('answers 404 VERIFIKAT_NOT_FOUND when the referenced verifikat does not exist for this company, and stores nothing', async () => {
    vi.stubEnv('UNDERLAGSJAKT_REGLERAR_SKULD_ENABLED', 'true')
    const ctx = buildCtx()
    await importFixture(ctx)
    journalEntryLookup = { data: null, error: null }
    const before = JSON.stringify([...store.entries()])
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar').handler(post('/svar', skuld), ctx),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('VERIFIKAT_NOT_FOUND')
    expect(JSON.stringify([...store.entries()])).toBe(before)
  })

  it('records a beslut debiting the liability account with the resolved verifikat label, and the file is stamped 1.7', async () => {
    vi.stubEnv('UNDERLAGSJAKT_REGLERAR_SKULD_ENABLED', 'true')
    const ctx = buildCtx()
    await importFixture(ctx)
    journalEntryLookup = { data: { voucher_series: 'A', voucher_number: 217 }, error: null }
    const { status, body } = await parseJsonResponse<{ data: { beslut: Record<string, unknown> } }>(
      await route('POST', '/svar').handler(post('/svar', skuld), ctx),
    )
    expect(status).toBe(200)
    expect(body.data.beslut).toMatchObject({
      svarstyp: 'reglerar_skuld',
      ursprungsverifikat_id: skuld.ursprungsverifikat_id,
      ursprungsverifikat_nummer: 'A217',
      bas_konto: '2893',
      motpart: 'LÖN',
    })

    const file = await parseJsonResponse<{ version: string; beslut: { svarstyp: string }[] }>(
      await route('GET', '/svarsfil').handler(get('/svarsfil'), ctx),
    )
    expect(file.body.version).toBe('1.7')
    expect(file.body.beslut.map((b) => b.svarstyp)).toEqual(['reglerar_skuld'])
  })

  it('GET / tells the workspace whether the type is switched on', async () => {
    const off = await parseJsonResponse<{ data: { reglerar_skuld_enabled: boolean } }>(
      await route('GET', '/').handler(get('/'), buildCtx()),
    )
    expect(off.body.data.reglerar_skuld_enabled).toBe(false)
    vi.stubEnv('UNDERLAGSJAKT_REGLERAR_SKULD_ENABLED', 'true')
    const on = await parseJsonResponse<{ data: { reglerar_skuld_enabled: boolean } }>(
      await route('GET', '/').handler(get('/'), buildCtx()),
    )
    expect(on.body.data.reglerar_skuld_enabled).toBe(true)
  })
})

describe('val_kandidat: choosing more than one document', () => {
  const twoDocuments = {
    svarstyp: 'val_kandidat',
    transaction_id: 'tx-google-20260803',
    sha256: [
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    ],
    motpart: 'GOOGLE*WORKSPACE',
    kategori: 'leverantor',
    bas_konto: null,
    momstyp: null,
    begransa_bolag: false,
    begransa_belopp: false,
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('a single choice is unaffected: still stored as before, whatever the flag says', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const res = await route('POST', '/svar').handler(post('/svar', { ...twoDocuments, sha256: [twoDocuments.sha256[0]] }), ctx)
    expect(res.status).toBe(200)
  })

  it('refuses a second document with 403 FEATURE_DISABLED while the flag is off, and stores nothing', async () => {
    const ctx = buildCtx()
    await importFixture(ctx)
    const before = JSON.stringify([...store.entries()])
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar').handler(post('/svar', twoDocuments), ctx),
    )
    expect(status).toBe(403)
    expect(body.error.code).toBe('FEATURE_DISABLED')
    expect(JSON.stringify([...store.entries()])).toBe(before)
  })

  it('records every chosen document once the flag is on, and the file is stamped 1.6', async () => {
    vi.stubEnv('UNDERLAGSJAKT_MULTI_KANDIDAT_ENABLED', 'true')
    const ctx = buildCtx()
    await importFixture(ctx)
    expect((await route('POST', '/svar').handler(post('/svar', twoDocuments), ctx)).status).toBe(200)

    const file = await parseJsonResponse<{ version: string; beslut: { vald_kandidater?: unknown[] }[] }>(
      await route('GET', '/svarsfil').handler(get('/svarsfil'), ctx),
    )
    expect(file.body.version).toBe('1.6')
    expect(file.body.beslut[0].vald_kandidater).toHaveLength(2)
  })

  it('GET / tells the workspace whether choosing several documents is switched on', async () => {
    const off = await parseJsonResponse<{ data: { multi_kandidat_enabled: boolean } }>(
      await route('GET', '/').handler(get('/'), buildCtx()),
    )
    expect(off.body.data.multi_kandidat_enabled).toBe(false)
    vi.stubEnv('UNDERLAGSJAKT_MULTI_KANDIDAT_ENABLED', 'true')
    const on = await parseJsonResponse<{ data: { multi_kandidat_enabled: boolean } }>(
      await route('GET', '/').handler(get('/'), buildCtx()),
    )
    expect(on.body.data.multi_kandidat_enabled).toBe(true)
  })
})

describe('POST /svar/bulk', () => {
  /**
   * Nine open payments: three HI3G (one spelled differently), one HI3G that
   * bertil suspects belongs to another company, one HI3G already answered, a
   * different vendor, and two SEB rows whose motpart is a reference number.
   */
  const ids = {
    hi3g: ['tx-hi3g-1', 'tx-hi3g-2', 'tx-hi3g-3'],
    felBolag: 'tx-hi3g-fel',
    answered: 'tx-hi3g-answered',
    telia: 'tx-telia-1',
    ocr: ['tx-ocr-a', 'tx-ocr-b'],
  }

  function exportWithVendors() {
    const raw = JSON.parse(JSON.stringify(fixture)) as {
      sammanstallningar: { posts: Record<string, unknown>[] }[]
    }
    const template = raw.sammanstallningar[0].posts.find((p) => p.transaction_id === 'tx-ocr-20260812')!
    const add = (transaction_id: string, motpart: string, kategori = 'behover_mattias') =>
      raw.sammanstallningar[0].posts.push({ ...template, transaction_id, motpart, kategori })
    add(ids.hi3g[0], 'HI3G')
    add(ids.hi3g[1], 'Hi3G ')
    add(ids.hi3g[2], 'HI3G')
    add(ids.felBolag, 'HI3G', 'fel_bolag')
    add(ids.answered, 'HI3G')
    add(ids.telia, 'Telia')
    add(ids.ocr[0], '100004000001')
    add(ids.ocr[1], '100004000002')
    return raw
  }

  const bulk = (body: unknown) => post('/svar/bulk', body)
  const hi3gBody = (over: Record<string, unknown> = {}) => ({
    svarstyp: 'levererar_sjalv',
    transaction_id: ids.hi3g[0],
    motpart: 'HI3G',
    bekrafta_antal: 3,
    ...over,
  })

  async function setup() {
    vi.stubEnv('UNDERLAGSJAKT_LEVERERAR_SJALV_ENABLED', 'true')
    const ctx = buildCtx()
    expect((await route('POST', '/export/fil').handler(post('/export/fil', exportWithVendors()), ctx)).status).toBe(200)
    // One HI3G post was answered on its own earlier: it is not open, so it is not counted.
    const answered = await route('POST', '/svar').handler(
      post('/svar', { svarstyp: 'osaker', transaction_id: ids.answered }),
      ctx,
    )
    expect(answered.status).toBe(200)
    return ctx
  }

  const svarStore = () =>
    store.get('svar') as Record<string, { beslut: Record<string, unknown>; answer_id: string; levererad_at: string | null }>

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 400 for a body that is not JSON', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar/bulk').handler(
        new Request('http://localhost/svar/bulk', { method: 'POST', body: '{nope' }),
        buildCtx(),
      ),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVALID_JSON')
  })

  it.each([
    ['another svarstyp', { svarstyp: 'osaker' }],
    ['a list of ids instead of an anchor', { transaction_id: undefined, transaction_ids: ['tx-hi3g-1'] }],
    ['no promised count', { bekrafta_antal: undefined }],
    ['a count of zero', { bekrafta_antal: 0 }],
    ['a blank motpart', { motpart: ' ' }],
  ])('returns 400 VALIDATION_ERROR for %s, and stores nothing new', async (_label, over) => {
    const ctx = await setup()
    const before = JSON.stringify(svarStore())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar/bulk').handler(bulk(hi3gBody(over)), ctx),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(JSON.stringify(svarStore())).toBe(before)
  })

  it('returns 403 FEATURE_DISABLED while the type is off, and stores nothing new', async () => {
    const ctx = await setup()
    vi.stubEnv('UNDERLAGSJAKT_LEVERERAR_SJALV_ENABLED', '')
    const before = JSON.stringify(svarStore())
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar/bulk').handler(bulk(hi3gBody()), ctx),
    )
    expect(status).toBe(403)
    expect(body.error.code).toBe('FEATURE_DISABLED')
    expect(JSON.stringify(svarStore())).toBe(before)
  })

  it('returns 404 for an anchor that is not in the export', async () => {
    const ctx = await setup()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route('POST', '/svar/bulk').handler(bulk(hi3gBody({ transaction_id: 'tx-nope' })), ctx),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('POST_NOT_FOUND')
  })

  it.each([2, 4, 7])('returns 409 COUNT_CHANGED for a promise of %i when 3 are covered, and writes nothing', async (antal) => {
    const ctx = await setup()
    const before = JSON.stringify(svarStore())
    const { status, body } = await parseJsonResponse<{ error: { code: string; antal: number } }>(
      await route('POST', '/svar/bulk').handler(bulk(hi3gBody({ bekrafta_antal: antal })), ctx),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('COUNT_CHANGED')
    expect(body.error.antal).toBe(3)
    expect(JSON.stringify(svarStore())).toBe(before)
  })

  it('writes one levererar_sjalv beslut per covered post, each with its own answer_id, and no other post', async () => {
    const ctx = await setup()
    const { status, body } = await parseJsonResponse<{ data: { recorded: number; transaction_ids: string[] } }>(
      await route('POST', '/svar/bulk').handler(bulk(hi3gBody()), ctx),
    )
    expect(status).toBe(200)
    expect(body.data.recorded).toBe(3)
    expect(body.data.transaction_ids).toEqual(ids.hi3g)

    const svar = svarStore()
    for (const id of ids.hi3g) {
      expect(svar[id].beslut).toEqual({
        answer_id: expect.stringContaining(id),
        transaction_id: id,
        svarstyp: 'levererar_sjalv',
        motpart: 'HI3G',
        underlag_hittat_at: null,
      })
    }
    // Acknowledgement is per transaction: no answer identity is shared between payments.
    expect(new Set(ids.hi3g.map((id) => svar[id].answer_id)).size).toBe(3)
    // Untouched: another vendor, the other-company post, the earlier answer, the reference numbers.
    expect(Object.keys(svar).sort()).toEqual([...ids.hi3g, ids.answered].sort())
    expect(svar[ids.answered].beslut.svarstyp).toBe('osaker')

    const { body: view } = await parseJsonResponse<GetBody>(await route('GET', '/').handler(get('/'), ctx))
    const open = view.data.posts.map((p) => p.transaction_id)
    expect(open).toContain(ids.felBolag)
    expect(open).toContain(ids.telia)
    expect(open).not.toContain(ids.hi3g[0])
    expect(view.data.waiting.map((w) => w.transaction_id).sort()).toEqual([...ids.hi3g].sort())
  })

  it('covers exactly one post for a reference-number motpart (task 1438): the OCR number is the whole key', async () => {
    const ctx = await setup()
    const anchor = { transaction_id: ids.ocr[0], motpart: '100004000001' }
    const tooMany = await route('POST', '/svar/bulk').handler(bulk(hi3gBody({ ...anchor, bekrafta_antal: 2 })), ctx)
    expect(tooMany.status).toBe(409)

    const res = await route('POST', '/svar/bulk').handler(bulk(hi3gBody({ ...anchor, bekrafta_antal: 1 })), ctx)
    expect(res.status).toBe(200)
    const svar = svarStore()
    expect(svar[ids.ocr[0]]).toBeDefined()
    expect(svar[ids.ocr[1]]).toBeUndefined()
  })

  it('answers a fel_bolag anchor for itself only, never sweeping in the others of that vendor', async () => {
    const ctx = await setup()
    const res = await route('POST', '/svar/bulk').handler(
      bulk(hi3gBody({ transaction_id: ids.felBolag, bekrafta_antal: 4 })),
      ctx,
    )
    // The anchor plus the three ordinary HI3G posts share the rule key: 4 posts, and the count is honest.
    expect(res.status).toBe(200)
    expect(Object.keys(svarStore()).sort()).toEqual([...ids.hi3g, ids.felBolag, ids.answered].sort())
  })

  it('refuses a second identical bulk: the posts are no longer open, so the promised count no longer matches', async () => {
    const ctx = await setup()
    await route('POST', '/svar/bulk').handler(bulk(hi3gBody()), ctx)
    const again = await route('POST', '/svar/bulk').handler(bulk(hi3gBody()), ctx)
    expect(again.status).toBe(409)
  })
})

describe('POST /documents/signed-url', () => {
  const createSignedUrlMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.doMock('@/lib/supabase/server', () => ({
      createServiceClient: () => ({
        storage: {
          from: () => ({
            createSignedUrl: createSignedUrlMock,
          }),
        },
      }),
    }))
  })

  it('returns 400 for invalid JSON', async () => {
    const ctx = buildCtx()
    const badRequest = new Request('http://localhost', {
      method: 'POST',
      body: 'not json',
    })
    const res = await route('POST', '/documents/signed-url').handler(badRequest, ctx)
    expect(res.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: Record<string, unknown> }>(res)
    expect(body.error.code).toBe('INVALID_JSON')
  })

  it('returns 400 for missing storagePath', async () => {
    const ctx = buildCtx()
    const res = await route('POST', '/documents/signed-url').handler(
      createMockRequest('/documents/signed-url', { method: 'POST', body: {} }),
      ctx,
    )
    expect(res.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: Record<string, unknown> }>(res)
    expect(body.error.code).toBe('INVALID_STORAGE_PATH')
  })

  it('returns 400 for non-string storagePath', async () => {
    const ctx = buildCtx()
    const res = await route('POST', '/documents/signed-url').handler(
      createMockRequest('/documents/signed-url', { method: 'POST', body: { storagePath: 123 } }),
      ctx,
    )
    expect(res.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: Record<string, unknown> }>(res)
    expect(body.error.code).toBe('INVALID_STORAGE_PATH')
  })

  it('returns 400 for invalid storage path format', async () => {
    const ctx = buildCtx()
    const res = await route('POST', '/documents/signed-url').handler(
      createMockRequest('/documents/signed-url', { method: 'POST', body: { storagePath: 'invalid/path' } }),
      ctx,
    )
    expect(res.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: Record<string, unknown> }>(res)
    expect(body.error.code).toBe('INVALID_STORAGE_PATH')
  })

  it('returns 403 when company in path does not match user context', async () => {
    const ctx = buildCtx()
    const res = await route('POST', '/documents/signed-url').handler(
      createMockRequest('/documents/signed-url', {
        method: 'POST',
        body: { storagePath: 'documents/other-company/user-1/doc.pdf' },
      }),
      ctx,
    )
    expect(res.status).toBe(403)
    const { body } = await parseJsonResponse<{ error: Record<string, unknown> }>(res)
    expect(body.error.code).toBe('ACCESS_DENIED')
  })

  it('returns 500 when signed URL creation fails', async () => {
    createSignedUrlMock.mockResolvedValue({ data: null, error: { message: 'Storage error' } })
    const ctx = buildCtx()
    ctx.supabase = {
      storage: {
        from: () => ({
          createSignedUrl: createSignedUrlMock,
        }),
      },
    } as unknown as ExtensionContext['supabase']

    const res = await route('POST', '/documents/signed-url').handler(
      createMockRequest('/documents/signed-url', {
        method: 'POST',
        body: { storagePath: 'documents/company-1/user-1/doc.pdf' },
      }),
      ctx,
    )
    expect(res.status).toBe(500)
    const { body } = await parseJsonResponse<{ error: Record<string, unknown> }>(res)
    expect(body.error.code).toBe('SIGNED_URL_FAILED')
  })

  it('returns signed URL on success', async () => {
    createSignedUrlMock.mockResolvedValue({
      data: {
        signedUrl: 'https://storage.example.com/signed/documents/company-1/user-1/doc.pdf?token=abc123',
      },
      error: null,
    })
    const ctx = buildCtx()
    ctx.supabase = {
      storage: {
        from: () => ({
          createSignedUrl: createSignedUrlMock,
        }),
      },
    } as unknown as ExtensionContext['supabase']

    const res = await route('POST', '/documents/signed-url').handler(
      createMockRequest('/documents/signed-url', {
        method: 'POST',
        body: { storagePath: 'documents/company-1/user-1/doc.pdf' },
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ signedUrl: string }>(res)
    expect(body.signedUrl).toBe('https://storage.example.com/signed/documents/company-1/user-1/doc.pdf?token=abc123')
  })

  it('returns 401 without a context', async () => {
    const res = await route('POST', '/documents/signed-url').handler(
      createMockRequest('/documents/signed-url', {
        method: 'POST',
        body: { storagePath: 'documents/company-1/user-1/doc.pdf' },
      }),
    )
    expect(res.status).toBe(401)
  })
})
