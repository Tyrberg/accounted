/**
 * The contract mirror. The fixture is generated from bertil's
 * docs/underlagsjakt-export-schema.md (version 1.1), with the MOANK/Avizion
 * wrong-company case from Mattias's decision 2026-09-17.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fixture from './fixtures/export-1.1.json'
import fixture14 from './fixtures/export-1.4.json'
import {
  ANSWER_VERSION,
  ANSWER_VERSION_MULTI_KANDIDAT,
  ANSWER_VERSION_UPLOAD,
  buildAnswerFile,
  buildBeslut,
  buildUppladdatBeslut,
  bulkSvarInputSchema,
  candidatesOf,
  motpartRegelNyckel,
  multiKandidatEnabled,
  parseExport,
  svarInputSchema,
  uppladdatInputSchema,
  type Post,
} from '../lib/contract'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function posts(fx: typeof fixture = fixture): Post[] {
  const parsed = parseExport(clone(fx))
  if (!parsed.ok) throw new Error('fixture must parse')
  return parsed.export.sammanstallningar.flatMap((s) => s.posts)
}

const post = (id: string, fx?: typeof fixture) => posts(fx).find((p) => p.transaction_id === id)!

describe('parseExport', () => {
  it('reads the CLI wrapper at version 1.1', () => {
    const parsed = parseExport(clone(fixture))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.export.sammanstallningar).toHaveLength(2)
    expect(parsed.export.sammanstallningar[0].posts[0].konto_identitet).toBe('SEB Företagskonto 5609 11 241 10')
  })

  it('reads a single sammanstallning (the root schema) as a one-element export', () => {
    const parsed = parseExport(clone(fixture.sammanstallningar[0]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.export.sammanstallningar).toHaveLength(1)
    expect(parsed.export.export_version).toBe('1.1')
  })

  it.each([['1.0'], ['2.0'], ['0.9']])('refuses export version %s instead of guessing', (version) => {
    const raw = { ...clone(fixture), export_version: version }
    expect(parseExport(raw)).toEqual({ ok: false, code: 'UNSUPPORTED_VERSION', version })
  })

  it('accepts a newer minor version within the same major (new fields are additive)', () => {
    const raw = { ...clone(fixture), export_version: '1.5' }
    expect(parseExport(raw).ok).toBe(true)
  })

  it('refuses a file without a version', () => {
    const raw: Record<string, unknown> = clone(fixture)
    delete raw.export_version
    expect(parseExport(raw)).toEqual({ ok: false, code: 'UNSUPPORTED_VERSION', version: null })
  })

  it('refuses a wrapper whose inner sammanstallning carries another version', () => {
    const raw = clone(fixture)
    raw.sammanstallningar[1].export_version = '1.0'
    expect(parseExport(raw)).toEqual({ ok: false, code: 'UNSUPPORTED_VERSION', version: '1.0' })
  })

  it('refuses a 1.1 candidate without sha256', () => {
    const raw = clone(fixture) as unknown as {
      sammanstallningar: { posts: { kandidater: Record<string, unknown>[] }[] }[]
    }
    delete raw.sammanstallningar[0].posts[0].kandidater[0].sha256
    const parsed = parseExport(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.code).toBe('INVALID_EXPORT')
  })

  it('accepts forslag: null, as bertil writes it when it has no suggestion', () => {
    expect(post('tx-ocr-20260812').forslag).toBeNull()
  })

  it('reads a 1.4 export with new fields (reglering, leverantor_sokord)', () => {
    const parsed = parseExport(clone(fixture14))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.export.export_version).toBe('1.4')
    expect(parsed.export.sammanstallningar).toHaveLength(2)
    expect(parsed.export.sammanstallningar[0].posts).toHaveLength(3)
  })

  it('accepts export with unknown fields (leverantor_sokord on posts)', () => {
    const moankPost = post('tx-moank-20260821', fixture14)
    const googlePost = post('tx-google-20260803', fixture14)
    expect(moankPost.transaction_id).toBe('tx-moank-20260821')
    expect(googlePost.transaction_id).toBe('tx-google-20260803')
    // leverantor_sokord is in the fixture but not destructured into the Post type;
    // the fixture parses successfully despite the unknown field
  })

  it('rejects export with structural errors even if it has version 1.4', () => {
    const raw = clone(fixture14) as unknown as {
      sammanstallningar: { posts: { transaction_id: unknown }[] }[]
    }
    raw.sammanstallningar[0].posts[0].transaction_id = null
    const parsed = parseExport(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.code).toBe('INVALID_EXPORT')
  })
})

describe('candidatesOf', () => {
  it('offers tvetydiga_alternativ for ambiguous posts', () => {
    expect(candidatesOf(post('tx-google-20260803')).map((k) => k.filnamn)).toEqual([
      'google_workspace_juli.pdf',
      'google_workspace_augusti.pdf',
    ])
  })

  it('reads an optional belopp on a candidate, and leaves it undefined when bertil has not sent it (every export version to date)', () => {
    const p = post('tx-google-20260803')
    expect(candidatesOf(p).every((k) => k.belopp === undefined)).toBe(true)
    const raw = clone(fixture) as unknown as {
      sammanstallningar: { posts: { transaction_id: string; tvetydiga_alternativ: Record<string, unknown>[] }[] }[]
    }
    const rawPost = raw.sammanstallningar[0].posts.find((x) => x.transaction_id === 'tx-google-20260803')!
    rawPost.tvetydiga_alternativ[0].belopp = -1249
    const parsed = parseExport(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const reparsed = candidatesOf(parsed.export.sammanstallningar[0].posts.find((x) => x.transaction_id === 'tx-google-20260803')!)
    expect(reparsed[0].belopp).toBe(-1249)
  })
})

describe('svarInputSchema', () => {
  it('requires a settlement when the concerned company is known', () => {
    const r = svarInputSchema.safeParse({
      svarstyp: 'fel_bolag',
      transaction_id: 'tx',
      fel_bolag_mottagare: 'Villa Viola AB',
      till_bolag: 'Villa Viola',
      reglering: null,
    })
    expect(r.success).toBe(false)
  })

  it('allows no settlement when the company is unknown', () => {
    const r = svarInputSchema.safeParse({
      svarstyp: 'fel_bolag',
      transaction_id: 'tx',
      fel_bolag_mottagare: 'Villa Viola AB',
      till_bolag: null,
      reglering: null,
    })
    expect(r.success).toBe(true)
  })

  it('requires the invoice addressee', () => {
    const r = svarInputSchema.safeParse({
      svarstyp: 'fel_bolag',
      transaction_id: 'tx',
      fel_bolag_mottagare: '  ',
      till_bolag: null,
      reglering: null,
    })
    expect(r.success).toBe(false)
  })

  it('refuses a BAS account that is not four digits and unknown categories', () => {
    const base = {
      svarstyp: 'val_kandidat',
      transaction_id: 'tx',
      sha256: [],
      motpart: 'X',
      kategori: 'leverantor',
      bas_konto: '5420',
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    }
    expect(svarInputSchema.safeParse(base).success).toBe(true)
    expect(svarInputSchema.safeParse({ ...base, bas_konto: '542' }).success).toBe(false)
    expect(svarInputSchema.safeParse({ ...base, kategori: 'okand' }).success).toBe(false)
    expect(svarInputSchema.safeParse({ ...base, momstyp: 'moms_12' }).success).toBe(false)
  })

  it('refuses a single sha256 string: it must be an array, even for one document', () => {
    const base = {
      svarstyp: 'val_kandidat',
      transaction_id: 'tx',
      sha256: 'a'.repeat(64),
      motpart: 'X',
      kategori: 'leverantor',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    }
    expect(svarInputSchema.safeParse(base).success).toBe(false)
  })
})

describe('buildBeslut', () => {
  it('resolves the chosen file from the stored candidates, not from the browser', () => {
    const p = post('tx-google-20260803')
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: ['B1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90'],
      motpart: 'GOOGLE*WORKSPACE',
      kategori: 'leverantor',
      bas_konto: '5420',
      momstyp: 'eu_reverse_charge',
      begransa_bolag: true,
      begransa_belopp: false,
    }, 'test-answer-id')
    expect(result).toEqual({
      ok: true,
      reglering: null,
      beslut: {
        answer_id: 'test-answer-id',
        transaction_id: 'tx-google-20260803',
        svarstyp: 'val_kandidat',
        vald_kandidat: 'google_workspace_augusti.pdf',
        sha256: 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        kalla: 'gmail:bohed',
        vald_kandidater: [
          {
            filnamn: 'google_workspace_augusti.pdf',
            sha256: 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
            kalla: 'gmail:bohed',
          },
        ],
        motpart: 'GOOGLE*WORKSPACE',
        kategori: 'leverantor',
        bas_konto: '5420',
        momstyp: 'eu_reverse_charge',
        bolag: 'Tyrberg Group',
        bankkonto: null,
        belopp: null,
      },
    })
  })

  it('resolves every chosen document, in the order chosen, when the answer picks more than one (task: one payment, several löneunderlag)', () => {
    const p = post('tx-google-20260803')
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: [
        'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      ],
      motpart: 'GOOGLE*WORKSPACE',
      kategori: 'leverantor',
      bas_konto: '5420',
      momstyp: 'eu_reverse_charge',
      begransa_bolag: false,
      begransa_belopp: false,
    }, 'test-answer-id')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // vald_kandidat/sha256/kalla keep naming only the first chosen document, for a 1.4/1.5 reader.
    expect(result.beslut).toMatchObject({
      vald_kandidat: 'google_workspace_augusti.pdf',
      sha256: 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    })
    expect((result.beslut as { vald_kandidater: unknown[] }).vald_kandidater).toEqual([
      {
        filnamn: 'google_workspace_augusti.pdf',
        sha256: 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        kalla: 'gmail:bohed',
      },
      {
        filnamn: 'google_workspace_juli.pdf',
        sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        kalla: 'gmail:bohed',
      },
    ])
  })

  it('dedupes a hash chosen twice instead of fabricating a second document', () => {
    const p = post('tx-google-20260803')
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: [
        'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        'B1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90',
      ],
      motpart: 'GOOGLE*WORKSPACE',
      kategori: 'leverantor',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    }, 'test-answer-id')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.beslut as { vald_kandidater: unknown[] }).vald_kandidater).toHaveLength(1)
  })

  it('answers "none of them" with vald_kandidat null, no sha256, and an empty vald_kandidater (the CLI --svara case)', () => {
    const p = post('tx-ocr-20260812')
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: [],
      motpart: '100003645765',
      kategori: 'skatt',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: true,
    }, 'test-answer-id')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.beslut).toMatchObject({
      vald_kandidat: null,
      vald_kandidater: [],
      belopp: -3120,
      bolag: null,
      answer_id: 'test-answer-id',
    })
    expect(result.beslut).not.toHaveProperty('sha256')
  })

  it('refuses a hash that is not one of the post candidates', () => {
    const p = post('tx-google-20260803')
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: ['f'.repeat(64)],
      motpart: 'X',
      kategori: 'leverantor',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    }, 'test-answer-id')
    expect(result).toEqual({ ok: false, code: 'CANDIDATE_NOT_FOUND' })
  })

  it('refuses the whole answer when the second of two chosen hashes is not a candidate', () => {
    const p = post('tx-google-20260803')
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: ['b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', 'f'.repeat(64)],
      motpart: 'X',
      kategori: 'leverantor',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    }, 'test-answer-id')
    expect(result).toEqual({ ok: false, code: 'CANDIDATE_NOT_FOUND' })
  })

  it('refuses a candidate whose exported hash is malformed (bertil would reject it)', () => {
    const p = clone(post('tx-moank-20260821'))
    p.kandidater[0].sha256 = 'not-a-hash'
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: ['not-a-hash'],
      motpart: 'X',
      kategori: 'leverantor',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    }, 'test-answer-id')
    expect(result).toEqual({ ok: false, code: 'CANDIDATE_WITHOUT_HASH' })
  })

  it('stores the settlement in a fel_bolag beslut when company is known', () => {
    const p = post('tx-moank-20260821')
    const result = buildBeslut(p, {
      svarstyp: 'fel_bolag',
      transaction_id: p.transaction_id,
      fel_bolag_mottagare: 'Villa Viola AB',
      till_bolag: 'Villa Viola',
      reglering: 'mellanhavande',
    }, 'test-answer-id')
    expect(result).toEqual({
      ok: true,
      reglering: 'mellanhavande',
      beslut: {
        answer_id: 'test-answer-id',
        transaction_id: 'tx-moank-20260821',
        svarstyp: 'fel_bolag',
        fel_bolag_mottagare: 'Villa Viola AB',
        till_bolag: 'Villa Viola',
        reglering: 'mellanhavande',
      },
    })
  })

  it('builds osaker with nothing but id and type', () => {
    const p = post('tx-ocr-20260812')
    expect(buildBeslut(p, { svarstyp: 'osaker', transaction_id: p.transaction_id }, 'test-answer-id')).toEqual({
      ok: true,
      reglering: null,
      beslut: { answer_id: 'test-answer-id', transaction_id: 'tx-ocr-20260812', svarstyp: 'osaker' },
    })
  })
})

describe('buildAnswerFile', () => {
  it('writes the answer version with reglering support', () => {
    expect(ANSWER_VERSION).toBe('1.4')
    expect(buildAnswerFile([])).toEqual({ version: '1.4', beslut: [] })
  })

  it('keeps every file without an upload at 1.4, so a 1.4 reader is not refused', () => {
    const p = post('tx-ocr-20260812')
    const osaker = buildBeslut(p, { svarstyp: 'osaker', transaction_id: p.transaction_id }, 'a1')
    if (!osaker.ok) throw new Error('unreachable')
    expect(buildAnswerFile([osaker.beslut]).version).toBe('1.4')
  })

  it('writes 1.5 only to a file that holds an uppladdat_underlag', () => {
    const p = post('tx-ocr-20260812')
    const osaker = buildBeslut(p, { svarstyp: 'osaker', transaction_id: p.transaction_id }, 'a1')
    if (!osaker.ok) throw new Error('unreachable')
    const upload = buildUppladdatBeslut(
      p,
      {
        svarstyp: 'uppladdat_underlag',
        transaction_id: p.transaction_id,
        motpart: 'Google',
        kategori: 'leverantor',
        bas_konto: null,
        momstyp: null,
        begransa_bolag: false,
        begransa_belopp: false,
      },
      { id: 'doc-1', filnamn: 'kvitto.pdf', sha256: 'a'.repeat(64), mime_type: 'application/pdf', storage_path: 'c/doc-1.pdf' },
      'a2',
    )
    expect(ANSWER_VERSION_UPLOAD).toBe('1.5')
    expect(buildAnswerFile([osaker.beslut, upload]).version).toBe('1.5')
    expect(buildAnswerFile([upload]).version).toBe('1.5')
  })

  it('includes reglering in fel_bolag beslut', () => {
    const p = post('tx-moank-20260821')
    const result = buildBeslut(p, {
      svarstyp: 'fel_bolag',
      transaction_id: p.transaction_id,
      fel_bolag_mottagare: 'Villa Viola AB',
      till_bolag: 'Villa Viola',
      reglering: 'mellanhavande',
    }, 'test-answer-id')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.beslut).toEqual({
      answer_id: 'test-answer-id',
      transaction_id: 'tx-moank-20260821',
      svarstyp: 'fel_bolag',
      fel_bolag_mottagare: 'Villa Viola AB',
      till_bolag: 'Villa Viola',
      reglering: 'mellanhavande',
    })
  })

  it('omits reglering from fel_bolag when company is unknown', () => {
    const p = post('tx-moank-20260821')
    const result = buildBeslut(p, {
      svarstyp: 'fel_bolag',
      transaction_id: p.transaction_id,
      fel_bolag_mottagare: 'Villa Viola AB',
      till_bolag: null,
      reglering: null,
    }, 'test-answer-id')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.beslut).toEqual({
      answer_id: 'test-answer-id',
      transaction_id: 'tx-moank-20260821',
      svarstyp: 'fel_bolag',
      fel_bolag_mottagare: 'Villa Viola AB',
      till_bolag: null,
    })
    expect(result.beslut).not.toHaveProperty('reglering')
  })
})

describe('uppladdat_underlag', () => {
  const fields = {
    svarstyp: 'uppladdat_underlag',
    transaction_id: 'tx-google-20260803',
    motpart: 'Google',
    kategori: 'leverantor',
    bas_konto: '6540',
    momstyp: 'eu_reverse_charge',
    begransa_bolag: true,
    begransa_belopp: false,
  }
  const dokument = {
    id: 'doc-1',
    filnamn: 'kvitto.pdf',
    sha256: 'A'.repeat(64),
    mime_type: 'application/pdf',
    storage_path: 'documents/c-1/u-1/1_kvitto.pdf',
  }

  it('is not accepted as a JSON answer: a file-less answer must never claim one', () => {
    expect(svarInputSchema.safeParse(fields).success).toBe(false)
  })

  it('validates the classification like val_kandidat', () => {
    expect(uppladdatInputSchema.safeParse(fields).success).toBe(true)
    expect(uppladdatInputSchema.safeParse({ ...fields, motpart: '  ' }).success).toBe(false)
    expect(uppladdatInputSchema.safeParse({ ...fields, kategori: 'okand' }).success).toBe(false)
    expect(uppladdatInputSchema.safeParse({ ...fields, bas_konto: 6540 }).success).toBe(false)
  })

  it('carries the stored document instead of a choice among candidates', () => {
    const p = posts(fixture14 as typeof fixture)[0]
    const input = uppladdatInputSchema.parse({ ...fields, transaction_id: p.transaction_id })
    const beslut = buildUppladdatBeslut(p, input, dokument, 'answer-1')
    expect(beslut).toEqual({
      answer_id: 'answer-1',
      transaction_id: p.transaction_id,
      svarstyp: 'uppladdat_underlag',
      dokument_id: 'doc-1',
      filnamn: 'kvitto.pdf',
      // Lower-cased: bertil compares hashes case-insensitively but stores them lower-case.
      sha256: 'a'.repeat(64),
      mime_type: 'application/pdf',
      storage_path: 'documents/c-1/u-1/1_kvitto.pdf',
      kalla: 'gnubok_uppladdning',
      motpart: 'Google',
      kategori: 'leverantor',
      bas_konto: '6540',
      momstyp: 'eu_reverse_charge',
      bolag: p.bolag,
      bankkonto: null,
      belopp: null,
    })
    expect(beslut).not.toHaveProperty('vald_kandidat')
  })

  it('restricts the learned rule to the amount only when asked', () => {
    const p = posts(fixture14 as typeof fixture)[0]
    const input = uppladdatInputSchema.parse({ ...fields, begransa_bolag: false, begransa_belopp: true })
    const beslut = buildUppladdatBeslut(p, input, dokument, 'answer-1')
    expect(beslut.bolag).toBeNull()
    expect(beslut.belopp).toBe(p.belopp)
  })
})

describe('levererar_sjalv: "I will deliver the document myself"', () => {
  const p = posts(fixture14 as typeof fixture)[0]

  it('validates as a svar input', () => {
    const input = { svarstyp: 'levererar_sjalv' as const, transaction_id: p.transaction_id, motpart: 'HI3G' }
    expect(svarInputSchema.safeParse(input).success).toBe(true)
  })

  it('requires motpart to be non-empty', () => {
    expect(svarInputSchema.safeParse({ svarstyp: 'levererar_sjalv', transaction_id: p.transaction_id, motpart: '  ' }).success).toBe(false)
  })

  it('builds a beslut with the vendor name and null underlag_hittat_at', () => {
    const input = svarInputSchema.parse({ svarstyp: 'levererar_sjalv', transaction_id: p.transaction_id, motpart: 'HI3G' })
    const built = buildBeslut(p, input, 'answer-1')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.beslut).toEqual({
      answer_id: 'answer-1',
      transaction_id: p.transaction_id,
      svarstyp: 'levererar_sjalv',
      motpart: 'HI3G',
      underlag_hittat_at: null,
    })
  })
})

describe('bulkSvarInputSchema', () => {
  const p = posts(fixture14 as typeof fixture)[0]
  const valid = { svarstyp: 'levererar_sjalv', transaction_id: p.transaction_id, motpart: 'HI3G', bekrafta_antal: 3 }

  it('takes the anchor post, the motpart and the promised count, and nothing that names other posts', () => {
    const parsed = bulkSvarInputSchema.parse({ ...valid, transaction_ids: ['a', 'b'] })
    expect(parsed).toEqual(valid)
  })

  it.each([
    ['osaker', { ...valid, svarstyp: 'osaker' }],
    ['val_kandidat', { ...valid, svarstyp: 'val_kandidat' }],
    ['fel_bolag', { ...valid, svarstyp: 'fel_bolag' }],
    ['a zero count', { ...valid, bekrafta_antal: 0 }],
    ['a fractional count', { ...valid, bekrafta_antal: 1.5 }],
    ['a missing count', { svarstyp: 'levererar_sjalv', transaction_id: p.transaction_id, motpart: 'HI3G' }],
    ['a blank motpart', { ...valid, motpart: '  ' }],
    ['a missing anchor', { ...valid, transaction_id: '' }],
  ])('rejects %s', (_label, body) => {
    expect(bulkSvarInputSchema.safeParse(body).success).toBe(false)
  })
})

describe('answer file version', () => {
  const osaker = { answer_id: 'a', transaction_id: 't1', svarstyp: 'osaker' } as const
  const sjalv = { answer_id: 'b', transaction_id: 't2', svarstyp: 'levererar_sjalv', motpart: 'HI3G', underlag_hittat_at: null } as const

  it('stays 1.4 for a file bertil already reads', () => {
    expect(buildAnswerFile([osaker]).version).toBe('1.4')
  })

  it('is 1.5 for a file that holds a levererar_sjalv answer, the only file a 1.4 reader cannot take', () => {
    expect(buildAnswerFile([osaker, sjalv]).version).toBe('1.5')
    expect(buildAnswerFile([sjalv]).version).toBe(ANSWER_VERSION_UPLOAD)
  })

  it('stays 1.4 for a val_kandidat with a single chosen document', () => {
    const p = post('tx-google-20260803')
    const single = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: ['b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'],
      motpart: 'GOOGLE*WORKSPACE',
      kategori: 'leverantor',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    }, 'a1')
    if (!single.ok) throw new Error('unreachable')
    expect(buildAnswerFile([single.beslut]).version).toBe('1.4')
  })

  it('is 1.6 for a file where a val_kandidat beslut chose more than one document, the only file a 1.4/1.5 reader cannot take', () => {
    const p = post('tx-google-20260803')
    const multi = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: [
        'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      ],
      motpart: 'GOOGLE*WORKSPACE',
      kategori: 'leverantor',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    }, 'a1')
    if (!multi.ok) throw new Error('unreachable')
    expect(buildAnswerFile([osaker, multi.beslut]).version).toBe('1.6')
    expect(buildAnswerFile([multi.beslut]).version).toBe(ANSWER_VERSION_MULTI_KANDIDAT)
  })

  it('does not throw for a val_kandidat beslut stored before vald_kandidater existed', () => {
    const preDeploy = {
      answer_id: 'a1',
      transaction_id: 'tx-google-20260803',
      svarstyp: 'val_kandidat',
      vald_kandidat: 'kvitto.pdf',
      sha256: 'a'.repeat(64),
      kalla: 'inlard_regel',
      motpart: 'GOOGLE*WORKSPACE',
      kategori: 'leverantor',
      bas_konto: null,
      momstyp: null,
      bolag: null,
      bankkonto: null,
      belopp: null,
    } as const
    expect(() => buildAnswerFile([preDeploy])).not.toThrow()
    expect(buildAnswerFile([preDeploy]).version).toBe('1.4')
  })
})

describe('multiKandidatEnabled', () => {
  const ORIGINAL = process.env.UNDERLAGSJAKT_MULTI_KANDIDAT_ENABLED

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.UNDERLAGSJAKT_MULTI_KANDIDAT_ENABLED
    else process.env.UNDERLAGSJAKT_MULTI_KANDIDAT_ENABLED = ORIGINAL
  })

  it('is off unless the env var is exactly "true"', () => {
    delete process.env.UNDERLAGSJAKT_MULTI_KANDIDAT_ENABLED
    expect(multiKandidatEnabled()).toBe(false)
    process.env.UNDERLAGSJAKT_MULTI_KANDIDAT_ENABLED = 'yes'
    expect(multiKandidatEnabled()).toBe(false)
    process.env.UNDERLAGSJAKT_MULTI_KANDIDAT_ENABLED = 'true'
    expect(multiKandidatEnabled()).toBe(true)
  })
})

describe('motpartRegelNyckel', () => {
  it('is the existing rule key with bolag, bankkonto and belopp all empty', () => {
    expect(motpartRegelNyckel('HI3G')).toBe('hi3g|bolag=|bankkonto=|belopp=')
  })

  it('ignores case, surrounding and repeated spaces, but nothing else', () => {
    expect(motpartRegelNyckel('  Hi3G   Sweden ')).toBe(motpartRegelNyckel('HI3G SWEDEN'))
    expect(motpartRegelNyckel('HI3G')).not.toBe(motpartRegelNyckel('HI3G SWEDEN'))
  })
})

describe('underlag_hittat in an export', () => {
  it('is empty when the export does not carry the list, at any version', () => {
    for (const fx of [fixture, fixture14]) {
      const parsed = parseExport(clone(fx))
      expect(parsed.ok && parsed.underlag_hittat).toEqual([])
    }
  })

  it('is read from the root, whatever the export_version says', () => {
    const raw = { ...clone(fixture14), export_version: '1.5', underlag_hittat: ['tx-a', 'tx-b'] }
    const parsed = parseExport(raw)
    expect(parsed.ok && parsed.underlag_hittat).toEqual(['tx-a', 'tx-b'])
  })

  it('also collects it from a sammanstallning, without duplicates', () => {
    const raw = clone(fixture14) as unknown as { underlag_hittat?: string[]; sammanstallningar: { underlag_hittat?: string[] }[] }
    raw.underlag_hittat = ['tx-a']
    raw.sammanstallningar[0].underlag_hittat = ['tx-a', 'tx-c']
    const parsed = parseExport(raw)
    expect(parsed.ok && parsed.underlag_hittat).toEqual(['tx-a', 'tx-c'])
  })

  it('refuses a list that is not a list of ids', () => {
    const parsed = parseExport({ ...clone(fixture14), underlag_hittat: [1, 2] })
    expect(parsed.ok).toBe(false)
  })
})
