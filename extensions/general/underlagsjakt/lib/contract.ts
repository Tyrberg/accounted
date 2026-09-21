/**
 * The bertil <-> Accounted underlagsjakt contract.
 *
 * Source of truth: `docs/underlagsjakt-export-schema.md` in the bertil repo
 * (merged in bertil#179). This file mirrors that document and nothing else:
 * every field here is named there. When the contract version moves, the
 * version lists below are the only place that decides whether we read it.
 *
 * Transport, as bertil implements it:
 *   export: `python -m underlagsjakt --json` prints a wrapper
 *           `{ export_version, generated_at, sammanstallningar: [...] }`
 *           (one sammanstallning per bolag, the root schema in the doc).
 *   answer: `python -m underlagsjakt --mottak-svar <file>` reads
 *           `{ version, beslut: [...] }`.
 */
import { z } from 'zod'
import { accountNumberSchema } from '@/lib/invariants/zod'

/**
 * Version range this extension reads. Only the major component is bounded on
 * both ends: a minor bump within a supported major adds optional fields only
 * (see "Forward Compatibility" in the schema doc), so it is accepted even
 * before this file has ever seen it. A different major is refused outright.
 */
export const MIN_SUPPORTED_EXPORT_VERSION = '1.1'
export const MAX_SUPPORTED_EXPORT_VERSION = '1.4'
/** Export versions this extension has been built and tested against, for error messages. */
export const SUPPORTED_EXPORT_VERSIONS = ['1.1', '1.2', '1.3', '1.4'] as const
/**
 * Answer version this extension writes. 1.4 adds reglering to fel_bolag beslut only.
 * A file with no upload in it stays 1.4, so a reader that predates 1.5 keeps
 * ingesting every answer it always did.
 */
export const ANSWER_VERSION = '1.4'
/**
 * 1.5 adds the `uppladdat_underlag` and `levererar_sjalv` svarstyper. Written
 * only to a file that actually holds one of them: that is the only file a 1.4
 * reader cannot understand. Both types are also switched off (see
 * `leverarSjalvEnabled` and the upload flag) until bertil reads 1.5, so a
 * 1.5 file is never produced before then.
 */
export const ANSWER_VERSION_UPLOAD = '1.5'

/**
 * Whether the `levererar_sjalv` answer type is available: the option is hidden
 * and both `POST /svar` and `POST /svar/bulk` answer 403 until
 * UNDERLAGSJAKT_LEVERERAR_SJALV_ENABLED=true, which is set only once bertil's
 * mottak_svar_fran_ui reads answer version 1.5 and the type, and its export
 * carries the optional `underlag_hittat` list.
 */
export function leverarSjalvEnabled(): boolean {
  return process.env.UNDERLAGSJAKT_LEVERERAR_SJALV_ENABLED === 'true'
}

/** `SVARSKATEGORIER` in bertil. */
export const KATEGORIER = [
  'leverantor',
  'utlagg',
  'lon',
  'intern_overforing',
  'lan',
  'ranta',
  'skatt',
  'bankavgift',
] as const
export type Kategori = (typeof KATEGORIER)[number]

/** `MOMSTYPER` in bertil. */
export const MOMSTYPER = ['svensk_25', 'eu_reverse_charge', 'utland', 'representation'] as const
export type Momstyp = (typeof MOMSTYPER)[number]

/**
 * How a wrong-company payment should be settled. Mattias decision 2026-09-17.
 * Added to export in 1.2 (bertil#180), included in answer schema from 1.4.
 */
export const REGLERINGAR = ['vidarefakturera', 'mellanhavande'] as const
export type Reglering = (typeof REGLERINGAR)[number]

/**
 * What a person actually holds: a PDF or a photo of the receipt. HEIC/HEIF
 * because that is what an iPhone produces by default.
 */
export const UNDERLAG_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const

/** `kalla` on an uploaded underlag beslut: where the document came from, in bertil's vocabulary. */
export const UPPLADDAT_KALLA = 'gnubok_uppladdning'

export const POST_KATEGORIER = ['behover_mattias', 'tvetydig', 'fel_bolag'] as const

