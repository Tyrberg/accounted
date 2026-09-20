/**
 * The machine path: how bertil delivers an export and collects answers
 * without a logged-in human.
 *
 * Every other route in this extension is dispatched behind
 * `lib/auth/require-auth.ts`, which wants a Supabase cookie session and
 * clears an MFA gate. bertil has neither, so the delivery could only ever
 * answer 401 (verified 2026-09-20). This module is the one way in for a
 * machine, and it is deliberately the narrowest thing that works:
 *
 *   - It covers exactly two routes: POST /export (lay an export down) and
 *     GET /svar (pick the answers up). Nothing else in Accounted is
 *     reachable with this credential, by construction: no other route calls
 *     `authenticateLeverans`.
 *   - The credential carries company affiliation. Which company an export
 *     lands in is decided HERE, from `UNDERLAGSJAKT_LEVERANS_ORGNR`, never
 *     from the request: a caller holding the token cannot name a company,
 *     so it cannot write to the wrong one. An org number that matches more
 *     than one company is refused rather than guessed.
 *   - It fails closed. Both env vars unset (the default, and what every
 *     hosted deployment of upstream has) means the machine path answers 503
 *     and no token exists to guess.
 *
 * Why not an Accounted API key (`gnubok_sk_`, lib/auth/api-keys.ts), which
 * already does company binding, scopes, revocation and rate limiting: a key
 * cannot be narrowed to one extension. Scopes live in the core catalogue
 * (lib/auth/scope-catalog.ts), and a key minted without an explicit scope
 * falls back to DEFAULT_SCOPES, i.e. read access to transactions, invoices,
 * customers, suppliers and every report through MCP and /api/v1. Handing
 * bertil the ledger to deliver a JSON file is the opposite of requirement 3
 * ("lay an export and read answers, nothing else"), and narrowing it would
 * mean adding an `underlagsjakt:*` scope to an upstream-owned file that this
 * fork has to merge forever (fork/README.md section 4). The trade is
 * recorded in fork/DECISIONS.md.
 *
 * The secret itself is never in the repository: it is an environment
 * variable on the box, the same place the rest of the deployment's secrets
 * live, and the same value goes into bertil's own .env as GNUBOK_API_KEY.
 */
import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import {
  formatOrgNumberDisplay,
  hasInvalidOrgNumberCheckDigit,
  normalizeOrgNumber,
} from '@/lib/invariants/org-number'
import type { ExtensionContext } from '@/lib/extensions/types'

const EXTENSION_ID = 'underlagsjakt'

/** Shared secret between this deployment and bertil. Set on the box, never committed. */
export const TOKEN_ENV = 'UNDERLAGSJAKT_LEVERANS_TOKEN'
/** The one company the delivery may write to, as an organisationsnummer. */
export const ORGNR_ENV = 'UNDERLAGSJAKT_LEVERANS_ORGNR'

/**
 * A token shorter than this is refused at read time rather than trusted.
 * 32 characters is what `openssl rand -base64 24` produces, which is what
 * the setup instructions tell the operator to run; anything materially
 * shorter is a word someone typed by hand, and a typed word that silently
 * works is how a machine path stops being a secret.
 */
const MIN_TOKEN_LENGTH = 32

export type Env = Record<string, string | undefined>

export interface LeveransConfig {
  token: string
  /** Canonical 10-digit form, as companies.org_number stores it. */
  orgnr: string
}

/** One thing that is wrong with one variable, and which kind of wrong it is. */
export interface LeveransConfigProblem {
  /** The environment variable this sentence is about. */
  variable: string
  /**
   * `missing`: the line is not in the file, so the operator has to write it.
   * `invalid`: the line is there and does not hold up, so the operator has to
   * edit it. Telling that person to "switch the delivery on" sends them to do
   * the thing they already did.
   */
  kind: 'missing' | 'invalid'
  /** What the operator reads: which line, and what to do about it. */
  message: string
}

export type LeveransConfigResult =
  | { ok: true; config: LeveransConfig }
  /** Why the machine path is off, one problem per variable that is wrong. */
  | { ok: false; problems: LeveransConfigProblem[] }

/** The problems as one paragraph, for the places that show a single line. */
export function describeLeveransProblems(problems: LeveransConfigProblem[]): string {
  return problems.map((problem) => problem.message).join(' ')
}

/**
 * The configuration, or exactly what is wrong with it.
 *
 * "Off" and "set wrong" are different situations for the person switching the
 * delivery on, and only one of them is fixed by setting the variables. A box
 * where the token was typed by hand, or where the org number is a company
 * name, is configured as far as the operator is concerned; answering "set
 * ${TOKEN_ENV} and ${ORGNR_ENV}" there sends them to re-read a file that
 * already holds both lines. So each variable reports its own problem, and the
 * 503 and the switch-on check (leverans-status.ts) both say which line to
 * edit.
 *
 * The org number splits that same way once more. `normalizeOrgNumber` refuses
 * a company name and a mistyped last digit alike, and those two are not the
 * same news: the operator who fat-fingers one digit of an otherwise perfect
 * `556012-5790` would count ten digits and one hyphen against a sentence
 * asking for ten digits and a hyphen, and conclude the check is broken. A
 * mistyped digit is the typo this whole message exists to catch, so it gets
 * told the truth: right shape, wrong check digit.
 */
