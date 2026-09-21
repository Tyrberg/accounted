import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The team a company is attached to when no team id is given: the user's
 * PERSONAL team only, never the first membership of any kind (that would
 * attach a private company to a byra team). Same lookup as
 * POST /api/v1/companies: earliest teams row with kind='personal'. Returns
 * null when the user has no personal team; create_company_for_user then
 * decides what that means. Queried from `teams` (inner-joined to the user's
 * membership) so the ordering is on plain columns the schema guard can check.
 */
export async function resolvePersonalTeamId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('teams')
    .select('id, team_members!inner(user_id)')
    .eq('kind', 'personal')
    .eq('team_members.user_id', userId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`teams: ${error.message}`)
  return (data?.id as string | undefined) ?? null
}
