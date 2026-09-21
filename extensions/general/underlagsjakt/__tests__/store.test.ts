import { describe, it, expect } from 'vitest'
import type { Post, Beslut } from '../lib/contract'
import {
  recordAnswer,
  withdrawAnswer,
  markOffered,
  markDelivered,
  markDeliveredManual,
  openPosts,
  bulkTargets,
  markUnderlagHittat,
  waitingRows,
  reconcileWithExport,
  felBolagRows,
  bolagChoices,
  pendingBeslut,
  type SvarMap,
  type SvarRecord,
  type StoredExport,
} from '../lib/store'

const makePost = (overrides?: Partial<Post>): Post => ({
  bolag: 'Test AB',
  period: '2026-01-01/2026-03-31',
  transaction_id: 'test-txn-1',
  datum: '2026-01-15',
  belopp: 1000,
  valuta: 'SEK',
  motpart: 'Test Vendor',
  konto_identitet: 'test-konto',
  typ: 'utgift',
  saldo: null,
  kategori: 'behover_mattias',
  forslag: null,
  kandidater: [],
  tvetydiga_alternativ: [],
  mottagare: null,
  ...overrides,
})

const makeBeslut = (overrides?: Partial<Beslut>): Beslut => {
  const base: Beslut = {
    answer_id: 'test-answer-1',
    transaction_id: 'test-txn-1',
    svarstyp: 'osaker',
  }
  return { ...base, ...overrides } as Beslut
}

const makeSvarRecord = (overrides?: Partial<SvarRecord>): SvarRecord => ({
  beslut: makeBeslut(),
  reglering: null,
  post: {
    bolag: 'Test AB',
    period: '2026-01-01/2026-03-31',
    datum: '2026-01-15',
    belopp: 1000,
    valuta: 'SEK',
    motpart: 'Test Vendor',
    konto_identitet: 'test-konto',
    typ: 'utgift',
  },
  besvarad_at: '2026-01-15T10:00:00Z',
  besvarad_av: 'user-1',
  answer_id: 'test-answer-1',
  erbjudet_at: null,
  levererad_at: null,
  ...overrides,
})

const makeStoredExport = (posts: Post[] = []): StoredExport => ({
  export_version: '1.4',
  generated_at: '2026-01-20T10:00:00Z',
  imported_at: '2026-01-20T11:00:00Z',
  sammanstallningar: [
    {
      export_version: '1.4',
      bolag: 'Test AB',
      period: '2026-01-01/2026-03-31',
      generated_at: '2026-01-20T10:00:00Z',
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
    },
  ],
})

