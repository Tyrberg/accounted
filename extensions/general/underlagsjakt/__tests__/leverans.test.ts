/**
 * The machine path: bertil delivering an export and collecting answers with
 * no logged-in human anywhere in the request.
 *
 * What these tests hold onto:
 *   - the path is off until the box is configured, and refuses a wrong token
 *   - which company the export lands in comes from the server's config, never
 *     from the caller, and an org number matching more than one company stops
 *     the delivery instead of guessing
 *   - the write really is scoped to that company (the extension_data row
 *     carries its id)
 *   - the workspace promises an automatic delivery only to the company that
 *     actually receives one, so nobody waits for an export going elsewhere
 *   - answers remain available until explicitly acknowledged
 *   - the box can tell a delivery that runs from one that was configured and
 *     never called, which is what leverans-status.ts reports on
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ORGNR_ENV,
  TOKEN_ENV,
  authenticateLeverans,
  describeLeveransProblems,
  extractLeveransToken,
  inspectLeveransConfig,
  leveransTargetsCompany,
  readLeveransConfig,
} from '@/extensions/general/underlagsjakt/lib/leverans'
import {
  MAX_QUIET_DAYS,
  describeLeveransStatus,
  formatReport,
  gatherEvidence,
  loadDeploymentEnv,
  main,
  type LeveransEvidence,
} from '@/extensions/general/underlagsjakt/leverans-status'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createLeveransSupabaseSlice, type LeveransSupabaseSlice } from './supabase-slice'
import fixture from './fixtures/export-1.1.json'

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn(async () => ({ ok: true })),
}))

const serviceClient = vi.fn()
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => serviceClient(),
}))

// Imported after the mocks so the extension's own module graph gets them.
const { underlagsjaktExtension } = await import('@/extensions/general/underlagsjakt')

const TOKEN = 'kLq7Z2m9Xr4vBn6TpW8sEyHu3Ac1Df5G'
const ORGNR = '556012-5790'
const CANONICAL = '5560125790'

const env = (overrides: Record<string, string | undefined> = {}) => ({
  [TOKEN_ENV]: TOKEN,
  [ORGNR_ENV]: ORGNR,
  ...overrides,
})

function route(method: string, path: string) {
  const r = underlagsjaktExtension.apiRoutes!.find((x) => x.method === method && x.path === path)
  if (!r) throw new Error(`no route ${method} ${path}`)
  return r
}

// The Supabase stand-in lives in ./supabase-slice.ts: leverans-dispatch.test.ts
// drives the same handlers through the dispatcher and needs the same database.
let slice: LeveransSupabaseSlice

const makeClient = () => slice.client()

const request = (init: { token?: string | null; apikey?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? TOKEN}`
  if (init.apikey) headers.apikey = init.apikey
  return new Request('http://localhost/api/extensions/ext/underlagsjakt/export', {
    method: init.body === undefined ? 'GET' : 'POST',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

async function parse<T>(response: Response): Promise<{ status: number; body: T }> {
  return { status: response.status, body: (await response.json()) as T }
}

const storedValue = (key: string) => slice.storedValue(key)

beforeEach(() => {
  vi.clearAllMocks()
  slice = createLeveransSupabaseSlice()
  serviceClient.mockImplementation(() => makeClient())
  process.env[TOKEN_ENV] = TOKEN
  process.env[ORGNR_ENV] = ORGNR
})

afterEach(() => {
  // The workspace route reads these from the real process.env; leaving them
  // set would configure the delivery for every test file after this one.
  delete process.env[TOKEN_ENV]
  delete process.env[ORGNR_ENV]
})

describe('readLeveransConfig', () => {
  it('is off until both the token and the company are set', () => {
    expect(readLeveransConfig({})).toBeNull()
    expect(readLeveransConfig(env({ [TOKEN_ENV]: undefined }))).toBeNull()
    expect(readLeveransConfig(env({ [ORGNR_ENV]: undefined }))).toBeNull()
  })

  it('refuses a token short enough to have been typed by hand', () => {
    expect(readLeveransConfig(env({ [TOKEN_ENV]: 'hemlighet' }))).toBeNull()
  })

  it('refuses an org number that is not one', () => {
    expect(readLeveransConfig(env({ [ORGNR_ENV]: '556012-5791' }))).toBeNull()
    expect(readLeveransConfig(env({ [ORGNR_ENV]: 'Tyrberg Group AB' }))).toBeNull()
  })

  it('normalizes the company to the canonical ten digits', () => {
    expect(readLeveransConfig(env())?.orgnr).toBe(CANONICAL)
    expect(readLeveransConfig(env({ [ORGNR_ENV]: CANONICAL }))?.orgnr).toBe(CANONICAL)
    expect(readLeveransConfig(env({ [ORGNR_ENV]: '165560125790' }))?.orgnr).toBe(CANONICAL)
  })

})

/**
 * Switching the delivery on is four steps on two machines, and the box gets
 * exactly one line to say what it thinks of the two variables it was given.
 * "Set them" and "the one you set is wrong" send the operator to different
 * places, so they must not be the same sentence.
 */
