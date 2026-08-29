import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines } from '@/lib/bookkeeping/entry-lines'
import { roundOre } from '@/lib/money'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
import {
  getEffectiveOpeningBalances,
  isBalanceSheetAccount,
  OPENING_BALANCE_DESCRIPTION_RE,
  SHARE_CAPITAL_DESCRIPTION_RE,
} from './sie-parser'
import type { AccountMapping, ParsedSIEFile } from './types'

export const SIE_MIGRATION_YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] as const
export const SIE_MIGRATION_VAT_ACCOUNTS = ['1650', '2610', '2614', '2615', '2640', '2645', '2650'] as const

export interface MigrationYearSnapshot {
  year: number
  voucherCount: number
  /** Debit turnover for ordinary vouchers, excluding a separately-created IB entry. */
  turnover: number
  openingBalances: Record<string, number>
  closingBalances: Record<string, number>
  vouchers: Array<{ sourceSeries: string | null; sourceNumber: number | null }>
}

export interface MigrationDifference {
  year: number
  metric: 'voucher_count' | 'turnover' | 'opening_balance' | 'closing_balance' | 'required_voucher'
  account: string | null
  source: number | string
  imported: number | string
  difference: number | null
}

export interface MigrationYearValidation {
  year: number
  source: MigrationYearSnapshot
  imported: MigrationYearSnapshot
  differences: MigrationDifference[]
  valid: boolean
}

export interface EightYearMigrationValidation {
  valid: boolean
  years: MigrationYearValidation[]
  missingYears: number[]
}

function addAmount(target: Record<string, number>, account: string, amount: number): void {
  target[account] = roundOre((target[account] ?? 0) + amount)
}

function mappedAccount(account: string, mappings: ReadonlyMap<string, string>): string {
  return mappings.get(account) ?? account
}

/** Build the Fortnox side directly from its SIE export. */
export function summarizeSIESource(
  year: number,
  parsed: ParsedSIEFile,
  accountMappings: readonly Pick<AccountMapping, 'sourceAccount' | 'targetAccount'>[] = []
): MigrationYearSnapshot {
  const mappings = new Map(accountMappings.map((mapping) => [mapping.sourceAccount, mapping.targetAccount]))
  const openingBalances: Record<string, number> = {}
  const movements: Record<string, number> = {}
  const effectiveOpeningBalances = getEffectiveOpeningBalances(parsed)
  const fiscalYearStart = parsed.stats.fiscalYearStart?.slice(0, 10)
  const openingBalanceVoucher = effectiveOpeningBalances.balances.length === 0
    ? parsed.vouchers.find((voucher) =>
      voucher.lines.length > 0 &&
      `${voucher.date.getFullYear()}-${String(voucher.date.getMonth() + 1).padStart(2, '0')}-${String(voucher.date.getDate()).padStart(2, '0')}` === fiscalYearStart &&
      voucher.lines.every((line) => isBalanceSheetAccount(line.account)) &&
      OPENING_BALANCE_DESCRIPTION_RE.test(voucher.description || '') &&
      !SHARE_CAPITAL_DESCRIPTION_RE.test(voucher.description || '')
    )
    : undefined

  for (const balance of effectiveOpeningBalances.balances) {
    addAmount(openingBalances, mappedAccount(balance.account, mappings), balance.amount)
  }
  for (const line of openingBalanceVoucher?.lines ?? []) {
    addAmount(openingBalances, mappedAccount(line.account, mappings), line.amount)
  }
  for (const voucher of parsed.vouchers) {
    if (voucher === openingBalanceVoucher) continue
    for (const line of voucher.lines) addAmount(movements, mappedAccount(line.account, mappings), line.amount)
  }

  // #UB and #RES are authoritative. Only accounts absent from those records
  // fall back to IB plus movements, for valid SIE4 variants omitting summaries.
  const closingBalances: Record<string, number> = {}
  const currentUB = parsed.closingBalances.filter((balance) => balance.yearIndex === 0)
  const currentResult = parsed.resultBalances.filter((balance) => balance.yearIndex === 0)
  for (const balance of currentUB) {
    if (isBalanceSheetAccount(balance.account)) addAmount(closingBalances, mappedAccount(balance.account, mappings), balance.amount)
  }
  for (const balance of currentResult) {
    if (!isBalanceSheetAccount(balance.account)) addAmount(closingBalances, mappedAccount(balance.account, mappings), balance.amount)
  }

  for (const account of new Set([...Object.keys(openingBalances), ...Object.keys(movements)])) {
    const sourceAccounts = [account, ...[...mappings.entries()].filter(([, target]) => target === account).map(([source]) => source)]
    const hasAuthoritativeBalance = sourceAccounts.some((sourceAccount) =>
      isBalanceSheetAccount(sourceAccount)
        ? currentUB.some((balance) => balance.account === sourceAccount)
        : currentResult.some((balance) => balance.account === sourceAccount)
    )
    if (!hasAuthoritativeBalance) closingBalances[account] = roundOre((openingBalances[account] ?? 0) + (movements[account] ?? 0))
  }

  return {
    year,
    voucherCount: parsed.vouchers.length - (openingBalanceVoucher ? 1 : 0),
    turnover: roundOre(parsed.vouchers.reduce(
      (sum, voucher) => voucher === openingBalanceVoucher ? sum :
        sum + voucher.lines.reduce((lineSum, line) => lineSum + Math.max(line.amount, 0), 0), 0
    )),
    openingBalances,
    closingBalances,
    vouchers: parsed.vouchers
      .filter((voucher) => voucher !== openingBalanceVoucher)
      .map((voucher) => ({ sourceSeries: voucher.series, sourceNumber: voucher.number })),
  }
}

