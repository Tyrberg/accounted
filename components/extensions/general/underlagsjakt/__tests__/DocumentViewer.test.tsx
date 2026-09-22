import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { DocumentViewer, isCloseKey } from '../DocumentViewer'
import sv from '@/messages/sv.json'

describe('isCloseKey (the modal Esc-to-close predicate)', () => {
  it('is true for Escape', () => {
    expect(isCloseKey('Escape')).toBe(true)
  })

  it('is false for any other key', () => {
    expect(isCloseKey('Enter')).toBe(false)
    expect(isCloseKey('a')).toBe(false)
    expect(isCloseKey('')).toBe(false)
  })
})

describe('DocumentViewer', () => {
  it('renders modal with document name and close button', () => {
    const mockOnClose = () => {}
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="sv" messages={{ underlagsjakt: sv.underlagsjakt }}>
        <DocumentViewer
          filnamn="receipt.pdf"
          mimeType="application/pdf"
          signedUrl="https://example.com/doc.pdf"
          onClose={mockOnClose}
          isModal={true}
        />
      </NextIntlClientProvider>,
    )

    expect(html).toContain('receipt.pdf')
    expect(html).toContain('lucide lucide-x') // Close button renders as X icon
    expect(html).toContain('fixed inset-0') // Modal styling
  })

  it('shows unsupported type error message', () => {
    const mockOnClose = () => {}
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="sv" messages={{ underlagsjakt: sv.underlagsjakt }}>
        <DocumentViewer
          filnamn="document.doc"
          mimeType="application/msword"
          signedUrl="https://example.com/doc.doc"
          onClose={mockOnClose}
          isModal={true}
        />
      </NextIntlClientProvider>,
    )

    expect(html).toContain('document.doc')
    // Unsupported type should show error state
    expect(html).toContain('kan inte visas direkt')
  })

  it('shows loading error when signed URL is missing', () => {
    const mockOnClose = () => {}
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="sv" messages={{ underlagsjakt: sv.underlagsjakt }}>
        <DocumentViewer
          filnamn="receipt.pdf"
          mimeType="application/pdf"
          signedUrl={undefined}
          onClose={mockOnClose}
          isModal={true}
        />
      </NextIntlClientProvider>,
    )

    expect(html).toContain('receipt.pdf')
    // Missing signed URL should show loading/error state
    expect(html).toContain('kunde inte')
  })

  it('renders sidebar mode', () => {
    const mockOnClose = () => {}
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="sv" messages={{ underlagsjakt: sv.underlagsjakt }}>
        <DocumentViewer
          filnamn="receipt.pdf"
          mimeType="application/pdf"
          signedUrl="https://example.com/doc.pdf"
          onClose={mockOnClose}
          isModal={false}
        />
      </NextIntlClientProvider>,
    )

    expect(html).toContain('receipt.pdf')
    // Sidebar mode should have lg:flex class
    expect(html).toContain('lg:flex')
  })

  it('renders PDF documents correctly', () => {
    const mockOnClose = () => {}
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="sv" messages={{ underlagsjakt: sv.underlagsjakt }}>
        <DocumentViewer
          filnamn="document.pdf"
          mimeType="application/pdf"
          signedUrl="https://example.com/doc.pdf"
          onClose={mockOnClose}
          isModal={true}
        />
      </NextIntlClientProvider>,
    )

    expect(html).toContain('iframe')
    expect(html).toContain('https://example.com/doc.pdf')
  })

  it('renders images correctly', () => {
    const mockOnClose = () => {}
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="sv" messages={{ underlagsjakt: sv.underlagsjakt }}>
        <DocumentViewer
          filnamn="photo.jpg"
          mimeType="image/jpeg"
          signedUrl="https://example.com/photo.jpg"
          onClose={mockOnClose}
          isModal={true}
        />
      </NextIntlClientProvider>,
    )

    expect(html).toContain('img')
    expect(html).toContain('https://example.com/photo.jpg')
    expect(html).toContain('photo.jpg')
  })

  it('handles stored documents with MIME type', () => {
    const mockOnClose = () => {}
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="sv" messages={{ underlagsjakt: sv.underlagsjakt }}>
        <DocumentViewer
          filnamn="invoice.pdf"
          mimeType="application/pdf"
          signedUrl="https://example.com/stored/invoice.pdf"
          onClose={mockOnClose}
          isModal={true}
        />
      </NextIntlClientProvider>,
    )

    expect(html).toContain('invoice.pdf')
    expect(html).toContain('iframe')
  })
})
