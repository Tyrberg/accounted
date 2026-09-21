import { describe, it, expect, vi, beforeEach } from 'vitest'
import { underlagsjaktExtension } from '@/extensions/general/underlagsjakt'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import { ANSWER_VERSION, buildBeslut, parseExport, svarInputSchema, type Post } from '../lib/contract'
import {
  MAX_WAITING_DAYS,
  bulkTargets,
  markDelivered,
  normalizeMotpart,
  openPosts,
  reconcileWithExport,
  recordAnswers,
  waitingRows,
  waitingSummary,
  type StoredExport,
  type SvarMap,
} from '../lib/store'

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

function buildCtx(): ExtensionContext {
  const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn() }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.is.mockResolvedValue({ data: [], error: null })
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'underlagsjakt',
    supabase: { from: vi.fn().mockReturnValue(query) } as unknown as ExtensionContext['supabase'],
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

const makePost = (id: string, motpart: string, overrides: Partial<Post> = {}): Post => ({
  bolag: 'Tyrberg Group',
  period: '2026-08',
  transaction_id: id,
  datum: '2026-08-03',
  belopp: -499,
  valuta: 'SEK',
  motpart,
  konto_identitet: 'SEB Företagskonto',
  typ: 'Autogiro',
  saldo: null,
  kategori: 'behover_mattias',
  forslag: null,
  kandidater: [],
  tvetydiga_alternativ: [],
  mottagare: null,
  ...overrides,
})

function exportOf(posts: Post[], extra: Record<string, unknown> = {}) {
  return {
    export_version: '1.5',
    generated_at: '2026-09-21T06:00:00+00:00',
    sammanstallningar: [
      {
        export_version: '1.5',
        bolag: 'Tyrberg Group',
        period: '2026-08',
        generated_at: '2026-09-21T06:00:00+00:00',
        sammanfattning: {
          totalt: posts.length,
          med_underlag: 0,
          hittad_i_mejl: 0,
          sjalvforklarande: 0,
          inlard_regel: 0,
          behover_mattias: posts.length,
          tvetydig: 0,
          fel_bolag: 0,
          uppskjuten: 0,
          lost_svar: 0,
        },
        posts,
        ...extra,
      },
    ],
  }
}

// HI3G: one invoice per month, the same counterparty text every time.
const HI3G = [1, 2, 3, 4].map((n) => makePost(`tx-hi3g-${n}`, n === 4 ? 'hi3g  ACCESS AB' : 'HI3G ACCESS AB'))
const HI3G_NORMALISED = HI3G.map((p) => ({ ...p, motpart: 'HI3G ACCESS AB' }))
const HI3G_WRONG_COMPANY = makePost('tx-hi3g-fb', 'HI3G ACCESS AB', { kategori: 'fel_bolag' })
const OTHER = makePost('tx-other', 'GOOGLE*WORKSPACE')
// SEB: the counterparty is the payment's own OCR number, different on every row (task 1438).
const OCR = Array.from({ length: 9 }, (_, i) => makePost(`tx-ocr-${i}`, `10000364576${i}`))

interface GetBody {
  data: {
    posts: { transaction_id: string }[]
    vantar: { transaction_id: string; dagar: number; forsenad: boolean; galler_alla: boolean }[]
    answered: { transaction_id: string; underlag_hittat_at?: string | null }[]
    pending_count: number
  }
}

async function loadExport(ctx: ExtensionContext, posts: Post[], extra: Record<string, unknown> = {}) {
  const res = await route('POST', '/export/fil').handler(
    createMockRequest('/export/fil', { method: 'POST', body: exportOf(posts, extra) }),
    ctx,
  )
  expect(res.status).toBe(200)
}

const answer = (ctx: ExtensionContext, body: unknown) =>
  route('POST', '/svar').handler(createMockRequest('/svar', { method: 'POST', body }), ctx)
const workspace = async (ctx: ExtensionContext) =>
  (await parseJsonResponse<GetBody>(await route('GET', '/').handler(createMockRequest('/'), ctx))).body.data