interface ImportedMigrationLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  journal_entries: {
    id: string
    source_type: string
    source_voucher_series: string | null
    source_voucher_number: number | null
  }
}

/** Build the Accounted side from posted entries created by an SIE import. */
export async function summarizeImportedYear(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  year: number
): Promise<MigrationYearSnapshot> {
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_start, opening_balance_entry_id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (periodError) throw new Error(periodError.message)

  const { balances: importedOpeningBalances, obEntryId } = await getOpeningBalances(supabase, companyId, period)
  const lines = await fetchEntryLines<ImportedMigrationLine>({
    supabase,
    entryColumns: 'id, source_type, source_voucher_series, source_voucher_number',
    lineColumns: 'account_number, debit_amount, credit_amount',
    filterEntries: (query) => query
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .eq('status', 'posted')
      .in('source_type', ['import', 'opening_balance']),
  })
  const openingBalances: Record<string, number> = {}
  const movements: Record<string, number> = {}
  const ordinaryEntries = new Map<string, ImportedMigrationLine['journal_entries']>()
  let turnover = 0

  for (const [account, balance] of importedOpeningBalances) {
    addAmount(openingBalances, account, Number(balance.debit) - Number(balance.credit))
  }

  for (const line of lines) {
    const amount = Number(line.debit_amount) - Number(line.credit_amount)
    if (line.journal_entries.source_type === 'opening_balance') {
      if (line.journal_entries.id !== obEntryId) addAmount(openingBalances, line.account_number, amount)
    } else {
      addAmount(movements, line.account_number, amount)
      turnover += Number(line.debit_amount)
      ordinaryEntries.set(line.journal_entries.id, line.journal_entries)
    }
  }
  const closingBalances: Record<string, number> = {}
  for (const account of new Set([...Object.keys(openingBalances), ...Object.keys(movements)])) {
    closingBalances[account] = roundOre((openingBalances[account] ?? 0) + (movements[account] ?? 0))
  }

  return {
    year,
    voucherCount: ordinaryEntries.size,
    turnover: roundOre(turnover),
    openingBalances,
    closingBalances,
    vouchers: [...ordinaryEntries.values()].map((entry) => ({
      sourceSeries: entry.source_voucher_series,
      sourceNumber: entry.source_voucher_number,
    })),
  }
}

function compareMoneyRecords(
  year: number,
  metric: 'opening_balance' | 'closing_balance',
  source: Record<string, number>,
  imported: Record<string, number>
): MigrationDifference[] {
  const differences: MigrationDifference[] = []
  const accounts = new Set([...Object.keys(source), ...Object.keys(imported), ...SIE_MIGRATION_VAT_ACCOUNTS])
  for (const account of [...accounts].sort()) {
    const expected = roundOre(source[account] ?? 0)
    const actual = roundOre(imported[account] ?? 0)
    const difference = roundOre(actual - expected)
    if (difference !== 0) differences.push({ year, metric, account, source: expected, imported: actual, difference })
  }
  return differences
}

export function compareMigrationYear(source: MigrationYearSnapshot, imported: MigrationYearSnapshot): MigrationYearValidation {
  const differences: MigrationDifference[] = []
  if (source.voucherCount !== imported.voucherCount) {
    differences.push({
      year: source.year, metric: 'voucher_count', account: null, source: source.voucherCount,
      imported: imported.voucherCount, difference: imported.voucherCount - source.voucherCount,
    })
  }
  const turnoverDifference = roundOre(imported.turnover - source.turnover)
  if (turnoverDifference !== 0) {
    differences.push({
      year: source.year, metric: 'turnover', account: null, source: roundOre(source.turnover),
      imported: roundOre(imported.turnover), difference: turnoverDifference,
    })
  }
  differences.push(...compareMoneyRecords(source.year, 'opening_balance', source.openingBalances, imported.openingBalances))
  differences.push(...compareMoneyRecords(source.year, 'closing_balance', source.closingBalances, imported.closingBalances))

  if (source.year === 2026) {
    const sourceHasM1 = source.vouchers.some((voucher) => voucher.sourceSeries === 'M' && voucher.sourceNumber === 1)
    const importedHasM1 = imported.vouchers.some((voucher) => voucher.sourceSeries === 'M' && voucher.sourceNumber === 1)
    if (!sourceHasM1 || !importedHasM1) {
      differences.push({
        year: source.year, metric: 'required_voucher', account: null,
        source: sourceHasM1 ? 'M1' : 'saknas i SIE', imported: importedHasM1 ? 'M1' : 'saknas', difference: null,
      })
    }
  }

  return { year: source.year, source, imported, differences, valid: differences.length === 0 }
}

