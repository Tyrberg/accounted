import { z } from 'zod'
import { ISO_DATE_RE, ISO_DATE_MESSAGE_SV } from '@/lib/invariants/iso-date'

/**
 * Lease revenue-account override: BAS class 3 ONLY.
 *
 * The general recurring-schedule-item override (INVOICE_POSTING_ACCOUNT_REGEX,
 * lib/invoices/posting-account.ts) accepts class 1-3, because a manually
 * built recurring invoice can legitimately carry a zero-VAT class 1-2 line
 * (a deposit, an advance, an outlay). A lease's rent/tillägg line is never
 * that: depositioner are explicitly out of scope for this chain (filed as a
 * follow-up), so every line propmate ever writes is ordinary revenue. Class
 * 1-2 therefore has no legitimate use here and is refused at the schema
 * layer, not just by the shared validator: a class 1-2 account on a
 * VAT-bearing lease line would divert the tax base off a 3xxx account and
 * silently zero out ruta 05 while doubling ruta 10/11/12 every month the
 * schedule fires, which is exactly the failure this narrower regex prevents
 * regardless of which lease-sync code path runs.
 */
export const LEASE_REVENUE_ACCOUNT_REGEX = /^3\d{3}$/

const isoDate = z.string().regex(ISO_DATE_RE, ISO_DATE_MESSAGE_SV)

export const LeaseAdditionSchema = z.object({
  description: z.string().min(1, 'Beskrivning krävs').max(200),
  amount: z.number().nonnegative('Tillägget kan inte vara negativt'),
})

export const CreateLeaseSchema = z.object({
  customer_id: z.string().uuid(),
  property_name: z.string().min(1, 'Fastighetsnamn krävs').max(200),
  unit_description: z.string().max(200).nullable().optional(),
  monthly_rent: z.number().nonnegative('Grundhyran kan inte vara negativ'),
  // Itemized supplements (el, värme, gemensamma utrymmen, ...), each becomes
  // its own line on the linked recurring schedule.
  additions: z.array(LeaseAdditionSchema).default([]),
  campaign_price_amount: z.number().nonnegative().nullable().optional(),
  campaign_start_date: isoDate.nullable().optional(),
  campaign_end_date: isoDate.nullable().optional(),
  // KPI-index avtalsklausul: reference data only. No automatic uppräkning
  // is computed from these fields (follow-up task); a human edits
  // monthly_rent when the clause falls due.
  kpi_base_index: z.number().nonnegative().nullable().optional(),
  kpi_base_year: z.number().int().nullable().optional(),
  kpi_next_review_date: isoDate.nullable().optional(),
  // Lokalhyra is momsfri (0) by default; 25 only once the landlord has
  // frivillig skattskyldighet för uthyrning. There is no third VAT rate
  // for rent.
  vat_rate: z.union([z.literal(0), z.literal(25)]).default(0),
  revenue_account: z.string().regex(LEASE_REVENUE_ACCOUNT_REGEX).nullable().optional(),
  day_of_month: z.number().int().min(1).max(28).default(1),
  auto_send: z.boolean().default(false),
  start_date: isoDate,
  end_date: isoDate.nullable().optional(),
})

export const UpdateLeaseSchema = z.object({
  customer_id: z.string().uuid().optional(),
  property_name: z.string().min(1).max(200).optional(),
  unit_description: z.string().max(200).nullable().optional(),
  monthly_rent: z.number().nonnegative().optional(),
  additions: z.array(LeaseAdditionSchema).optional(),
  campaign_price_amount: z.number().nonnegative().nullable().optional(),
  campaign_start_date: isoDate.nullable().optional(),
  campaign_end_date: isoDate.nullable().optional(),
  kpi_base_index: z.number().nonnegative().nullable().optional(),
  kpi_base_year: z.number().int().nullable().optional(),
  kpi_next_review_date: isoDate.nullable().optional(),
  vat_rate: z.union([z.literal(0), z.literal(25)]).optional(),
  revenue_account: z.string().regex(LEASE_REVENUE_ACCOUNT_REGEX).nullable().optional(),
  day_of_month: z.number().int().min(1).max(28).optional(),
  auto_send: z.boolean().optional(),
  start_date: isoDate.optional(),
  end_date: isoDate.nullable().optional(),
  status: z.enum(['active', 'ended']).optional(),
}).superRefine((changes, ctx) => {
  if (Object.keys(changes).length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one field must be supplied' })
  }
})

export type CreateLeaseInput = z.infer<typeof CreateLeaseSchema>
export type UpdateLeaseInput = z.infer<typeof UpdateLeaseSchema>
export type LeaseAddition = z.infer<typeof LeaseAdditionSchema>

export interface CampaignAndDateFields {
  campaign_price_amount?: number | null
  campaign_start_date?: string | null
  campaign_end_date?: string | null
  start_date?: string | null
  end_date?: string | null
}

export interface FieldIssue {
  message: string
  path: string
}

/**
 * Campaign-triple and date-order checks, mirroring the DB CHECK constraints
 * (leases_campaign_triple, leases_campaign_dates_order, leases_end_after_start
 * in the propmate migration) so a bad request gets a clear Swedish message
 * instead of a raw Postgres CHECK-violation error.
 *
 * Takes the FULLY MERGED row (existing DB values overlaid with the caller's
 * partial PATCH), not the raw request body: a PATCH that only changes
 * campaign_end_date must be checked against the lease's EXISTING
 * campaign_price_amount/campaign_start_date, not against "undefined" for
 * fields the caller didn't touch. CreateLeaseSchema's input is already
 * "fully merged" (every field is either provided or defaulted), so the same
 * function covers both create and update call sites.
 */
export function checkCampaignAndDates(v: CampaignAndDateFields): FieldIssue[] {
  const issues: FieldIssue[] = []
  const campaignFields = [v.campaign_price_amount, v.campaign_start_date, v.campaign_end_date]
  const definedCount = campaignFields.filter((f) => f !== null && f !== undefined).length
  if (definedCount !== 0 && definedCount !== 3) {
    issues.push({
      message: 'Kampanjpris kräver belopp, startdatum och slutdatum tillsammans',
      path: 'campaign_price_amount',
    })
  }
  if (v.campaign_start_date && v.campaign_end_date && v.campaign_end_date < v.campaign_start_date) {
    issues.push({ message: 'Kampanjens slutdatum måste vara efter startdatum', path: 'campaign_end_date' })
  }
  if (v.start_date && v.end_date && v.end_date < v.start_date) {
    issues.push({ message: 'Avtalets slutdatum måste vara efter startdatum', path: 'end_date' })
  }
  return issues
}