describe('inspectLeveransConfig', () => {
  const problems = (overrides?: Record<string, string | undefined>) => {
    const result = inspectLeveransConfig(overrides === undefined ? env() : env(overrides))
    return result.ok ? [] : result.problems
  }

  it('names both variables when neither is set', () => {
    const lines = inspectLeveransConfig({})
    expect(lines.ok).toBe(false)
    if (lines.ok) return
    expect(lines.problems).toHaveLength(2)
    expect(describeLeveransProblems(lines.problems)).toContain(TOKEN_ENV)
    expect(describeLeveransProblems(lines.problems)).toContain(ORGNR_ENV)
    // Nothing was ever written here, so the operator writes both lines.
    expect(lines.problems.map((p) => p.kind)).toEqual(['missing', 'missing'])
  })

  it('says a set token is too short, not that it is missing', () => {
    const lines = problems({ [TOKEN_ENV]: 'hemlighet' })
    expect(lines).toHaveLength(1)
    expect(lines[0].kind).toBe('invalid')
    expect(lines[0].message).toContain('kortare än')
    expect(lines[0].message).toContain('openssl rand -base64 24')
    expect(lines[0].message).not.toContain('är inte satt')
  })

  it('says a set org number is not one, not that it is missing', () => {
    const lines = problems({ [ORGNR_ENV]: 'Tyrberg Group AB' })
    expect(lines).toHaveLength(1)
    expect(lines[0].kind).toBe('invalid')
    expect(lines[0].message).toContain('är inte ett organisationsnummer')
    // The token is fine here: it must not be dragged into the complaint.
    expect(lines[0].message).not.toContain(TOKEN_ENV)
  })

  /**
   * One mistyped digit is the typo this message exists to catch, and it is the
   * one shape where "ange 10 eller 12 siffror" reads as a broken check: the
   * operator looks at 556012-5791, counts ten digits and one hyphen, and
   * believes they already did what they were told. So the check digit gets its
   * own sentence.
   */
  it('separates a mistyped digit from a number that is the wrong shape', () => {
    const lines = problems({ [ORGNR_ENV]: '556012-5791' })
    expect(lines).toHaveLength(1)
    expect(lines[0].kind).toBe('invalid')
    expect(lines[0].message).toContain('kontrollsiffra')
    expect(lines[0].message).toContain('556012-5791')
    // The shape advice would be false here, and false advice is the bug.
    expect(lines[0].message).not.toContain('ange 10 eller 12 siffror')
  })

  it('says nothing is wrong when both are right', () => {
    expect(problems()).toEqual([])
    expect(inspectLeveransConfig(env())).toEqual({ ok: true, config: { token: TOKEN, orgnr: CANONICAL } })
  })
})

describe('leveransTargetsCompany', () => {
  const targets = (companyId: string, overrides?: Record<string, string | undefined>) =>
    leveransTargetsCompany(companyId, { client: makeClient(), env: env(overrides) })

  it('says yes only for the company the delivery is bound to', async () => {
    expect(await targets('company-1')).toBe(true)
    // Same box, another company: its export will never arrive, so the
    // workspace must not promise one.
    expect(await targets('company-2')).toBe(false)
  })

  it('says no while the box has no delivery configured', async () => {
    expect(await leveransTargetsCompany('company-1', { client: makeClient(), env: {} })).toBe(false)
  })

  it('says no when the org number matches no active company', async () => {
    slice.companyRows = []
    expect(await targets('company-1')).toBe(false)
  })

  it('says no when the org number matches several companies, as the delivery would refuse', async () => {
    slice.companyRows = [{ id: 'company-1' }, { id: 'company-2' }]
    expect(await targets('company-1')).toBe(false)
  })

  it('says no rather than breaking the workspace when the lookup cannot run', async () => {
    serviceClient.mockImplementation(() => {
      throw new Error('no service role key')
    })
    expect(await leveransTargetsCompany('company-1')).toBe(false)
  })
})

describe('extractLeveransToken', () => {
  it('reads the bearer token bertil sends', () => {
    expect(extractLeveransToken(request())).toBe(TOKEN)
  })

  it('accepts the apikey header bertil sends alongside it', () => {
    expect(extractLeveransToken(request({ token: null, apikey: TOKEN }))).toBe(TOKEN)
  })

  it('is null when neither header carries anything', () => {
    expect(extractLeveransToken(new Request('http://localhost/x'))).toBeNull()
  })
})

