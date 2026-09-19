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
  '1250': '(Fritt konto för Inventarier, verktyg och installationer)',
  '1510': 'Kundfordringar',
  '1630': 'Avräkning för skatter och avgifter (skattekonto)',
  '1680': 'Andra kortfristiga fordringar',
  '1930': 'Företagskonto',

  // Equity & Liabilities (2xxx)
  '2013': 'Övriga egna uttag',
  '2018': 'Övriga egna insättningar',
  '2350': 'Andra långfristiga skulder till kreditinstitut',
  '2393': 'Lån från närstående personer, långfristig del',
  '2440': 'Leverantörsskulder',
  '2510': 'Skatteskulder',
  '2611': 'Utgående moms på försäljning inom Sverige, 25 %',
  '2621': 'Utgående moms på försäljning inom Sverige, 12 %',
  '2631': 'Utgående moms på försäljning inom Sverige, 6 %',
  '2614': 'Utgående moms omvänd betalskyldighet, 25 %',
  '2624': 'Utgående moms omvänd betalningsskyldighet 12 %',
  '2634': 'Utgående moms omvänd betalningsskyldighet, 6 %',
  '2641': 'Debiterad ingående moms',
  '2645': 'Beräknad ingående moms på förvärv från utlandet',
  '2647': 'Ingående moms omvänd betalningsskyldighet varor och tjänster i Sverige',
  '2731': 'Avräkning lagstadgade sociala avgifter',
  '2893': 'Skulder till närstående personer, kortfristig del',

  // Revenue (3xxx)
  '3001': 'Försäljning inom Sverige, 25 % moms',
  '3002': 'Försäljning inom Sverige, 12 % moms',
  '3003': 'Försäljning inom Sverige, 6 % moms',
  '3004': 'Försäljning inom Sverige, momsfri',
  '3305': 'Försäljning tjänster till land utanför EU',
  '3308': 'Försäljning tjänster till annat EU-land',
  '3900': 'Övriga rörelseintäkter (gruppkonto)',
  '3960': 'Valutakursvinster på fordringar och skulder av rörelsekaraktär',

  // Cost of goods (4xxx)
  '4010': 'Inköp av handelsvaror i Sverige',
  '4060': 'Inköp av handelsvaror i Sverige, omvänd betalningsskyldighet',
  '4070': 'Inköp av handelsvaror från annat EU-land',
  '4500': 'Inköp av råvaror och material, tjänster m.m. från utlandet (gruppkonto)',
  '4531': 'Inköp av tjänster från ett land utanför EU, 25 % moms',
  '4600': 'Inköp av tjänster, underentreprenader och legoarbeten i Sverige (gruppkonto)',

  // External expenses (5xxx)
  '5010': 'Lokalhyra',
  '5020': 'El',
  '5410': 'Förbrukningsinventarier',
  '5420': 'Programvaror',
  '5460': 'Förbrukningsmaterial',
  '5611': 'Drivmedel för personbilar, mc, m.m.',
  '5613': 'Reparation och underhåll av personbilar, mc, m.m.',
  '5615': 'Leasing av personbilar, mc, m.m.',
  '5619': 'Övriga kostnader för personbilar och mc, m.m.',
  '5800': 'Resekostnader (gruppkonto)',
  '5810': 'Biljetter',
  '5820': 'Hyrbilskostnader',
  '5830': 'Kost och logi',
  '5910': 'Annonsering',
  '5920': 'Utomhus- och trafikreklam',
  '5990': 'Övriga kostnader för reklam och PR',

  // Other external expenses (6xxx)
  '6071': 'Representation, avdragsgill',
  '6110': 'Kontorsmateriel',
  '6200': 'Tele, data och post (gruppkonto)',
  '6211': 'Fast telefoni',
  '6230': 'Datakommunikation',
  '6250': 'Porto',
  '6310': 'Företagsförsäkringar',
  '6530': 'Redovisningstjänster',
  '6550': 'Konsultarvoden',
  '6570': 'Bankkostnader',
  '6980': 'Föreningsavgifter',
  '6991': 'Övriga externa kostnader, avdragsgilla',

  // Personnel & financial (7xxx / 8xxx)
  '7210': 'Löner till tjänstemän',
  '7321': 'Skattefria traktamenten, Sverige',
  '7322': 'Skattepliktiga traktamenten, Sverige',
  '7323': 'Skattefria traktamenten, utlandet',
  '7324': 'Skattepliktiga traktamenten, utlandet',
  '7331': 'Skattefria bilersättningar',
  '7332': 'Skattepliktiga bilersättningar',
  '7333': 'Ersättning för trängselskatt, skattefri',
  '7410': 'Pensionsförsäkringspremier',
  '7610': 'Utbildning',
  '7622': 'Sjuk- och hälsovård, ej avdragsgill',
  '7960': 'Valutakursförluster på fordringar och skulder av rörelsekaraktär',
  '8310': 'Ränteintäkter från omsättningstillgångar',
  '8410': 'Räntekostnader för långfristiga skulder',
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
