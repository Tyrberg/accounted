import { describe, it, expect } from 'vitest'
import fixture from './fixtures/export-1.1.json'
import { buildBeslut, parseExport, type ParsedExport } from '../lib/contract'
import {
  bolagChoices,
  felBolagRows,
  findPost,
  markDelivered,
  openPosts,
  pendingBeslut,
  reconcileWithExport,
  recordAnswer,
  withdrawAnswer,
  type StoredExport,
  type SvarMap,
} from '../lib/store'

function stored(generatedAt = '2026-09-17T12:12:00+00:00'): StoredExport {
  const parsed = parseExport(JSON.parse(JSON.stringify(fixture)))
  if (!parsed.ok) throw new Error('fixture must parse')
  return { ...parsed.export, generated_at: generatedAt, imported_at: '2026-09-17T12:30:00Z' }
}

function answerMoank(svar: SvarMap, exp: StoredExport, now = '2026-09-17T13:00:00Z'): SvarMap {
  const post = findPost(exp, 'tx-moank-20260821')!
  const built = buildBeslut(post, {
    svarstyp: 'fel_bolag',
    transaction_id: post.transaction_id,
    fel_bolag_mottagare: 'Villa Viola AB',
    till_bolag: 'Villa Viola',
    reglering: 'mellanhavande',
  })
  if (!built.ok) throw new Error('must build')
  const r = recordAnswer(svar, post, built.beslut, built.reglering, 'user-1', now)
  if (!r.ok) throw new Error('must record')
  return r.svar
}

function answerOsaker(svar: SvarMap, exp: StoredExport, id: string, now: string): SvarMap {
  const post = findPost(exp, id)!
  const r = recordAnswer(svar, post, { transaction_id: id, svarstyp: 'osaker' }, null, 'user-1', now)
  if (!r.ok) throw new Error('must record')
  return r.svar
}

describe('openPosts', () => {
  it('lists every post of every bolag until it is answered, then drops it', () => {
    const exp = stored()
    expect(openPosts(exp, {}).map((p) => p.transaction_id)).toEqual([
      'tx-moank-20260821',
      'tx-google-20260803',
      'tx-ocr-20260812',
    ])
    const svar = answerMoank({}, exp)
    expect(openPosts(exp, svar).map((p) => p.transaction_id)).not.toContain('tx-moank-20260821')
  })

  it('is empty without an export', () => {
    expect(openPosts(null, {})).toEqual([])
  })
})

