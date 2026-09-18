import { describe, it, expect } from 'vitest'
import { BOOKING_TEMPLATES } from '@/lib/bookkeeping/booking-templates'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'

describe('formatAccountWithName', () => {
  it('has a display name for every account the underlagsjakt keyword-fallback suggester can reach', () => {
    // Mirrors the reachability rule in extensions/general/underlagsjakt/lib/account-suggestion.ts:
    // entity_applicability 'all', the leg for this amount direction has no AB-specific
    // override, and the account isn't the bank account itself (1930, carries no information).
    // A bare account number shown to an owner who by design doesn't know BAS is a
    // regression (task 1450): this guards against a template account changing without
    // the client-side name map following it.
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