describe('authenticateLeverans', () => {
  const auth = (init?: Parameters<typeof request>[0], overrides?: Record<string, string | undefined>) =>
    authenticateLeverans(request(init), { client: makeClient(), env: env(overrides) })

  it('answers 503 while the box has no delivery configured', async () => {
    const result = await authenticateLeverans(request(), { client: makeClient(), env: {} })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { status, body } = await parse<{ error: { code: string; message: string } }>(result.response)
    expect(status).toBe(503)
    expect(body.error.code).toBe('LEVERANS_NOT_CONFIGURED')
    expect(body.error.message).toContain(TOKEN_ENV)
  })

  it('answers 503 naming the variable that is wrong, not both variables', async () => {
    const result = await auth(undefined, { [ORGNR_ENV]: 'Tyrberg Group AB' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { status, body } = await parse<{ error: { code: string; message: string } }>(result.response)
    expect(status).toBe(503)
    expect(body.error.code).toBe('LEVERANS_NOT_CONFIGURED')
    expect(body.error.message).toContain('är inte ett organisationsnummer')
    // bertil's operator must not be sent to re-mint a token that is correct.
    expect(body.error.message).not.toContain(TOKEN_ENV)
  })

  it('answers 401 without a token', async () => {
    const result = await auth({ token: null })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(401)
    const { body } = await parse<{ error: { code: string } }>(result.response)
    expect(body.error.code).toBe('LEVERANS_TOKEN_MISSING')
  })

  it('answers 401 for a token that is not the configured one', async () => {
    const result = await auth({ token: `${TOKEN}x` })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { status, body } = await parse<{ error: { code: string } }>(result.response)
    expect(status).toBe(401)
    expect(body.error.code).toBe('LEVERANS_TOKEN_INVALID')
  })

  it('binds the context to the company the configuration names, in both stored spellings', async () => {
    const result = await auth()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ctx.companyId).toBe('company-1')
    expect(result.ctx.userId).toBe('owner-1')
    expect(result.ctx.extensionId).toBe('underlagsjakt')
    expect(slice.inFilters).toEqual([CANONICAL, '556012-5790'])
  })

  it('stops rather than guessing when the org number matches several companies', async () => {
    slice.companyRows = [{ id: 'company-1' }, { id: 'company-2' }]
    const result = await auth()
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { status, body } = await parse<{ error: { code: string } }>(result.response)
    expect(status).toBe(503)
    expect(body.error.code).toBe('LEVERANS_COMPANY_AMBIGUOUS')
  })

  it('says which env var to fix when no company matches', async () => {
    slice.companyRows = []
    const result = await auth()
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { body } = await parse<{ error: { code: string; message: string } }>(result.response)
    expect(body.error.code).toBe('LEVERANS_COMPANY_NOT_FOUND')
    expect(body.error.message).toContain(ORGNR_ENV)
  })

  it('refuses when the company lookup itself failed', async () => {
    slice.companyError = { message: 'boom' }
    const result = await auth()
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { body } = await parse<{ error: { code: string } }>(result.response)
    expect(body.error.code).toBe('LEVERANS_COMPANY_LOOKUP_FAILED')
  })

  it('refuses when the company has no owner to attribute the write to', async () => {
    slice.ownerRow = null
    const result = await auth()
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { body } = await parse<{ error: { code: string } }>(result.response)
    expect(body.error.code).toBe('LEVERANS_OWNER_NOT_FOUND')
  })
})

describe('the delivery routes', () => {
  it('are the only routes that bypass the session dispatcher', () => {
    const machine = underlagsjaktExtension
      .apiRoutes!.filter((r) => r.skipAuth)
      .map((r) => `${r.method} ${r.path}`)
    expect(machine).toEqual(['POST /export', 'GET /svar', 'POST /svar/kvittens'])
  })

  it("POST /export stores bertil's export on the configured company", async () => {
    const res = await route('POST', '/export').handler(request({ body: fixture }))
    const { status, body } = await parse<{ data: { posts: number; export_version: string } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ posts: 3, export_version: '1.1' })

    const row = slice.dataRows.find((r) => r.key === 'export')!
    expect(row.company_id).toBe('company-1')
    expect(row.user_id).toBe('owner-1')
    expect(row.extension_id).toBe('underlagsjakt')
    expect(storedValue('export')).toMatchObject({ export_version: '1.1', imported_via: 'leverans' })
  })

  it('POST /export refuses a wrong token before touching any state', async () => {
    const res = await route('POST', '/export').handler(request({ token: 'not-the-token-but-long-enough-x', body: fixture }))
    expect(res.status).toBe(401)
    expect(slice.dataRows).toEqual([])
  })

  it('POST /export still checks the contract version', async () => {
    const res = await route('POST', '/export').handler(request({ body: { ...fixture, export_version: '1.0' } }))
    const { status, body } = await parse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('UNSUPPORTED_VERSION')
    expect(slice.dataRows).toEqual([])
  })

  it('GET /svar retries failed ingestion until an explicit, idempotent acknowledgement', async () => {
    await route('POST', '/export').handler(request({ body: fixture }))
    // The import writes an (empty) svar row of its own; answer one post in it.
    const answerId = '2026-09-19T08:00:00.000Z:tx-moank-20260821'
    slice.dataRows.find((r) => r.key === 'svar')!.value = {
      'tx-moank-20260821': {
        beslut: { transaction_id: 'tx-moank-20260821', svarstyp: 'osaker' },
        reglering: null,
        post: {},
        besvarad_at: '2026-09-19T08:00:00.000Z',
        besvarad_av: 'owner-1',
        answer_id: answerId,
        erbjudet_at: null,
        levererad_at: null,
      },
    }

    const first = await parse<{ version: string; beslut: { transaction_id: string }[] }>(
      await route('GET', '/svar').handler(request()),
    )
    expect(first.status).toBe(200)
    expect(first.body.version).toBe('1.4')
    expect(first.body.beslut.map((b) => b.transaction_id)).toEqual(['tx-moank-20260821'])

    const svar = storedValue('svar') as Record<string, { levererad_at: string | null }>
    expect(svar['tx-moank-20260821'].levererad_at).toBeNull()

    const ingest = vi.fn().mockRejectedValue(new Error('ingestion failed'))
    await expect(ingest(first.body)).rejects.toThrow('ingestion failed')

    const second = await parse<{ beslut: unknown[] }>(await route('GET', '/svar').handler(request()))
    expect(second.body).toEqual(first.body)
    expect((await gatherEvidence()).lastAcknowledgedAt).toBeNull()
    const acknowledge = () => route('POST', '/svar/kvittens').handler(
      request({ body: { transaction_id: 'tx-moank-20260821', answer_id: answerId } }),
    )
    expect((await acknowledge()).status).toBe(200)
    const acknowledged = structuredClone(storedValue('svar')) as Record<string, { levererad_at: string | null }>
    expect(acknowledged['tx-moank-20260821'].levererad_at).toEqual(expect.any(String))
    const receipt = (await gatherEvidence()).lastAcknowledgedAt
    expect(receipt).toBe(acknowledged['tx-moank-20260821'].levererad_at)
    expect((await acknowledge()).status).toBe(200)
    expect((await gatherEvidence()).lastAcknowledgedAt).toBe(receipt)
    expect(storedValue('svar')).toEqual(acknowledged)
    const third = await parse<{ beslut: unknown[] }>(await route('GET', '/svar').handler(request()))
    expect(third.body.beslut).toEqual([])

    // A later export prunes this answer but must retain machine evidence.
    const later = { ...fixture, generated_at: new Date(Date.parse(receipt!) + 1000).toISOString() }
    expect((await route('POST', '/export').handler(request({ body: later }))).status).toBe(200)
    expect(storedValue('svar')).toEqual({})
    await route('GET', '/svar').handler(request())
    const evidence = await gatherEvidence()
    expect(evidence.lastAcknowledgedAt).toBe(receipt)
    expect(describeLeveransStatus(evidence, new Date()).exitCode).toBe(0)
  })


  it('does not count manual delivery or legacy delivery timestamps as machine acknowledgement', async () => {
    await route('POST', '/export').handler(request({ body: fixture }))
    slice.dataRows.find((r) => r.key === 'svar')!.value = {
      'tx-moank-20260821': {
        beslut: { transaction_id: 'tx-moank-20260821', svarstyp: 'osaker' },
        reglering: null,
        post: {},
        besvarad_at: new Date().toISOString(),
        besvarad_av: 'owner-1',
        levererad_at: null,
      },
    }
    const auth = await authenticateLeverans(request())
    expect(auth.ok).toBe(true)
    if (!auth.ok) throw new Error('Expected authenticated context')
    const delivered = await route('POST', '/svarsfil/levererad').handler(
      request({ body: { transaction_ids: ['tx-moank-20260821'] } }), auth.ctx,
    )
    expect(delivered.status).toBe(200)
    expect(storedValue('svar')).toMatchObject({
      'tx-moank-20260821': { levererad_at: expect.any(String) },
    })
    await route('GET', '/svar').handler(request())
    const evidence = await gatherEvidence()
    expect(evidence.lastAcknowledgedAt).toBeNull()
    const report = describeLeveransStatus(evidence, new Date())
    expect(report.exitCode).toBe(2)
    expect(report.checks.find((c) => c.label === 'answers (Accounted -> bertil)')?.state).toBe('alarm')
  })

  it.each([null, 'wrong-token'])('rejects acknowledgement with token %s', async (token) => {
    const res = await route('POST', '/svar/kvittens').handler(request({ token, body: { transaction_id: 'tx' } }))
    expect(res.status).toBe(401)
    expect(slice.dataRows).toEqual([])
  })

  it.each([null, {}, { transaction_id: '' }, { transaction_id: ' ' }, { transaction_id: 1 }])(
    'rejects invalid acknowledgement %j', async (body) => {
      const res = await route('POST', '/svar/kvittens').handler(request({ body }))
      expect(res.status).toBe(400)
      expect(slice.dataRows).toEqual([])
    },
  )

  it('rejects malformed JSON and accepts unknown acknowledgements without writes', async () => {
    const malformed = new Request('http://localhost/svar/kvittens', {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{',
    })
    expect((await route('POST', '/svar/kvittens').handler(malformed)).status).toBe(400)
    const missing = await route('POST', '/svar/kvittens').handler(
      request({ body: { transaction_id: 'missing', answer_id: 'missing-answer-id' } }),
    )
    expect(missing.status).toBe(200)
    expect(await missing.json()).toEqual({ data: { transaction_id: 'missing' } })
    const retry = await route('POST', '/svar/kvittens').handler(
      request({ body: { transaction_id: 'missing', answer_id: 'missing-answer-id' } }),
    )
    expect(retry.status).toBe(200)
    expect(slice.dataRows).toEqual([])
  })

  it('POST /export answers the documented preflight: 400 for a rejected body, nothing stored', async () => {
    // fork/README.md section 11 tells the operator to probe the configuration
    // with an empty body and read 400 as "token and company are right".
    const res = await route('POST', '/export').handler(request({ body: {} }))
    expect(res.status).toBe(400)
    expect(slice.dataRows).toEqual([])
  })

  it('GET /svar refuses a caller without the token', async () => {
    const res = await route('GET', '/svar').handler(request({ token: null }))
    expect(res.status).toBe(401)
  })

  it('GET /svar records every call, including the ones carrying nothing', async () => {
    await route('POST', '/export').handler(request({ body: fixture }))

    // A poll with no answers waiting: the only evidence the box gets that
    // bertil is still running at all.
    await route('GET', '/svar').handler(request())
    const empty = storedValue('leverans') as { senast_antal: number; senast_hamtad_at: string }
    expect(empty.senast_antal).toBe(0)
    expect(Date.parse(empty.senast_hamtad_at)).not.toBeNaN()

    slice.dataRows.find((r) => r.key === 'svar')!.value = {
      'tx-moank-20260821': {
        beslut: { transaction_id: 'tx-moank-20260821', svarstyp: 'osaker' },
        reglering: null,
        post: {},
        besvarad_at: '2026-09-19T08:00:00.000Z',
        besvarad_av: 'owner-1',
        answer_id: '2026-09-19T08:00:00.000Z:tx-moank-20260821',
        erbjudet_at: null,
        levererad_at: null,
      },
    }
    await route('GET', '/svar').handler(request())
    expect(storedValue('leverans')).toMatchObject({ senast_antal: 1 })

    // Poll statistics count repeated offers, not confirmed consumption.
    await route('GET', '/svar').handler(request())
    expect(storedValue('leverans')).toMatchObject({ senast_antal: 1 })
  })
})

describe('describeLeveransStatus', () => {
  const NOW = new Date('2026-09-21T07:00:00.000Z')
  const recently = '2026-09-21T04:17:00.000Z'

  // The problems as inspectLeveransConfig really produces them, so the report
  // is never tested against a shape the configuration reader cannot emit.
  const configProblems = (overrides: Record<string, string | undefined>) => {
    const result = inspectLeveransConfig({ [TOKEN_ENV]: TOKEN, [ORGNR_ENV]: ORGNR, ...overrides })
    if (result.ok) throw new Error('expected a configuration problem')
    return result.problems
  }

  const evidence = (overrides: Partial<LeveransEvidence> = {}): LeveransEvidence => ({
    envFile: '/srv/accounted/.env',
    configProblems: [],
    companyProblem: null,
    companyId: 'company-1',
    export: { imported_at: recently, via: 'leverans' },
    journal: { senast_hamtad_at: recently, senast_antal: 1 },
    pendingAnswers: 0,
    lastAcknowledgedAt: recently,
    oldestPendingAt: null,
    ...overrides,
  })

  const labels = (report: ReturnType<typeof describeLeveransStatus>, state: string) =>
    report.checks.filter((c) => c.state === state).map((c) => c.label)

  it('passes only once both directions have carried real data', () => {
    const report = describeLeveransStatus(evidence(), NOW)
    expect(report.exitCode).toBe(0)
    expect(labels(report, 'alarm')).toEqual([])
  })

  it('says nothing is switched on when the box has no configuration', () => {
    const report = describeLeveransStatus(
      evidence({ configProblems: configProblems({ [TOKEN_ENV]: undefined, [ORGNR_ENV]: undefined }) }),
      NOW,
    )
    expect(report.exitCode).toBe(4)
    expect(report.headline).toContain('is not switched on on this box')
    expect(report.checks[0].line).toContain('not switched on')
    expect(report.checks[0].line).toContain(TOKEN_ENV)
    expect(report.checks[0].line).toContain(ORGNR_ENV)
    expect(report.checks[0].line).toContain(`Add ${TOKEN_ENV}`)
    expect(report.checks[0].line).toContain(`Add ${ORGNR_ENV}`)
    expect(report.checks[0].line).not.toContain('Correct')
    // Where it looked, so "not switched on" cannot be confused with "looked
    // in the wrong place".
    expect(report.checks[0].line).toContain('Read /srv/accounted/.env.')
  })

  it('names the variable that is wrong rather than telling the operator to set both again', () => {
    const report = describeLeveransStatus(
      evidence({ configProblems: configProblems({ [ORGNR_ENV]: 'Tyrberg Group AB' }) }),
      NOW,
    )
    expect(report.exitCode).toBe(4)
    expect(report.checks[0].line).toContain('är inte ett organisationsnummer')
    // The token is fine on this box: saying "set it" would send the operator
    // to rewrite a line that is already correct.
    expect(report.checks[0].line).not.toContain(TOKEN_ENV)
  })

  /**
   * The box with one mistyped digit is switched on, and its operator knows it.
   * A headline saying the delivery "is off" sends that person to do the thing
   * they already did, which is the conflation the detail line stopped making:
   * it must not survive one level up.
   */
  it('calls a wrong line wrong, not off, all the way up to the headline', () => {
    const report = describeLeveransStatus(
      evidence({ configProblems: configProblems({ [ORGNR_ENV]: '556012-5791' }) }),
      NOW,
    )
    expect(report.exitCode).toBe(4)
    expect(report.headline).toContain('is configured wrong')
    expect(report.headline).not.toContain('not switched on')
    expect(report.checks[0].line).toContain('kontrollsiffra')
    expect(report.checks[0].line).toContain(`Correct ${ORGNR_ENV} in the deployment's .env.`)
    expect(report.checks[0].line).not.toContain('not switched on')
  })

  it.each([
    { missing: TOKEN_ENV, invalid: ORGNR_ENV, value: '556012-5791' },
    { missing: ORGNR_ENV, invalid: TOKEN_ENV, value: 'short-token' },
  ])('distinguishes missing $missing from invalid $invalid', ({ missing, invalid, value }) => {
    const report = describeLeveransStatus(
      evidence({ configProblems: configProblems({ [missing]: undefined, [invalid]: value }) }),
      NOW,
    )
    expect(report.exitCode).toBe(4)
    expect(report.headline).toContain('is partly missing and partly invalid')
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0].state).toBe('blocked')
    expect(report.checks[0].line).toContain('configuration is partly missing and partly invalid')
    expect(report.checks[0].line).toContain(`Add ${missing} in the deployment's .env.`)
    expect(report.checks[0].line).toContain(`Correct ${invalid} in the deployment's .env.`)
    expect(report.checks[0].line).not.toContain(`Correct ${missing}`)
    expect(report.checks[0].line).not.toContain(`Add ${invalid}`)
    expect(report.checks[0].line).toContain('Read /srv/accounted/.env.')
    expect(report.checks[0].line).not.toContain('short-token')
  })

  it('gives correction advice for both invalid variables', () => {
    const report = describeLeveransStatus(
      evidence({ configProblems: configProblems({ [TOKEN_ENV]: 'short-token', [ORGNR_ENV]: '556012-5791' }) }),
      NOW,
    )
    expect(report.exitCode).toBe(4)
    expect(report.headline).toContain('is configured wrong')
    expect(report.checks[0].line).toContain(`Correct ${TOKEN_ENV}`)
    expect(report.checks[0].line).toContain(`Correct ${ORGNR_ENV}`)
    expect(report.checks[0].line).not.toContain('Add')
  })

  it('says so when it found no .env at all, rather than blaming the operator', () => {
    const report = describeLeveransStatus(
      evidence({ configProblems: configProblems({ [TOKEN_ENV]: undefined }), envFile: null }),
      NOW,
    )
    expect(report.exitCode).toBe(4)
    expect(report.checks[0].line).toContain("See fork/README.md section 11, step 2. no .env found; only this shell's environment was read.")
    expect(report.checks[0].line).not.toContain('Läste')
    expect(report.checks[0].line).not.toContain('Read no .env')
  })

  it('stops at the company when the org number names none, as the delivery would', () => {
    const report = describeLeveransStatus(
      evidence({ companyProblem: 'LEVERANS_COMPANY_NOT_FOUND: inget aktivt bolag.' }),
      NOW,
    )
    expect(report.exitCode).toBe(4)
    expect(labels(report, 'blocked')).toEqual(['company'])
  })

  it('fails while bertil has never delivered an export', () => {
    const report = describeLeveransStatus(evidence({ export: null, journal: null }), NOW)
    expect(report.exitCode).toBe(2)
    expect(labels(report, 'alarm')).toEqual(['export (bertil -> Accounted)', 'answers (Accounted -> bertil)'])
  })

  it('does not accept a hand-uploaded export as proof of the delivery', () => {
    const report = describeLeveransStatus(evidence({ export: { imported_at: recently, via: 'fil' } }), NOW)
    expect(report.exitCode).toBe(2)
    expect(labels(report, 'alarm')).toEqual(['export (bertil -> Accounted)'])
  })

  it('fails while no answer has ever gone the other way, even though exports arrive', () => {
    const report = describeLeveransStatus(
      evidence({ lastAcknowledgedAt: null, journal: { senast_hamtad_at: recently, senast_antal: 0 } }),
      NOW,
    )
    expect(report.exitCode).toBe(2)
    expect(labels(report, 'alarm')).toEqual(['answers (Accounted -> bertil)'])
  })

  const stale = new Date(NOW.getTime() - (MAX_QUIET_DAYS + 1) * 86_400_000).toISOString()

  it('alarms on overdue unacknowledged answers despite fresh repeated polls and past acknowledgements', () => {
    const report = describeLeveransStatus(evidence({
      pendingAnswers: 1, oldestPendingAt: stale,
      journal: { senast_hamtad_at: recently, senast_antal: 1 },
    }), NOW)
    expect(report.exitCode).toBe(2)
    expect(labels(report, 'alarm')).toContain('waiting')
    expect(formatReport(report)).not.toContain('handed over')
  })

  it('allows pending acknowledgements within the deadline but alarms immediately after it', () => {
    const boundary = new Date(NOW.getTime() - MAX_QUIET_DAYS * 86_400_000).toISOString()
    expect(describeLeveransStatus(evidence({
      pendingAnswers: 1, oldestPendingAt: boundary,
    }), NOW).exitCode).toBe(0)
    expect(describeLeveransStatus(evidence({
      pendingAnswers: 1, oldestPendingAt: boundary,
    }), new Date(NOW.getTime() + 1)).exitCode).toBe(2)
  })

  it('does not treat repeated offers as acknowledgement evidence', () => {
    expect(describeLeveransStatus(evidence({ lastAcknowledgedAt: null }), NOW).exitCode).toBe(2)
  })

  it('treats silence as the alarm it is: an unscheduled client looks exactly like a dead one', () => {
    const report = describeLeveransStatus(
      evidence({
        export: { imported_at: stale, via: 'leverans' },
        journal: { senast_hamtad_at: stale, senast_antal: 1 },
      }),
      NOW,
    )
    expect(report.exitCode).toBe(2)
    expect(labels(report, 'alarm')).toEqual(['freshness'])
  })

  /**
   * The two halves stop independently, and each one alone is a dead delivery.
   * Measuring recency as the newest moment across both would let the half that
   * still runs hold the other one green: exit 0, and on the schedule in
   * fork/README.md section 11 step 5 a heartbeat pinging healthy every morning
   * over a direction that has been down for weeks.
   */
  it('alarms when the export stopped, even though bertil still collects answers daily', () => {
    const report = describeLeveransStatus(
      evidence({ export: { imported_at: stale, via: 'leverans' } }),
      NOW,
    )
    expect(report.exitCode).toBe(2)
    expect(labels(report, 'alarm')).toEqual(['freshness'])
    const freshness = report.checks.find((c) => c.label === 'freshness')!
    expect(freshness.line).toContain('no export has arrived since')
    expect(freshness.line).not.toContain('has not collected')
  })

  it('alarms when bertil stopped collecting, even though exports still arrive daily', () => {
    const report = describeLeveransStatus(
      evidence({ journal: { senast_hamtad_at: stale, senast_antal: 1 } }),
      NOW,
    )
    expect(report.exitCode).toBe(2)
    expect(labels(report, 'alarm')).toEqual(['freshness'])
    const freshness = report.checks.find((c) => c.label === 'freshness')!
    expect(freshness.line).toContain('has not collected answers since')
    expect(freshness.line).not.toContain('no export has arrived')
  })

  it('names both halves when both went quiet, so the log says what stopped', () => {
    const report = describeLeveransStatus(
      evidence({
        export: { imported_at: stale, via: 'leverans' },
        journal: { senast_hamtad_at: stale, senast_antal: 1 },
      }),
      NOW,
    )
    const freshness = report.checks.find((c) => c.label === 'freshness')!
    expect(freshness.line).toContain('no export has arrived since')
    expect(freshness.line).toContain('has not collected answers since')
  })

  it('reports each direction it can date, and passes only when neither is quiet', () => {
    const report = describeLeveransStatus(evidence(), NOW)
    const freshness = report.checks.find((c) => c.label === 'freshness')!
    expect(freshness.state).toBe('ok')
    expect(freshness.line).toContain('last export')
    expect(freshness.line).toContain('last collection')
  })

  it('reports every check whatever the code, so one alarm never hides another', () => {
    const report = describeLeveransStatus(
      evidence({ export: null, journal: null, pendingAnswers: 2 }),
      NOW,
    )
    expect(report.checks.map((c) => c.label)).toEqual([
      'configuration',
      'company',
      'export (bertil -> Accounted)',
      'answers (Accounted -> bertil)',
      'waiting',
    ])
  })
})