beforeEach(() => {
  vi.clearAllMocks()
  store = new Map()
  writePermission.mockResolvedValue({ ok: true })
})

describe('contract: levererar_sjalv', () => {
  it('raises the answer version', () => {
    expect(ANSWER_VERSION).toBe('1.5')
  })

  it('builds a bulk beslut with an empty rule key: no bolag, no bankkonto, no belopp', () => {
    const input = svarInputSchema.parse({
      svarstyp: 'levererar_sjalv',
      transaction_id: 'tx-hi3g-1',
      motpart: 'HI3G ACCESS AB',
      galler_alla: true,
      bekrafta_antal: 4,
    })
    const built = buildBeslut(HI3G[0], input, 'a1')
    expect(built).toMatchObject({
      ok: true,
      beslut: {
        answer_id: 'a1',
        transaction_id: 'tx-hi3g-1',
        svarstyp: 'levererar_sjalv',
        motpart: 'HI3G ACCESS AB',
        galler_alla: true,
        bolag: null,
        bankkonto: null,
        belopp: null,
      },
    })
  })

  it('a single answer carries the post\'s own bolag and amount, never an empty key', () => {
    const input = svarInputSchema.parse({
      svarstyp: 'levererar_sjalv',
      transaction_id: 'tx-hi3g-1',
      motpart: 'HI3G ACCESS AB',
      galler_alla: false,
      bekrafta_antal: null,
    })
    expect(buildBeslut(HI3G[0], input, 'a1')).toMatchObject({
      beslut: { galler_alla: false, bolag: 'Tyrberg Group', belopp: -499, bankkonto: null },
    })
  })

  it('refuses a bulk answer without the confirmed count, and a blank counterparty', () => {
    expect(
      svarInputSchema.safeParse({
        svarstyp: 'levererar_sjalv',
        transaction_id: 't',
        motpart: 'X',
        galler_alla: true,
        bekrafta_antal: null,
      }).success,
    ).toBe(false)
    expect(
      svarInputSchema.safeParse({
        svarstyp: 'levererar_sjalv',
        transaction_id: 't',
        motpart: '  ',
        galler_alla: false,
        bekrafta_antal: null,
      }).success,
    ).toBe(false)
  })

  it('reads an export that carries underlag_hittat, and one that does not', () => {
    const withIt = parseExport(exportOf(HI3G, { underlag_hittat: ['tx-hi3g-1'] }))
    expect(withIt.ok && withIt.export.sammanstallningar[0].underlag_hittat).toEqual(['tx-hi3g-1'])
    const without = parseExport(exportOf(HI3G))
    expect(without.ok && without.export.sammanstallningar[0].underlag_hittat).toBeUndefined()
  })
})

describe('bulkTargets', () => {
  it('a single answer targets only the post', () => {
    expect(bulkTargets([...HI3G, OTHER], HI3G[0], 'HI3G ACCESS AB', false)).toEqual([HI3G[0]])
  })

  it('a bulk answer targets every open post with the same counterparty, primary first, ignoring case and spacing', () => {
    const targets = bulkTargets([...HI3G, HI3G_WRONG_COMPANY, OTHER], HI3G[1], 'HI3G ACCESS AB', true)
    expect(targets.map((p) => p.transaction_id)).toEqual(['tx-hi3g-2', 'tx-hi3g-1', 'tx-hi3g-3', 'tx-hi3g-4'])
    expect(normalizeMotpart('hi3g  ACCESS AB')).toBe('hi3g access ab')
  })

  it('never sweeps in a post bertil flagged as possibly another company\'s payment', () => {
    const targets = bulkTargets([...HI3G, HI3G_WRONG_COMPANY], HI3G[0], 'HI3G ACCESS AB', true)
    expect(targets.map((p) => p.transaction_id)).not.toContain('tx-hi3g-fb')
  })

  it('reference numbers as counterparty: the bulk honestly reports one post (task 1438 unsolved)', () => {
    expect(bulkTargets(OCR, OCR[0], OCR[0].motpart, true)).toHaveLength(1)
  })
})

