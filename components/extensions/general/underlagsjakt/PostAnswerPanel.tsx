'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Eye, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { isAccountNumber } from '@/lib/invariants/account-number'
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
} from '@/extensions/general/underlagsjakt/lib/contract'
import { matchesCandidate } from '@/extensions/general/underlagsjakt/lib/document'
import {
  EXTERNAL,
  NONE,
  OTHER,
  OTHER_COMPANY,
  PAYER,
  UNKNOWN,
  buildAnswerInput,
  deriveTillBolag,
  interpretSaveResult,
} from './shared'

type Mode = 'val_kandidat' | 'fel_bolag' | 'osaker'

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
  const suggestedMomstyp = (MOMSTYPER as readonly string[]).includes(post.forslag?.momstyp ?? '')
    ? (post.forslag!.momstyp as Momstyp)
    : null
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [motpart, setMotpart] = useState(post.motpart)
  const [kategori, setKategori] = useState<Kategori | undefined>(suggestedKategori)
  const [basKonto, setBasKonto] = useState(post.forslag?.bas_konto ?? '')
  const [momstyp, setMomstyp] = useState<Momstyp | null>(suggestedMomstyp)
  const [begransaBolag, setBegransaBolag] = useState(false)
  const [begransaBelopp, setBegransaBelopp] = useState(false)

  // fel_bolag: nothing preselected; the user must state each of the three facts.
  const [tillBolagChoice, setTillBolagChoice] = useState<string | undefined>(undefined)
  const [externalBolag, setExternalBolag] = useState('')
  const [mottagareChoice, setMottagareChoice] = useState<string | undefined>(undefined)
  const [otherMottagare, setOtherMottagare] = useState('')
  const [reglering, setReglering] = useState<Reglering | undefined>(undefined)

  const basKontoValid = basKonto.trim() === '' || isAccountNumber(basKonto.trim())

  // Same derivation buildAnswerInput uses for validation, so what's rendered (the "same
  // company" recipient option, the settlement fieldset) can never drift from what's required.
  const tillBolag = deriveTillBolag(tillBolagChoice, externalBolag)

  const otherCompanies = bolagChoices.filter((b) => b.toLowerCase() !== post.bolag.toLowerCase())

  const answerResult = buildAnswerInput({
    mode,
    transactionId: post.transaction_id,
    hasCandidate: chosen !== undefined,
    sha256: chosen === NONE ? null : (chosen ?? null),
    kategori,
    motpart,
    basKonto,
    basKontoValid,
    momstyp,
    begransaBolag,
    begransaBelopp,
    tillBolagChoice,
    externalBolag,
    mottagareChoice,
    otherMottagare,
    payerBolag: post.bolag,
    reglering,
  })
  const input = answerResult.input ?? null
  const missingReasons = answerResult.missing ?? []

  const submit = async () => {
    if (!input) return
    setSaving(true)
    try {
      const res = await fetch('/api/extensions/ext/underlagsjakt/svar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const json: unknown = await res.json().catch(() => null)
      const outcome = interpretSaveResult(t, res.ok, json)
      toast(outcome.toast)
      if (outcome.refresh) await onAnswered()
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
                      {t(`kategori_${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`bas-${post.transaction_id}`}>{t('field_bas_konto')}</Label>
              <Input
                id={`bas-${post.transaction_id}`}
                inputMode="numeric"
                maxLength={4}
                value={basKonto}
                onChange={(e) => setBasKonto(e.target.value)}
                aria-invalid={!basKontoValid}
              />
              {!basKontoValid && <p className="text-xs text-destructive">{t('field_bas_konto_invalid')}</p>}
            </div>
            <div className="space-y-2">
              <Label>{t('field_momstyp')}</Label>
              <Select
                value={momstyp ?? NONE}
                onValueChange={(v) => setMomstyp(v === NONE ? null : (v as Momstyp))}
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

      <div className="flex flex-col items-end gap-2">
        {!input && !saving && (
          <p className="text-xs text-muted-foreground">
            {t('save_disabled_reason', { fields: missingReasons.map((key) => t(key)).join(', ') })}
          </p>
        )}
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
