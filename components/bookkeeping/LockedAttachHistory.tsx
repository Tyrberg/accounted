'use client'

import { useTranslations } from 'next-intl'
import { DetailSection } from '@/components/ui/detail-section'
import { formatDateTime } from '@/lib/utils'

/** One LOCKED_PERIOD_ATTACH audit row, as returned by the locked-attach-log route. */
export type LockedAttachLogRow = {
  id: string
  created_at: string
  actor: string | null
  actor_label: string | null
  api_key_name: string | null
  document_id: string | null
  file_name: string | null
  sha256_hash: string | null
  reason: string | null
}

/**
 * Verifikat history section for underlag archived into a locked/closed
 * period: who (user and API key), when, which file, its sha256 and why.
 * Renders nothing when the entry has no such trail.
 */
export default function LockedAttachHistory({ rows }: { rows: LockedAttachLogRow[] }) {
  const t = useTranslations('journal_detail')
  if (rows.length === 0) return null

  return (
    <DetailSection kicker={t('locked_attach_history_title')}>
      <ul className="divide-y divide-border text-sm">
        {rows.map((row) => (
          <li key={row.id} className="py-2">
            <div className="flex items-center justify-between gap-3">
              {/* data-ph-mask: the actor label is a person's e-mail or name */}
              <span data-ph-mask="" className="text-muted-foreground">
                <span className="tabular-nums">{formatDateTime(row.created_at)}</span>
                {row.actor_label ? ` · ${row.actor_label}` : ''}
                {row.api_key_name ? ` · ${t('locked_attach_by_key', { key: row.api_key_name })}` : ''}
              </span>
            </div>
            <p>{row.file_name}</p>
            {row.sha256_hash && (
              <p className="break-all font-mono text-xs text-muted-foreground">sha256 {row.sha256_hash}</p>
            )}
            {row.reason && (
              <p className="text-xs text-muted-foreground">{t('locked_attach_reason', { reason: row.reason })}</p>
            )}
          </li>
        ))}
      </ul>
    </DetailSection>
  )
}
