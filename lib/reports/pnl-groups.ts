// Operational P&L headings stay Swedish in every locale.
// Account prefixes, rather than four-digit bounds, also include subaccounts.
export const PNL_GROUPS: readonly {
  klass: number
  label: string
  matchesAccount?: (accountNumber: string) => boolean
}[] = [
  { klass: 3, label: '3 Rörelsens inkomster/intäkter' },
  { klass: 4, label: '4 Material- och varukostnader' },
  { klass: 5, label: '5 Övriga externa kostnader' },
  { klass: 6, label: '6 Övriga externa kostnader' },
  { klass: 7, label: '70-76 Personalkostnader', matchesAccount: (number) => number[1] <= '6' },
  { klass: 7, label: '77-79 Avskrivningar, nedskrivningar och övriga rörelsekostnader', matchesAccount: (number) => number[1] > '6' },
  { klass: 8, label: '8 Finansiella poster och bokslutsdispositioner' },
]