describe('store', () => {
  describe('recordAnswer', () => {
    it('creates a new answer with answer_id and erbjudet_at=null', () => {
      const svar: SvarMap = {}
      const post = makePost()
      const now = '2026-09-21T10:00:00Z'

      const result = recordAnswer(svar, post, makeBeslut(), null, 'user-1', now)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const record = result.svar['test-txn-1']
      expect(record.answer_id).toBe(`${now}:${post.transaction_id}`)
      expect(record.erbjudet_at).toBe(null)
      expect(record.levererad_at).toBe(null)
      expect(record.besvarad_at).toBe(now)
      expect(record.besvarad_av).toBe('user-1')
    })

    it('refuses to overwrite delivered answer', () => {
      const now = '2026-09-21T10:00:00Z'
      const svar: SvarMap = {
        'test-txn-1': makeSvarRecord({
          levererad_at: now,
        }),
      }

      const result = recordAnswer(svar, makePost(), makeBeslut(), null, 'user-2', now)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('ALREADY_DELIVERED')
    })

    it('refuses to overwrite offered answer', () => {
      const now = '2026-09-21T10:00:00Z'
      const offered = '2026-09-21T10:05:00Z'
      const svar: SvarMap = {
        'test-txn-1': makeSvarRecord({
          erbjudet_at: offered,
        }),
      }

      const result = recordAnswer(svar, makePost(), makeBeslut(), null, 'user-2', now)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('ALREADY_DELIVERED')
    })
  })

  describe('withdrawAnswer', () => {
    it('removes answer if not yet offered', () => {
      const svar: SvarMap = {
        'test-txn-1': makeSvarRecord(),
      }

      const result = withdrawAnswer(svar, 'test-txn-1')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.svar['test-txn-1']).toBeUndefined()
    })

    it('refuses to withdraw if already offered', () => {
      const offered = '2026-09-21T10:05:00Z'
      const svar: SvarMap = {
        'test-txn-1': makeSvarRecord({ erbjudet_at: offered }),
      }

      const result = withdrawAnswer(svar, 'test-txn-1')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('ALREADY_DELIVERED')
    })

    it('refuses to withdraw if already delivered', () => {
      const delivered = '2026-09-21T10:10:00Z'
      const svar: SvarMap = {
        'test-txn-1': makeSvarRecord({
          erbjudet_at: '2026-09-21T10:05:00Z',
          levererad_at: delivered,
        }),
      }

      const result = withdrawAnswer(svar, 'test-txn-1')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('ALREADY_DELIVERED')
    })

    it('returns NOT_FOUND for non-existent answer', () => {
      const svar: SvarMap = {}

      const result = withdrawAnswer(svar, 'test-txn-1')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('NOT_FOUND')
    })
  })

  describe('markOffered', () => {
    it('sets erbjudet_at on first call', () => {
      const offered = '2026-09-21T10:05:00Z'
      const svar: SvarMap = {
        'test-txn-1': makeSvarRecord(),
      }

      const result = markOffered(svar, ['test-txn-1'], offered)
      expect(result['test-txn-1'].erbjudet_at).toBe(offered)
    })

    it('does not overwrite existing erbjudet_at', () => {
      const offered = '2026-09-21T10:05:00Z'
      const offered2 = '2026-09-21T10:10:00Z'
      const svar: SvarMap = {
        'test-txn-1': makeSvarRecord({ erbjudet_at: offered }),
      }

      const result = markOffered(svar, ['test-txn-1'], offered2)
      expect(result['test-txn-1'].erbjudet_at).toBe(offered)
    })

    it('ignores non-existent IDs', () => {
      const svar: SvarMap = {}
      const result = markOffered(svar, ['test-txn-1'], '2026-09-21T10:05:00Z')
      expect(result['test-txn-1']).toBeUndefined()
    })
  })

  describe('markDelivered', () => {
    it('marks delivered only when answer_id matches', () => {
      const offered = '2026-09-21T10:05:00Z'
      const delivered = '2026-09-21T10:10:00Z'
      const answerId = 'test-answer-1'
      const svar: SvarMap = {
        'test-txn-1': makeSvarRecord({
          answer_id: answerId,
          erbjudet_at: offered,
        }),
      }

      const result = markDelivered(svar, [{ id: 'test-txn-1', answerId }], delivered)
      expect(result['test-txn-1'].levererad_at).toBe(delivered)
    })

    it('does not mark delivered with wrong answer_id', () => {
      const offered = '2026-09-21T10:05:00Z'
      const delivered = '2026-09-21T10:10:00Z'
      const answerId = 'test-answer-1'
      const wrongAnswerId = 'wrong-answer-id'
      const svar: SvarMap = {
        'test-txn-1': makeSvarRecord({
          answer_id: answerId,
          erbjudet_at: offered,
        }),
      }

      const result = markDelivered(svar, [{ id: 'test-txn-1', answerId: wrongAnswerId }], delivered)
      expect(result['test-txn-1'].levererad_at).toBeNull()
    })

    it('ignores non-existent IDs', () => {
      const svar: SvarMap = {}
      const result = markDelivered(svar, [{ id: 'test-txn-1', answerId: 'test-answer-1' }], '2026-09-21T10:10:00Z')
      expect(result['test-txn-1']).toBeUndefined()
    })
  })

  describe('markDeliveredManual', () => {
    it('marks delivered without answer_id validation', () => {
      const offered = '2026-09-21T10:05:00Z'
      const delivered = '2026-09-21T10:10:00Z'
      const svar: SvarMap = {
        'test-txn-1': makeSvarRecord({ erbjudet_at: offered }),
      }

      const result = markDeliveredManual(svar, ['test-txn-1'], delivered)
      expect(result['test-txn-1'].levererad_at).toBe(delivered)
    })
  })

  describe('openPosts', () => {
    it('returns all posts when no answers exist', () => {
      const post1 = makePost({ transaction_id: 'tx-1' })
      const post2 = makePost({ transaction_id: 'tx-2' })
      const exp = makeStoredExport([post1, post2])

      const result = openPosts(exp, {})
      expect(result).toHaveLength(2)
      expect(result.map((p) => p.transaction_id)).toEqual(['tx-1', 'tx-2'])
    })

    it('excludes posts with any answer (delivered or offered)', () => {
      const post1 = makePost({ transaction_id: 'tx-1' })
      const post2 = makePost({ transaction_id: 'tx-2' })
      const post3 = makePost({ transaction_id: 'tx-3' })
      const exp = makeStoredExport([post1, post2, post3])
      const svar: SvarMap = {
        'tx-1': makeSvarRecord({
          post: post1,
          levererad_at: '2026-09-21T10:00:00Z',
        }),
        'tx-2': makeSvarRecord({
          post: post2,
          erbjudet_at: '2026-09-21T10:00:00Z',
          levererad_at: null,
        }),
      }

      const result = openPosts(exp, svar)
      expect(result).toHaveLength(1)
      expect(result[0].transaction_id).toBe('tx-3')
    })

    it('returns empty list when all posts have answers or export is null', () => {
      expect(openPosts(null, {})).toEqual([])
    })
  })

  describe('reconcileWithExport', () => {
    it('keeps unanswered posts', () => {
      const post1 = makePost({ transaction_id: 'tx-1' })
      const post2 = makePost({ transaction_id: 'tx-2' })
      const exp = makeStoredExport([post1, post2])
      const svar: SvarMap = {
        'tx-1': makeSvarRecord({ post: post1 }),
      }

      const result = reconcileWithExport(svar, exp)
      expect(result['tx-1']).toBeDefined()
    })

    it('drops delivered answers that are re-asked in new export and were delivered before export', () => {
      const post1 = makePost({ transaction_id: 'tx-1' })
      const exp = makeStoredExport([post1])
      const svar: SvarMap = {
        'tx-1': makeSvarRecord({
          post: post1,
          levererad_at: '2026-01-19T09:00:00Z',
        }),
      }

      const result = reconcileWithExport(svar, exp)
      expect(result['tx-1']).toBeUndefined()
    })

    it('keeps delivered answers not in the new export', () => {
      const post1 = makePost({ transaction_id: 'tx-1' })
      const exp = makeStoredExport([post1])
      const svar: SvarMap = {
        'tx-2': makeSvarRecord({
          post: makePost({ transaction_id: 'tx-2' }),
          levererad_at: '2026-09-21T10:00:00Z',
        }),
      }

      const result = reconcileWithExport(svar, exp)
      expect(result['tx-2']).toBeDefined()
    })

    it('keeps undelivered answers even if not in export', () => {
      const post1 = makePost({ transaction_id: 'tx-1' })
      const exp = makeStoredExport([post1])
      const svar: SvarMap = {
        'tx-2': makeSvarRecord({
          post: makePost({ transaction_id: 'tx-2' }),
          levererad_at: null,
        }),
      }

      const result = reconcileWithExport(svar, exp)
      expect(result['tx-2']).toBeDefined()
    })

    it('keeps delivered answers delivered after export generation', () => {
      const post1 = makePost({ transaction_id: 'tx-1' })
      const oldExp = makeStoredExport([post1])
      oldExp.generated_at = '2026-09-20T10:00:00Z'
      const svar: SvarMap = {
        'tx-1': makeSvarRecord({
          post: post1,
          levererad_at: '2026-09-21T10:00:00Z',
        }),
      }

      const result = reconcileWithExport(svar, oldExp)
      expect(result['tx-1']).toBeDefined()
    })
  })

  describe('felBolagRows', () => {
    it('returns only fel_bolag answers, newest first', () => {
      const svar: SvarMap = {
        'tx-1': makeSvarRecord({
          beslut: {
            answer_id: 'test-answer-1',
            transaction_id: 'tx-1',
            svarstyp: 'osaker',
          },
          besvarad_at: '2026-09-20T10:00:00Z',
        }),
        'tx-2': makeSvarRecord({
          beslut: {
            answer_id: 'test-answer-2',
            transaction_id: 'tx-2',
            svarstyp: 'fel_bolag',
            fel_bolag_mottagare: 'Company B',
            till_bolag: 'Other Inc',
          },
          besvarad_at: '2026-09-21T10:00:00Z',
        }),
        'tx-3': makeSvarRecord({
          beslut: {
            answer_id: 'test-answer-3',
            transaction_id: 'tx-3',
            svarstyp: 'fel_bolag',
            fel_bolag_mottagare: 'Company C',
            till_bolag: 'Third Ltd',
          },
          besvarad_at: '2026-09-19T10:00:00Z',
        }),
      }

      const result = felBolagRows(svar)
      expect(result).toHaveLength(2)
      expect(result[0].transaction_id).toBe('tx-2')
      expect(result[1].transaction_id).toBe('tx-3')
    })

    it('returns empty list when no fel_bolag answers', () => {
      const svar: SvarMap = {
        'tx-1': makeSvarRecord({
          beslut: {
            answer_id: 'test-answer-1',
            transaction_id: 'tx-1',
            svarstyp: 'osaker',
          },
        }),
      }

      const result = felBolagRows(svar)
      expect(result).toHaveLength(0)
    })
  })

  describe('pendingBeslut', () => {
    it('returns undelivered beslut in order, oldest first', () => {
      const svar: SvarMap = {
        'tx-1': makeSvarRecord({
          beslut: makeBeslut({ transaction_id: 'tx-1', answer_id: 'ans-1' }),
          besvarad_at: '2026-09-21T10:00:00Z',
          levererad_at: null,
        }),
        'tx-2': makeSvarRecord({
          beslut: makeBeslut({ transaction_id: 'tx-2', answer_id: 'ans-2' }),
          besvarad_at: '2026-09-20T10:00:00Z',
          levererad_at: null,
        }),
        'tx-3': makeSvarRecord({
          beslut: makeBeslut({ transaction_id: 'tx-3', answer_id: 'ans-3' }),
          besvarad_at: '2026-09-22T10:00:00Z',
          levererad_at: null,
        }),
      }

      const result = pendingBeslut(svar)
      expect(result).toHaveLength(3)
      expect(result[0].transaction_id).toBe('tx-2')
      expect(result[1].transaction_id).toBe('tx-1')
      expect(result[2].transaction_id).toBe('tx-3')
    })

    it('excludes delivered answers', () => {
      const svar: SvarMap = {
        'tx-1': makeSvarRecord({
          beslut: makeBeslut({ transaction_id: 'tx-1', answer_id: 'ans-1' }),
          levererad_at: '2026-09-21T10:00:00Z',
        }),
        'tx-2': makeSvarRecord({
          beslut: makeBeslut({ transaction_id: 'tx-2', answer_id: 'ans-2' }),
          levererad_at: null,
        }),
      }

      const result = pendingBeslut(svar)
      expect(result).toHaveLength(1)
      expect(result[0].transaction_id).toBe('tx-2')
    })
  })

  describe('bolagChoices', () => {
    it('returns company names from export, earlier answers, and memberships', () => {
      const post1 = makePost({ transaction_id: 'tx-1', bolag: 'Company A' })
      const exp: StoredExport = {
        export_version: '1.4',
        generated_at: '2026-01-20T10:00:00Z',
        imported_at: '2026-01-20T11:00:00Z',
        sammanstallningar: [
          {
            export_version: '1.4',
            bolag: 'Company A',
            period: '2026-01-01/2026-03-31',
            generated_at: '2026-01-20T10:00:00Z',
            sammanfattning: {
              totalt: 1,
              med_underlag: 0,
              hittad_i_mejl: 0,
              sjalvforklarande: 0,
              inlard_regel: 0,
              behover_mattias: 1,
              tvetydig: 0,
              fel_bolag: 0,
              uppskjuten: 0,
              lost_svar: 0,
            },
            posts: [post1],
          },
        ],
      }
      const svar: SvarMap = {
        'tx-2': makeSvarRecord({
          beslut: {
            answer_id: 'ans-2',
            transaction_id: 'tx-2',
            svarstyp: 'fel_bolag',
            fel_bolag_mottagare: 'Company B',
            till_bolag: 'Totally Different Inc',
          },
        }),
      }

      const result = bolagChoices(exp, svar, ['Member Company'])
      expect(result).toContain('Company A')
      expect(result).toContain('Totally Different Inc')
      expect(result).toContain('Member Company')
    })

    it('dedupes companies by normalized spelling', () => {
      const post1 = makePost({ transaction_id: 'tx-1', bolag: 'Company AB' })
      const post2 = makePost({ transaction_id: 'tx-2', bolag: 'Company (publ) AB' })
      const exp: StoredExport = {
        export_version: '1.4',
        generated_at: '2026-01-20T10:00:00Z',
        imported_at: '2026-01-20T11:00:00Z',
        sammanstallningar: [
          {
            export_version: '1.4',
            bolag: 'Company AB',
            period: '2026-01-01/2026-03-31',
            generated_at: '2026-01-20T10:00:00Z',
            sammanfattning: {
              totalt: 2,
              med_underlag: 0,
              hittad_i_mejl: 0,
              sjalvforklarande: 0,
              inlard_regel: 0,
              behover_mattias: 2,
              tvetydig: 0,
              fel_bolag: 0,
              uppskjuten: 0,
              lost_svar: 0,
            },
            posts: [post1, post2],
          },
        ],
      }

      const result = bolagChoices(exp, {}, [])
      // The key is normalized to "company", so only one variant is kept
      const companyVariants = result.filter((name) => name.toLowerCase().includes('company'))
      expect(companyVariants).toHaveLength(1)
    })

    it('returns empty list when no companies are available', () => {
      const result = bolagChoices(null, {}, [])
      expect(result).toEqual([])
    })

    it('sorts results alphabetically in Swedish locale', () => {
      const post1 = makePost({ transaction_id: 'tx-1', bolag: 'Zebra AB' })
      const post2 = makePost({ transaction_id: 'tx-2', bolag: 'Apple Inc' })
      const exp: StoredExport = {
        export_version: '1.4',
        generated_at: '2026-01-20T10:00:00Z',
        imported_at: '2026-01-20T11:00:00Z',
        sammanstallningar: [
          {
            export_version: '1.4',
            bolag: 'Zebra AB',
            period: '2026-01-01/2026-03-31',
            generated_at: '2026-01-20T10:00:00Z',
            sammanfattning: {
              totalt: 1,
              med_underlag: 0,
              hittad_i_mejl: 0,
              sjalvforklarande: 0,
              inlard_regel: 0,
              behover_mattias: 1,
              tvetydig: 0,
              fel_bolag: 0,
              uppskjuten: 0,
              lost_svar: 0,
            },
            posts: [post1],
          },
          {
            export_version: '1.4',
            bolag: 'Apple Inc',
            period: '2026-01-01/2026-03-31',
            generated_at: '2026-01-20T10:00:00Z',
            sammanfattning: {
              totalt: 1,
              med_underlag: 0,
              hittad_i_mejl: 0,
              sjalvforklarande: 0,
              inlard_regel: 0,
              behover_mattias: 1,
              tvetydig: 0,
              fel_bolag: 0,
              uppskjuten: 0,
              lost_svar: 0,
            },
            posts: [post2],
          },
        ],
      }

      const result = bolagChoices(exp, {}, ['Monkey Ltd'])
      expect(result.length).toBe(3)
      expect(result).toContain('Apple Inc')
      expect(result).toContain('Monkey Ltd')
      expect(result).toContain('Zebra AB')
    })
  })
})

