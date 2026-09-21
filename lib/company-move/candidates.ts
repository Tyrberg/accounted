/**
 * Move proposal: which posted verifikat in OTHER companies might belong to a
 * company that is being set up (Mölleborgen AB, task 1479).
 *
 * This module only PROPOSES. It reads nothing and writes nothing: the caller
 * hands in rows, gets back candidates and a Markdown list the owner can answer
 * ja/nej to line by line. Moving a verifikat between companies changes two
 * companies' räkenskaper at once, so nothing here (or in the script around it)
 * moves anything.
 *
 * A raw text search is not a source of truth, it only says "probably something
 * to move". Candidates therefore carry WHY they matched (which term, in which
 * field), and a single term can match on several axes: free text, motpart
 * (supplier/customer), bank account, fastighetsbeteckning, hyresgäst.
 */

import { roundOre } from '@/lib/money'

export type MatchAxis = 'text' | 'counterparty' | 'bank_account' | 'property' | 'tenant'

export interface MoveSearchTerms {
  /** Free text, matched against verifikattext and radtext (e.g. the company name). */
  text: string[]
  /** Supplier / customer names. */
  counterparties: string[]
  /** Account identifiers: IBAN, BBAN, clearing+konto, bankgiro, plusgiro. */
  bankAccounts: string[]
  /** Fastighetsbeteckningar, e.g. "Mollen 4". */
  properties: string[]
  /** Hyresgäster (tenant names). */
  tenants: string[]
}

export interface CandidateLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
}

export interface CandidateEntry {
  id: string
  company_id: string
  company_name: string
  voucher_series: string
  voucher_number: number
  entry_date: string
  description: string
  lines: CandidateLine[]
}

/** A hit found outside the entry's own text (linked supplier, cash account, ...). */
export interface LinkedMatch {
  entryId: string
  axis: MatchAxis
  term: string
  /** Human-readable origin, e.g. "leverantör Foo AB". */
  via: string
}

export interface CandidateMatch {
  axis: MatchAxis
  term: string
  via: string
}

export interface Candidate {
  entry: CandidateEntry
  matches: CandidateMatch[]
  /** Sum of debits, rounded to öre. */
  amount: number
}

/**
 * Lowercase and fold å/ä/ö to a/a/o. The same company shows up as
 * "Mölleborgen" and "Molleborgen" in bank text, Dropbox folder names and
 * bertil's config, so a match must not depend on which spelling was used.
 */
export function foldForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Digits/letters only, for account identifiers typed with spaces or hyphens. */
export function foldAccountIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function containsTerm(haystack: string | null | undefined, term: string): boolean {
  const folded = foldForMatch(term)
  if (!haystack || !folded) return false
  return foldForMatch(haystack).includes(folded)
}

export function containsAccountIdentifier(
  haystack: string | null | undefined,
  identifier: string,
): boolean {
  const folded = foldAccountIdentifier(identifier)
  // Short digit strings match everywhere by accident: refuse to search on them.
  if (!haystack || folded.length < 6) return false
  return foldAccountIdentifier(haystack).includes(folded)
}

/** The text-based axes and the terms each one searches for. */
function textAxes(terms: MoveSearchTerms): Array<[MatchAxis, string[]]> {
  return [
    ['text', terms.text],
    ['property', terms.properties],
    ['tenant', terms.tenants],
    ['counterparty', terms.counterparties],
  ]
}

/** Matches found in the entry's own verifikattext and radtexter. */
export function matchEntryText(entry: CandidateEntry, terms: MoveSearchTerms): CandidateMatch[] {
  const matches: CandidateMatch[] = []
  const fields: Array<[string, string | null]> = [
    ['verifikattext', entry.description],
    ...entry.lines.map((l, i): [string, string | null] => [`rad ${i + 1}`, l.line_description]),
  ]

  for (const [axis, list] of textAxes(terms)) {
    for (const term of list) {
      const hit = fields.find(([, text]) => containsTerm(text, term))
      if (hit) matches.push({ axis, term, via: hit[0] })
    }
  }
  for (const term of terms.bankAccounts) {
    const hit = fields.find(([, text]) => containsAccountIdentifier(text, term))
    if (hit) matches.push({ axis: 'bank_account', term, via: hit[0] })
  }
  return matches
}