const SHA256_RE = /^[0-9a-f]{64}$/i

export function isValidSha256(value: string | null | undefined): value is string {
  return typeof value === 'string' && SHA256_RE.test(value)
}

const kandidatSchema = z
  .object({
    filnamn: z.string(),
    kalla: z.string(),
    datum: z.string().nullable(),
    bevisgrund: z.string(),
    sha256: z.string(),
  })
  .passthrough()
export type Kandidat = z.infer<typeof kandidatSchema>

const postSchema = z
  .object({
    bolag: z.string(),
    period: z.string(),
    transaction_id: z.string().min(1),
    datum: z.string(),
    belopp: z.number(),
    valuta: z.string(),
    motpart: z.string(),
    konto_identitet: z.string(),
    typ: z.string(),
    saldo: z.number().nullable(),
    kategori: z.enum(POST_KATEGORIER),
    // The doc shows an object; bertil's exporter writes null when foresla() had nothing.
    forslag: z
      .object({
        kategori: z.string(),
        varfor: z.string(),
        bas_konto: z.string().nullable(),
        momstyp: z.string().nullable(),
      })
      .passthrough()
      .nullable(),
    kandidater: z.array(kandidatSchema),
    tvetydiga_alternativ: z.array(kandidatSchema),
    mottagare: z.string().nullable(),
  })
  .passthrough()
export type Post = z.infer<typeof postSchema>

const sammanfattningSchema = z
  .object({
    totalt: z.number(),
    med_underlag: z.number(),
    hittad_i_mejl: z.number(),
    sjalvforklarande: z.number(),
    inlard_regel: z.number(),
    behover_mattias: z.number(),
    tvetydig: z.number(),
    fel_bolag: z.number(),
    uppskjuten: z.number(),
    lost_svar: z.number(),
  })
  .passthrough()

/**
 * Optional list of transaction_ids whose promised (`levererar_sjalv`) document
 * bertil has since found on the usual place. Deliberately NOT tied to an
 * export_version: it is optional in every supported version and its presence
 * is the signal, so it cannot collide with what a given version number
 * already means in bertil (1.5 carries the root `information` field).
 */
const underlagHittatSchema = z.array(z.string().min(1)).optional()

const sammanstallningSchema = z
  .object({
    export_version: z.string(),
    bolag: z.string(),
    period: z.string(),
    generated_at: z.string(),
    sammanfattning: sammanfattningSchema,
    posts: z.array(postSchema),
    underlag_hittat: underlagHittatSchema,
  })
  .passthrough()
export type Sammanstallning = z.infer<typeof sammanstallningSchema>

const wrapperSchema = z
  .object({
    export_version: z.string(),
    generated_at: z.string(),
    sammanstallningar: z.array(sammanstallningSchema),
    underlag_hittat: underlagHittatSchema,
  })
  .passthrough()

export interface ParsedExport {
  export_version: string
  generated_at: string
  sammanstallningar: Sammanstallning[]
}

export type ParseExportResult =
  | { ok: true; export: ParsedExport; underlag_hittat: string[] }
  | { ok: false; code: 'UNSUPPORTED_VERSION'; version: string | null }
  | { ok: false; code: 'INVALID_EXPORT'; issues: string[] }

function readVersion(raw: unknown): string | null {
  if (raw && typeof raw === 'object' && 'export_version' in raw) {
    const v = (raw as { export_version: unknown }).export_version
    return typeof v === 'string' ? v : null
  }
  return null
}

function isSupported(version: string | null): boolean {
  if (!version) return false
  const [minMajor, minMinor] = MIN_SUPPORTED_EXPORT_VERSION.split('.').map((x) => parseInt(x, 10))
  const [maxMajor] = MAX_SUPPORTED_EXPORT_VERSION.split('.').map((x) => parseInt(x, 10))
  const [vMajor, vMinor] = version.split('.').map((x) => parseInt(x, 10))
  if (!Number.isFinite(vMajor) || !Number.isFinite(vMinor)) return false
  if (vMajor < minMajor || vMajor > maxMajor) return false
  if (vMajor === minMajor && vMinor < minMinor) return false
  return true
}