describe('where the check reads its configuration', () => {
  /**
   * The box the operator actually has after step 2: the two variables are in
   * the deployment's .env, which docker compose hands the app through
   * `env_file`, and nothing exported them into the shell that runs the check.
   * A check that only read process.env would report that box as switched off,
   * send the operator back to re-edit correct variables, and never alarm on a
   * delivery that had died: both states print the same thing.
   */
  let box: string

  beforeEach(() => {
    box = mkdtempSync(join(tmpdir(), 'leverans-box-'))
    writeFileSync(join(box, '.env'), `${TOKEN_ENV}=${TOKEN}\n${ORGNR_ENV}=${ORGNR}\n`)
    delete process.env[TOKEN_ENV]
    delete process.env[ORGNR_ENV]
  })

  afterEach(() => {
    rmSync(box, { recursive: true, force: true })
  })

  it('loads the deployment .env, because that is where the configuration lives', () => {
    expect(readLeveransConfig()).toBeNull()
    expect(loadDeploymentEnv(box)).toBe(join(box, '.env'))
    expect(readLeveransConfig()?.orgnr).toBe(CANONICAL)
  })

  it('lets the file win over a stale variable left exported in the shell', () => {
    process.env[TOKEN_ENV] = 'aStaleTokenFromAnEarlierAttempt!!'
    loadDeploymentEnv(box)
    expect(readLeveransConfig()?.token).toBe(TOKEN)
  })

  it('reports a correctly configured box as configured, not as switched off', async () => {
    const written: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })

    // 2, not 4: configured and resolving, nothing carried yet. That is the
    // answer step 2 of the switch-on documents, and exit 0 is only reachable
    // from here.
    const code = await main(box)
    stdout.mockRestore()

    expect(code).toBe(2)
    const output = written.join('')
    expect(output).toContain(join(box, '.env'))
    expect(output).not.toContain('not switched on')
    expect(output).toContain('deliveries land in company company-1')
  })

  it('says which directory it searched when there is no .env anywhere', () => {
    const empty = mkdtempSync(join(tmpdir(), 'leverans-empty-'))
    try {
      expect(loadDeploymentEnv(empty)).toBeNull()
      expect(readLeveransConfig()).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('what the workspace is told', () => {
  /** Enough context for GET /: settings for one company and the membership read. */
  function workspaceCtx(companyId: string): ExtensionContext {
    const store = new Map<string, unknown>()
    const memberships = {
      select: () => memberships,
      eq: () => memberships,
      is: async () => ({ data: [], error: null }),
    }
    return {
      userId: 'owner-1',
      companyId,
      extensionId: 'underlagsjakt',
      supabase: { from: () => memberships } as unknown as ExtensionContext['supabase'],
      emit: vi.fn(),
      settings: {
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: unknown) => {
          store.set(key, value)
        },
        clear: async (key: string) => {
          store.delete(key)
        },
      },
      storage: {} as ExtensionContext['storage'],
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      services: {} as ExtensionContext['services'],
    } as unknown as ExtensionContext
  }

  const status = async (companyId: string) =>
    (
      await parse<{ data: { leverans: { till_detta_bolag: boolean } } }>(
        await route('GET', '/').handler(request({ token: null }), workspaceCtx(companyId)),
      )
    ).body.data.leverans

  it('promises an automatic delivery only to the company that receives it', async () => {
    expect(await status('company-1')).toEqual({ till_detta_bolag: true })
    // Another company on the same box: the delivery lands elsewhere, so this
    // user is told to import the file rather than left waiting for nothing.
    expect(await status('company-2')).toEqual({ till_detta_bolag: false })
  })

  it('promises nothing while the box has no delivery configured', async () => {
    delete process.env[TOKEN_ENV]
    expect(await status('company-1')).toEqual({ till_detta_bolag: false })
  })
})