describe('waiting state', () => {
  const NOW = new Date('2026-09-21T12:00:00Z')

  function answered(posts: Post[], at: string): SvarMap {
    const targets = posts.map((post) => {
      const built = buildBeslut(
        post,
        svarInputSchema.parse({
          svarstyp: 'levererar_sjalv',
          transaction_id: post.transaction_id,
          motpart: post.motpart,
          galler_alla: true,
          bekrafta_antal: posts.length,
        }),
        `${at}:${post.transaction_id}`,
      )
      if (!built.ok) throw new Error('unreachable')
      return { post, beslut: built.beslut }
    })
    const recorded = recordAnswers({}, targets, 'user-1', at)
    if (!recorded.ok) throw new Error('unreachable')
    return recorded.svar
  }

  it('lists the promises oldest first with days waited and flags the overdue ones', () => {
    const old = answered([HI3G[0]], '2026-08-01T10:00:00Z')
    const fresh = answered([HI3G[1]], '2026-09-20T10:00:00Z')
    const rows = waitingRows({ ...fresh, ...old }, NOW)
    expect(rows.map((r) => r.transaction_id)).toEqual(['tx-hi3g-1', 'tx-hi3g-2'])
    expect(rows[0]).toMatchObject({ dagar: 51, forsenad: true, galler_alla: true })
    expect(rows[1]).toMatchObject({ dagar: 1, forsenad: false })
  })

  it('summarises the backlog as one aggregate', () => {
    const svar = { ...answered([HI3G[0], HI3G[1]], '2026-08-01T10:00:00Z'), ...answered([HI3G[2]], '2026-09-20T10:00:00Z') }
    expect(waitingSummary(svar, NOW)).toEqual({ count: 3, overdue: 2, oldestAt: '2026-08-01T10:00:00Z' })
    expect(MAX_WAITING_DAYS).toBe(14)
  })

  it('a document bertil found silently moves the post from waiting to with-document, keeping who promised and when', () => {
    const svar = answered(HI3G_NORMALISED.slice(0, 2), '2026-09-01T10:00:00Z')
    const exp = parseExport(exportOf([OTHER], { underlag_hittat: ['tx-hi3g-1', 'tx-unknown'] }))
    if (!exp.ok) throw new Error('unreachable')
    const next = reconcileWithExport(svar, exp.export)
    expect(next['tx-hi3g-1'].underlag_hittat_at).toBe('2026-09-21T06:00:00+00:00')
    expect(next['tx-hi3g-1'].besvarad_at).toBe('2026-09-01T10:00:00Z')
    expect(next['tx-hi3g-2'].underlag_hittat_at ?? null).toBeNull()
    expect(next).not.toHaveProperty('tx-unknown')
    expect(waitingRows(next, NOW).map((r) => r.transaction_id)).toEqual(['tx-hi3g-2'])
  })

  it('bulk answer, acknowledged, then a later export that still lists the posts: the promise and the waiting list survive', () => {
    const answeredAt = '2026-09-01T10:00:00Z'
    let svar = answered(HI3G_NORMALISED, answeredAt)
    svar = markDelivered(
      svar,
      Object.entries(svar).map(([id, rec]) => ({ id, answerId: rec.answer_id })),
      '2026-09-02T08:00:00Z',
    )
    const exp = parseExport(exportOf(HI3G_NORMALISED))
    if (!exp.ok) throw new Error('unreachable')
    const next = reconcileWithExport(svar, exp.export)
    expect(Object.keys(next).sort()).toEqual(HI3G_NORMALISED.map((p) => p.transaction_id))
    expect(openPosts(exp.export as StoredExport, next)).toEqual([])
    expect(waitingRows(next, NOW)).toHaveLength(4)
    expect(waitingSummary(next, NOW).overdue).toBe(4)
  })

  it('an acknowledged non-promise answer that is asked about again is still dropped', () => {
    const post = makePost('tx-x', 'GOOGLE*WORKSPACE')
    const svar: SvarMap = {
      'tx-x': {
        ...answered([HI3G_NORMALISED[0]], '2026-09-01T10:00:00Z')['tx-hi3g-1'],
        beslut: { svarstyp: 'inget_underlag' } as unknown as SvarMap[string]['beslut'],
        levererad_at: '2026-09-02T08:00:00Z',
      },
    }
    const exp = parseExport(exportOf([post]))
    if (!exp.ok) throw new Error('unreachable')
    expect(reconcileWithExport(svar, exp.export)).toEqual({})
  })

  it('an id listed in both posts and underlag_hittat still makes the found transition and stays off the to-do list', () => {
    let svar = answered(HI3G_NORMALISED.slice(0, 1), '2026-09-01T10:00:00Z')
    svar = markDelivered(svar, [{ id: 'tx-hi3g-1', answerId: svar['tx-hi3g-1'].answer_id }], '2026-09-02T08:00:00Z')
    const exp = parseExport(exportOf(HI3G_NORMALISED.slice(0, 1), { underlag_hittat: ['tx-hi3g-1'] }))
    if (!exp.ok) throw new Error('unreachable')
    const next = reconcileWithExport(svar, exp.export)
    expect(next['tx-hi3g-1'].underlag_hittat_at).toBe('2026-09-21T06:00:00+00:00')
    expect(openPosts(exp.export as StoredExport, next)).toEqual([])
    expect(waitingRows(next, NOW)).toEqual([])
  })

  it('answered posts are off the to-do list', () => {
    const svar = answered(HI3G, '2026-09-20T10:00:00Z')
    const exp = { ...(parseExport(exportOf([...HI3G, OTHER])) as { ok: true; export: StoredExport }).export }
    expect(openPosts(exp, svar).map((p) => p.transaction_id)).toEqual(['tx-other'])
  })
})