/**
 * Parse what bertil exported: the CLI wrapper, or a single sammanstallning
 * (the root schema in the doc). The version is checked before the shape, and
 * on every sammanstallning, so a mixed or unknown file is refused outright.
 */
export function parseExport(raw: unknown): ParseExportResult {
  const version = readVersion(raw)
  if (!isSupported(version)) return { ok: false, code: 'UNSUPPORTED_VERSION', version }

  const isWrapper = !!raw && typeof raw === 'object' && 'sammanstallningar' in raw
  if (isWrapper) {
    const inner = (raw as { sammanstallningar: unknown }).sammanstallningar
    if (Array.isArray(inner)) {
      for (const s of inner) {
        const v = readVersion(s)
        if (!isSupported(v)) return { ok: false, code: 'UNSUPPORTED_VERSION', version: v }
      }
    }
    const parsed = wrapperSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, code: 'INVALID_EXPORT', issues: formatIssues(parsed.error) }
    return { ok: true, export: parsed.data, underlag_hittat: collectUnderlagHittat(parsed.data) }
  }

  const parsed = sammanstallningSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, code: 'INVALID_EXPORT', issues: formatIssues(parsed.error) }
  return {
    ok: true,
    export: {
      export_version: parsed.data.export_version,
      generated_at: parsed.data.generated_at,
      sammanstallningar: [parsed.data],
    },
    underlag_hittat: collectUnderlagHittat({ sammanstallningar: [parsed.data] }),
  }
}

/** Every `underlag_hittat` id in a wrapper, at the root or on a sammanstallning, without duplicates. */
function collectUnderlagHittat(exp: {
  underlag_hittat?: string[]
  sammanstallningar: { underlag_hittat?: string[] }[]
}): string[] {
  const ids = [...(exp.underlag_hittat ?? []), ...exp.sammanstallningar.flatMap((s) => s.underlag_hittat ?? [])]
  return [...new Set(ids)]
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(rot)'}: ${i.message}`)
}

/**
 * The candidates a post offers, in bertil's order (bertil already ranked
 * them). bertil fills `tvetydiga_alternativ` for tvetydig posts and
 * `kandidater` for the rest, so the two lists never overlap.
 */
export function candidatesOf(post: Post): Kandidat[] {
  return [...post.kandidater, ...post.tvetydiga_alternativ]
}

// ── Answers ──────────────────────────────────────────────────

/**
 * bertil's learned-rule key for a motpart with no bolag, bankkonto or belopp
 * restriction: `motpart|bolag=|bankkonto=|belopp=`. A `levererar_sjalv` bulk
 * reuses exactly this key (all three restrictions empty) to decide which posts
 * it covers, rather than inventing a second matching rule. The motpart is
 * compared as exact normalized text: NFKC, trimmed, single-spaced, lower-cased.
 */
export function motpartRegelNyckel(motpart: string): string {
  const normalized = motpart.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
  return `${normalized}|bolag=|bankkonto=|belopp=`
}

/** One entry in `beslut`, as the answer schema lists it (1.4 includes reglering in fel_bolag only). */
export type Beslut =
  | {
      answer_id: string
      transaction_id: string
      svarstyp: 'val_kandidat'
      vald_kandidat: string | null
      sha256?: string
      kalla?: string
      motpart: string
      kategori: Kategori
      bas_konto: string | null
      momstyp: Momstyp | null
      bolag: string | null
      bankkonto: string | null
      belopp: number | null
    }
  | {
      answer_id: string
      transaction_id: string
      svarstyp: 'fel_bolag'
      fel_bolag_mottagare: string
      till_bolag: string | null
      reglering?: Reglering | null
    }
  | {
      answer_id: string
      transaction_id: string
      svarstyp: 'uppladdat_underlag'
      /** The stored document (document_attachments.id in Accounted). */
      dokument_id: string
      filnamn: string
      /** sha256 of the stored bytes, computed server-side: the same hash bertil uses for candidates. */
      sha256: string
      mime_type: string | null
      /** Key in Accounted's `documents` storage bucket. */
      storage_path: string
      kalla: typeof UPPLADDAT_KALLA
      motpart: string
      kategori: Kategori
      bas_konto: string | null
      momstyp: Momstyp | null
      bolag: string | null
      bankkonto: string | null
      belopp: number | null
    }
  | {
      answer_id: string
      transaction_id: string
      svarstyp: 'levererar_sjalv'
      motpart: string
      /** ISO timestamp when bertil confirmed the document was found. Null while waiting. */
      underlag_hittat_at: string | null
    }
  | { answer_id: string; transaction_id: string; svarstyp: 'osaker' }