export function validateEightYearMigration(
  sourceYears: readonly MigrationYearSnapshot[],
  importedYears: readonly MigrationYearSnapshot[]
): EightYearMigrationValidation {
  const sourceByYear = new Map(sourceYears.map((snapshot) => [snapshot.year, snapshot]))
  const importedByYear = new Map(importedYears.map((snapshot) => [snapshot.year, snapshot]))
  const missingYears = SIE_MIGRATION_YEARS.filter((year) => !sourceByYear.has(year) || !importedByYear.has(year))
  const years = SIE_MIGRATION_YEARS.flatMap((year) => {
    const source = sourceByYear.get(year)
    const imported = importedByYear.get(year)
    return source && imported ? [compareMigrationYear(source, imported)] : []
  })
  return { valid: missingYears.length === 0 && years.every((result) => result.valid), years, missingYears }
}

export interface EightYearMigrationRunInput {
  year: number
  parsed: ParsedSIEFile
  fiscalPeriodId: string
  accountMappings?: readonly Pick<AccountMapping, 'sourceAccount' | 'targetAccount'>[]
}

/** Run the complete read-only source-to-database validation. */
export async function runEightYearMigrationValidation(
  supabase: SupabaseClient,
  companyId: string,
  inputs: readonly EightYearMigrationRunInput[]
): Promise<EightYearMigrationValidation> {
  const sourceYears = inputs.map((input) =>
    summarizeSIESource(input.year, input.parsed, input.accountMappings)
  )
  const importedYears = await Promise.all(inputs.map((input) =>
    summarizeImportedYear(supabase, companyId, input.fiscalPeriodId, input.year)
  ))
  return validateEightYearMigration(sourceYears, importedYears)
}

function tableValue(value: number | string): string {
  return String(value)
}

/** Render a comparison table suitable for the named eight-year delivery. */
export function formatMigrationValidationTable(validation: EightYearMigrationValidation): string {
  const rows = validation.years.flatMap(({ year, source, imported }) => {
    const result: string[] = [
      `| ${year} | voucher_count | - | ${source.voucherCount} | ${imported.voucherCount} | ${imported.voucherCount - source.voucherCount} |`,
      `| ${year} | turnover | - | ${tableValue(source.turnover)} | ${tableValue(imported.turnover)} | ${tableValue(roundOre(imported.turnover - source.turnover))} |`,
    ]
    if (year === 2026) {
      const sourceHasM1 = source.vouchers.some((voucher) => voucher.sourceSeries === 'M' && voucher.sourceNumber === 1)
      const importedHasM1 = imported.vouchers.some((voucher) => voucher.sourceSeries === 'M' && voucher.sourceNumber === 1)
      // Absent on BOTH sides is not a match: compareMigrationYear() flags it as
      // a difference, and the required M1 for Q1 2026 is exactly what this row
      // exists to confirm. Rendering `0` there would read as verified.
      result.push(`| ${year} | required_voucher | M1 | ${sourceHasM1 ? 'M1' : 'missing'} | ${importedHasM1 ? 'M1' : 'missing'} | ${sourceHasM1 && importedHasM1 ? '0' : 'mismatch'} |`)
    }
    for (const metric of ['opening_balance', 'closing_balance'] as const) {
      const sourceBalances = metric === 'opening_balance' ? source.openingBalances : source.closingBalances
      const importedBalances = metric === 'opening_balance' ? imported.openingBalances : imported.closingBalances
      for (const account of [...new Set([...Object.keys(sourceBalances), ...Object.keys(importedBalances), ...SIE_MIGRATION_VAT_ACCOUNTS])].sort()) {
        const expected = roundOre(sourceBalances[account] ?? 0)
        const actual = roundOre(importedBalances[account] ?? 0)
        result.push(`| ${year} | ${metric} | ${account} | ${tableValue(expected)} | ${tableValue(actual)} | ${tableValue(roundOre(actual - expected))} |`)
      }
    }
    return result
  })
  return [
    '| Year | Metric | Account | Fortnox | Accounted | Difference |',
    '| ---: | --- | ---: | ---: | ---: | ---: |',
    ...rows,
  ].join('\n')
}
