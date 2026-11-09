import { z } from 'zod'
import { renderToBuffer } from '@react-pdf/renderer'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { assertKnownQueryParams, loadPeriodFromQuery, loadRangeFromQuery, safeGenerate } from '@/lib/api/v1/report-period'
import { contentDisposition } from '@/lib/api/content-disposition'
import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { ResultatrapportPDF } from '@/lib/reports/operational-report-pdf-template'
import { parseDimensionFilterParams, dimensionFilterDisclosure, dimensionFilterFileSuffix } from '@/lib/reports/dimension-filter'
import type { CompanySettings } from '@/types'

const ALLOWED_PARAMS = ['period_id', 'from_date', 'to_date', 'dim_no', 'dim_code'] as const

registerEndpoint({
  operation: 'reports.resultatrapport.pdf',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/resultatrapport/pdf',
  summary: 'Operational Resultatrapport as a PDF.',
  description:
    'Per-account operational report with comparison figures and no annual-report draft disclaimer. Requires `period_id`; optional `from_date` / `to_date` (YYYY-MM-DD) must be within the fiscal period. Optional `dim_no` / `dim_code` must be supplied together; filtered reports disclose the partial view and omit the comparison.',
  useWhen: 'You need an interim Resultatrapport PDF for reconciliation or a bank request.',
  doNotUseFor: 'The formal annual-report financial statement or machine-readable figures.',
  pitfalls: ['Unknown query parameters are rejected. The date range must lie within the fiscal period.'],
  example: { response: { _note: 'Returns an application/pdf binary stream.' } },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.unknown(), contentType: 'application/pdf' },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.resultatrapport.pdf',
  async (request, ctx) => {
    const params = await assertKnownQueryParams(request, ALLOWED_PARAMS, ctx)
    if (!params.ok) return params.response

    const period = await loadPeriodFromQuery(request, {
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      requestId: ctx.requestId,
      log: ctx.log,
    })
    if (!period.ok) return period.response

    const range = await loadRangeFromQuery(request, period.period, ctx)
    if (!range.ok) return range.response

    const filter = parseDimensionFilterParams(new URL(request.url).searchParams)
    if (!filter.ok) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { fields: ['dim_no', 'dim_code'], message: filter.error },
      })
    }

    const { data: company, error } = await ctx.supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!company) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'company_settings' },
      })
    }

    const generated = await safeGenerate(
      () => generateResultatrapport(ctx.supabase, ctx.companyId!, period.period.id, { ...range.range, dimensions: filter.dimensions }),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'resultatrapport-pdf' },
    )
    if (!generated.ok) return generated.response
    const report = generated.result

    let pdfBuffer: Buffer
    try {
      pdfBuffer = await renderToBuffer(
        ResultatrapportPDF({
          report,
          company: company as CompanySettings,
          generatedAt: new Date().toISOString(),
          filterNote: dimensionFilterDisclosure(filter.dimensions) ?? undefined,
        }),
      )
    } catch (err) {
      ctx.log.error('reports.resultatrapport.pdf: render failed', err as Error)
      return v1ErrorResponseFromCode('REPORT_GENERATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { report: 'resultatrapport-pdf', reason: 'PDF rendering failed.' },
      })
    }

    const filename = `resultatrapport${dimensionFilterFileSuffix(filter.dimensions)}-${report.period.start}--${report.period.end}.pdf`
    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('attachment', filename),
        'Content-Length': String(pdfBuffer.length),
        'Cache-Control': 'private, no-store',
        'X-Request-Id': ctx.requestId,
      },
    })
  },
)
