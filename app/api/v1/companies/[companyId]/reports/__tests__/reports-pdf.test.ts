/**
 * Route-layer tests for the v1 report PDF endpoints (income-statement/pdf,
 * balance-sheet/pdf and the operational reports). Rendering is mocked: what is under test is the route
 * contract: strict query params, range validation, company-settings guard,
 * the balance gate, and the binary response headers.
 */

// TESTÄNDRING app/api/v1/companies/[companyId]/reports/__tests__/reports-pdf.test.ts: the existing income-statement/pdf and balance-sheet/pdf scenarios are unchanged; the injected FinancialStatementPDF mock return value (FINANCIAL_DOCUMENT) and the template assertions are added so those tests also prove the årsredovisning routes keep rendering FinancialStatementPDF and never the new operational ResultatrapportPDF/BalansrapportPDF.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createQueuedMockSupabase } from '@/tests/helpers'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `reports PDF route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

// Keep extension startup outside these route contract tests. Auth and scope
// enforcement still run through the real withApiV1 wrapper.
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

const mocks = vi.hoisted(() => ({
  generateBalanceSheet: vi.fn(),
  generateIncomeStatement: vi.fn(),
  renderToBuffer: vi.fn(),
  generateResultatrapport: vi.fn(),
  generateBalansrapport: vi.fn(),
  ResultatrapportPDF: vi.fn(),
  BalansrapportPDF: vi.fn(),
  FinancialStatementPDF: vi.fn(),
}))

vi.mock('@/lib/reports/balance-sheet', () => ({
  generateBalanceSheet: mocks.generateBalanceSheet,
}))
vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: mocks.generateIncomeStatement,
}))
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: mocks.renderToBuffer,
}))
vi.mock('@/lib/reports/financial-statement-pdf-template', () => ({
  FinancialStatementPDF: mocks.FinancialStatementPDF,
}))

vi.mock('@/lib/reports/resultatrapport', () => ({ generateResultatrapport: mocks.generateResultatrapport }))
vi.mock('@/lib/reports/balansrapport', () => ({ generateBalansrapport: mocks.generateBalansrapport }))
vi.mock('@/lib/reports/operational-report-pdf-template', () => ({
  ResultatrapportPDF: mocks.ResultatrapportPDF,
  BalansrapportPDF: mocks.BalansrapportPDF,
}))

import { GET as resultatrapportPdf } from '../resultatrapport/pdf/route'
import { GET as balansrapportPdf } from '../balansrapport/pdf/route'
import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as incomeStatementPdf } from '../income-statement/pdf/route'
import { GET as balanceSheetPdf } from '../balance-sheet/pdf/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FINANCIAL_DOCUMENT = createElement('div', { 'data-report': 'financial-statement' })

const PERIOD_ROW = {
  id: PERIOD_ID,
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
}

const INCOME_STATEMENT_REPORT = {
  revenue_sections: [],
  total_revenue: 100,
  expense_sections: [],
  total_expenses: 40,
  financial_sections: [],
  total_financial: 0,
  net_result: 60,
  period: { start: '2026-01-01', end: '2026-12-31' },
}

const BALANCED_BALANCE_SHEET = {
  asset_sections: [],
  total_assets: 500,
  equity_liability_sections: [],
  total_equity_liabilities: 500,
  period: { start: '2026-01-01', end: '2026-12-31' },
}

