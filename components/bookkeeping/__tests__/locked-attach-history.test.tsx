import { describe, it, expect } from 'vitest'
import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import sv from '@/messages/sv.json'
import LockedAttachHistory, { type LockedAttachLogRow } from '../LockedAttachHistory'

const render = (rows: LockedAttachLogRow[]) =>
  renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale: 'sv', messages: sv, timeZone: 'Europe/Stockholm' } as unknown as Parameters<
        typeof NextIntlClientProvider
      >[0],
      createElement(LockedAttachHistory, { rows }),
    ),
  )

const SHA = 'b'.repeat(64)

describe('LockedAttachHistory (verifikat history for locked-period archiving)', () => {
  it('shows who, which key, when, file, sha256 and reason', () => {
    const html = render([
      {
        id: 'log-1',
        created_at: '2026-11-16T10:00:00Z',
        actor: 'user-1',
        actor_label: 'user@example.com',
        api_key_name: 'Backoffice',
        document_id: 'doc-1',
        file_name: 'kvitto.pdf',
        sha256_hash: SHA,
        reason: 'Underlag till stängt år',
      },
    ])
    expect(html).toContain('Arkiverade underlag i låst period')
    // When = date AND time of the archive, not just the day.
    expect(html).toMatch(/2026-11-1[67] \d{2}:\d{2}/)
    expect(html).toContain('user@example.com')
    expect(html).toContain('via nyckel Backoffice')
    expect(html).toContain('kvitto.pdf')
    expect(html).toContain(SHA)
    expect(html).toContain('Orsak: Underlag till stängt år')
  })

  it('renders nothing when there is no trail', () => {
    expect(render([])).toBe('')
  })
})
