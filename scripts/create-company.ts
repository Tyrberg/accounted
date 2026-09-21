/**
 * Create a company through the one shared creation path (createCompanyCore),
 * the same sequence POST /api/v1/companies uses: company + owner membership,
 * chart of accounts, settings, first fiscal period, tax deadlines. Task 1479:
 * Mölleborgen AB (organisationsnummer 556577-1069).
 *
 * Dry-run by default: prints what would be created and writes nothing. Pass
 * --apply to create. A company without verifikat is cheap to reject, so the
 * owner confirms name and orgnr on the printed result BEFORE any verifikat is
 * moved to it (scripts/propose-company-move.ts).
 *
 * The tax facts are required flags, never defaulted: moms registration, moms
 * period, F-skatt and (optionally) the fiscal year start month change what
 * the company files and bills, and must come from the owner or the company's
 * registration, not from a guess.
 *
 * --team-id is only needed when the company must not go to the owner's
 * personal team; when omitted the personal team is resolved exactly as the
 * route does, so sync_team_to_company runs.
 *
 * .env.local points at the production database. --apply writes there: confirm
 * with the owner first.
 *
 * Usage:
 *   npx tsx scripts/create-company.ts --user-id <owner uuid> \
 *     --name "Molleborgen Aktiebolag" --org-number 5565771069 \
 *     --vat-registered true --moms-period quarterly --f-skatt true \
 *     [--fiscal-year-start-month 1] [--team-id <uuid>] [--apply]
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createCompanyCore } from '@/lib/company/create-company'
import { CompanySetupSchema, planCompanySetup } from '@/lib/company/onboarding-input'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { resolvePersonalTeamId } from '@/lib/company-move/personal-team'

config({ path: resolve(process.cwd(), '.env.local') })

const { values } = parseArgs({
  options: {
    'user-id': { type: 'string' },
    name: { type: 'string' },
    'org-number': { type: 'string' },
    'vat-registered': { type: 'string' },
    'moms-period': { type: 'string' },
    'f-skatt': { type: 'string' },
    'fiscal-year-start-month': { type: 'string' },
    'team-id': { type: 'string' },
    apply: { type: 'boolean' },
  },
})

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function requireBool(flag: 'vat-registered' | 'f-skatt'): boolean {
  const raw = values[flag]
  if (raw !== 'true' && raw !== 'false') fail(`--${flag} must be given explicitly as true or false`)
  return raw === 'true'
}

const userId = values['user-id']
if (!userId || !values.name || !values['org-number']) {
  fail('Required: --user-id, --name, --org-number, --vat-registered, --f-skatt (and --moms-period when VAT-registered)')
}

const orgNumber = normalizeOrgNumber(values['org-number'])
if (!orgNumber) fail(`Invalid organisationsnummer: ${values['org-number']}`)

const vatRegistered = requireBool('vat-registered')
const fSkatt = requireBool('f-skatt')

const parsed = CompanySetupSchema.safeParse({
  name: values.name,
  entity_type: 'aktiebolag',
  org_number: orgNumber,
  vat_registered: vatRegistered,
  ...(vatRegistered ? { moms_period: values['moms-period'] } : {}),
  f_skatt: fSkatt,
  ...(values['fiscal-year-start-month']
    ? { fiscal_year_start_month: Number(values['fiscal-year-start-month']) }
    : {}),
  ...(values['team-id'] ? { team_id: values['team-id'] } : {}),
})
if (!parsed.success) fail(`Invalid company setup: ${JSON.stringify(parsed.error.issues)}`)
const setup = parsed.data

const planResult = planCompanySetup(setup)
if (!planResult.ok) fail(`Invalid fiscal period: ${planResult.error}`)
const plan = planResult

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  // createCompanyCore deliberately allows duplicate org numbers; for a
  // one-off script a rerun must not create a second copy.
  const { data: existing, error: existingErr } = await supabase
    .from('companies')
    .select('id, name, org_number')
    .eq('org_number', orgNumber)
  if (existingErr) throw new Error(`companies: ${existingErr.message}`)
  if (existing && existing.length > 0) {
    console.log(`A company with organisationsnummer ${orgNumber} already exists; nothing created:`)
    for (const c of existing) console.log(`  ${c.id}  ${c.name}  ${c.org_number}`)
    return
  }

  // Same team rule as POST /api/v1/companies: explicit team id, else the
  // owner's personal team. A null team skips sync_team_to_company.
  const teamId = setup.team_id ?? (await resolvePersonalTeamId(supabase, userId!))

  const summary = {
    name: setup.name,
    org_number: orgNumber,
    entity_type: setup.entity_type,
    vat_registered: setup.vat_registered,
    moms_period: setup.moms_period ?? null,
    f_skatt: setup.f_skatt,
    accounting_method: plan.resolved.accountingMethod,
    fiscal_period: plan.fiscalPeriod,
    owner_user_id: userId,
    team_id: teamId,
  }

  if (!values.apply) {
    console.log('Dry run, nothing created. Would create:')
    console.log(JSON.stringify(summary, null, 2))
    console.log('\nRerun with --apply to create it.')
    return
  }

  const result = await createCompanyCore(supabase, plan.input, () =>
    supabase.rpc('create_company_for_user', {
      p_user_id: userId,
      p_name: setup.name,
      p_entity_type: setup.entity_type,
      p_team_id: teamId,
    }),
  )
  if (result.error !== undefined) throw new Error(`createCompanyCore: ${result.error}`)

  console.log('Created. Show this to the owner and get an explicit confirmation of name and')
  console.log('organisationsnummer BEFORE proposing or moving any verifikat:')
  console.log(JSON.stringify({ id: result.companyId, ...summary }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