export function inspectLeveransConfig(env: Env = process.env): LeveransConfigResult {
  const token = env[TOKEN_ENV]?.trim()
  const rawOrgnr = env[ORGNR_ENV]?.trim()
  const orgnr = normalizeOrgNumber(rawOrgnr)

  const problems: LeveransConfigProblem[] = []
  const problem = (variable: string, kind: LeveransConfigProblem['kind'], message: string) =>
    problems.push({ variable, kind, message })

  if (!token) {
    problem(TOKEN_ENV, 'missing', `${TOKEN_ENV} är inte satt.`)
  } else if (token.length < MIN_TOKEN_LENGTH) {
    problem(
      TOKEN_ENV,
      'invalid',
      `${TOKEN_ENV} är kortare än ${MIN_TOKEN_LENGTH} tecken och godtas inte. Generera nyckeln med "openssl rand -base64 24".`,
    )
  }
  if (!rawOrgnr) {
    problem(ORGNR_ENV, 'missing', `${ORGNR_ENV} är inte satt.`)
  } else if (hasInvalidOrgNumberCheckDigit(rawOrgnr)) {
    problem(
      ORGNR_ENV,
      'invalid',
      `${ORGNR_ENV} har rätt form men fel kontrollsiffra: ${rawOrgnr} är inget giltigt organisationsnummer. Siffrorna stämmer inte mot varandra, så kontrollera numret mot bolagets registreringsbevis, oftast är det sista siffran som blivit fel.`,
    )
  } else if (!orgnr) {
    problem(
      ORGNR_ENV,
      'invalid',
      `${ORGNR_ENV} är inte ett organisationsnummer: ange 10 eller 12 siffror, bindestreck valfritt.`,
    )
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, config: { token: token!, orgnr: orgnr! } }
}

/** Config for the machine path, or null when the deployment has not enabled it. */
export function readLeveransConfig(env: Env = process.env): LeveransConfig | null {
  const result = inspectLeveransConfig(env)
  return result.ok ? result.config : null
}

/**
 * Whether bertil's delivery lands in THIS company.
 *
 * The workspace is per company, the delivery is bound to exactly one, and a
 * box can hold several. "The token is set" is therefore not an answer the
 * workspace can use: on a box with two companies it would promise the other
 * company's user that exports arrive by themselves, and that user would wait
 * for a delivery that is, by construction, going somewhere else. So the
 * question asked here is the one the user actually has, and it is answered
 * through the same resolution the delivery itself runs: configured, org
 * number resolves to a single active company, and that company is this one.
 * Anything else is a no, and the workspace says "import the file".
 */
export async function leveransTargetsCompany(companyId: string, deps: LeveransDeps = {}): Promise<boolean> {
  const config = readLeveransConfig(deps.env ?? process.env)
  if (!config) return false
  try {
    const supabase = deps.client ?? createServiceClientNoCookies()
    const resolved = await resolveLeveransCompany(supabase, config)
    return resolved.ok && resolved.companyId === companyId
  } catch {
    // This runs on every workspace load. A box that cannot build a
    // service-role client cannot receive a delivery either, so the honest
    // answer is no; it must never be a broken workspace.
    return false
  }
}

/**
 * The token as bertil sends it: `Authorization: Bearer <token>`.
 *
 * The `apikey` header is accepted as well because bertil's client
 * (underlagsjakt_export_client.py, bertil#183) sets both, and a delivery
 * that fails because one of two identical headers was read would be a
 * needlessly obscure outage.
 */
export function extractLeveransToken(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const value = authorization.slice(7).trim()
    if (value) return value
  }
  const apikey = request.headers.get('apikey')?.trim()
  return apikey || null
}

/**
 * Constant-time comparison over digests, so inputs of different length are still safe to compare.
 *
 * CodeQL flags this as js/insufficient-password-hash. It is not password hashing and a KDF would
 * add nothing here: the value is never a human-chosen password and is never stored. It is a
 * machine token that only ever lives in the environment, and inspectLeveransConfig refuses any
 * token shorter than MIN_TOKEN_LENGTH and tells the operator to generate it with
 * "openssl rand -base64 24" — so the input is high-entropy by construction, which is the property
 * a KDF exists to manufacture for low-entropy secrets. SHA-256 is used only to normalise both
 * sides to a fixed width so timingSafeEqual cannot throw on length mismatch and cannot leak
 * length through timing. Stretching a 192-bit random token would cost work and buy nothing.
 *
 * If the length floor is ever removed, this justification stops holding and the alert must be
 * re-evaluated rather than re-suppressed.
 */
