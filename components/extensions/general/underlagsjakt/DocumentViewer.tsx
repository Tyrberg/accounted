'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface DocumentViewerProps {
  filnamn: string
  mimeType?: string | null
  signedUrl?: string
  onClose?: () => void
  isModal?: boolean
}

const SUPPORTED_PDF_TYPES = ['application/pdf']
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const SUPPORTED_TYPES = [...SUPPORTED_PDF_TYPES, ...SUPPORTED_IMAGE_TYPES]

function getInitialError(signedUrl?: string, mimeType?: string | null): 'unsupported' | 'loading' | null {
  if (!signedUrl) return 'loading'
  if (mimeType && !SUPPORTED_TYPES.includes(mimeType)) return 'unsupported'
  return null
}

/** Pulled out of the keydown handler so "Esc closes the modal" is testable without a DOM. */
export function isCloseKey(key: string): boolean {
  return key === 'Escape'
}

/**
 * Display a document in-place: sidebar on wide screens, overlay modal on narrow.
 * Supports PDFs and images. Shows clear error messages if display fails.
 * Never downloads or opens in a new tab.
 */
export function DocumentViewer({
  filnamn,
  mimeType,
  signedUrl,
  onClose,
  isModal = false,
}: DocumentViewerProps) {
  const t = useTranslations('underlagsjakt')
  const [state, setState] = useState(() => ({
    error: getInitialError(signedUrl, mimeType),
    isLoading: true,
  }))

  // Reset error and loading state when signedUrl or mimeType changes (e.g., opening a different document)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({
      error: getInitialError(signedUrl, mimeType),
      isLoading: true,
    })
  }, [signedUrl, mimeType])

  const { error, isLoading } = state

  const handleClose = useCallback(() => {
    if (onClose) onClose()
  }, [onClose])

  // Handle keyboard: ESC to close
  useEffect(() => {
    if (!isModal) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isCloseKey(e.key)) {
        handleClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isModal, handleClose])

  const content = (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
        <p className="truncate text-sm font-medium">{filnamn}</p>
        {isModal && onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={handleClose}
            aria-label={t('document_close')}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {error === 'unsupported' && (
        <div className="flex flex-col items-center justify-center gap-2 flex-1 text-center p-4">
          <p className="text-xs text-destructive">{t('document_unsupported_type')}</p>
        </div>
      )}

      {error === 'loading' && (
        <div className="flex flex-col items-center justify-center gap-2 flex-1 text-center p-4">
          <p className="text-xs text-destructive">{t('document_loading_error')}</p>
        </div>
      )}

      {!error && signedUrl && (
        <>
          {mimeType?.startsWith('application/pdf') ? (
            <iframe
              src={`${signedUrl}#toolbar=0`}
              className="flex-1 border border-border rounded-lg w-full"
              title={filnamn}
              onLoad={() => setState((s) => ({ ...s, isLoading: false }))}
              onError={() => setState((s) => ({ ...s, error: 'loading' }))}
            />
          ) : mimeType?.startsWith('image/') ? (
            <div className="flex-1 overflow-auto flex items-center justify-center bg-muted/30 rounded-lg border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={signedUrl}
                alt={filnamn}
                className="max-w-full max-h-full object-contain"
                onLoad={() => setState((s) => ({ ...s, isLoading: false }))}
                onError={() => setState((s) => ({ ...s, error: 'loading' }))}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              {isLoading && <p className="text-xs text-muted-foreground">{t('document_loading')}</p>}
            </div>
          )}
        </>
      )}
    </div>
  )

  if (isModal) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={handleClose}>
        <div
          className={cn(
            'bg-background rounded-t-xl md:rounded-lg border border-border',
            'w-full md:w-[600px] h-[70vh] md:h-[600px]',
            'flex flex-col p-4',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </div>
      </div>
    )
  }

  // Sidebar version (wide screens)
  return (
    <div className="hidden lg:flex flex-col gap-3 h-full p-4 border-l border-border bg-muted/10 w-96">
      {content}
    </div>
  )
}
