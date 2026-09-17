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

/** Export versions this extension reads. Anything else is refused, never guessed at. */
export const SUPPORTED_EXPORT_VERSIONS = ['1.1'] as const
/** Answer version this extension writes. 1.1 is the first that can carry a file choice (sha256). */
export const ANSWER_VERSION = '1.1'

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
 * NOT part of contract 1.1: bertil#180 adds it under a new contract version.
 * Until this extension is taught that version, the value is kept here and
 * shown in the re-billing view, but left out of the answer file.
 */
export const REGLERINGAR = ['vidarefakturera', 'mellanhavande'] as const
export type Reglering = (typeof REGLERINGAR)[number]

export const POST_KATEGORIER = ['behover_mattias', 'tvetydig', 'fel_bolag'] as const

const SHA256_RE = /^[0-9a-f]{64}$/i

export function isValidSha256(value: string | null | undefined): value is string {
  return typeof value === 'string' && SHA256_RE.test(value)
}

const kandidatSchema = z.object({
  filnamn: z.string(),
  kalla: z.string(),
  datum: z.string().nullable(),
  bevisgrund: z.string(),
  sha256: z.string(),
})
export type Kandidat = z.infer<typeof kandidatSchema>

const postSchema = z.object({
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
    .nullable(),
  kandidater: z.array(kandidatSchema),
  tvetydiga_alternativ: z.array(kandidatSchema),
  mottagare: z.string().nullable(),
})
export type Post = z.infer<typeof postSchema>

const sammanfattningSchema = z.object({
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

const sammanstallningSchema = z.object({
  export_version: z.string(),
  bolag: z.string(),
  period: z.string(),
  generated_at: z.string(),
  sammanfattning: sammanfattningSchema,
  posts: z.array(postSchema),
})
export type Sammanstallning = z.infer<typeof sammanstallningSchema>

const wrapperSchema = z.object({
  export_version: z.string(),
  generated_at: z.string(),
  sammanstallningar: z.array(sammanstallningSchema),
})

export interface ParsedExport {
  export_version: string
  generated_at: string
  sammanstallningar: Sammanstallning[]
}

export type ParseExportResult =
  | { ok: true; export: ParsedExport }
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
  return version !== null && (SUPPORTED_EXPORT_VERSIONS as readonly string[]).includes(version)
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
    return { ok: true, export: parsed.data }
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
  }
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

/** One entry in `beslut`, exactly as the 1.1 answer schema lists it. */
export type Beslut =
  | {
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
      transaction_id: string
      svarstyp: 'fel_bolag'
      fel_bolag_mottagare: string
      till_bolag: string | null
    }
  | { transaction_id: string; svarstyp: 'osaker' }

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
  z.object({
    svarstyp: z.literal('osaker'),
    transaction_id: z.string().min(1),
  }),
])
export type SvarInput = z.infer<typeof svarInputSchema>

export type BuildBeslutResult =
  | { ok: true; beslut: Beslut; reglering: Reglering | null }
  | { ok: false; code: 'CANDIDATE_NOT_FOUND' | 'CANDIDATE_WITHOUT_HASH' }

/**
 * Turn a validated input into the contract's `beslut`. The chosen file is
 * resolved from the stored post by hash, so filnamn/kalla/sha256 always come
 * from what bertil offered, never from the browser.
 */
export function buildBeslut(post: Post, input: SvarInput): BuildBeslutResult {
  const transaction_id = post.transaction_id
  if (input.svarstyp === 'osaker') {
    return { ok: true, beslut: { transaction_id, svarstyp: 'osaker' }, reglering: null }
  }
  if (input.svarstyp === 'fel_bolag') {
    return {
      ok: true,
      beslut: {
        transaction_id,
        svarstyp: 'fel_bolag',
        fel_bolag_mottagare: input.fel_bolag_mottagare,
        till_bolag: input.till_bolag,
      },
      reglering: input.till_bolag === null ? null : input.reglering,
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

export function buildAnswerFile(beslut: Beslut[]): { version: string; beslut: Beslut[] } {
  return { version: ANSWER_VERSION, beslut }
}
