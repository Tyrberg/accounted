import { describe, it, expect } from 'vitest'
import { Children, isValidElement, type ReactNode } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { BalansrapportPDF, ResultatrapportPDF } from '../operational-report-pdf-template'
import type { BalansrapportReport, CompanySettings, ResultatrapportReport } from '@/types'

// Real @react-pdf/renderer layout is CPU-heavy; under a fully parallel
// test run these can exceed the 5s default on a saturated machine.
const RENDER_TIMEOUT = 30_000

function fakeCompany(): CompanySettings {
  return {
    company_name: 'Testbolaget AB',
    org_number: '5566778899',
    vat_number: 'SE556677889901',
    entity_type: 'aktiebolag',
  } as unknown as CompanySettings
}

function balansrapport(overrides: Partial<BalansrapportReport> = {}): BalansrapportReport {
  return {
    groups: [
      {
        class: 1,
        class_label: '1 Tillgångar',
        rows: [
          { account_number: '1930', account_name: 'Företagskonto', ib: 50000, ub: 75000, period_change: 25000 },
        ],
        subtotal_ib: 50000,
        subtotal_ub: 75000,
      },
    ],
    total_assets_ub: 75000,
    total_equity_liabilities_ub: -75000,
    beraknat_resultat: 0,
    is_balanced: true,
    period: { start: '2026-01-01', end: '2026-12-31' },
    ...overrides,
  }
}

function resultatrapport(overrides: Partial<ResultatrapportReport> = {}): ResultatrapportReport {
  return {
    groups: [
      {
        class: 3,
        class_label: '3 Rörelsens inkomster/intäkter',
        rows: [
          { account_number: '3001', account_name: 'Försäljning 25%', current_period: 100000, prior_period: 80000 },
        ],
        subtotal_current: 100000,
        subtotal_prior: 80000,
      },
    ],
    net_result_current: 100000,
    net_result_prior: 80000,
    period: { start: '2026-01-01', end: '2026-12-31' },
    prior_period: { start: '2025-01-01', end: '2025-12-31' },
    ...overrides,
  }
}

// Inspect text from shared header/footer components as well as PDF primitives.
function documentContent(node: ReactNode): { keys: string[]; text: string[] } {
  const keys: string[] = []
  const text: string[] = []
  function visit(node: ReactNode) {
    Children.forEach(node, (child) => {
      if (typeof child === 'string') text.push(child)
      if (isValidElement<{ children?: ReactNode }>(child)) {
        if (child.key !== null) keys.push(child.key)
        if (typeof child.type === 'function') {
          const component = child.type as (props: { children?: ReactNode }) => ReactNode
          visit(component(child.props))
        } else {
          visit(child.props.children)
        }
      }
    })
  }
  visit(node)
  return { keys, text }
}

describe('operational report PDFs', () => {
  it('test__when_class_7_is_split__then_pdf_contains_both_groups_without_a_draft_disclaimer', async () => {
    const groups = [
      {
        class: 7, class_label: '70-76 Personalkostnader',
        rows: [{ account_number: '7210', account_name: 'Löner', current_period: -100, prior_period: -90 }],
        subtotal_current: -100, subtotal_prior: -90,
      },
      {
        class: 7, class_label: '77-79 Avskrivningar, nedskrivningar och övriga rörelsekostnader',
        rows: [
          { account_number: '7821', account_name: 'Avskrivningar på byggnader', current_period: -50, prior_period: -40 },
          { account_number: '7960', account_name: 'Valutakursförluster', current_period: -20, prior_period: -10 },
          { account_number: '7990', account_name: 'Övriga rörelsekostnader', current_period: -30, prior_period: -20 },
        ],
        subtotal_current: -100, subtotal_prior: -70,
      },
    ]
    const document = ResultatrapportPDF({
      report: resultatrapport({ groups, net_result_current: -200, net_result_prior: -160 }),
      company: fakeCompany(), generatedAt: '2026-07-28T10:00:00.000Z',
    })
    const { keys, text } = documentContent(document)
    for (const group of groups) {
      expect(keys).toContain(group.class_label)
      expect(text).toContain(group.class_label)
      for (const row of group.rows) {
        expect(text).toContain(row.account_number)
        expect(text).toContain(row.account_name)
      }
    }
    expect(text.join(' ')).not.toContain('Arbetsutkast')
    const buffer = await renderToBuffer(document)
    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-')
    expect(buffer.length).toBeGreaterThan(1000)
  }, RENDER_TIMEOUT)

  it(
    'renders the balansrapport with the latest-voucher header line',
    async () => {
      const buffer = await renderToBuffer(
        BalansrapportPDF({
          report: balansrapport({
            latest_vouchers: [
              { series: 'A', last_number: 214 },
              { series: 'B', last_number: 37 },
            ],
          }),
          company: fakeCompany(),
          generatedAt: '2026-07-28T10:00:00.000Z',
        })
      )

      expect(buffer).toBeInstanceOf(Buffer)
      expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
      expect(buffer.length).toBeGreaterThan(1000)
    },
    RENDER_TIMEOUT
  )

  it(
    'renders the balansrapport without the line when no vouchers exist',
    async () => {
      const buffer = await renderToBuffer(
        BalansrapportPDF({
          report: balansrapport(),
          company: fakeCompany(),
          generatedAt: '2026-07-28T10:00:00.000Z',
        })
      )

      expect(buffer).toBeInstanceOf(Buffer)
      expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
      expect(buffer.length).toBeGreaterThan(1000)
    },
    RENDER_TIMEOUT
  )

  it(
    'renders the resultatrapport with both the voucher line and a filter note',
    async () => {
      const document = ResultatrapportPDF({
        report: resultatrapport({
          latest_vouchers: [{ series: 'A', last_number: 88 }],
        }),
        company: fakeCompany(),
        generatedAt: '2026-07-28T10:00:00.000Z',
        filterNote: 'Filtrerad (dimension 6: P001), ej fullständig rapport',
      })
      const { text } = documentContent(document)
      expect(text.join(' ')).toContain('Senaste bokförda verifikat :  A 88')
      expect(text).toContain('Filtrerad (dimension 6: P001), ej fullständig rapport')
      expect(text.join(' ')).not.toContain('Arbetsutkast')
      const buffer = await renderToBuffer(document)

      expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
      expect(buffer.length).toBeGreaterThan(1000)
    },
    RENDER_TIMEOUT
  )
})
