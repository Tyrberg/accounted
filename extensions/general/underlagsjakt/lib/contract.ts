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
export const MAX_SUPPORTED_EXPORT_VERSION = '1.5'
/** Export versions this extension has been built and tested against, for error messages. */
export const SUPPORTED_EXPORT_VERSIONS = ['1.1', '1.2', '1.3', '1.4', '1.5'] as const
/**
 * Answer version this extension writes. 1.4 added reglering to fel_bolag beslut;
 * 1.5 adds the `levererar_sjalv` svarstyp ("the document exists, I deliver it myself").
 */
export const ANSWER_VERSION = '1.5'

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

const sammanstallningSchema = z
  .object({
    export_version: z.string(),
    bolag: z.string(),
    period: z.string(),
    generated_at: z.string(),
    sammanfattning: sammanfattningSchema,
    posts: z.array(postSchema),
    /**
     * Optional (a 1.5 addition, absent in older exports): transaction_ids that
     * were answered `levererar_sjalv` and whose document bertil has since found
     * in the ordinary place. Read only to move those posts from "waiting" to
     * "with document"; an export without it changes nothing.
     */
    underlag_hittat: z.array(z.string()).optional(),
  })
  .passthrough()
export type Sammanstallning = z.infer<typeof sammanstallningSchema>

const wrapperSchema = z
  .object({
    export_version: z.string(),
    generated_at: z.string(),
    sammanstallningar: z.array(sammanstallningSchema),
  })
  .passthrough()

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
      /**
       * "The document exists and I will leave it in the ordinary place." NOT the
       * same as "no document needed": bertil must keep looking for the document
       * and must not book the payment as documented-by-nothing.
       */
      svarstyp: 'levererar_sjalv'
      motpart: string
      /**
       * True: a rule for every payment matching `motpart`, i.e. the rule key
       * `motpart|bolag=|bankkonto=|belopp=` with bolag, bankkonto and belopp all
       * empty (null). False: this transaction only; bolag and belopp then carry
       * the post's own values for reference and bertil must not widen them.
       */
      galler_alla: boolean
      bolag: string | null
      bankkonto: null
      belopp: number | null
    }
  | { answer_id: string; transaction_id: string; svarstyp: 'osaker' }

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
  z
    .object({
      svarstyp: z.literal('levererar_sjalv'),
      transaction_id: z.string().min(1),
      /** The pattern the rule recognises the counterparty by. */
      motpart: z.string().trim().min(1),
      /** Apply to every open payment with the same counterparty, not just this one. */
      galler_alla: z.boolean(),
      /**
       * How many posts the user was shown and confirmed ("this removes N posts").
       * Required for a bulk answer: the server refuses when the count it computes
       * has moved, so a bulk never clears a different set than the one confirmed.
       */
      bekrafta_antal: z.number().int().min(1).nullable(),
    })
    .refine((v) => !v.galler_alla || v.bekrafta_antal !== null, {
      message: 'bekrafta_antal krävs när galler_alla är satt',
      path: ['bekrafta_antal'],
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
        galler_alla: input.galler_alla,
        bolag: input.galler_alla ? null : post.bolag,
        bankkonto: null,
        belopp: input.galler_alla ? null : post.belopp,
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

export function buildAnswerFile(
  beslut: Beslut[],
): { version: string; beslut: Beslut[] } {
  return { version: ANSWER_VERSION, beslut }
}
