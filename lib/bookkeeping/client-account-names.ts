/**
 * Client-safe account name map for UI display.
 * Covers the accounts used in transaction categorization.
 * No server dependencies: safe for 'use client' components.
 * lib/bookkeeping/__tests__/client-account-names.test.ts pins every entry
 * against the canonical BAS 2026 chart (lib/bookkeeping/bas-data): never add
 * or rename an entry here without a matching account_name there.
 */

export const ACCOUNT_NAMES: Readonly<Record<string, string>> = {
  // Assets (1xxx)
  '1250': 'Inventarier',
  '1510': 'Kundfordringar',
  '1630': 'Skattekonto',
  '1680': 'Andra kortfristiga fordringar',
  '1930': 'Företagskonto',

  // Equity & Liabilities (2xxx)
  '2013': 'Övriga egna uttag',
  '2018': 'Egna insättningar',
  '2350': 'Långfristiga skulder',
  '2393': 'Lån från närstående personer, långfristig del',
  '2440': 'Leverantörsskulder',
  '2510': 'Skatteskulder',
  '2611': 'Utg. moms 25%',
  '2621': 'Utg. moms 12%',
  '2631': 'Utg. moms 6%',
  '2614': 'Utg. moms omvänd 25%',
  '2624': 'Utg. moms omvänd 12%',
  '2634': 'Utg. moms omvänd 6%',
  '2641': 'Ing. moms',
  '2645': 'Beräknad ing. moms förvärv utlandet',
  '2647': 'Beräknad ing. moms omvänd i Sverige',
  '2731': 'Arbetsgivaravgifter',
  '2893': 'Skuld till ägare',

  // Revenue (3xxx)
  '3001': 'Försäljning 25%',
  '3002': 'Försäljning 12%',
  '3003': 'Försäljning 6%',
  '3004': 'Momsfri försäljning',
  '3305': 'Exportförsäljning',
  '3308': 'EU-tjänster',
  '3900': 'Övriga rörelseintäkter',
  '3960': 'Valutakursvinster',

  // Cost of goods (4xxx)
  '4010': 'Varuinköp',
  '4060': 'Varuinköp omvänd moms',
  '4070': 'Varuinköp EU',
  '4500': 'Övriga inköpskostnader',
  '4531': 'Import-/tullkostnader',
  '4600': 'Subentreprenader',

  // External expenses (5xxx)
  '5010': 'Lokalhyra',
  '5020': 'El & uppvärmning',
  '5410': 'Förbrukningsinventarier',
  '5420': 'Programvaror',
  '5460': 'Förbrukningsvaror',
  '5611': 'Drivmedel bil',
  '5613': 'Reparation fordon',
  '5615': 'Leasing fordon',
  '5619': 'Övriga kostnader för personbilar och mc',
  '5800': 'Resekostnader',
  '5810': 'Biljetter & transport',
  '5820': 'Hyrbilskostnader',
  '5830': 'Kost och logi',
  '5910': 'Annonsering',
  '5920': 'Utomhus- och trafikreklam',
  '5990': 'Övriga kostnader för reklam och PR',

  // Other external expenses (6xxx)
  '6071': 'Representation',
  '6110': 'Kontorsförbrukning',
  '6200': 'Telefon & internet',
  '6211': 'Fast telefoni',
  '6230': 'Internet',
  '6250': 'Porto',
  '6310': 'Företagsförsäkring',
  '6530': 'Redovisningstjänster',
  '6550': 'Konsulttjänster',
  '6570': 'Bankavgifter',
  '6980': 'Medlemsavgifter',
  '6991': 'Övriga kostnader',

  // Personnel & financial (7xxx / 8xxx)
  '7210': 'Löner tjänstemän',
  '7321': 'Skattefria traktamenten, Sverige',
  '7322': 'Skattepliktiga traktamenten, Sverige',
  '7323': 'Skattefria traktamenten, utlandet',
  '7324': 'Skattepliktiga traktamenten, utlandet',
  '7331': 'Skattefria bilersättningar',
  '7332': 'Skattepliktiga bilersättningar',
  '7333': 'Ersättning för trängselskatt, skattefri',
  '7410': 'Pensionsförsäkring',
  '7610': 'Utbildning',
  '7622': 'Sjuk- och hälsovård, ej avdragsgill',
  '7960': 'Valutakursförluster',
  '8310': 'Ränteintäkter',
  '8410': 'Räntekostnader',
}

/**
 * Get the Swedish display name for an account number.
 * Returns the number itself if no name is mapped.
 */
export function getAccountName(accountNumber: string): string {
  return ACCOUNT_NAMES[accountNumber] || accountNumber
}

/**
 * Format an account number with its name, e.g. "5010 Lokalhyra".
 */
export function formatAccountWithName(accountNumber: string): string {
  const name = ACCOUNT_NAMES[accountNumber]
  return name ? `${accountNumber} ${name}` : accountNumber
}