describe('recordAnswer / withdrawAnswer', () => {
  it('stores the post snapshot and the settlement next to the contract beslut', () => {
    const svar = answerMoank({}, stored())
    const rec = svar['tx-moank-20260821']
    expect(rec.reglering).toBe('mellanhavande')
    expect(rec.post).toMatchObject({ belopp: -75000, datum: '2026-08-21', bolag: 'Tyrberg Group' })
    expect(rec.levererad_at).toBeNull()
    expect(rec.besvarad_av).toBe('user-1')
  })

  it('lets an answer be replaced or withdrawn until it is handed to bertil, not after', () => {
    const exp = stored()
    let svar = answerMoank({}, exp)
    svar = answerMoank(svar, exp, '2026-09-17T13:05:00Z')
    expect(svar['tx-moank-20260821'].besvarad_at).toBe('2026-09-17T13:05:00Z')

    const delivered = markDelivered(svar, ['tx-moank-20260821'], '2026-09-17T14:00:00Z')
    const post = findPost(exp, 'tx-moank-20260821')!
    expect(recordAnswer(delivered, post, { transaction_id: post.transaction_id, svarstyp: 'osaker' }, null, 'u', 'n')).toEqual({
      ok: false,
      code: 'ALREADY_DELIVERED',
    })
    expect(withdrawAnswer(delivered, 'tx-moank-20260821')).toEqual({ ok: false, code: 'ALREADY_DELIVERED' })

    const withdrawn = withdrawAnswer(svar, 'tx-moank-20260821')
    expect(withdrawn.ok && withdrawn.svar).toEqual({})
    expect(withdrawAnswer({}, 'nope')).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
})

describe('pendingBeslut / markDelivered', () => {
  it('returns undelivered beslut oldest first and marks only the ids given', () => {
    const exp = stored()
    let svar = answerOsaker({}, exp, 'tx-ocr-20260812', '2026-09-17T13:10:00Z')
    svar = answerMoank(svar, exp, '2026-09-17T13:00:00Z')
    expect(pendingBeslut(svar).map((b) => b.transaction_id)).toEqual(['tx-moank-20260821', 'tx-ocr-20260812'])

    const after = markDelivered(svar, ['tx-moank-20260821', 'unknown'], '2026-09-17T14:00:00Z')
    expect(pendingBeslut(after).map((b) => b.transaction_id)).toEqual(['tx-ocr-20260812'])
    expect(after['tx-moank-20260821'].levererad_at).toBe('2026-09-17T14:00:00Z')
  })
})

describe('reconcileWithExport', () => {
  it('drops a delivered answer that a LATER export asks about again (osaker came back)', () => {
    const first = stored()
    let svar = answerOsaker({}, first, 'tx-ocr-20260812', '2026-09-17T13:00:00Z')
    svar = markDelivered(svar, ['tx-ocr-20260812'], '2026-09-17T14:00:00Z')

    const later: ParsedExport = stored('2026-09-25T08:00:00+00:00')
    const next = reconcileWithExport(svar, later)
    expect(next).toEqual({})
  })

  it('keeps answers not yet handed to bertil, even when the post is exported again', () => {
    const first = stored()
    const svar = answerMoank({}, first)
    expect(reconcileWithExport(svar, stored('2026-09-25T08:00:00+00:00'))).toEqual(svar)
  })

  it('does not resurrect a post when an export older than the delivery is read back in', () => {
    const first = stored()
    let svar = answerMoank({}, first)
    svar = markDelivered(svar, ['tx-moank-20260821'], '2026-09-17T14:00:00Z')
    expect(reconcileWithExport(svar, first)).toEqual(svar)
  })

  it('keeps a delivered answer bertil resolved (not in the new export)', () => {
    const first = stored()
    let svar = answerMoank({}, first)
    svar = markDelivered(svar, ['tx-moank-20260821'], '2026-09-17T14:00:00Z')
    const later = stored('2026-09-25T08:00:00+00:00')
    later.sammanstallningar[0].posts = later.sammanstallningar[0].posts.filter(
      (p) => p.transaction_id !== 'tx-moank-20260821',
    )
    expect(reconcileWithExport(svar, later)).toEqual(svar)
  })
})

describe('felBolagRows / bolagChoices', () => {
  it('lists wrong-company answers with company, addressee and settlement', () => {
    const exp = stored()
    let svar = answerMoank({}, exp)
    svar = answerOsaker(svar, exp, 'tx-ocr-20260812', '2026-09-17T13:10:00Z')
    expect(felBolagRows(svar)).toEqual([
      expect.objectContaining({
        transaction_id: 'tx-moank-20260821',
        till_bolag: 'Villa Viola',
        fel_bolag_mottagare: 'Villa Viola AB',
        reglering: 'mellanhavande',
      }),
    ])
  })

  it("offers bertil's bolag names plus companies typed in earlier answers, deduplicated", () => {
    const exp = stored()
    const svar = answerMoank({}, exp)
    expect(bolagChoices(exp, svar, [])).toEqual(['Tyrberg Fastigheter', 'Tyrberg Group', 'Villa Viola'])
    expect(bolagChoices(null, {}, [])).toEqual([])
  })

  it('offers every company the user is a member of, even when the export only covers one', () => {
    const exp = stored()
    exp.sammanstallningar = exp.sammanstallningar.filter((s) => s.bolag === 'Tyrberg Group')
    expect(
      bolagChoices(exp, {}, ['Tyrberg Group AB', 'Tyrberg Fastigheter AB', 'Marblechain AB', 'Villa  Viola AB']),
    ).toEqual(['Marblechain AB', 'Tyrberg Fastigheter AB', 'Tyrberg Group', 'Villa Viola AB'])
  })

  it("prefers bertil's spelling over the membership spelling for the same company", () => {
    const exp = stored()
    const svar = answerMoank({}, exp)
    expect(bolagChoices(exp, svar, ['villa viola ab', 'Tyrberg Fastigheter (publ)'])).toEqual([
      'Tyrberg Fastigheter',
      'Tyrberg Group',
      'Villa Viola',
    ])
  })
})
