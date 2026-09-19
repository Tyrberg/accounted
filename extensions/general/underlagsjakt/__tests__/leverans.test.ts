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
 *   - answers go out exactly once
 *   - the box can tell a delivery that runs from one that was configured and
 *     never called, which is what leverans-status.ts reports on
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ORGNR_ENV,
  TOKEN_ENV,
  authenticateLeverans,
  extractLeveransToken,
  leveransTargetsCompany,
  readLeveransConfig,
} from '@/extensions/general/underlagsjakt/lib/leverans'
import {
  MAX_QUIET_DAYS,
  describeLeveransStatus,
  type LeveransEvidence,
} from '@/extensions/general/underlagsjakt/leverans-status'
import type { ExtensionContext } from '@/lib/extensions/types'
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

// ── A Supabase stand-in with just the three tables this path touches ──

interface DataRow {
  user_id: string
  company_id: string
  extension_id: string
  key: string
  value: unknown
}

let companyRows: { id: string }[]
let companyError: { message: string } | null
let ownerRow: { user_id: string } | null
let dataRows: DataRow[]
let inFilters: unknown[]

function companiesChain() {
  const chain = {
    select: () => chain,
    in: (_col: string, values: unknown[]) => {
      inFilters = values
      return chain
    },
    is: () => Promise.resolve({ data: companyRows, error: companyError }),
  }
  return chain
}

function membersChain() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: ownerRow, error: null }),
  }
  return chain
}

function extensionDataChain() {
  const filters: Record<string, string> = {}
  const chain = {
    select: () => chain,
    eq: (column: string, value: string) => {
      filters[column] = value
      return chain
    },
    single: async () => {
      const row = dataRows.find(
        (r) =>
          r.company_id === filters.company_id &&
          r.extension_id === filters.extension_id &&
          r.key === filters.key,
      )
      return { data: row ? { value: row.value } : null, error: row ? null : { message: 'no rows' } }
    },
    upsert: async (row: DataRow) => {
      const index = dataRows.findIndex(
        (r) => r.company_id === row.company_id && r.extension_id === row.extension_id && r.key === row.key,
      )
      const stored = { ...row, value: JSON.parse(JSON.stringify(row.value)) }
      if (index >= 0) dataRows[index] = stored
      else dataRows.push(stored)
      return { error: null }
    },
  }
  return chain
}

function makeClient() {
  return {
    from: (table: string) =>
      table === 'companies'
        ? companiesChain()
        : table === 'company_members'
          ? membersChain()
          : extensionDataChain(),
  } as never
}

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

const storedValue = (key: string) => dataRows.find((r) => r.key === key)?.value as Record<string, unknown> | undefined

beforeEach(() => {
  vi.clearAllMocks()
  companyRows = [{ id: 'company-1' }]
  companyError = null
  ownerRow = { user_id: 'owner-1' }
  dataRows = []
  inFilters = []
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
    companyRows = []
    expect(await targets('company-1')).toBe(false)
  })

  it('says no when the org number matches several companies, as the delivery would refuse', async () => {
    companyRows = [{ id: 'company-1' }, { id: 'company-2' }]
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
    expect(inFilters).toEqual([CANONICAL, '556012-5790'])
  })

  it('stops rather than guessing when the org number matches several companies', async () => {
    companyRows = [{ id: 'company-1' }, { id: 'company-2' }]
    const result = await auth()
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { status, body } = await parse<{ error: { code: string } }>(result.response)
    expect(status).toBe(503)
    expect(body.error.code).toBe('LEVERANS_COMPANY_AMBIGUOUS')
  })

  it('says which env var to fix when no company matches', async () => {
    companyRows = []
    const result = await auth()
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { body } = await parse<{ error: { code: string; message: string } }>(result.response)
    expect(body.error.code).toBe('LEVERANS_COMPANY_NOT_FOUND')
    expect(body.error.message).toContain(ORGNR_ENV)
  })

  it('refuses when the company lookup itself failed', async () => {
    companyError = { message: 'boom' }
    const result = await auth()
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { body } = await parse<{ error: { code: string } }>(result.response)
    expect(body.error.code).toBe('LEVERANS_COMPANY_LOOKUP_FAILED')
  })

  it('refuses when the company has no owner to attribute the write to', async () => {
    ownerRow = null
    const result = await auth()
    expect(result.ok).toBe(false)
    if (result.ok) return
    const { body } = await parse<{ error: { code: string } }>(result.response)
    expect(body.error.code).toBe('LEVERANS_OWNER_NOT_FOUND')
  })
})

