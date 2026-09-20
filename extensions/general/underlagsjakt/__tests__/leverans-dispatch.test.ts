/**
 * The delivery through the real dispatcher, with no session anywhere.
 *
 * This is the bug the machine path exists to fix, tested where it happened.
 * bertil's client posts to `/api/extensions/ext/underlagsjakt/export`, and
 * that URL is served by `app/api/extensions/ext/[...path]/route.ts`, which
 * calls `requireAuth()` (a Supabase cookie session plus the MFA gate) before
 * it ever reaches an extension handler. A machine has neither, so the
 * delivery could only answer 401 (verified 2026-09-20).
 *
 * What was already covered, and what was not:
 *   - `leverans.test.ts` exercises the rules of the machine path by invoking
 *     the handlers directly, and guards the dispatcher contract with one
 *     assertion: that only the machine routes carry `skipAuth`.
 *     That does catch a route losing the flag, but it reads the route table,
 *     not the dispatcher, so it passes unchanged if the dispatcher stops
 *     honouring `skipAuth`.
 *   - The dispatcher's own suite has a single `skipAuth` case, and it
 *     registers a synthetic extension to assert that the branch returns ahead
 *     of the paywall gate; it does not run without a session.
 *
 * So no test composed the two: this extension's delivery, arriving at the URL
 * bertil posts to, with nothing but its token. These do, driving the
 * dispatcher's exported `GET`/`POST`/`DELETE` with `createClient` returning a
 * client that has no user. Any regression that routes the delivery back
 * through the session gate turns into a 401 here.
 *
 * The same session-less caller is what makes the negative cases mean
 * something: the delivery token opens exactly the two delivery routes, and
 * every other route of this extension still answers the session gate's own
 * 401 to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { ORGNR_ENV, TOKEN_ENV } from '@/extensions/general/underlagsjakt/lib/leverans'
import { createLeveransSupabaseSlice, type LeveransSupabaseSlice } from './supabase-slice'
import fixture from './fixtures/export-1.1.json'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const serviceClient = vi.fn()
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => serviceClient(),
}))

import { createClient } from '@/lib/supabase/server'
import { extensionRegistry } from '@/lib/extensions/registry'
import { GET, POST, DELETE } from '@/app/api/extensions/ext/[...path]/route'

const { underlagsjaktExtension } = await import('@/extensions/general/underlagsjakt')

const mockCreateClient = vi.mocked(createClient)

const TOKEN = 'kLq7Z2m9Xr4vBn6TpW8sEyHu3Ac1Df5G'
const ORGNR = '556012-5790'
const CANONICAL = '5560125790'

/** The dispatcher takes the URL tail as params; mirror how Next.js supplies it. */
const pathParams = (...path: string[]) => ({ params: Promise.resolve({ path }) })

const url = (...path: string[]) => `/api/extensions/ext/${path.join('/')}`