/**
 * "The document exists and I will leave it in the usual place." The opposite of
 * `osaker` and of "no underlag needed": it promises a document, so the post is
 * kept as waiting until bertil reports it found.
 */
const levererarSjalvSchema = z.object({
  svarstyp: z.literal('levererar_sjalv'),
  transaction_id: z.string().min(1),
  motpart: z.string().trim().min(1),
})

/** What the workspace sends for one post. Validated against the stored post before it becomes a Beslut. */
export const svarInputSchema = z.discriminatedUnion('svarstyp', [
  z.object({
    svarstyp: z.literal('val_kandidat'),
    transaction_id: z.string().min(1),
    /** sha256 of the chosen candidate, or null for "none of them". */
    sha256: z.string().nullable(),
    motpart: z.string().trim().min(1),
    kategori: z.enum(KATEGORIER),
    bas_konto: accountNumberSchema.nullable(),
    momstyp: z.enum(MOMSTYPER).nullable(),
    /** Restrict the learned rule to the post's bolag. */
    begransa_bolag: z.boolean(),
    /** Restrict the learned rule to the post's recurring amount. */
    begransa_belopp: z.boolean(),
  }),
  z
    .object({
      svarstyp: z.literal('fel_bolag'),
      transaction_id: z.string().min(1),
      fel_bolag_mottagare: z.string().trim().min(1),
      till_bolag: z.string().trim().min(1).nullable(),
      reglering: z.enum(REGLERINGAR).nullable(),
    })
    .refine((v) => v.till_bolag === null || v.reglering !== null, {
      message: 'reglering krävs när till_bolag är satt',
      path: ['reglering'],
    }),
  levererarSjalvSchema,
  z.object({
    svarstyp: z.literal('osaker'),
    transaction_id: z.string().min(1),
  }),
])
export type SvarInput = z.infer<typeof svarInputSchema>

/**
 * "I have the document": the classification half of an uploaded-underlag
 * answer. The file itself travels as multipart alongside these fields (see
 * POST /svar/underlag), so this is deliberately NOT part of `svarInputSchema`:
 * a JSON answer without a file must never be able to claim one.
 */
export const uppladdatInputSchema = z.object({
  svarstyp: z.literal('uppladdat_underlag'),
  transaction_id: z.string().min(1),
  motpart: z.string().trim().min(1),
  kategori: z.enum(KATEGORIER),
  bas_konto: accountNumberSchema.nullable(),
  momstyp: z.enum(MOMSTYPER).nullable(),
  begransa_bolag: z.boolean(),
  begransa_belopp: z.boolean(),
})
export type UppladdatInput = z.infer<typeof uppladdatInputSchema>

/** The stored document an uploaded-underlag answer points at. */
export interface UppladdatDokument {
  id: string
  filnamn: string
  sha256: string
  mime_type: string | null
  storage_path: string
}

export function buildUppladdatBeslut(
  post: Post,
  input: UppladdatInput,
  dokument: UppladdatDokument,
  answerId: string,
): Extract<Beslut, { svarstyp: 'uppladdat_underlag' }> {
  return {
    answer_id: answerId,
    transaction_id: post.transaction_id,
    svarstyp: 'uppladdat_underlag',
    dokument_id: dokument.id,
    filnamn: dokument.filnamn,
    sha256: dokument.sha256.toLowerCase(),
    mime_type: dokument.mime_type,
    storage_path: dokument.storage_path,
    kalla: UPPLADDAT_KALLA,
    motpart: input.motpart,
    kategori: input.kategori,
    bas_konto: input.bas_konto,
    momstyp: input.momstyp,
    bolag: input.begransa_bolag ? post.bolag : null,
    bankkonto: null,
    belopp: input.begransa_belopp ? post.belopp : null,
  }
}

