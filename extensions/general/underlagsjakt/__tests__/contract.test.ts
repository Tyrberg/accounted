/**
 * The contract mirror. The fixture is generated from bertil's
 * docs/underlagsjakt-export-schema.md (version 1.1), with the MOANK/Avizion
 * wrong-company case from Mattias's decision 2026-09-17.
 */
import { describe, it, expect } from 'vitest'
import fixture from './fixtures/export-1.1.json'
import fixture14 from './fixtures/export-1.4.json'
import {
  ANSWER_VERSION,
  buildAnswerFile,
  buildBeslut,
  candidatesOf,
  parseExport,
  svarInputSchema,
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

  it('ignores unknown fields in 1.4 posts (leverantor_sokord, reglering)', () => {
    const moankPost = post('tx-moank-20260821', fixture14)
    const googlePost = post('tx-google-20260803', fixture14)
    expect(moankPost.transaction_id).toBe('tx-moank-20260821')
    expect(googlePost.transaction_id).toBe('tx-google-20260803')
  })
})

describe('candidatesOf', () => {
  it('offers tvetydiga_alternativ for ambiguous posts', () => {
    expect(candidatesOf(post('tx-google-20260803')).map((k) => k.filnamn)).toEqual([
      'google_workspace_juli.pdf',
      'google_workspace_augusti.pdf',
    ])
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
      sha256: null,
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
})

describe('buildBeslut', () => {
  it('resolves the chosen file from the stored candidates, not from the browser', () => {
    const p = post('tx-google-20260803')
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: 'B1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90',
      motpart: 'GOOGLE*WORKSPACE',
      kategori: 'leverantor',
      bas_konto: '5420',
      momstyp: 'eu_reverse_charge',
      begransa_bolag: true,
      begransa_belopp: false,
    })
    expect(result).toEqual({
      ok: true,
      reglering: null,
      beslut: {
        transaction_id: 'tx-google-20260803',
        svarstyp: 'val_kandidat',
        vald_kandidat: 'google_workspace_augusti.pdf',
        sha256: 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        kalla: 'gmail:bohed',
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

  it('answers "none of them" with vald_kandidat null and no sha256 (the CLI --svara case)', () => {
    const p = post('tx-ocr-20260812')
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: null,
      motpart: '100003645765',
      kategori: 'skatt',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.beslut).toMatchObject({ vald_kandidat: null, belopp: -3120, bolag: null })
    expect(result.beslut).not.toHaveProperty('sha256')
  })

  it('refuses a hash that is not one of the post candidates', () => {
    const p = post('tx-google-20260803')
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: 'f'.repeat(64),
      motpart: 'X',
      kategori: 'leverantor',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    })
    expect(result).toEqual({ ok: false, code: 'CANDIDATE_NOT_FOUND' })
  })

  it('refuses a candidate whose exported hash is malformed (bertil would reject it)', () => {
    const p = clone(post('tx-moank-20260821'))
    p.kandidater[0].sha256 = 'not-a-hash'
    const result = buildBeslut(p, {
      svarstyp: 'val_kandidat',
      transaction_id: p.transaction_id,
      sha256: 'not-a-hash',
      motpart: 'X',
      kategori: 'leverantor',
      bas_konto: null,
      momstyp: null,
      begransa_bolag: false,
      begransa_belopp: false,
    })
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
    })
    expect(result).toEqual({
      ok: true,
      reglering: 'mellanhavande',
      beslut: {
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
    expect(buildBeslut(p, { svarstyp: 'osaker', transaction_id: p.transaction_id })).toEqual({
      ok: true,
      reglering: null,
      beslut: { transaction_id: 'tx-ocr-20260812', svarstyp: 'osaker' },
    })
  })
})

describe('buildAnswerFile', () => {
  it('writes the answer version with reglering support', () => {
    expect(ANSWER_VERSION).toBe('1.4')
    expect(buildAnswerFile([])).toEqual({ version: '1.4', beslut: [] })
  })

  it('includes reglering in fel_bolag beslut', () => {
    const p = post('tx-moank-20260821')
    const result = buildBeslut(p, {
      svarstyp: 'fel_bolag',
      transaction_id: p.transaction_id,
      fel_bolag_mottagare: 'Villa Viola AB',
      till_bolag: 'Villa Viola',
      reglering: 'mellanhavande',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.beslut).toEqual({
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
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.beslut).toEqual({
      transaction_id: 'tx-moank-20260821',
      svarstyp: 'fel_bolag',
      fel_bolag_mottagare: 'Villa Viola AB',
      till_bolag: null,
    })
    expect(result.beslut).not.toHaveProperty('reglering')
  })
})
