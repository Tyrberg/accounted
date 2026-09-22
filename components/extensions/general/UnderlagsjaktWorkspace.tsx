'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronRight, Download, FileSearch, Upload } from 'lucide-react'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { HOVER_REVEAL_CLASS, RowFoldout, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate, formatDateLong } from '@/lib/utils'
import { PostAnswerPanel } from './underlagsjakt/PostAnswerPanel'
import { MAX_WAITING_DAYS } from '@/extensions/general/underlagsjakt/lib/store'
import { answerSummary, errorText, type WorkspaceData } from './underlagsjakt/shared'

type Tab = 'open' | 'answered' | 'vantar' | 'fel_bolag'

const API = '/api/extensions/ext/underlagsjakt'

export default function UnderlagsjaktWorkspace(_props: WorkspaceComponentProps) {
  const t = useTranslations('underlagsjakt')
  const locale = useLocale()
  const { toast } = useToast()
  const [data, setData] = useState<WorkspaceData | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [tab, setTab] = useState<Tab>('open')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [downloadedIds, setDownloadedIds] = useState<string[] | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/`)
      if (!res.ok) throw new Error(String(res.status))
      const json = (await res.json()) as { data: WorkspaceData }
      setData(json.data)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleImport = async (file: File) => {
    setImporting(true)
    try {
      let body: unknown
      try {
        body = JSON.parse(await file.text())
      } catch {
        toast({ title: t('import_failed'), description: t('error_INVALID_JSON'), variant: 'destructive' })
        return
      }
      // /export is bertil's delivery endpoint (machine token, no session);
      // the file picker posts the same body to the session route.
      const res = await fetch(`${API}/export/fil`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: t('import_failed'), description: errorText(t, json), variant: 'destructive' })
        return
      }
      toast({ title: t('import_done', { count: json?.data?.posts ?? 0 }) })
      setTab('open')
      await load()
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDownload = async () => {
    const res = await fetch(`${API}/svarsfil`)
    if (!res.ok) {
      toast({ title: t('download_failed'), variant: 'destructive' })
      return
    }
    const text = await res.text()
    const file = JSON.parse(text) as { beslut: { transaction_id: string }[] }
    const disposition = res.headers.get('Content-Disposition') ?? ''
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'underlagsjakt-svar.json'
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    // Only the answers inside THIS file may be marked as handed over.
    setDownloadedIds(file.beslut.map((b) => b.transaction_id))
  }

  const markDelivered = async (ids: string[]) => {
    const res = await fetch(`${API}/svarsfil/levererad`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_ids: ids }),
    })
    if (!res.ok) {
      toast({ title: t('mark_delivered_failed'), variant: 'destructive' })
      return
    }
    await load()
  }

  const withdraw = async (transactionId: string) => {
    const res = await fetch(`${API}/svar/${encodeURIComponent(transactionId)}`, { method: 'DELETE' })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      toast({ title: t('withdraw_failed'), description: errorText(t, json), variant: 'destructive' })
      return
    }
    await load()
  }

  if (loadFailed && !data) {
    return <EmptyState icon={FileSearch} title={t('load_failed_title')} description={t('load_failed_description')} onAction={() => void load()} actionLabel={t('retry')} />
  }

  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const importInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="application/json,.json"
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) void handleImport(file)
      }}
    />
  )

  if (!data.export) {
    return (
      <>
        {importInput}
        <EmptyState
          icon={FileSearch}
          title={t('empty_title')}
          description={t(data.leverans.till_detta_bolag ? 'empty_description_leverans' : 'empty_description', {
            versions: data.supported_export_versions.join(', '),
          })}
          actionLabel={t('import_export')}
          onAction={() => fileInputRef.current?.click()}
        />
      </>
    )
  }

  const pendingCount = data.pending_count

  return (
    <div className="space-y-8">
      {importInput}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<Tab>
          aria-label={t('tabs_label')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'open', label: t('tab_open'), count: data.posts.length },
            { value: 'answered', label: t('tab_answered'), count: pendingCount },
            { value: 'vantar', label: t('tab_vantar'), count: data.waiting.filter((row) => !row.underlag_hittat_at).length },
            { value: 'fel_bolag', label: t('tab_fel_bolag'), count: data.fel_bolag.length },
          ]}
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            <Upload className="mr-2 h-4 w-4" />
            {t('import_export')}
          </Button>
          <Button onClick={() => void handleDownload()} disabled={pendingCount === 0}>
            <Download className="mr-2 h-4 w-4" />
            {t('download_answers', { count: pendingCount })}
          </Button>
        </div>
      </div>

      <div className="space-y-1 text-[12.5px] text-muted-foreground">
        <p>
          {data.leverans.till_detta_bolag
            ? t(data.export.imported_via === 'leverans' ? 'leverans_active_delivered' : 'leverans_active_file')
            : t('leverans_off')}
        </p>
        <p>
          {t('export_meta', {
            version: data.export.export_version,
            generated: formatDateLong(data.export.generated_at, locale),
            imported: formatDateLong(data.export.imported_at, locale),
          })}
        </p>
        {data.export.sammanstallningar.map((s) => (
          <p key={`${s.bolag}|${s.period}`} data-ph-mask="">
            {t('summary_line', {
              bolag: s.bolag,
              period: s.period,
              totalt: s.sammanfattning.totalt,
              med_underlag: s.sammanfattning.med_underlag,
              sjalvforklarande: s.sammanfattning.sjalvforklarande,
              inlard_regel: s.sammanfattning.inlard_regel,
              fragor: s.sammanfattning.behover_mattias + s.sammanfattning.tvetydig + s.sammanfattning.fel_bolag,
              uppskjuten: s.sammanfattning.uppskjuten,
              lost_svar: s.sammanfattning.lost_svar,
            })}
          </p>
        ))}
      </div>

      {tab === 'open' &&
        (data.posts.length === 0 ? (
          <EmptyState icon={FileSearch} title={t('open_empty_title')} description={t('open_empty_description')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_date')}</th>
                  <th className={TH_CLASS}>{t('col_account')}</th>
                  <th className={TH_CLASS}>{t('col_counterparty')}</th>
                  <th className={TH_CLASS}>{t('col_type')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                  <th className={TH_CLASS} aria-label={t('col_expand')} />
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {data.posts.map((post) => {
                  const expanded = expandedId === post.transaction_id
                  return (
                    <PostRows
                      key={post.transaction_id}
                      expanded={expanded}
                      onToggle={() => setExpandedId(expanded ? null : post.transaction_id)}
                      post={post}
                      posts={data.posts}
                      bolagChoices={data.bolag_choices}
                      uploadEnabled={data.underlag_upload_enabled}
                      leverarSjalvEnabled={data.levererar_sjalv_enabled}
                      multiKandidatEnabled={data.multi_kandidat_enabled}
                      onAnswered={async () => {
                        setExpandedId(null)
                        await load()
                      }}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'answered' &&
        (data.answered.length === 0 ? (
          <EmptyState icon={FileSearch} title={t('answered_empty_title')} description={t('answered_empty_description')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_date')}</th>
                  <th className={TH_CLASS}>{t('col_counterparty')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                  <th className={TH_CLASS}>{t('col_answer')}</th>
                  <th className={TH_CLASS}>{t('col_status')}</th>
                  <th className={TH_CLASS} aria-label={t('col_actions')} />
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {data.answered.map((a) => (
                  <tr key={a.transaction_id} className="group hover:bg-secondary/35">
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{formatDate(a.post.datum)}</td>
                    <td className={TD_CLASS} data-ph-mask="">{a.post.motpart}</td>
                    <td className={cn(TD_CLASS, 'text-right whitespace-nowrap tabular-nums')} data-ph-mask="">
                      {formatCurrency(a.post.belopp, a.post.valuta)}
                    </td>
                    <td className={TD_CLASS} data-ph-mask="">{answerSummary(t, a)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      {a.levererad_at ? (
                        <span className="text-xs text-muted-foreground">
                          {t('status_delivered', { date: formatDate(a.levererad_at) })}
                        </span>
                      ) : a.erbjudet_at ? (
                        <Badge variant="warning">{t('status_offered')}</Badge>
                      ) : (
                        <Badge variant="warning">{t('status_pending')}</Badge>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'text-right')}>
                      {!a.erbjudet_at && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className={HOVER_REVEAL_CLASS}
                          onClick={() => void withdraw(a.transaction_id)}
                        >
                          {t('withdraw')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'vantar' &&
        (data.waiting.length === 0 ? (
          <EmptyState icon={FileSearch} title={t('vantar_empty_title')} description={t('vantar_empty_description')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_date')}</th>
                  <th className={TH_CLASS}>{t('col_counterparty')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                  <th className={TH_CLASS}>{t('col_answered')}</th>
                  <th className={TH_CLASS}>{t('col_status')}</th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {data.waiting.map((row) => {
                  const days = Math.floor((Date.now() - new Date(row.besvarad_at).getTime()) / (1000 * 60 * 60 * 24))
                  const isOverdue = !row.underlag_hittat_at && days > MAX_WAITING_DAYS
                  return (
                    <tr key={row.transaction_id} className={cn('hover:bg-secondary/35', isOverdue && 'bg-destructive/5')} data-ph-mask="">
                      <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{formatDate(row.post.datum)}</td>
                      <td className={TD_CLASS}>{row.motpart}</td>
                      <td className={cn(TD_CLASS, 'text-right whitespace-nowrap tabular-nums')}>
                        {formatCurrency(row.post.belopp, row.post.valuta)}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-xs text-muted-foreground')}>{formatDateLong(row.besvarad_at, locale)}</td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                        {row.underlag_hittat_at ? (
                          <span className="text-xs text-muted-foreground">{t('status_underlag_hittat', { date: formatDate(row.underlag_hittat_at) })}</span>
                        ) : isOverdue ? (
                          <Badge variant="destructive">{t('status_overdue', { days })}</Badge>
                        ) : (
                          <Badge variant="warning">{t('status_waiting')}</Badge>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'fel_bolag' &&
        (data.fel_bolag.length === 0 ? (
          <EmptyState icon={FileSearch} title={t('fel_bolag_empty_title')} description={t('fel_bolag_empty_description')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_date')}</th>
                  <th className={TH_CLASS}>{t('col_counterparty')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                  <th className={TH_CLASS}>{t('col_paid_by')}</th>
                  <th className={TH_CLASS}>{t('col_concerns')}</th>
                  <th className={TH_CLASS}>{t('col_invoice_to')}</th>
                  <th className={TH_CLASS}>{t('col_settlement')}</th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {data.fel_bolag.map((row) => (
                  <tr key={row.transaction_id} className="hover:bg-secondary/35" data-ph-mask="">
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{formatDate(row.post.datum)}</td>
                    <td className={TD_CLASS}>{row.post.motpart}</td>
                    <td className={cn(TD_CLASS, 'text-right whitespace-nowrap tabular-nums')}>
                      {formatCurrency(row.post.belopp, row.post.valuta)}
                    </td>
                    <td className={TD_CLASS}>{row.post.bolag}</td>
                    <td className={TD_CLASS}>{row.till_bolag ?? t('unknown_company')}</td>
                    <td className={TD_CLASS}>{row.fel_bolag_mottagare}</td>
                    <td className={TD_CLASS}>
                      {row.reglering ? t(`reglering_${row.reglering}`) : t('reglering_none')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[12.5px] text-muted-foreground">{t('fel_bolag_footnote')}</p>
          </div>
        ))}

      <ConfirmDialog
        open={downloadedIds !== null}
        onOpenChange={(open) => {
          if (!open) setDownloadedIds(null)
        }}
        title={t('deliver_title')}
        description={t('deliver_description', { count: downloadedIds?.length ?? 0 })}
        confirmLabel={t('deliver_confirm')}
        cancelLabel={t('deliver_later')}
        onConfirm={() => (downloadedIds ? markDelivered(downloadedIds) : undefined)}
      >
        <code className="block rounded-sm bg-muted px-2 py-1 text-xs">
          python -m underlagsjakt --mottak-svar &lt;fil&gt;
        </code>
      </ConfirmDialog>
    </div>
  )
}

function PostRows({
  post,
  posts,
  expanded,
  onToggle,
  bolagChoices,
  uploadEnabled,
  leverarSjalvEnabled,
  multiKandidatEnabled,
  onAnswered,
}: {
  post: WorkspaceData['posts'][number]
  posts: WorkspaceData['posts']
  expanded: boolean
  onToggle: () => void
  bolagChoices: string[]
  uploadEnabled: boolean
  leverarSjalvEnabled: boolean
  multiKandidatEnabled: boolean
  onAnswered: () => Promise<void>
}) {
  const t = useTranslations('underlagsjakt')
  return (
    <>
      <tr
        className="group cursor-pointer hover:bg-secondary/35"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{formatDate(post.datum)}</td>
        <td className={TD_CLASS} data-ph-mask="">
          {post.konto_identitet || <span className="text-muted-foreground">{t('account_unknown')}</span>}
        </td>
        <td className={TD_CLASS} data-ph-mask="">
          <span className="mr-2">{post.motpart}</span>
          {post.kategori !== 'behover_mattias' && (
            <Badge variant="warning">{t(`kategori_post_${post.kategori}`)}</Badge>
          )}
        </td>
        <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>{post.typ}</td>
        <td className={cn(TD_CLASS, 'text-right whitespace-nowrap tabular-nums')} data-ph-mask="">
          {formatCurrency(post.belopp, post.valuta)}
        </td>
        <td className={cn(TD_CLASS, 'w-10 text-right')}>
          <button
            type="button"
            aria-label={expanded ? t('collapse') : t('expand')}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            <ChevronRight className={cn('h-4 w-4 transition-transform duration-150', expanded && 'rotate-90')} />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="border-b border-border p-0">
            <RowFoldout>
              <PostAnswerPanel
                post={post}
                posts={posts}
                bolagChoices={bolagChoices}
                uploadEnabled={uploadEnabled}
                leverarSjalvEnabled={leverarSjalvEnabled}
                multiKandidatEnabled={multiKandidatEnabled}
                onAnswered={onAnswered}
              />
            </RowFoldout>
          </td>
        </tr>
      )}
    </>
  )
}