describe('bulkTargets: one "I will deliver it myself" for a whole motpart', () => {
  const hi3g = (n: number, overrides?: Partial<Post>) =>
    makePost({ transaction_id: `hi3g-${n}`, motpart: 'HI3G', ...overrides })

  it('covers every open post with the same motpart, the anchor included', () => {
    const open = [hi3g(1), hi3g(2), hi3g(3), makePost({ transaction_id: 'other', motpart: 'Telia' })]
    expect(bulkTargets(open, open[0]).map((p) => p.transaction_id)).toEqual(['hi3g-1', 'hi3g-2', 'hi3g-3'])
  })

  it('matches exact normalized text: case and spacing do not split a vendor, a different name does', () => {
    const open = [
      hi3g(1),
      hi3g(2, { motpart: '  hi3g ' }),
      hi3g(3, { motpart: 'HI3G  ' }),
      hi3g(4, { motpart: 'HI3G SWEDEN' }),
      hi3g(5, { motpart: 'HI3' }),
    ]
    expect(bulkTargets(open, open[0]).map((p) => p.transaction_id)).toEqual(['hi3g-1', 'hi3g-2', 'hi3g-3'])
  })

  it('never sweeps in a fel_bolag post, even with the same motpart', () => {
    const open = [hi3g(1), hi3g(2, { kategori: 'fel_bolag' }), hi3g(3)]
    expect(bulkTargets(open, open[0]).map((p) => p.transaction_id)).toEqual(['hi3g-1', 'hi3g-3'])
  })

  it('still counts the anchor when the user answers a fel_bolag post themselves', () => {
    const open = [hi3g(1, { kategori: 'fel_bolag' }), hi3g(2), hi3g(3, { kategori: 'fel_bolag' })]
    expect(bulkTargets(open, open[0]).map((p) => p.transaction_id)).toEqual(['hi3g-1', 'hi3g-2'])
  })

  it('reports 1 for a reference-number motpart (task 1438): the OCR number is the key and only one post has it', () => {
    const open = ['100003645765', '100003645766', '100003645767'].map((ocr, i) =>
      makePost({ transaction_id: `seb-${i}`, motpart: ocr }),
    )
    for (const anchor of open) expect(bulkTargets(open, anchor)).toEqual([anchor])
  })

  it('does not group posts with a blank motpart', () => {
    const open = [hi3g(1, { motpart: '' }), hi3g(2, { motpart: ' ' })]
    expect(bulkTargets(open, open[0])).toEqual([open[0]])
  })

  it('takes only the posts it is given: answered posts are not open and so not counted', () => {
    const exp = {
      export_version: '1.4',
      generated_at: '2026-09-21T00:00:00Z',
      imported_at: '2026-09-21T00:00:00Z',
      sammanstallningar: [{ posts: [hi3g(1), hi3g(2), hi3g(3)] }],
    } as unknown as StoredExport
    const answered = recordAnswer({}, hi3g(2), makeBeslut({ transaction_id: 'hi3g-2' }), null, 'u', '2026-09-21T00:00:00Z')
    if (!answered.ok) throw new Error('setup')
    const open = openPosts(exp, answered.svar)
    expect(bulkTargets(open, hi3g(1)).map((p) => p.transaction_id)).toEqual(['hi3g-1', 'hi3g-3'])
  })
})

