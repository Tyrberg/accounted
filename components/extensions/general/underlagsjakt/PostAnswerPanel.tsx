'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronUp, Eye, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import {
  KATEGORIER,
  MOMSTYPER,
  REGLERINGAR,
  candidatesOf,
  isValidSha256,
  type Kandidat,
  type Kategori,
  type Momstyp,
  type Post,
  type Reglering,
  type SvarInput,
} from '@/extensions/general/underlagsjakt/lib/contract'
import { matchesCandidate } from '@/extensions/general/underlagsjakt/lib/document'
import { looksLikeReferenceNumber, suggestBasKonto } from '@/extensions/general/underlagsjakt/lib/account-suggestion'
import { errorText } from './shared'

type Mode = 'val_kandidat' | 'fel_bolag' | 'osaker'

/** Sentinel for "none of the candidates": a chosen state, unlike `undefined` (nothing chosen yet). */
const NONE = 'none'
const EXTERNAL = '__external__'
const UNKNOWN = '__unknown__'
const OTHER = '__other__'
const OTHER_COMPANY = '__other_company__'
const PAYER = '__payer__'

const RADIO_CLASS = 'mt-1 h-4 w-4 shrink-0 accent-foreground'

export function PostAnswerPanel({
  post,
  bolagChoices,
  onAnswered,
}: {
  post: Post
  bolagChoices: string[]
  onAnswered: () => Promise<void>
}) {
  const t = useTranslations('underlagsjakt')
  const { toast } = useToast()
  const candidates = candidatesOf(post)
  const [mode, setMode] = useState<Mode>(post.kategori === 'fel_bolag' ? 'fel_bolag' : 'val_kandidat')
  const [saving, setSaving] = useState(false)

  // val_kandidat
  const suggestedKategori = (KATEGORIER as readonly string[]).includes(post.forslag?.kategori ?? '')
    ? (post.forslag!.kategori as Kategori)
    : undefined
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [motpart, setMotpart] = useState(post.motpart)
  const [kategori, setKategori] = useState<Kategori | undefined>(suggestedKategori)
  // null = follow the live suggestion below as kategori/motpart change; a string means the
  // owner typed something themselves, so it stops following.
  const [basKontoOverride, setBasKontoOverride] = useState<string | null>(null)
  // undefined = follow the live suggestion below as kategori changes; Momstyp | null means the
  // owner chose explicitly (including "ingen moms"), so it stops following.
  const [momstypOverride, setMomstypOverride] = useState<Momstyp | null | undefined>(undefined)
  const [begransaBolag, setBegransaBolag] = useState(false)
  const [begransaBelopp, setBegransaBelopp] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // fel_bolag: nothing preselected; the user must state each of the three facts.
  const [tillBolagChoice, setTillBolagChoice] = useState<string | undefined>(undefined)
  const [externalBolag, setExternalBolag] = useState('')
  const [mottagareChoice, setMottagareChoice] = useState<string | undefined>(undefined)
  const [otherMottagare, setOtherMottagare] = useState('')
  const [reglering, setReglering] = useState<Reglering | undefined>(undefined)

  // bertil's own forslag wins when it was made for the kategori actually chosen; otherwise
  // fall back to a suggestion derived from the kategori (and motpart) the owner picked, so
  // they never have to type a BAS account number themselves.
  const suggestedBasKonto =
    kategori && post.forslag?.kategori === kategori && post.forslag.bas_konto
      ? post.forslag.bas_konto
      : kategori
        ? suggestBasKonto(kategori, motpart, post.belopp)
        : null
  const basKonto = basKontoOverride ?? suggestedBasKonto ?? ''
  const basKontoValid = basKonto.trim() === '' || isAccountNumber(basKonto.trim())
  const motpartLooksLikeReference = looksLikeReferenceNumber(motpart)

  // Same "follow the forslag only when it was made for this kategori" rule as
  // suggestedBasKonto: correcting leverantor/svensk_25 to bankavgift (momsfritt)
  // must not silently keep submitting svensk_25.
  const suggestedMomstyp =
    kategori && post.forslag?.kategori === kategori && (MOMSTYPER as readonly string[]).includes(post.forslag?.momstyp ?? '')
      ? (post.forslag!.momstyp as Momstyp)
      : null
  const momstyp = momstypOverride !== undefined ? momstypOverride : suggestedMomstyp
  // A rejected BAS account (typed or from an unvalidated forslag.bas_konto) must not hide its
  // own error behind the collapsed disclosure: force it open until the owner fixes it.
  const advancedOpen = showAdvanced || !basKontoValid

  const tillBolag: string | null | undefined =
    tillBolagChoice === undefined
      ? undefined
      : tillBolagChoice === UNKNOWN
        ? null
        : tillBolagChoice === EXTERNAL
          ? externalBolag.trim() || undefined
          : tillBolagChoice
  const mottagare =
    mottagareChoice === OTHER
      ? otherMottagare.trim() || undefined
      : mottagareChoice === PAYER
        ? post.bolag
        : mottagareChoice === OTHER_COMPANY && typeof tillBolag === 'string'
          ? tillBolag
          : undefined

  const otherCompanies = bolagChoices.filter((b) => b.toLowerCase() !== post.bolag.toLowerCase())

  const buildInput = (): SvarInput | null => {
    const transaction_id = post.transaction_id
    if (mode === 'osaker') return { svarstyp: 'osaker', transaction_id }
    if (mode === 'fel_bolag') {
      if (tillBolag === undefined || !mottagare) return null
      if (tillBolag !== null && !reglering) return null
      return {
        svarstyp: 'fel_bolag',
        transaction_id,
        till_bolag: tillBolag,
        fel_bolag_mottagare: mottagare,
        reglering: tillBolag === null ? null : (reglering ?? null),
      }
    }
    if (chosen === undefined || !kategori || !motpart.trim() || !basKontoValid) return null
    return {
      svarstyp: 'val_kandidat',
      transaction_id,
      sha256: chosen === NONE ? null : chosen,
      motpart: motpart.trim(),
      kategori,
      bas_konto: basKonto.trim() || null,
      momstyp,
      begransa_bolag: begransaBolag,
      begransa_belopp: begransaBelopp,
    }
  }

  const input = buildInput()

  const submit = async () => {
    if (!input) return
    setSaving(true)
    try {
      const res = await fetch('/api/extensions/ext/underlagsjakt/svar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: t('save_failed'), description: errorText(t, json), variant: 'destructive' })
        return
      }
      await onAnswered()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 bg-secondary/20 px-4 py-6" data-ph-mask="">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-2">
        <Fact label={t('fact_company')} value={`${post.bolag} (${post.period})`} />
        <Fact label={t('fact_account')} value={post.konto_identitet || t('account_unknown')} />
        <Fact label={t('fact_type')} value={post.typ} />
        <Fact
          label={t('fact_balance')}
          value={post.saldo === null ? '-' : formatCurrency(post.saldo, post.valuta)}
          numeric
        />
        <Fact label={t('fact_what')} value={post.forslag?.varfor || t('fact_what_unknown')} wide />
        {post.mottagare && <Fact label={t('fact_addressee')} value={post.mottagare} wide />}
      </dl>

      <SegmentedControl<Mode>
        aria-label={t('answer_mode_label')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'val_kandidat', label: t('mode_val_kandidat') },
          { value: 'fel_bolag', label: t('mode_fel_bolag') },
          { value: 'osaker', label: t('mode_osaker') },
        ]}
      />

      {mode === 'val_kandidat' && (
        <div className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">{t('candidates_legend')}</legend>
            {candidates.length === 0 && (
              <p className="text-[12.5px] text-muted-foreground">{t('candidates_none')}</p>
            )}
            {candidates.map((k) => (
              <CandidateOption
                key={k.sha256 || k.filnamn}
                name={`kandidat-${post.transaction_id}`}
                candidate={k}
                checked={chosen === k.sha256}
                onSelect={() => setChosen(k.sha256)}
              />
            ))}
            <label className="flex items-start gap-3 text-[13px]">
              <input
                type="radio"
                className={RADIO_CLASS}
                name={`kandidat-${post.transaction_id}`}
                checked={chosen === NONE}
                onChange={() => setChosen(NONE)}
              />
              <span>{candidates.length === 0 ? t('candidate_none_needed') : t('candidate_none_of_them')}</span>
            </label>
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`motpart-${post.transaction_id}`}>{t('field_motpart')}</Label>
              <Input
                id={`motpart-${post.transaction_id}`}
                value={motpart}
                onChange={(e) => setMotpart(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('field_motpart_hint')}</p>
              {motpartLooksLikeReference && (
                <p className="text-[12.5px] text-attn">{t('motpart_reference_number_warning')}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('field_kategori')}</Label>
              <Select value={kategori} onValueChange={(v) => setKategori(v as Kategori)}>
                <SelectTrigger aria-label={t('field_kategori')}>
                  <SelectValue>{kategori ? t(`kategori_${kategori}`) : t('field_kategori_choose')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {KATEGORIER.map((k) => (
                    <SelectItem key={k} value={k}>
                      <span className="flex flex-col py-0.5">
                        <span>{t(`kategori_${k}`)}</span>
                        <span className="text-xs text-muted-foreground">{t(`kategori_${k}_example`)}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {kategori && suggestedBasKonto && (
                <p className="text-xs text-muted-foreground">
                  {t('suggested_account', { account: formatAccountWithName(suggestedBasKonto) })}
                </p>
              )}
              {momstyp && (
                <p className="text-xs text-muted-foreground">
                  {t('current_momstyp', { momstyp: t(`momstyp_${momstyp}`) })}
                </p>
              )}
            </div>
          </div>

          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 justify-start gap-1.5 px-0 text-xs text-muted-foreground hover:bg-transparent"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {advancedOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {t('advanced_toggle')}
            </Button>
            {advancedOpen && (
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`bas-${post.transaction_id}`}>{t('field_bas_konto')}</Label>
                  <Input
                    id={`bas-${post.transaction_id}`}
                    inputMode="numeric"
                    maxLength={4}
                    value={basKonto}
                    onChange={(e) => setBasKontoOverride(e.target.value)}
                    aria-invalid={!basKontoValid}
                  />
                  {!basKontoValid && <p className="text-xs text-destructive">{t('field_bas_konto_invalid')}</p>}
                </div>
                <div className="space-y-2">
                  <Label>{t('field_momstyp')}</Label>
                  <Select
                    value={momstyp ?? NONE}
                    onValueChange={(v) => setMomstypOverride(v === NONE ? null : (v as Momstyp))}
                  >
                    <SelectTrigger aria-label={t('field_momstyp')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('momstyp_none')}</SelectItem>
                      {MOMSTYPER.map((m) => (
                        <SelectItem key={m} value={m}>
                          {t(`momstyp_${m}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2 text-[13px]">
            <label className="flex items-center gap-3">
              <Checkbox
                className="border-foreground"
                checked={begransaBolag}
                onCheckedChange={(v) => setBegransaBolag(v === true)}
              />
              {t('restrict_bolag', { bolag: post.bolag })}
            </label>
            <label className="flex items-center gap-3">
              <Checkbox
                className="border-foreground"
                checked={begransaBelopp}
                onCheckedChange={(v) => setBegransaBelopp(v === true)}
              />
              {t('restrict_belopp', { belopp: formatCurrency(Math.abs(post.belopp), post.valuta) })}
            </label>
          </div>
        </div>
      )}

      {mode === 'fel_bolag' && (
        <div className="space-y-6">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{t('fel_bolag_which_company')}</legend>
            {otherCompanies.map((b) => (
              <RadioRow
                key={b}
                name={`till-${post.transaction_id}`}
                checked={tillBolagChoice === b}
                onSelect={() => setTillBolagChoice(b)}
                label={b}
              />
            ))}
            <RadioRow
              name={`till-${post.transaction_id}`}
              checked={tillBolagChoice === EXTERNAL}
              onSelect={() => setTillBolagChoice(EXTERNAL)}
              label={t('fel_bolag_external')}
            />
            {tillBolagChoice === EXTERNAL && (
              <div className="ml-8 max-w-sm space-y-2">
                <Label htmlFor={`extern-${post.transaction_id}`}>{t('fel_bolag_external_name')}</Label>
                <Input
                  id={`extern-${post.transaction_id}`}
                  value={externalBolag}
                  onChange={(e) => setExternalBolag(e.target.value)}
                />
              </div>
            )}
            <RadioRow
              name={`till-${post.transaction_id}`}
              checked={tillBolagChoice === UNKNOWN}
              onSelect={() => setTillBolagChoice(UNKNOWN)}
              label={t('fel_bolag_unknown')}
            />
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">{t('fel_bolag_invoice_to')}</legend>
            <p className="mb-2 text-xs text-muted-foreground">
              {post.mottagare
                ? t('fel_bolag_invoice_to_hint_read', { mottagare: post.mottagare })
                : t('fel_bolag_invoice_to_hint')}
            </p>
            {typeof tillBolag === 'string' && (
              <RadioRow
                name={`mottagare-${post.transaction_id}`}
                checked={mottagareChoice === OTHER_COMPANY}
                onSelect={() => setMottagareChoice(OTHER_COMPANY)}
                label={t('fel_bolag_invoice_to_other_company', { bolag: tillBolag })}
              />
            )}
            <RadioRow
              name={`mottagare-${post.transaction_id}`}
              checked={mottagareChoice === PAYER}
              onSelect={() => setMottagareChoice(PAYER)}
              label={t('fel_bolag_invoice_to_payer', { bolag: post.bolag })}
            />
            <RadioRow
              name={`mottagare-${post.transaction_id}`}
              checked={mottagareChoice === OTHER}
              onSelect={() => setMottagareChoice(OTHER)}
              label={t('fel_bolag_invoice_to_someone_else')}
            />
            {mottagareChoice === OTHER && (
              <div className="ml-8 max-w-sm space-y-2">
                <Label htmlFor={`mottagare-namn-${post.transaction_id}`}>{t('fel_bolag_invoice_to_name')}</Label>
                <Input
                  id={`mottagare-namn-${post.transaction_id}`}
                  value={otherMottagare}
                  onChange={(e) => setOtherMottagare(e.target.value)}
                />
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-2" disabled={tillBolag === null}>
            <legend className={cn('mb-1 text-sm font-medium', tillBolag === null && 'text-muted-foreground')}>
              {t('fel_bolag_settlement')}
            </legend>
            {REGLERINGAR.map((r) => (
              <RadioRow
                key={r}
                name={`reglering-${post.transaction_id}`}
                checked={reglering === r}
                onSelect={() => setReglering(r)}
                label={t(`reglering_${r}`)}
              />
            ))}
            <p className="text-xs text-muted-foreground">
              {tillBolag === null ? t('fel_bolag_settlement_needs_company') : t('fel_bolag_settlement_not_in_contract')}
            </p>
          </fieldset>
          <p className="text-xs text-muted-foreground">{t('fel_bolag_not_booked')}</p>
        </div>
      )}

      {mode === 'osaker' && <p className="text-[13px] text-muted-foreground">{t('osaker_description')}</p>}

      <div className="flex justify-end">
        <Button onClick={() => void submit()} disabled={!input || saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {mode === 'osaker' ? t('submit_osaker') : t('submit')}
        </Button>
      </div>
    </div>
  )
}

function Fact({ label, value, numeric, wide }: { label: string; value: string; numeric?: boolean; wide?: boolean }) {
  return (
    <div className={cn('flex gap-3', wide && 'sm:col-span-2')}>
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn(numeric && 'tabular-nums')}>{value}</dd>
    </div>
  )
}

function RadioRow({
  name,
  checked,
  onSelect,
  label,
}: {
  name: string
  checked: boolean
  onSelect: () => void
  label: string
}) {
  return (
    <label className="flex items-start gap-3 text-[13px]">
      <input type="radio" className={RADIO_CLASS} name={name} checked={checked} onChange={onSelect} />
      <span>{label}</span>
    </label>
  )
}

function CandidateOption({
  name,
  candidate,
  checked,
  onSelect,
}: {
  name: string
  candidate: Kandidat
  checked: boolean
  onSelect: () => void
}) {
  const t = useTranslations('underlagsjakt')
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const selectable = isValidSha256(candidate.sha256)

  const openDocument = async (file: File) => {
    const data = await file.arrayBuffer()
    if (!(await matchesCandidate(data, candidate.sha256))) {
      toast({
        title: t('document_mismatch_title'),
        description: t('document_mismatch_description', { filnamn: candidate.filnamn }),
        variant: 'destructive',
      })
      return
    }
    const url = URL.createObjectURL(new Blob([data], { type: file.type || 'application/pdf' }))
    window.open(url, '_blank', 'noopener')
    // The tab holds its own reference; release ours once it has loaded.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  return (
    <div className={cn('rounded-lg border border-border p-4', checked && 'border-foreground')}>
      <div className="flex items-start gap-3">
        <input
          type="radio"
          className={RADIO_CLASS}
          name={name}
          checked={checked}
          disabled={!selectable}
          onChange={onSelect}
          aria-label={candidate.filnamn}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-[13px] font-medium">{candidate.filnamn}</p>
          <p className="text-[13px]">{candidate.bevisgrund}</p>
          <p className="text-xs text-muted-foreground">
            {candidate.datum
              ? t('candidate_source_dated', { kalla: candidate.kalla, datum: formatDate(candidate.datum) })
              : t('candidate_source', { kalla: candidate.kalla })}
          </p>
          {!selectable && <p className="text-xs text-destructive">{t('candidate_without_hash')}</p>}
        </div>
        {selectable && (
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void openDocument(file)
                e.target.value = ''
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Eye className="mr-2 h-4 w-4" />
              {t('document_view')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
