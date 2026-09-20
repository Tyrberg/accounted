/**
 * The slice of Supabase the machine path touches, shared by the two files that
 * exercise it: `leverans.test.ts` drives the handlers directly, and
 * `leverans-dispatch.test.ts` drives the same handlers through the real
 * dispatcher. They see one stand-in rather than a copy each, so the two cannot
 * drift into disagreeing about what the database does.
 *
 * Three tables, and only the columns `authenticateLeverans()` and the delivery
 * handlers actually read or write:
 *   - `companies`: the org-number lookup that binds a delivery to one company
 *   - `company_members`: the owner the write is attributed to
 *   - `extension_data`: the stored export, the answers, the delivery journal
 */

export interface StoredRow {
  user_id: string
  company_id: string
  extension_id: string
  key: string
  value: unknown
}

export interface LeveransSupabaseSlice {
  /**
   * What the org-number lookup finds. `[]` is the "no such company" path and
   * two rows the ambiguous one, both of which stop a delivery.
   */
  companyRows: { id: string }[]
  /** Non-null makes the company lookup itself fail. */
  companyError: { message: string } | null
  /** The owner `company_members` returns; null is a company with nobody to attribute the write to. */
  ownerRow: { user_id: string } | null
  /** Every `extension_data` row written, in write order. */
  dataRows: StoredRow[]
  /**
   * The org-number spellings the last `companies` lookup filtered on. This is
   * what proves the company came from the server's configuration: nothing in a
   * delivery's body reaches it.
   */
  inFilters: unknown[]
  /** A fresh client over this slice's state, one per request as the real factory hands out. */
  client(): never
  /** The value stored under `key` in `extension_data`, if anything is. */
  storedValue(key: string): Record<string, unknown> | undefined
}

export function createLeveransSupabaseSlice(): LeveransSupabaseSlice {
  function companiesChain() {
    const chain = {
      select: () => chain,
      in: (_column: string, values: unknown[]) => {
        slice.inFilters = values
        return chain
      },
      is: () => Promise.resolve({ data: slice.companyRows, error: slice.companyError }),
    }
    return chain
  }

  function membersChain() {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: slice.ownerRow, error: null }),
    }
    return chain
  }

  function extensionDataChain() {
    const filters: Record<string, string> = {}
    const chain = {
      select: () => chain,
      eq: (column: string, value: string) => {
        filters[column] = value
        return chain
      },
      single: async () => {
        const row = slice.dataRows.find(
          (r) =>
            r.company_id === filters.company_id &&
            r.extension_id === filters.extension_id &&
            r.key === filters.key,
        )
        return { data: row ? { value: row.value } : null, error: row ? null : { message: 'no rows' } }
      },
      upsert: async (row: StoredRow) => {
        const index = slice.dataRows.findIndex(
          (r) => r.company_id === row.company_id && r.extension_id === row.extension_id && r.key === row.key,
        )
        const stored = { ...row, value: JSON.parse(JSON.stringify(row.value)) }
        if (index >= 0) slice.dataRows[index] = stored
        else slice.dataRows.push(stored)
        return { error: null }
      },
    }
    return chain
  }

  const slice: LeveransSupabaseSlice = {
    companyRows: [{ id: 'company-1' }],
    companyError: null,
    ownerRow: { user_id: 'owner-1' },
    dataRows: [],
    inFilters: [],
    client: () =>
      ({
        from: (table: string) =>
          table === 'companies'
            ? companiesChain()
            : table === 'company_members'
              ? membersChain()
              : extensionDataChain(),
      }) as never,
    storedValue: (key: string) =>
      slice.dataRows.find((r) => r.key === key)?.value as Record<string, unknown> | undefined,
  }

  return slice
}