function makeReq(url: string): Request {
  return new Request(url, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

function mockClientWith(settings: TableResp = { data: { company_id: COMPANY_ID, company_name: 'Testbolaget AB' }, error: null }) {
  mockServiceClient.mockReturnValue(
    makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      fiscal_periods: { data: PERIOD_ROW, error: null },
      company_settings: settings,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
  mocks.renderToBuffer.mockResolvedValue(Buffer.from('%PDF-fixture'))
  mocks.FinancialStatementPDF.mockReturnValue(FINANCIAL_DOCUMENT)
})

describe('GET /reports/income-statement/pdf', () => {
  it('returns 401 without a bearer token', async () => {
    mockClientWith()

    const res = await incomeStatementPdf(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/income-statement/pdf?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(401)
    expect(mocks.renderToBuffer).not.toHaveBeenCalled()
  })

  it('renders a PDF for a custom range with the range in the filename', async () => {
    mockClientWith()
    mocks.generateIncomeStatement.mockResolvedValue({ ...INCOME_STATEMENT_REPORT })

    const res = await incomeStatementPdf(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/income-statement/pdf?period_id=${PERIOD_ID}&from_date=2026-01-01&to_date=2026-07-31`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain(
      'resultatrakning-2026-01-01--2026-07-31-utkast.pdf',
    )
    expect(await res.text()).toBe('%PDF-fixture')
    expect(mocks.FinancialStatementPDF).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      title: 'Resultaträkning',
      period: { start: '2026-01-01', end: '2026-07-31' },
    }))
    expect(mocks.renderToBuffer).toHaveBeenCalledExactlyOnceWith(FINANCIAL_DOCUMENT)
    expect(mocks.ResultatrapportPDF).not.toHaveBeenCalled()
    expect(mocks.BalansrapportPDF).not.toHaveBeenCalled()
    expect(mocks.generateIncomeStatement).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      PERIOD_ID,
      { fromDate: '2026-01-01', toDate: '2026-07-31' },
    )
  })

  it('rejects unknown query parameters', async () => {
    mockClientWith()

    const res = await incomeStatementPdf(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/income-statement/pdf?period_id=${PERIOD_ID}&locale=sv`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.unknown_params).toEqual(['locale'])
    expect(mocks.generateIncomeStatement).not.toHaveBeenCalled()
  })

  it('returns 404 NOT_FOUND when company settings are missing', async () => {
    mockClientWith({ data: null, error: null })

    const res = await incomeStatementPdf(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/income-statement/pdf?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(mocks.renderToBuffer).not.toHaveBeenCalled()
  })
})

describe('GET /reports/balance-sheet/pdf', () => {
  it('returns 401 without a bearer token', async () => {
    mockClientWith()

    const res = await balanceSheetPdf(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/balance-sheet/pdf?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(401)
    expect(mocks.renderToBuffer).not.toHaveBeenCalled()
  })

  it('renders the balance position as of a custom date', async () => {
    mockClientWith()
    mocks.generateBalanceSheet.mockResolvedValue({ ...BALANCED_BALANCE_SHEET })

    const res = await balanceSheetPdf(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/balance-sheet/pdf?period_id=${PERIOD_ID}&as_of=2026-07-31`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain(
      'balansrakning-2026-01-01--2026-07-31-utkast.pdf',
    )
    expect(await res.text()).toBe('%PDF-fixture')
    expect(mocks.FinancialStatementPDF).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      title: 'Balansräkning',
      period: { start: '2026-01-01', end: '2026-07-31' },
    }))
    expect(mocks.renderToBuffer).toHaveBeenCalledExactlyOnceWith(FINANCIAL_DOCUMENT)
    expect(mocks.ResultatrapportPDF).not.toHaveBeenCalled()
    expect(mocks.BalansrapportPDF).not.toHaveBeenCalled()
    expect(mocks.generateBalanceSheet).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      PERIOD_ID,
      { fromDate: undefined, toDate: '2026-07-31' },
    )
  })

  it('refuses to render an unbalanced balansräkning', async () => {
    mockClientWith()
    mocks.generateBalanceSheet.mockResolvedValue({
      ...BALANCED_BALANCE_SHEET,
      total_equity_liabilities: 400,
    })

    const res = await balanceSheetPdf(
      makeReq(
        `https://x.test/api/v1/companies/${COMPANY_ID}/reports/balance-sheet/pdf?period_id=${PERIOD_ID}`,
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('REPORT_GENERATION_FAILED')
    expect(mocks.renderToBuffer).not.toHaveBeenCalled()
  })
})

describe.each([
  { slug: 'resultatrapport', get: resultatrapportPdf, generate: mocks.generateResultatrapport, template: mocks.ResultatrapportPDF },
  { slug: 'balansrapport', get: balansrapportPdf, generate: mocks.generateBalansrapport, template: mocks.BalansrapportPDF },
])('GET /reports/$slug/pdf', ({ slug, get, generate, template }) => {
  const url = (query = `period_id=${PERIOD_ID}`) =>
    `https://example.com/api/v1/companies/${COMPANY_ID}/reports/${slug}/pdf?${query}`
  const call = (query?: string) => get(makeReq(url(query)), companyParams(COMPANY_ID))

  const report = {
    groups: [],
    period: { start: '2026-01-01', end: '2026-12-31' },
    prior_period: null,
  }
  const document = createElement('div', { 'data-report': slug })

  beforeEach(() => {
    mockClientWith()
    generate.mockResolvedValue(report)
    template.mockReturnValue(document)
  })

  it('test__when_bearer_token_is_missing__then_returns_401', async () => {
    const res = await get(new Request(url()), companyParams(COMPANY_ID))
    expect(res.status).toBe(401)
    expect(generate).not.toHaveBeenCalled()
  })

  it('test__when_api_key_is_invalid__then_returns_401', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await call()).status).toBe(401)
    expect(generate).not.toHaveBeenCalled()
  })

  it('test__when_reports_read_scope_is_missing__then_returns_403', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', scopes: ['invoices:read'], mode: 'live' })
    const res = await call()
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('INSUFFICIENT_SCOPE')
    expect(generate).not.toHaveBeenCalled()
  })

  it('test__when_company_membership_is_missing__then_returns_404', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: { data: null } }))
    expect((await call()).status).toBe(404)
    expect(generate).not.toHaveBeenCalled()
  })

  it.each(['', 'period_id=invalid', `period_id=${PERIOD_ID}&from_date=2025-01-01`,
    `period_id=${PERIOD_ID}&from_date=2026-07-01&to_date=2026-01-01`,
    `period_id=${PERIOD_ID}&unexpected=true`,
  ])('test__when_query_is_invalid_%s__then_returns_400', async (query) => {
    const res = await call(query)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(generate).not.toHaveBeenCalled()
  })

  it('test__when_period_is_absent_or_foreign__then_returns_404', async () => {
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' } },
      fiscal_periods: { data: null },
    }))
    expect((await call()).status).toBe(404)
    expect(generate).not.toHaveBeenCalled()
  })

  it('test__when_company_settings_are_missing__then_returns_404', async () => {
    mockClientWith({ data: null })
    expect((await call()).status).toBe(404)
    expect(template).not.toHaveBeenCalled()
  })

  it('test__when_request_is_valid__then_returns_operational_pdf_with_private_binary_headers', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain(`${slug}-2026-01-01--2026-12-31.pdf`)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Content-Length')).toBe(String(Buffer.byteLength('%PDF-fixture')))
    expect(await res.text()).toBe('%PDF-fixture')
    expect(template).toHaveBeenCalledWith(expect.objectContaining({
      report,
      company: expect.objectContaining({ company_id: COMPANY_ID }),
    }))
    expect(mocks.renderToBuffer).toHaveBeenCalledExactlyOnceWith(document)
    expect(mocks.FinancialStatementPDF).not.toHaveBeenCalled()
    expect(generate).toHaveBeenCalledExactlyOnceWith(expect.anything(), COMPANY_ID, PERIOD_ID,
      slug === 'resultatrapport' ? { dimensions: undefined } : {})
  })

  it('test__when_company_is_requested__then_scopes_period_and_settings_to_that_company', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: { company_id: COMPANY_ID, role: 'owner' } })
    q.enqueue({ data: PERIOD_ROW })
    q.enqueue({ data: { company_id: COMPANY_ID, company_name: 'Example AB' } })
    mockServiceClient.mockReturnValue(q.supabase)
    expect((await call()).status).toBe(200)
    expect(q.findCalls('fiscal_periods', 'eq')).toEqual([
      ['id', PERIOD_ID], ['company_id', COMPANY_ID],
    ])
    expect(q.findCalls('company_settings', 'eq')).toEqual([['company_id', COMPANY_ID]])
  })

  it('test__when_date_window_is_requested__then_passes_it_to_generator_and_filename', async () => {
    generate.mockResolvedValue({ groups: [], period: { start: '2026-03-01', end: '2026-07-31' } })
    const res = await call(`period_id=${PERIOD_ID}&from_date=2026-03-01&to_date=2026-07-31`)
    expect(res.status).toBe(200)
    expect(generate).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, PERIOD_ID,
      expect.objectContaining({ fromDate: '2026-03-01', toDate: '2026-07-31' }))
    expect(res.headers.get('Content-Disposition')).toContain(`${slug}-2026-03-01--2026-07-31.pdf`)
  })

  it('test__when_generation_or_rendering_fails__then_returns_500_in_v1_envelope', async () => {
    generate.mockRejectedValueOnce(new Error('Generation failed'))
    const generation = await call()
    expect(generation.status).toBe(500)
    expect((await generation.json()).error.code).toBe('REPORT_GENERATION_FAILED')
    mocks.renderToBuffer.mockRejectedValueOnce(new Error('Rendering failed'))
    const rendering = await call()
    expect(rendering.status).toBe(500)
    expect((await rendering.json()).error.code).toBe('REPORT_GENERATION_FAILED')
  })

  it('test__when_dimensions_are_requested__then_validates_support_and_discloses_filter', async () => {
    const incomplete = await call(`period_id=${PERIOD_ID}&dim_no=6`)
    expect(incomplete.status).toBe(400)
    const filtered = await call(`period_id=${PERIOD_ID}&dim_no=6&dim_code=P001`)
    if (slug === 'balansrapport') {
      expect(filtered.status).toBe(400)
      expect(generate).not.toHaveBeenCalled()
    } else {
      expect(filtered.status).toBe(200)
      expect(generate).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, PERIOD_ID,
        expect.objectContaining({ dimensions: { '6': 'P001' } }))
      expect(template).toHaveBeenCalledWith(expect.objectContaining({
        filterNote: 'Filtrerad (dimension 6: P001), ej fullständig rapport',
      }))
      expect(filtered.headers.get('Content-Disposition')).toContain('resultatrapport-dim6-p001-')
    }
  })
})
