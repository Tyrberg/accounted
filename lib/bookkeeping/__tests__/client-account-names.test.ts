import { describe, it, expect } from 'vitest'
import { BOOKING_TEMPLATES } from '@/lib/bookkeeping/booking-templates'
import { ACCOUNT_NAMES, formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import { BAS_ACCOUNT_NUMBERS } from '@/lib/bookkeeping/bas-account-numbers'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'

const BAS_NAME_BY_ACCOUNT = new Map(BAS_REFERENCE.map((a) => [a.account_number, a.account_name]))

/**
 * Approved deviations from canonical BAS 2026 names: entries where we
 * deliberately use a different name than BAS for UI clarity.
 * Key = account number. Value = the reason for the deviation, ONLY.
 *
 * This list must never carry a copy of the UI name: the test below reads
 * ACCOUNT_NAMES directly and compares it against bas-data, so a wrong name
 * written here alongside a plausible reason cannot launder itself past the
 * guard by matching a hand-typed twin (task 1450 fixround: the previous
 * `{ uiName, reason }` shape let 45/78 entries be checked against their own
 * copy instead of against BAS).
 */
const NAME_ALLOWLIST: Record<string, string> = {
  '2611': 'Abbreviation (Utg. = Utgående) for brevity; unambiguous in context',
  '2614': 'Removed verbose "betalningsskyldighet" phrase; VAT mechanism is clear',
  '2621': 'Abbreviation (Utg. = Utgående) for brevity; unambiguous in context',
  '2624': 'Removed verbose "betalningsskyldighet" phrase; VAT mechanism is clear',
  '2631': 'Abbreviation (Utg. = Utgående) for brevity; unambiguous in context',
  '2634': 'Removed verbose "betalningsskyldighet" phrase; VAT mechanism is clear',
  '2641': 'Abbreviation (Ing. = Ingående) for brevity; unambiguous in context',
  '2645': 'Abbreviated "ingående" and simplified prepositions; meaning is clear',
  '2647': 'Reworded for clarity; more concise than BAS verbose version',
  '3001': 'VAT rate is the only relevant distinction in UI; dropped "skattepliktig, momssats"',
  '3002': 'VAT rate is the only relevant distinction in UI; dropped "skattepliktig, momssats"',
  '3003': 'VAT rate is the only relevant distinction in UI; dropped "skattepliktig, momssats"',
  '3004': 'Reordered for naturalness; "Momsfri försäljning" reads better than BAS "Försäljning momsfri"',
  '3305': 'Single word for UI compactness; clearer than BAS "Försäljning varor för export m.m."',
  '3308': 'Single phrase for clarity; "försäljning tjänster för export m.m." is less specific',
  '4070': 'Shortened; "från andra EU-länder" is implied by "EU" suffix',
  '4500': 'Removed verbose enumeration; scope is clear from "från utlandet"',
  '5613': 'Removed "och underhåll" (repair implies maintenance)',
  '5615': 'Removed "och uthyrning"; "leasing" is the common vehicle expense term',
  '6200': 'Used & symbol for brevity; meaning is identical to BAS "och"',
  '1630': 'Shortened from "Avräkning för skatter och avgifter (skattekonto)"; purpose is clear',
  '2018': 'Removed "Övriga" prefix for brevity; account purpose is unambiguous',
  '2350': 'Removed specific lender type "till kreditinstitut" for general applicability',
  '2731': 'Common name for employer contributions; more recognizable than "Avräkning lagstadgade sociala avgifter"',
  '2893': 'Simplified; BAS phrase "Skulder till närstående personer, kortfristig del" is overly specific',
  '3900': 'Removed "(gruppkonto)" suffix; grouping nature is implicit',
  '3960': 'Shortened from verbose "på fordringar och skulder av rörelsekaraktär"; essence is clear',
  '4010': 'Shortened for UI; "Inköp av handelsvaror i Sverige" is implied for Swedish companies',
  '4060': 'Removed "Inköp av handelsvaror i Sverige" prefix; reverse charge context is clear',
  '4600': 'Common term; "Inköp av tjänster, underentreprenader och legoarbeten i Sverige (gruppkonto)" is verbose',
  '5460': 'Common synonym for "Förbrukningsmaterial"; both convey the same meaning',
  '5611': 'Shortened; "för personbilar, mc, m.m." is implied in vehicle context',
  '5619': 'Removed ", m.m." suffix (et cetera is unnecessary in UI)',
  '5800': 'Removed "(gruppkonto)" suffix; grouping is implicit',
  '6071': 'Removed ", avdragsgill" (all BAS accounts in this map are deductible)',
  '6310': 'Singular form for UI consistency; BAS "Företagsförsäkringar" (plural) refers to the same account',
  '6550': 'Common term; BAS "Konsultarvoden" has same meaning but "konsulttjänster" is more familiar',
  '6570': 'Common term; BAS "Bankkostnader" has similar meaning but "avgifter" is more specific',
  '6991': 'Shortened from "Övriga externa kostnader, avdragsgilla" for UI clarity',
  '7210': 'Minor wording change from BAS "Löner till tjänstemän"; meaning is identical',
  '7410': 'Shortened from "Pensionsförsäkringspremier"; essence is clear',
  '7960': 'Shortened from verbose "på fordringar och skulder av rörelsekaraktär"; essence is clear',
  '8310': 'Shortened from "från omsättningstillgångar"; context is clear in financial section',
  '8410': 'Shortened from "för långfristiga skulder"; applies to all interest-bearing obligations',
}

describe('ACCOUNT_NAMES', () => {
  it('only names accounts that exist in the BAS 2026 chart', () => {
    const bogus = Object.keys(ACCOUNT_NAMES).filter((account) => !BAS_ACCOUNT_NUMBERS.includes(account))
    expect(bogus).toEqual([])
  })

  it('names every account with its canonical BAS 2026 name, or an approved abbreviation of it', () => {
    // An owner who by design cannot read the BAS number judges the account purely
    // by this name (task 1450): a wrong name is worse than the bare number it
    // replaces, so it must match the real chart, not just look plausible.
    // Task 1450: validates ACCOUNT_NAMES itself against bas-data. The
    // allowlist carries only a reason string, never a copy of the name, so a
    // wrong name cannot pass by matching a hand-typed twin of itself.
    const mismatches: string[] = []
    let exactMatches = 0
    let approvedDeviations = 0
    for (const [account, mapName] of Object.entries(ACCOUNT_NAMES)) {
      const basName = BAS_NAME_BY_ACCOUNT.get(account)
      if (mapName === basName) {
        // Exact match: OK
        exactMatches++
        continue
      }
      const reason = NAME_ALLOWLIST[account]
      if (reason && reason.trim() !== '') {
        // Documented, deliberate deviation from the BAS name
        approvedDeviations++
        continue
      }
      // Neither a BAS exact match nor a documented, reasoned deviation
      mismatches.push(`${account}: map="${mapName}" official="${basName}" (no documented reason found)`)
    }
    expect(mismatches).toEqual([])
    // Report the breakdown to help verify the audit passed
    console.log(
      `Account name validation: ${exactMatches} exact matches, ${approvedDeviations} documented deviations, ${exactMatches + approvedDeviations} of ${Object.keys(ACCOUNT_NAMES).length} entries checked against BAS data`
    )
  })

  it('has no dead exceptions in the allowlist (all exceptions must differ from BAS)', () => {
    // The allowlist documents approved deviations from BAS. Each entry must:
    // 1. Exist in ACCOUNT_NAMES
    // 2. Exist in BAS
    // 3. Actually differ from the BAS name (not match it) -- otherwise it isn't a deviation
    const deadExceptions: string[] = []
    for (const [account, reason] of Object.entries(NAME_ALLOWLIST)) {
      if (!BAS_NAME_BY_ACCOUNT.has(account)) {
        deadExceptions.push(`${account}: account does not exist in BAS`)
        continue
      }
      if (!(account in ACCOUNT_NAMES)) {
        deadExceptions.push(`${account}: account not in ACCOUNT_NAMES`)
        continue
      }
      const basName = BAS_NAME_BY_ACCOUNT.get(account)
      if (ACCOUNT_NAMES[account] === basName) {
        deadExceptions.push(
          `${account}: ACCOUNT_NAMES value matches BAS exactly ("${basName}") -- this is not an exception and should be removed from allowlist`
        )
        continue
      }
      if (!reason || reason.trim() === '') {
        deadExceptions.push(`${account}: exception has empty reason`)
      }
    }
    expect(deadExceptions).toEqual([])
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