describe('the delivery routes', () => {
  it('are the only two that bypass the session dispatcher', () => {
    const machine = underlagsjaktExtension
      .apiRoutes!.filter((r) => r.skipAuth)
      .map((r) => `${r.method} ${r.path}`)
    expect(machine).toEqual(['POST /export', 'GET /svar'])
  })

  it("POST /export stores bertil's export on the configured company", async () => {
    const res = await route('POST', '/export').handler(request({ body: fixture }))
    const { status, body } = await parse<{ data: { posts: number; export_version: string } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ posts: 3, export_version: '1.1' })

    const row = dataRows.find((r) => r.key === 'export')!
    expect(row.company_id).toBe('company-1')
    expect(row.user_id).toBe('owner-1')
    expect(row.extension_id).toBe('underlagsjakt')
    expect(storedValue('export')).toMatchObject({ export_version: '1.1', imported_via: 'leverans' })
  })

  it('POST /export refuses a wrong token before touching any state', async () => {
    const res = await route('POST', '/export').handler(request({ token: 'not-the-token-but-long-enough-x', body: fixture }))
    expect(res.status).toBe(401)
    expect(dataRows).toEqual([])
  })

  it('POST /export still checks the contract version', async () => {
    const res = await route('POST', '/export').handler(request({ body: { ...fixture, export_version: '1.0' } }))
    const { status, body } = await parse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('UNSUPPORTED_VERSION')
    expect(dataRows).toEqual([])
  })

  it('GET /svar hands over the pending answers once and marks them delivered', async () => {
    await route('POST', '/export').handler(request({ body: fixture }))
    // The import writes an (empty) svar row of its own; answer one post in it.
    dataRows.find((r) => r.key === 'svar')!.value = {
      'tx-moank-20260821': {
        beslut: { transaction_id: 'tx-moank-20260821', svarstyp: 'osaker' },
        reglering: null,
        post: {},
        besvarad_at: '2026-09-19T08:00:00.000Z',
        besvarad_av: 'owner-1',
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
    expect(svar['tx-moank-20260821'].levererad_at).not.toBeNull()

    const second = await parse<{ beslut: unknown[] }>(await route('GET', '/svar').handler(request()))
    expect(second.body.beslut).toEqual([])
  })

  it('POST /export answers the documented preflight: 400 for a rejected body, nothing stored', async () => {
    // fork/README.md section 11 tells the operator to probe the configuration
    // with an empty body and read 400 as "token and company are right".
    const res = await route('POST', '/export').handler(request({ body: {} }))
    expect(res.status).toBe(400)
    expect(dataRows).toEqual([])
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
    const empty = storedValue('leverans') as { senast_antal: number; totalt_antal: number; senast_hamtad_at: string }
    expect(empty.senast_antal).toBe(0)
    expect(empty.totalt_antal).toBe(0)
    expect(Date.parse(empty.senast_hamtad_at)).not.toBeNaN()

    dataRows.find((r) => r.key === 'svar')!.value = {
      'tx-moank-20260821': {
        beslut: { transaction_id: 'tx-moank-20260821', svarstyp: 'osaker' },
        reglering: null,
        post: {},
        besvarad_at: '2026-09-19T08:00:00.000Z',
        besvarad_av: 'owner-1',
        levererad_at: null,
      },
    }
    await route('GET', '/svar').handler(request())
    expect(storedValue('leverans')).toMatchObject({ senast_antal: 1, totalt_antal: 1 })

    // The total is what proves an answer ever reached bertil, so it counts up
    // rather than tracking only the last call.
    await route('GET', '/svar').handler(request())
    expect(storedValue('leverans')).toMatchObject({ senast_antal: 0, totalt_antal: 1 })
  })
})

describe('describeLeveransStatus', () => {
  const NOW = new Date('2026-09-21T07:00:00.000Z')
  const recently = '2026-09-21T04:17:00.000Z'

  const evidence = (overrides: Partial<LeveransEvidence> = {}): LeveransEvidence => ({
    configured: true,
    companyProblem: null,
    companyId: 'company-1',
    export: { imported_at: recently, via: 'leverans' },
    journal: { senast_hamtad_at: recently, senast_antal: 1, totalt_antal: 3 },
    pendingAnswers: 0,
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
    const report = describeLeveransStatus(evidence({ configured: false }), NOW)
    expect(report.exitCode).toBe(4)
    expect(report.checks[0].line).toContain(TOKEN_ENV)
    expect(report.checks[0].line).toContain(ORGNR_ENV)
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
      evidence({ journal: { senast_hamtad_at: recently, senast_antal: 0, totalt_antal: 0 } }),
      NOW,
    )
    expect(report.exitCode).toBe(2)
    expect(labels(report, 'alarm')).toEqual(['answers (Accounted -> bertil)'])
  })

  it('treats silence as the alarm it is: an unscheduled client looks exactly like a dead one', () => {
    const stale = new Date(NOW.getTime() - (MAX_QUIET_DAYS + 1) * 86_400_000).toISOString()
    const report = describeLeveransStatus(
      evidence({
        export: { imported_at: stale, via: 'leverans' },
        journal: { senast_hamtad_at: stale, senast_antal: 1, totalt_antal: 3 },
      }),
      NOW,
    )
    expect(report.exitCode).toBe(2)
    expect(labels(report, 'alarm')).toEqual(['freshness'])
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