/** A caller with the delivery token and nothing else: no cookie, no session. */
function machineRequest(path: string[], init: { method?: string; body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = {}
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? TOKEN}`
  return createMockRequest(url(...path), {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  })
}

const methods = { GET, POST, DELETE }

// The database stand-in is shared with leverans.test.ts (./supabase-slice.ts),
// which drives these same handlers directly: one stand-in, so the two files
// cannot drift into disagreeing about what the delivery reads and writes.
let slice: LeveransSupabaseSlice

beforeEach(() => {
  vi.clearAllMocks()
  slice = createLeveransSupabaseSlice()
  serviceClient.mockImplementation(() => slice.client())

  // No session: `requireAuth()` answers 401 for anything that reaches it.
  // Deliberately the *only* client the request-cookie path can get, so a
  // delivery that ever routed through it would fail loudly here. The MFA gate
  // is left real: it runs after the user check, so it is unreachable from
  // here, and a 401 below can only mean "no user".
  mockCreateClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  } as never)

  process.env[TOKEN_ENV] = TOKEN
  process.env[ORGNR_ENV] = ORGNR

  // The dispatcher resolves the extension through the registry, so the real
  // extension has to be in it: an unregistered one answers 404 and would hide
  // whatever the auth chain does.
  extensionRegistry.clear()
  extensionRegistry.register(underlagsjaktExtension)
})

afterEach(() => {
  extensionRegistry.clear()
  delete process.env[TOKEN_ENV]
  delete process.env[ORGNR_ENV]
})

describe('bertil delivering through the extension dispatcher', () => {
  it('accepts the export on the URL bertil already posts to, with no session', async () => {
    const request = machineRequest(['underlagsjakt', 'export'], { method: 'POST', body: fixture })
    const response = await POST(request, pathParams('underlagsjakt', 'export'))
    const { status, body } = await parseJsonResponse<{ data: { posts: number; export_version: string } }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ posts: 3, export_version: '1.1' })

    // The company comes from the server's configuration, never from the call:
    // the only org number that reached the lookup is the configured one, in
    // both its stored spellings, and the posted body carries none at all.
    expect(slice.inFilters).toEqual([CANONICAL, ORGNR])
    expect(JSON.stringify(fixture)).not.toContain(CANONICAL)

    const stored = slice.dataRows.find((r) => r.key === 'export')!
    expect(stored.company_id).toBe('company-1')
    expect(stored.extension_id).toBe('underlagsjakt')
    expect(stored.value).toMatchObject({ imported_via: 'leverans' })
  })

  it('hands the answers back on the same machine credential, with no session', async () => {
    await POST(
      machineRequest(['underlagsjakt', 'export'], { method: 'POST', body: fixture }),
      pathParams('underlagsjakt', 'export'),
    )
    slice.dataRows.find((r) => r.key === 'svar')!.value = {
      'tx-moank-20260821': {
        beslut: { transaction_id: 'tx-moank-20260821', svarstyp: 'osaker' },
        reglering: null,
        post: {},
        besvarad_at: '2026-09-19T08:00:00.000Z',
        besvarad_av: 'owner-1',
        levererad_at: null,
      },
    }

    const response = await GET(
      machineRequest(['underlagsjakt', 'svar']),
      pathParams('underlagsjakt', 'svar'),
    )
    const { status, body } = await parseJsonResponse<{ beslut: { transaction_id: string }[] }>(response)

    expect(status).toBe(200)
    expect(body.beslut.map((b) => b.transaction_id)).toEqual(['tx-moank-20260821'])
    // No acknowledgement after a failed consumer: the next poll must retry.
    const retry = await GET(machineRequest(['underlagsjakt', 'svar']), pathParams('underlagsjakt', 'svar'))
    expect(await retry.json()).toEqual(body)
    // A later export reopens the question without consuming its saved answer.
    const reexport = await POST(
      machineRequest(['underlagsjakt', 'export'], {
        method: 'POST', body: { ...fixture, generated_at: '2026-09-27T08:00:00.000Z' },
      }),
      pathParams('underlagsjakt', 'export'),
    )
    expect(reexport.status).toBe(200)
    expect((await reexport.json()).data.posts).toBe(3)
    const retained = await GET(machineRequest(['underlagsjakt', 'svar']), pathParams('underlagsjakt', 'svar'))
    expect(await retained.json()).toEqual(body)
    const ack = await POST(
      machineRequest(['underlagsjakt', 'svar', 'kvittens'], {
        method: 'POST', body: { transaction_id: 'tx-moank-20260821' },
      }),
      pathParams('underlagsjakt', 'svar', 'kvittens'),
    )
    expect(ack.status).toBe(200)
    const after = await GET(machineRequest(['underlagsjakt', 'svar']), pathParams('underlagsjakt', 'svar'))
    expect((await after.json()).beslut).toEqual([])
  })

  it('answers the delivery 401, not the session 401, when the token is missing', async () => {
    const response = await POST(
      machineRequest(['underlagsjakt', 'export'], { method: 'POST', body: fixture, token: null }),
      pathParams('underlagsjakt', 'export'),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(401)
    // The delivery's own gate ran, so the route really did bypass the session
    // dispatcher rather than merely happening to fail in the same place.
    expect(body.error.code).toBe('LEVERANS_TOKEN_MISSING')
    expect(slice.dataRows).toEqual([])
  })

  it('stores nothing for a token that is not the configured one', async () => {
    const response = await POST(
      machineRequest(['underlagsjakt', 'export'], {
        method: 'POST',
        body: fixture,
        token: 'not-the-token-but-long-enough-x',
      }),
      pathParams('underlagsjakt', 'export'),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(401)
    expect(body.error.code).toBe('LEVERANS_TOKEN_INVALID')
    expect(slice.dataRows).toEqual([])
  })

  /**
   * Every route of this extension that is not one of the delivery routes,
   * so "the token opens nothing else" is a statement about the whole surface
   * rather than a sample of it. Keep this list in step with
   * `underlagsjaktExtension.apiRoutes`; the completeness check below fails if
   * a route is added and not listed here.
   */
  const humanRoutes = [
    ['GET', ['underlagsjakt'], undefined],
    ['POST', ['underlagsjakt', 'export', 'fil'], fixture],
    ['POST', ['underlagsjakt', 'svar'], { svarstyp: 'osaker', transaction_id: 'tx-moank-20260821' }],
    ['DELETE', ['underlagsjakt', 'svar', 'tx-moank-20260821'], undefined],
    ['GET', ['underlagsjakt', 'svarsfil'], undefined],
    ['POST', ['underlagsjakt', 'svarsfil', 'levererad'], { transaction_ids: ['tx-moank-20260821'] }],
  ] as const

  it.each(humanRoutes)(
    'still requires a logged-in human for %s %s: the delivery token opens nothing else',
    async (method, path, body) => {
      const request = machineRequest([...path], { method, body })
      const response = await methods[method](request, pathParams(...path))
      const parsed = await parseJsonResponse<{ error: string }>(response)

      expect(parsed.status).toBe(401)
      // The session gate's own envelope (`requireAuth()` returns a plain
      // string), not the delivery's `{ error: { code } }`: proof the request
      // was turned away for having no session, not for its token.
      expect(parsed.body.error).toBe('Unauthorized')
      expect(slice.dataRows).toEqual([])
    },
  )

  it('covers every route that is not a delivery route', () => {
    const listed = humanRoutes.map(([method, path]) => `${method} /${path.slice(1).join('/')}`)
    const actual = underlagsjaktExtension
      .apiRoutes!.filter((r) => !r.skipAuth)
      // `:param` patterns are listed above with a concrete id in their place.
      .map((r) => `${r.method} ${r.path.replace(':transactionId', 'tx-moank-20260821')}`)

    expect(listed.slice().sort()).toEqual(actual.slice().sort())
  })
})