export type BuildBeslutResult =
  | { ok: true; beslut: Beslut; reglering: Reglering | null }
  | { ok: false; code: 'CANDIDATE_NOT_FOUND' | 'CANDIDATE_WITHOUT_HASH' }

/**
 * Turn a validated input into the contract's `beslut`. The chosen file is
 * resolved from the stored post by hash, so filnamn/kalla/sha256 always come
 * from what bertil offered, never from the browser.
 */
export function buildBeslut(
  post: Post,
  input: SvarInput,
  answerId: string,
): BuildBeslutResult {
  const transaction_id = post.transaction_id
  if (input.svarstyp === 'osaker') {
    return {
      ok: true,
      beslut: { answer_id: answerId, transaction_id, svarstyp: 'osaker' },
      reglering: null,
    }
  }
  if (input.svarstyp === 'levererar_sjalv') {
    return {
      ok: true,
      beslut: {
        answer_id: answerId,
        transaction_id,
        svarstyp: 'levererar_sjalv',
        motpart: input.motpart,
        underlag_hittat_at: null,
      },
      reglering: null,
    }
  }
  const regleringSvar = input.svarstyp === 'fel_bolag' && input.till_bolag !== null ? input.reglering : null
  if (input.svarstyp === 'fel_bolag') {
    return {
      ok: true,
      beslut: {
        answer_id: answerId,
        transaction_id,
        svarstyp: 'fel_bolag',
        fel_bolag_mottagare: input.fel_bolag_mottagare,
        till_bolag: input.till_bolag,
        ...(regleringSvar !== null ? { reglering: regleringSvar } : {}),
      },
      reglering: regleringSvar,
    }
  }

  let chosen: Kandidat | null = null
  if (input.sha256 !== null) {
    const wanted = input.sha256.toLowerCase()
    chosen = candidatesOf(post).find((k) => k.sha256.toLowerCase() === wanted) ?? null
    if (!chosen) return { ok: false, code: 'CANDIDATE_NOT_FOUND' }
    if (!isValidSha256(chosen.sha256)) return { ok: false, code: 'CANDIDATE_WITHOUT_HASH' }
  }

  return {
    ok: true,
    beslut: {
      answer_id: answerId,
      transaction_id,
      svarstyp: 'val_kandidat',
      vald_kandidat: chosen ? chosen.filnamn : null,
      ...(chosen ? { sha256: chosen.sha256.toLowerCase(), kalla: chosen.kalla } : {}),
      motpart: input.motpart,
      kategori: input.kategori,
      bas_konto: input.bas_konto,
      momstyp: input.momstyp,
      bolag: input.begransa_bolag ? post.bolag : null,
      bankkonto: null,
      belopp: input.begransa_belopp ? post.belopp : null,
    },
    reglering: null,
  }
}

/**
 * "The same for every payment from this motpart": the answer for one anchor
 * post plus the number of posts the browser counted. Only `levererar_sjalv` can
 * be bulked. The server derives the affected posts itself with `bulkTargets` and
 * refuses (409 COUNT_CHANGED) when its count differs from `bekrafta_antal`, so
 * a client can never name posts the rule does not cover.
 */
export const bulkSvarInputSchema = levererarSjalvSchema.extend({
  bekrafta_antal: z.number().int().min(1),
})
export type BulkSvarInput = z.infer<typeof bulkSvarInputSchema>

export function buildAnswerFile(
  beslut: Beslut[],
): { version: string; beslut: Beslut[] } {
  const needsNewVersion = beslut.some((b) => b.svarstyp === 'uppladdat_underlag' || b.svarstyp === 'levererar_sjalv')
  return { version: needsNewVersion ? ANSWER_VERSION_UPLOAD : ANSWER_VERSION, beslut }
}
