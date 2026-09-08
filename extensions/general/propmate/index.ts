import type { Extension } from '@/lib/extensions/types'
import { propmateApiRoutes } from './api-routes'

/**
 * Propmate: hyresaviseringskedjan. Leases are propmate's own avtalskälla
 * (monthly_rent, tillägg, kampanjpris, KPI-index reference fields); every
 * lease sync writes through gnubok's core recurring-schedule write path
 * (lib/invoices/create-recurring-schedule.ts,
 * lib/invoices/apply-recurring-schedule-update.ts), never a propmate-owned
 * insert, so the revenue-account guard in
 * lib/invoices/validate-schedule-revenue-accounts.ts always runs.
 *
 * Depositioner and automatic KPI-index uppräkning are explicitly out of
 * scope: see the migration header and DECISIONS.md for the follow-up items.
 */
export const propmateExtension: Extension = {
  id: 'propmate',
  name: 'Propmate',
  version: '1.0.0',
  sector: 'general',
  apiRoutes: propmateApiRoutes,
}
