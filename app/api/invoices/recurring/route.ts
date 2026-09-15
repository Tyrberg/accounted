import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { CreateRecurringScheduleSchema } from '@/lib/api/schemas'
import { createRecurringSchedule } from '@/lib/invoices/create-recurring-schedule'

ensureInitialized()

export const GET = withRouteContext(
  'recurring_invoice.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    const { data, error } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, customer:customers(id,name,email), items:recurring_invoice_schedule_items(*)')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (error) {
      log.error('failed to list recurring schedules', error)
      return errorResponse(error, log, { requestId })
    }
    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'recurring_invoice.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', type: 'validation_error' },
        { status: 400 },
      )
    }

    const parsed = CreateRecurringScheduleSchema.safeParse(rawBody)
    if (!parsed.success) {
      log.warn('recurring schedule validation failed', {
        issueCount: parsed.error.issues.length,
      })
      return NextResponse.json(
        {
          error: 'Validation failed',
          type: 'validation_error',
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        },
        { status: 400 },
      )
    }
    const input = parsed.data

    // Verify the customer belongs to this company (defense in depth + clearer
    // 404 than the FK violation we'd otherwise get).
    const { data: customer } = await supabase
      .from('customers')
      .select('id, email')
      .eq('id', input.customer_id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!customer) {
      return NextResponse.json(
        { error: 'Customer not found', type: 'not_found' },
        { status: 404 },
      )
    }

    // auto_send without a customer email would silently degrade to a monthly
    // draft + warning at cron time. Reject it up front instead; the dialog
    // blocks this client-side, so this is the API backstop.
    if (input.auto_send && !customer.email) {
      return NextResponse.json(
        {
          error: 'Customer has no email address: automatic sending requires one',
          type: 'validation_error',
        },
        { status: 400 },
      )
    }

    const created = await createRecurringSchedule(supabase, {
      companyId,
      userId: user.id,
      input,
    })

    if (!created.ok) {
      if ('dbError' in created) {
        log.error('failed to create recurring schedule', created.dbError as Error)
        return errorResponse(created.dbError, log, { requestId })
      }
      return errorResponseFromCode(created.code, log, { requestId, details: created.details })
    }

    const { data: complete } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, customer:customers(id,name,email), items:recurring_invoice_schedule_items(*)')
      .eq('id', created.scheduleId)
      .single()

    return NextResponse.json({ data: complete }, { status: 201 })
  },
  { requireWrite: true },
)
