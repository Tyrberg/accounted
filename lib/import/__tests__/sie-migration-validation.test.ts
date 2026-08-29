import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedSIEFile } from '../types'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
import {
  compareMigrationYear, formatMigrationValidationTable, SIE_MIGRATION_YEARS,
  summarizeImportedYear, summarizeSIESource, validateEightYearMigration,
  type MigrationYearSnapshot,
} from '../sie-migration-validation'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/reports/opening-balances', () => ({ getOpeningBalances: vi.fn() }))

const mockGetOpeningBalances = vi.mocked(getOpeningBalances)

function parsedFile(year: number): ParsedSIEFile {
  const vouchers = [{
    series: year === 2026 ? 'M' : 'A', number: 1, date: new Date(year, 2, 31), description: 'Momsrapport',
    lines: [{ account: '1650', amount: 100 }, { account: '2650', amount: -100 }],
  }]
  return {
    header: {
      sieType: 4, flagga: 0, program: 'Fortnox', programVersion: null, generatedDate: null,
      format: 'PC8', companyName: 'Test AB', orgNumber: '5560000000', address: null,
      fiscalYears: [{ yearIndex: 0, start: `${year}-01-01`, end: `${year}-12-31` }], currency: 'SEK', kontoPlanType: 'BAS',
    },
    accounts: [{ number: '1650', name: 'Momsfordran' }, { number: '2650', name: 'Momsredovisning' }],
    openingBalances: [{ yearIndex: 0, account: '1650', amount: 97443 }],
    closingBalances: [{ yearIndex: 0, account: '1650', amount: 97543 }, { yearIndex: 0, account: '2650', amount: -100 }],
    resultBalances: [], vouchers, dimensions: [], dimensionValues: [], issues: [],
    stats: { totalAccounts: 2, totalVouchers: 1, totalTransactionLines: 2, fiscalYearStart: `${year}-01-01`, fiscalYearEnd: `${year}-12-31` },
  }
}

function clone(snapshot: MigrationYearSnapshot): MigrationYearSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as MigrationYearSnapshot
}