/**
 * Combine own-text matches with links found elsewhere (supplier invoices,
 * customer invoices, transactions on a matching bank account) into one
 * candidate per verifikat. Entries with no match are dropped. Result is sorted
 * by company, then date, then voucher, so a reviewer reads one company at a time.
 */
export function buildCandidates(
  entries: CandidateEntry[],
  linked: LinkedMatch[],
  terms: MoveSearchTerms,
): Candidate[] {
  const linkedByEntry = new Map<string, LinkedMatch[]>()
  for (const l of linked) {
    const list = linkedByEntry.get(l.entryId) ?? []
    list.push(l)
    linkedByEntry.set(l.entryId, list)
  }

  const candidates: Candidate[] = []
  for (const entry of entries) {
    const matches = [
      ...matchEntryText(entry, terms),
      ...(linkedByEntry.get(entry.id) ?? []).map(({ axis, term, via }) => ({ axis, term, via })),
    ]
    if (matches.length === 0) continue
    const amount = roundOre(entry.lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0))
    candidates.push({ entry, matches, amount })
  }

  return candidates.sort(
    (a, b) =>
      a.entry.company_name.localeCompare(b.entry.company_name, 'sv') ||
      a.entry.entry_date.localeCompare(b.entry.entry_date) ||
      a.entry.voucher_series.localeCompare(b.entry.voucher_series) ||
      a.entry.voucher_number - b.entry.voucher_number,
  )
}

const AXIS_LABEL: Record<MatchAxis, string> = {
  text: 'text',
  counterparty: 'motpart',
  bank_account: 'bankkonto',
  property: 'fastighet',
  tenant: 'hyresgäst',
}

function formatAmount(n: number): string {
  return n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Markdown-table cells must not contain pipes or newlines. */
function cell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
}

/**
 * The list Mattias answers ja/nej to. One row per verifikat with date, amount,
 * accounts, current company and the reason it was suggested. Every row starts
 * unanswered: only an explicit "ja" makes a row eligible to move.
 */
export function renderProposal(candidates: Candidate[], targetCompanyName: string): string {
  const lines: string[] = []
  lines.push(`# Förslag: verifikat att flytta till ${targetCompanyName}`)
  lines.push('')
  lines.push(
    'Ingenting är flyttat. Varje rad besvaras med ja eller nej; endast rader med ja får flyttas.',
  )
  lines.push(
    'Träffarna kommer från sökning i text, motpart, bankkonto, fastighetsbeteckning och hyresgäst ' +
      'och är kandidater, inte facit.',
  )
  lines.push('')

  if (candidates.length === 0) {
    lines.push('Inga kandidater hittades.')
    return lines.join('\n') + '\n'
  }

  lines.push('| # | Svar | Nuvarande bolag | Verifikat | Datum | Belopp | Konton | Text | Varför |')
  lines.push('|---|------|-----------------|-----------|-------|--------|--------|------|--------|')
  candidates.forEach((c, i) => {
    const accounts = [...new Set(c.entry.lines.map((l) => l.account_number))].join(' ')
    const why = c.matches.map((m) => `${AXIS_LABEL[m.axis]} "${m.term}" (${m.via})`).join('; ')
    lines.push(
      [
        i + 1,
        'ja / nej',
        cell(c.entry.company_name),
        `${c.entry.voucher_series}${c.entry.voucher_number}`,
        c.entry.entry_date,
        formatAmount(c.amount),
        accounts,
        cell(c.entry.description),
        cell(why),
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
    )
  })
  lines.push('')
  lines.push(`Totalt ${candidates.length} kandidater.`)
  return lines.join('\n') + '\n'
}