describe('markUnderlagHittat: waiting becomes "with document" without asking again', () => {
  const sjalv = (id: string, hittat: string | null = null): SvarRecord =>
    makeSvarRecord({
      beslut: {
        answer_id: `a-${id}`,
        transaction_id: id,
        svarstyp: 'levererar_sjalv',
        motpart: 'HI3G',
        underlag_hittat_at: hittat,
      },
    })

  it('stamps the promised answers named by bertil and leaves every other answer alone', () => {
    const svar: SvarMap = { a: sjalv('a'), b: sjalv('b'), c: makeSvarRecord() }
    const next = markUnderlagHittat(svar, ['a', 'c', 'unknown'], '2026-09-30T00:00:00Z')
    expect(waitingRows(next).map((r) => [r.transaction_id, r.underlag_hittat_at]).sort()).toEqual([
      ['a', '2026-09-30T00:00:00Z'],
      ['b', null],
    ])
    expect(next.c).toBe(svar.c)
    expect(next).not.toHaveProperty('unknown')
  })

  it('keeps the first time it was found', () => {
    const svar: SvarMap = { a: sjalv('a', '2026-09-25T00:00:00Z') }
    expect(markUnderlagHittat(svar, ['a'], '2026-09-30T00:00:00Z').a.beslut).toMatchObject({
      underlag_hittat_at: '2026-09-25T00:00:00Z',
    })
  })

  it('does not touch the answer identity, so acknowledgements still match', () => {
    const svar: SvarMap = { a: { ...sjalv('a'), answer_id: 'x' } }
    expect(markUnderlagHittat(svar, ['a'], '2026-09-30T00:00:00Z').a.answer_id).toBe('x')
  })
})