describe('SIE migration validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetOpeningBalances.mockResolvedValue({ balances: new Map(), obEntryId: null })
  })

  it('uses debit turnover once, authoritative balances, and preserves the 1650 IB', () => {
    const summary = summarizeSIESource(2026, parsedFile(2026))
    expect(summary.turnover).toBe(100)
    expect(summary.openingBalances['1650']).toBe(97443)
    expect(summary.closingBalances).toEqual({ '1650': 97543, '2650': -100 })
  })

  it('measures an IB-shaped voucher as opening balance and excludes it from voucher metrics', () => {
    const parsed = parsedFile(2026)
    parsed.openingBalances = []
    parsed.vouchers.unshift({
      series: 'A', number: 1, date: new Date(2026, 0, 1), description: 'Ingående balans',
      lines: [{ account: '1650', amount: 97443 }, { account: '2650', amount: -97443 }],
    })
    const summary = summarizeSIESource(2026, parsed)
    expect(summary.openingBalances).toEqual({ '1650': 97443, '2650': -97443 })
    expect(summary.voucherCount).toBe(1)
    expect(summary.turnover).toBe(100)
    expect(summary.vouchers).toEqual([{ sourceSeries: 'M', sourceNumber: 1 }])
  })

  it('builds the imported snapshot from posted import and opening-balance entries', async () => {
    const rows = {
      journal_entries: [
        { id: 'ib', source_type: 'opening_balance', source_voucher_series: 'A', source_voucher_number: 1 },
        { id: 'm1', source_type: 'import', source_voucher_series: 'M', source_voucher_number: 1 },
      ],
      journal_entry_lines: [
        { id: '1', journal_entry_id: 'ib', account_number: '1650', debit_amount: 97443, credit_amount: 0 },
        { id: '2', journal_entry_id: 'ib', account_number: '2650', debit_amount: 0, credit_amount: 97443 },
        { id: '3', journal_entry_id: 'm1', account_number: '1650', debit_amount: 100, credit_amount: 0 },
        { id: '4', journal_entry_id: 'm1', account_number: '2650', debit_amount: 0, credit_amount: 100 },
      ],
    }
    mockGetOpeningBalances.mockResolvedValue({
      balances: new Map([
        ['1650', { debit: 97443, credit: 0 }],
        ['2650', { debit: 0, credit: 97443 }],
      ]),
      obEntryId: 'ib',
    })
    const supabase = {
      from(table: keyof typeof rows) {
        if (table === 'fiscal_periods' as keyof typeof rows) {
          const periodBuilder = {
            select: () => periodBuilder,
            eq: () => periodBuilder,
            single: async () => ({
              data: { period_start: '2026-01-01', opening_balance_entry_id: 'ib' },
              error: null,
            }),
          }
          return periodBuilder
        }
        const builder = {
          select: () => builder, eq: () => builder, in: () => builder,
          order: () => builder,
          range: async () => ({ data: rows[table], error: null }),
        }
        return builder
      },
    } as unknown as SupabaseClient
    const snapshot = await summarizeImportedYear(supabase, 'company', 'period', 2026)
    expect(snapshot).toMatchObject({
      voucherCount: 1, turnover: 100,
      openingBalances: { '1650': 97443, '2650': -97443 },
      closingBalances: { '1650': 97543, '2650': -97543 },
      vouchers: [{ sourceSeries: 'M', sourceNumber: 1 }],
    })
    expect(mockGetOpeningBalances).toHaveBeenCalledWith(supabase, 'company', {
      period_start: '2026-01-01', opening_balance_entry_id: 'ib',
    })
  })

  it('uses computed prior opening balances when a continuation import has no opening-balance entry', async () => {
    mockGetOpeningBalances.mockResolvedValue({
      balances: new Map([['1650', { debit: 97443, credit: 0 }]]),
      obEntryId: null,
    })
    const supabase = {
      from(table: string) {
        if (table === 'fiscal_periods') {
          const builder = {
            select: () => builder, eq: () => builder,
            single: async () => ({
              data: { period_start: '2020-01-01', opening_balance_entry_id: null }, error: null,
            }),
          }
          return builder
        }
        const builder = {
          select: () => builder, eq: () => builder, in: () => builder, order: () => builder,
          range: async () => ({ data: [], error: null }),
        }
        return builder
      },
    } as unknown as SupabaseClient

    const snapshot = await summarizeImportedYear(supabase, 'company', 'period-2020', 2020)

    expect(snapshot.openingBalances).toEqual({ '1650': 97443 })
    expect(snapshot.closingBalances).toEqual({ '1650': 97443 })
    expect(mockGetOpeningBalances).toHaveBeenCalledWith(supabase, 'company', {
      period_start: '2020-01-01', opening_balance_entry_id: null,
    })
  })

  it('includes an unlinked retagged opening-balance voucher in imported opening balances', async () => {
    const rows = {
      journal_entries: [
        { id: 'linked-ib', source_type: 'opening_balance', source_voucher_series: null, source_voucher_number: null },
        { id: 'retagged-ib', source_type: 'opening_balance', source_voucher_series: 'A', source_voucher_number: 1 },
        { id: 'voucher-2', source_type: 'import', source_voucher_series: 'A', source_voucher_number: 2 },
      ],
      journal_entry_lines: [
        { id: '1', journal_entry_id: 'linked-ib', account_number: '1930', debit_amount: 500, credit_amount: 0 },
        { id: '2', journal_entry_id: 'linked-ib', account_number: '2099', debit_amount: 0, credit_amount: 500 },
        { id: '3', journal_entry_id: 'retagged-ib', account_number: '1650', debit_amount: 97443, credit_amount: 0 },
        { id: '4', journal_entry_id: 'retagged-ib', account_number: '2440', debit_amount: 0, credit_amount: 97443 },
        { id: '5', journal_entry_id: 'voucher-2', account_number: '1650', debit_amount: 100, credit_amount: 0 },
        { id: '6', journal_entry_id: 'voucher-2', account_number: '2440', debit_amount: 0, credit_amount: 100 },
      ],
    }
    mockGetOpeningBalances.mockResolvedValue({
      balances: new Map([
        ['1930', { debit: 500, credit: 0 }],
        ['2099', { debit: 0, credit: 500 }],
      ]),
      obEntryId: 'linked-ib',
    })
    const supabase = {
      from(table: keyof typeof rows) {
        if (table === 'fiscal_periods' as keyof typeof rows) {
          const periodBuilder = {
            select: () => periodBuilder,
            eq: () => periodBuilder,
            single: async () => ({
              data: { period_start: '2020-01-01', opening_balance_entry_id: 'linked-ib' },
              error: null,
            }),
          }
          return periodBuilder
        }
        const builder = {
          select: () => builder, eq: () => builder, in: () => builder,
          order: () => builder,
          range: async () => ({ data: rows[table], error: null }),
        }
        return builder
      },
    } as unknown as SupabaseClient

    const snapshot = await summarizeImportedYear(supabase, 'company', 'period-2020', 2020)

    expect(snapshot).toMatchObject({
      voucherCount: 1,
      turnover: 100,
      openingBalances: { '1930': 500, '2099': -500, '1650': 97443, '2440': -97443 },
      closingBalances: { '1930': 500, '2099': -500, '1650': 97543, '2440': -97543 },
      vouchers: [{ sourceSeries: 'A', sourceNumber: 2 }],
    })
  })

  it('reports even a one-krona account difference and a missing M1 separately', () => {
    const source = summarizeSIESource(2026, parsedFile(2026))
    const imported = clone(source)
    imported.closingBalances['1650'] -= 1
    imported.vouchers = []
    const result = compareMigrationYear(source, imported)
    expect(result.valid).toBe(false)
    expect(result.differences).toContainEqual(expect.objectContaining({ metric: 'closing_balance', account: '1650', difference: -1 }))
    expect(result.differences).toContainEqual(expect.objectContaining({ metric: 'required_voucher', imported: 'saknas' }))
  })

  it('exposes a synthetic opening-balance entry if it is wrongly counted as a source voucher', () => {
    const source = summarizeSIESource(2019, parsedFile(2019))
    const imported = clone(source)
    imported.voucherCount++
    expect(compareMigrationYear(source, imported).differences[0]).toEqual(expect.objectContaining({
      metric: 'voucher_count', source: 1, imported: 2,
    }))
  })

  it('fails closed unless all eight named years are present on both sides', () => {
    const sourceYears = SIE_MIGRATION_YEARS.map((year) => summarizeSIESource(year, parsedFile(year)))
    const importedYears = sourceYears.map(clone).filter((snapshot) => snapshot.year !== 2023)
    const result = validateEightYearMigration(sourceYears, importedYears)
    expect(result.valid).toBe(false)
    expect(result.missingYears).toEqual([2023])
  })

  it('passes a complete, exact eight-year comparison including M1', () => {
    const sourceYears = SIE_MIGRATION_YEARS.map((year) => summarizeSIESource(year, parsedFile(year)))
    const result = validateEightYearMigration(sourceYears, sourceYears.map(clone))
    expect(result.valid).toBe(true)
    expect(result.years).toHaveLength(8)
  })

  it('formats every account comparison and exposes a one-krona difference', () => {
    const source = summarizeSIESource(2026, parsedFile(2026))
    const imported = clone(source)
    imported.closingBalances['1650'] -= 1
    const table = formatMigrationValidationTable(validateEightYearMigration(
      SIE_MIGRATION_YEARS.map((year) => ({ ...clone(source), year })),
      SIE_MIGRATION_YEARS.map((year) => ({ ...clone(year === 2026 ? imported : source), year }))
    ))
    expect(table).toContain('| 2026 | closing_balance | 1650 | 97543 | 97542 | -1 |')
    expect(table).toContain('| 2026 | opening_balance | 2614 | 0 | 0 | 0 |')
    expect(table).toContain('| 2026 | required_voucher | M1 | M1 | M1 | 0 |')
  })

  it('never renders a zero difference when M1 is missing on both sides', () => {
    const source = summarizeSIESource(2026, parsedFile(2026))
    const withoutM1 = clone(source)
    withoutM1.vouchers = []

    const validation = validateEightYearMigration(
      SIE_MIGRATION_YEARS.map((year) => ({ ...clone(year === 2026 ? withoutM1 : source), year })),
      SIE_MIGRATION_YEARS.map((year) => ({ ...clone(year === 2026 ? withoutM1 : source), year }))
    )

    expect(validation.valid).toBe(false)
    expect(validation.years.at(-1)?.differences).toContainEqual(expect.objectContaining({
      year: 2026, metric: 'required_voucher', source: 'saknas i SIE', imported: 'saknas',
    }))
    const table = formatMigrationValidationTable(validation)
    expect(table).toContain('| 2026 | required_voucher | M1 | missing | missing | mismatch |')
    expect(table).not.toContain('| 2026 | required_voucher | M1 | missing | missing | 0 |')
  })
})