// codeql[js/insufficient-password-hash]
function tokenMatches(presented: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status })
}

export type LeveransAuth =
  | { ok: true; ctx: ExtensionContext; config: LeveransConfig }
  | { ok: false; response: NextResponse }

type ResolvedCompany =
  | { ok: true; companyId: string }
  | { ok: false; code: string; message: string }

/**
 * The one company the configured org number names, or why it names none.
 *
 * Shared by the delivery (which writes there) and the workspace (which tells
 * the user whether a delivery is coming), so the two can never disagree about
 * where an export lands.
 */
async function resolveLeveransCompany(
  supabase: SupabaseClient,
  config: LeveransConfig,
): Promise<ResolvedCompany> {
  // Both storage shapes: the canonical 10 digits and the hyphenated form a
  // company created before normalizeOrgNumber may still carry.
  const { data: companies, error } = await supabase
    .from('companies')
    .select('id')
    .in('org_number', [config.orgnr, formatOrgNumberDisplay(config.orgnr)])
    .is('archived_at', null)

  if (error) {
    return {
      ok: false,
      code: 'LEVERANS_COMPANY_LOOKUP_FAILED',
      message: 'Bolaget för leveransen kunde inte slås upp.',
    }
  }
  const rows = (companies ?? []) as { id: string }[]
  if (rows.length === 0) {
    return {
      ok: false,
      code: 'LEVERANS_COMPANY_NOT_FOUND',
      message: `Inget aktivt bolag har organisationsnummer ${formatOrgNumberDisplay(config.orgnr)}. Kontrollera ${ORGNR_ENV}.`,
    }
  }
  if (rows.length > 1) {
    // Never guess which one: the whole point of binding the company outside
    // the request is that an export cannot land in the wrong bolag.
    return {
      ok: false,
      code: 'LEVERANS_COMPANY_AMBIGUOUS',
      message: `Flera bolag har organisationsnummer ${formatOrgNumberDisplay(config.orgnr)}. Leveransen stoppas hellre än gissar.`,
    }
  }
  return { ok: true, companyId: rows[0].id }
}

export interface LeveransDeps {
  env?: Env
  /** Service-role client; injected in tests. */
  client?: SupabaseClient
}

export type LeveransContext =
  | { ok: true; ctx: ExtensionContext }
  | { ok: false; code: string; message: string }

/**
 * The company the configuration names, and the service-role context that
 * writes there.
 *
 * Shared by the delivery itself and by leverans-status.ts, so the operator's
 * switch-on check resolves the company through exactly the same code a real
 * delivery runs: a check that resolves it its own way can pass while the
 * delivery fails.
 */
export async function openLeveransContext(
  supabase: SupabaseClient,
  config: LeveransConfig,
): Promise<LeveransContext> {
  const resolved = await resolveLeveransCompany(supabase, config)
  if (!resolved.ok) return resolved
  const companyId = resolved.companyId

  // extension_data.user_id is NOT NULL, and a delivery has no human behind
  // it, so the write is attributed to the company's owner: the person who
  // answers the questions in the workspace anyway.
  const { data: owner, error: ownerError } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (ownerError || !owner) {
    return {
      ok: false,
      code: 'LEVERANS_OWNER_NOT_FOUND',
      message: 'Bolaget saknar ägare att bokföra leveransen på.',
    }
  }

  return {
    ok: true,
    ctx: createExtensionContext(supabase, (owner as { user_id: string }).user_id, companyId, EXTENSION_ID),
  }
}

/**
 * Authenticate a delivery call and build the context it may write through.
 *
 * The context is service-role (there is no session to run RLS against), so
 * the company it is bound to is the whole of the authorisation decision.
 * `createExtensionContext` scopes every `settings` read and write to that
 * company id, which is why no route reachable from here takes a company
 * from the request.
 */
export async function authenticateLeverans(
  request: Request,
  deps: LeveransDeps = {},
): Promise<LeveransAuth> {
  const inspected = inspectLeveransConfig(deps.env ?? process.env)
  if (!inspected.ok) {
    return {
      ok: false,
      response: fail(
        503,
        'LEVERANS_NOT_CONFIGURED',
        `Automatisk leverans är inte påslagen: ${describeLeveransProblems(inspected.problems)}`,
      ),
    }
  }
  const config = inspected.config

  const presented = extractLeveransToken(request)
  if (!presented) {
    return { ok: false, response: fail(401, 'LEVERANS_TOKEN_MISSING', 'Leveransnyckel saknas.') }
  }
  if (!tokenMatches(presented, config.token)) {
    return { ok: false, response: fail(401, 'LEVERANS_TOKEN_INVALID', 'Leveransnyckeln stämmer inte.') }
  }

  const supabase = deps.client ?? createServiceClientNoCookies()

  const opened = await openLeveransContext(supabase, config)
  if (!opened.ok) {
    return { ok: false, response: fail(503, opened.code, opened.message) }
  }

  return { ok: true, config, ctx: opened.ctx }
}
