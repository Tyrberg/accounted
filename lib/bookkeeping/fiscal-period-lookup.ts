import type { SupabaseClient } from '@supabase/supabase-js'

/** Shared open-period selection for booking and issuance preflight. */
export async function lookupOpenFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
  date: string,
) {
  // Overlapping periods are prevented by a DB exclusion constraint
  // (migration 042). limit(1) is kept as a defensive measure.
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, locked_at')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .eq('is_closed', false)
    .order('period_start', { ascending: false })
    .limit(1)

  return { period: data?.[0] ?? null, error }
}