describe('POST /svar: levererar_sjalv', () => {
  const bulk = (id: string, motpart: string, antal: number | null) => ({
    svarstyp: 'levererar_sjalv',
    transaction_id: id,
    motpart,
    galler_alla: true,
    bekrafta_antal: antal,
  })

  it('HI3G: bulk clears every open HI3G payment from the to-do list into the waiting list, one beslut each, all with the same empty rule key', async () => {
    const ctx = buildCtx()
    await loadExport(ctx, [...HI3G, HI3G_WRONG_COMPANY, OTHER])

    const res = await answer(ctx, bulk('tx-hi3g-1', 'HI3G ACCESS AB', 4))
    const { status, body } = await parseJsonResponse<{ data: { beslut: { transaction_id: string } }; antal: number }>(res)
    expect(status).toBe(200)
    expect(body.antal).toBe(4)
    expect(body.data.beslut.transaction_id).toBe('tx-hi3g-1')

    const data = await workspace(ctx)
    expect(data.posts.map((p) => p.transaction_id).sort()).toEqual(['tx-hi3g-fb', 'tx-other'])
    expect(data.vantar.map((r) => r.transaction_id).sort()).toEqual(['tx-hi3g-1', 'tx-hi3g-2', 'tx-hi3g-3', 'tx-hi3g-4'])
    expect(data.vantar.every((r) => r.galler_alla)).toBe(true)
    expect(data.pending_count).toBe(4)

    const file = await (await route('GET', '/svarsfil').handler(createMockRequest('/svarsfil'), ctx)).json()
    expect(file.version).toBe('1.5')
    expect(file.beslut).toHaveLength(4)
    expect(new Set(file.beslut.map((b: { answer_id: string }) => b.answer_id)).size).toBe(4)
    for (const b of file.beslut) {
      expect(b).toMatchObject({
        svarstyp: 'levererar_sjalv',
        motpart: 'HI3G ACCESS AB',
        galler_alla: true,
        bolag: null,
        bankkonto: null,
        belopp: null,
      })
    }
    // Task 1435: no document is bound to any payment by this answer.
    expect(JSON.stringify(file)).not.toContain('sha256')
    expect(JSON.stringify(file)).not.toContain('vald_kandidat')
  })

  it('refuses with COUNT_CHANGED, and writes nothing, when the confirmed count no longer matches', async () => {
    const ctx = buildCtx()
    await loadExport(ctx, [...HI3G, OTHER])
    const before = JSON.stringify([...store.entries()])
    const { status, body } = await parseJsonResponse<{ error: { code: string; antal: number } }>(
      await answer(ctx, bulk('tx-hi3g-1', 'HI3G ACCESS AB', 3)),
    )
    expect(status).toBe(409)
    expect(body.error).toMatchObject({ code: 'COUNT_CHANGED', antal: 4 })
    expect(JSON.stringify([...store.entries()])).toBe(before)
  })

  it('a bulk answer without a confirmed count is rejected as incomplete', async () => {
    const ctx = buildCtx()
    await loadExport(ctx, HI3G)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await answer(ctx, bulk('tx-hi3g-1', 'HI3G ACCESS AB', null)),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('without the tick, only the answered post moves', async () => {
    const ctx = buildCtx()
    await loadExport(ctx, HI3G)
    const res = await answer(ctx, {
      svarstyp: 'levererar_sjalv',
      transaction_id: 'tx-hi3g-2',
      motpart: 'HI3G ACCESS AB',
      galler_alla: false,
      bekrafta_antal: null,
    })
    expect(res.status).toBe(200)
    const data = await workspace(ctx)
    expect(data.vantar.map((r) => r.transaction_id)).toEqual(['tx-hi3g-2'])
    expect(data.vantar[0].galler_alla).toBe(false)
    expect(data.posts).toHaveLength(3)
  })

  it('SEB reference numbers: a bulk answer clears one post and says so, it does not pretend to clear nine', async () => {
    const ctx = buildCtx()
    await loadExport(ctx, OCR)
    const tooMany = await answer(ctx, bulk('tx-ocr-0', OCR[0].motpart, 9))
    expect(tooMany.status).toBe(409)
    const ok = await parseJsonResponse<{ antal: number }>(await answer(ctx, bulk('tx-ocr-0', OCR[0].motpart, 1)))
    expect(ok.status).toBe(200)
    expect(ok.body.antal).toBe(1)
    expect((await workspace(ctx)).posts).toHaveLength(8)
  })

  it('does not let an answer that bertil already has be overwritten by a later bulk', async () => {
    const ctx = buildCtx()
    await loadExport(ctx, HI3G)
    await answer(ctx, bulk('tx-hi3g-1', 'HI3G ACCESS AB', 4))
    // The machine path marks answers as offered; set it directly.
    const svar = store.get('svar') as Record<string, { erbjudet_at: string | null }>
    svar['tx-hi3g-1'].erbjudet_at = '2026-09-21T07:00:00Z'
    store.set('svar', svar)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await answer(ctx, {
        svarstyp: 'levererar_sjalv',
        transaction_id: 'tx-hi3g-1',
        motpart: 'HI3G ACCESS AB',
        galler_alla: false,
        bekrafta_antal: null,
      }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('ALREADY_DELIVERED')
  })

  it('a later export that reports the document found moves the post out of the waiting list without asking again', async () => {
    const ctx = buildCtx()
    await loadExport(ctx, [...HI3G, OTHER])
    await answer(ctx, bulk('tx-hi3g-1', 'HI3G ACCESS AB', 4))
    await loadExport(ctx, [OTHER], { underlag_hittat: ['tx-hi3g-1', 'tx-hi3g-2'] })

    const data = await workspace(ctx)
    expect(data.vantar.map((r) => r.transaction_id).sort()).toEqual(['tx-hi3g-3', 'tx-hi3g-4'])
    expect(data.posts.map((p) => p.transaction_id)).toEqual(['tx-other'])
    expect(data.answered.find((a) => a.transaction_id === 'tx-hi3g-1')?.underlag_hittat_at).toBe(
      '2026-09-21T06:00:00+00:00',
    )
  })
})
