import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import fixture from '@/extensions/general/underlagsjakt/__tests__/fixtures/export-1.4.json'
import type { Post } from '@/extensions/general/underlagsjakt/lib/contract'
import { PostAnswerPanel } from '../PostAnswerPanel'

function renderPanel(locale: 'sv' | 'en', account: string | null = null) {
  const post: Post = {
    ...fixture.sammanstallningar[0].posts[0],
    kategori: 'behover_mattias',
    forslag: { kategori: 'bankavgift', bas_konto: account, momstyp: null, varfor: '' },
  }
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      {
        locale,
        messages: locale === 'sv' ? sv : en,
        timeZone: 'Europe/Stockholm',
      } as unknown as Parameters<typeof NextIntlClientProvider>[0],
      createElement(PostAnswerPanel, { post, bolagChoices: [], onAnswered: async () => {} })
    )
  )
}

describe('answer panel initial render', () => {
  it.each(['sv', 'en'] as const)('renders optional labels and a labelled suggestion in %s', (locale) => {
    const messages = locale === 'sv' ? sv : en
    const html = renderPanel(locale)
    expect(html).toContain(`${messages.underlagsjakt.field_bas_konto} ${messages.settings_booking_templates.optional_suffix}`)
    expect(html).toContain(`${messages.underlagsjakt.field_momstyp} ${messages.settings_booking_templates.optional_suffix}`)
    expect(html).toContain('value="6570"')
    expect(html).toContain(messages.underlagsjakt.field_bas_konto_suggestion)
    expect(html).toContain('aria-describedby="bas-suggestion-')
  })
  it('keeps the exported account and labels it as a suggestion', () => {
    const html = renderPanel('sv', '6540')
    expect(html).toContain('value="6540"')
    expect(html).toContain(sv.underlagsjakt.field_bas_konto_suggestion)
  })
})
