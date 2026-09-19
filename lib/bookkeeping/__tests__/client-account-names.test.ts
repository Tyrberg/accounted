import { describe, it, expect } from 'vitest'
import { BOOKING_TEMPLATES } from '@/lib/bookkeeping/booking-templates'
import { ACCOUNT_NAMES, formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import { BAS_ACCOUNT_NUMBERS } from '@/lib/bookkeeping/bas-account-numbers'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'

const BAS_NAME_BY_ACCOUNT = new Map(BAS_REFERENCE.map((a) => [a.account_number, a.account_name]))

describe('ACCOUNT_NAMES', () => {
  it('only names accounts that exist in the BAS 2026 chart', () => {
    const bogus = Object.keys(ACCOUNT_NAMES).filter((account) => !BAS_ACCOUNT_NUMBERS.includes(account))
    expect(bogus).toEqual([])
  })

  // No exceptions: every displayed name is checked against the independent
  // BAS source, including accounts previously hidden behind the allowlist.
  it.each(Object.entries(ACCOUNT_NAMES))('%s uses its exact BAS 2026 name', (account, name) => {
    expect(BAS_NAME_BY_ACCOUNT.has(account)).toBe(true)
    expect(name).toBe(BAS_NAME_BY_ACCOUNT.get(account))
    expect(formatAccountWithName(account)).toBe(`${account} ${BAS_NAME_BY_ACCOUNT.get(account)}`)
  })

  it('has a display name for every account the underlagsjakt keyword-fallback suggester can reach', () => {
    // Mirrors the reachability rule in extensions/general/underlagsjakt/lib/account-suggestion.ts:
    // entity_applicability 'all', the leg for this amount direction has no AB-specific
    // override, and the account isn't the bank account itself (1930, carries no information).
    const reachable = new Set<string>()
    for (const t of BOOKING_TEMPLATES) {
      if (t.entity_applicability !== 'all') continue
      for (const [account, abOverride] of [
        [t.debit_account, t.debit_account_ab] as const,
        [t.credit_account, t.credit_account_ab] as const,
      ]) {
        if (abOverride || account === '1930') continue
        reachable.add(account)
      }
    }

    const unnamed = [...reachable].filter((account) => formatAccountWithName(account) === account)
    expect(unnamed).toEqual([])
  })
})
