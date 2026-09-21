import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolvePersonalTeamId } from '@/lib/company-move/personal-team'

function mockClient(result: { data: unknown; error: { message: string } | null }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  const from = vi.fn(() => chain)
  return { client: { from } as unknown as SupabaseClient, from, chain }
}

describe('resolvePersonalTeamId', () => {
  it('returns the earliest personal team of the user', async () => {
    const { client, from, chain } = mockClient({ data: { id: 'team-1' }, error: null })

    await expect(resolvePersonalTeamId(client, 'user-1')).resolves.toBe('team-1')

    expect(from).toHaveBeenCalledWith('teams')
    expect(chain.select).toHaveBeenCalledWith('id, team_members!inner(user_id)')
    expect(chain.eq).toHaveBeenCalledWith('kind', 'personal')
    expect(chain.eq).toHaveBeenCalledWith('team_members.user_id', 'user-1')
    expect(chain.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: true })
    expect(chain.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true })
    expect(chain.limit).toHaveBeenCalledWith(1)
  })

  it('returns null when the user has no personal team', async () => {
    const { client } = mockClient({ data: null, error: null })
    await expect(resolvePersonalTeamId(client, 'user-1')).resolves.toBeNull()
  })

  it('throws on a query error instead of silently creating a team-less company', async () => {
    const { client } = mockClient({ data: null, error: { message: 'boom' } })
    await expect(resolvePersonalTeamId(client, 'user-1')).rejects.toThrow('teams: boom')
  })
})
