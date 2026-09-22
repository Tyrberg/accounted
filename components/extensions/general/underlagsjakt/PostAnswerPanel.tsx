'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Eye, Loader2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { INBOX_MAX_UPLOAD_BYTES, exceedsHostedUploadLimit, formatMegabytes, isShrinkableImage, tooLargeMessage } from '@/lib/documents/upload-size'
import { shrinkImageForUpload } from '@/lib/documents/shrink-image'
import {
  KATEGORIER,
  MOMSTYPER,
  REGLERINGAR,
  UNDERLAG_UPLOAD_MIME_TYPES,
  candidatesOf,
  isValidSha256,
  type Kandidat,
  type Kategori,
  type Momstyp,
  type Post,
  type Reglering,
} from '@/extensions/general/underlagsjakt/lib/contract'
import { matchesCandidate } from '@/extensions/general/underlagsjakt/lib/document'
import { bulkTargets } from '@/extensions/general/underlagsjakt/lib/store'
import {
  EXTERNAL,
  NONE,
  OTHER,
  OTHER_COMPANY,
  PAYER,
  UNKNOWN,
  buildAnswerInput,
  deriveTillBolag,
  isReglerarSkuldAccountValid,
  searchReglerarSkuldVerifikat,
  submitAnswer,
  submitBulkAnswer,
  summarizeSelectedCandidates,
  type VerifikatSearchResult,
} from './shared'

import { suggestAnswerAccount } from './account-suggestion'

type Mode = 'val_kandidat' | 'uppladdat_underlag' | 'fel_bolag' | 'levererar_sjalv' | 'reglerar_skuld' | 'osaker'

const UPLOAD_ACCEPT = UNDERLAG_UPLOAD_MIME_TYPES.join(',')

const RADIO_CLASS = 'mt-1 h-4 w-4 shrink-0 accent-foreground'

export function PostAnswerPanel({
  post,
  posts,
  bolagChoices,
  uploadEnabled,
  leverarSjalvEnabled,
  multiKandidatEnabled = false,
  reglerarSkuldEnabled = false,
  onAnswered,
}: {
  post: Post
  posts: Post[]
  bolagChoices: string[]
  /** Off until bertil reads answer version 1.5: the upload option is then not offered. */
  uploadEnabled: boolean
  /** Off until bertil understands levererar_sjalv: the "I'll deliver it" option is then not offered. */
  leverarSjalvEnabled: boolean
  /** Off until bertil reads vald_kandidater (answer version 1.6): candidates stay single-choice. */
  multiKandidatEnabled?: boolean
  /** Off until bertil reads reglerar_skuld (answer version 1.7): the "settles a booked debt" option is then not offered. */
  reglerarSkuldEnabled?: boolean
  onAnswered: () => Promise<void>
}) {
  const t = useTranslations('underlagsjakt')
  const { toast } = useToast()
  const candidates = candidatesOf(post)
  const [mode, setMode] = useState<Mode>(post.kategori === 'fel_bolag' ? 'fel_bolag' : 'val_kandidat')
  const [saving, setSaving] = useState(false)

  // uppladdat_underlag
  const [file, setFile] = useState<File | undefined>(undefined)
  const [preparingFile, setPreparingFile] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // levererar_sjalv
  const [applyToAllVendor, setApplyToAllVendor] = useState(false)
  // The same function the server recounts with, so the promised number is the one enforced.
  const bulkCount = bulkTargets(posts, post).length

  // val_kandidat
  const suggestedKategori = (KATEGORIER as readonly string[]).includes(post.forslag?.kategori ?? '')
    ? (post.forslag!.kategori as Kategori)
    : undefined
  const suggestedMomstyp = (MOMSTYPER as readonly string[]).includes(post.forslag?.momstyp ?? '')
    ? (post.forslag!.momstyp as Momstyp)
    : null
  // Checkboxes once there is more than one candidate and multiKandidatEnabled; a single choice
  // (mouse-click count, not candidate count) stays exactly as easy as the radio it replaces.
  const showCheckboxes = multiKandidatEnabled && candidates.length > 1
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [noneChosen, setNoneChosen] = useState(false)
  const toggleCandidate = (sha256: string) => {
    setNoneChosen(false)
    setChosen((prev) => {
      if (!showCheckboxes) return new Set([sha256])
      const next = new Set(prev)
      if (next.has(sha256)) next.delete(sha256)
      else next.add(sha256)
      return next
    })
  }
  const selectNone = () => {
    setChosen(new Set())
    setNoneChosen(true)
  }
  const selectedCandidates = candidates.filter((k) => chosen.has(k.sha256))
  // bertil does not send belopp on every candidate (or any, yet): sum what it knows and say
  // plainly when a chosen document is not part of the sum, instead of a confidently wrong total.
  // summarizeSelectedCandidates keeps the payment's own sign throughout (both belopp fields are
  // negative for outgoing), so the diff is never computed by mixing a signed sum against an
  // absolute-valued payment.
  const { sum: selectedSum, missingBeloppCount, diff: selectedDiff } = summarizeSelectedCandidates(post.belopp, selectedCandidates)
  const [motpart, setMotpart] = useState(post.motpart)
  const [kategori, setKategori] = useState<Kategori | undefined>(suggestedKategori)
  const [basKontoOverride, setBasKontoOverride] = useState<string | undefined>(undefined)
  const suggestedAccount = suggestAnswerAccount(kategori, post.belopp, post.motpart)
  const [categoryChanged, setCategoryChanged] = useState(false)
  const basKonto = basKontoOverride ?? (!categoryChanged ? post.forslag?.bas_konto : null) ?? suggestedAccount
  const isAccountSuggestion = basKontoOverride === undefined && basKonto !== ''
  const optionalSuffix = useTranslations('settings_booking_templates')('optional_suffix')
  const [momstyp, setMomstyp] = useState<Momstyp | null>(suggestedMomstyp)
  const [begransaBolag, setBegransaBolag] = useState(false)
  const [begransaBelopp, setBegransaBelopp] = useState(false)

  // fel_bolag: nothing preselected; the user must state each of the three facts.
  const [tillBolagChoice, setTillBolagChoice] = useState<string | undefined>(undefined)
  const [externalBolag, setExternalBolag] = useState('')
  const [mottagareChoice, setMottagareChoice] = useState<string | undefined>(undefined)
  const [otherMottagare, setOtherMottagare] = useState('')
  const [reglering, setReglering] = useState<Reglering | undefined>(undefined)

  // reglerar_skuld: the debt is settled by pointing at the verifikat that already booked it,
  // found by searching Accounted's own journal entries (never typed), and the suggested
  // account is read from that verifikat's own BAS class 2 lines (account-suggestion.ts),
  // never the cost templates val_kandidat/uppladdat_underlag use.
  const [verifikatQuery, setVerifikatQuery] = useState('')
  const [verifikatResults, setVerifikatResults] = useState<VerifikatSearchResult[]>([])
  const [verifikatSearching, setVerifikatSearching] = useState(false)
  const [verifikatSearchError, setVerifikatSearchError] = useState<string | null>(null)
  const [verifikatSearched, setVerifikatSearched] = useState(false)
  const [selectedVerifikat, setSelectedVerifikat] = useState<VerifikatSearchResult | null>(null)
  const [skuldkontoOverride, setSkuldkontoOverride] = useState<string | undefined>(undefined)
  const reglerarBasKonto =
    skuldkontoOverride ?? (selectedVerifikat?.accountCandidates.length === 1 ? selectedVerifikat.accountCandidates[0] : '')
  const reglerarBasKontoValid = isReglerarSkuldAccountValid(reglerarBasKonto)
  // Guards against an in-flight search whose response arrives after a newer one: only the
  // most recently issued request may write its result, so a slow response for an earlier
  // query can never overwrite a faster response for what the user searched next.
  const verifikatSearchSeq = useRef(0)

  const searchVerifikat = async () => {
    const query = verifikatQuery.trim()
    if (!query) return
    const seq = ++verifikatSearchSeq.current
    setVerifikatSearching(true)
    setVerifikatSearchError(null)
    const outcome = await searchReglerarSkuldVerifikat(query)
    if (seq !== verifikatSearchSeq.current) return
    if (outcome.ok) {
      setVerifikatResults(outcome.results)
    } else {
      setVerifikatResults([])
      setVerifikatSearchError(t('reglerar_skuld_search_error'))
    }
    setVerifikatSearching(false)
    setVerifikatSearched(true)
  }

  const selectVerifikat = (v: VerifikatSearchResult) => {
    setSelectedVerifikat(v)
    setSkuldkontoOverride(undefined)
  }

  const basKontoValid = basKonto.trim() === '' || isAccountNumber(basKonto.trim())

  // Same derivation buildAnswerInput uses for validation, so what's rendered (the "same
  // company" recipient option, the settlement fieldset) can never drift from what's required.
  const tillBolag = deriveTillBolag(tillBolagChoice, externalBolag)

  const otherCompanies = bolagChoices.filter((b) => b.toLowerCase() !== post.bolag.toLowerCase())

  const answerResult = buildAnswerInput({
    mode,
    file,
    transactionId: post.transaction_id,
    hasCandidate: noneChosen || chosen.size > 0,
    sha256: Array.from(chosen),
    kategori,
    motpart,
    basKonto: mode === 'reglerar_skuld' ? reglerarBasKonto : basKonto,
    basKontoValid: mode === 'reglerar_skuld' ? reglerarBasKontoValid : basKontoValid,
    momstyp,
    begransaBolag,
    begransaBelopp,
    applyToAllVendor,
    tillBolagChoice,
    externalBolag,
    mottagareChoice,
    otherMottagare,
    payerBolag: post.bolag,
    reglering,
    ursprungsverifikatId: selectedVerifikat?.id,
  })
  const input = answerResult.input ?? null
  const missingReasons = answerResult.missing ?? []
  const ready = missingReasons.length === 0
  // Same rule as BookDirectlyDialog's disabledReason/canSubmit split (components/extensions/general/BookDirectlyDialog.tsx):
  // null while a save is in flight, so the line reads "ready" instead of flashing a stale reason.
  const disabledReason = saving || ready ? null : t('save_disabled_reason', { fields: missingReasons.map((key) => t(key)).join(', ') })
  // Derived from the same `ready` the line above reads, not from `input`, so the button and the
  // hint can never disagree even if buildAnswerInput's type ever allowed an empty `missing: []`.
  const canSubmit = ready && !saving && !preparingFile

  // A phone photo is routinely over the hosted body limit: shrink it here, and refuse with the
  // real reason (size and ceiling) when that is not enough, instead of a bare platform 413.
  const chooseFile = async (original: File) => {
    setPreparingFile(true)
    try {
      let chosenFile = original
      if (exceedsHostedUploadLimit(chosenFile.size) && isShrinkableImage(chosenFile.type)) {
        chosenFile = await shrinkImageForUpload(chosenFile)
      }
      const problem = !(UNDERLAG_UPLOAD_MIME_TYPES as readonly string[]).includes(chosenFile.type)
        ? t('upload_unsupported_type')
        : chosenFile.size > INBOX_MAX_UPLOAD_BYTES
          ? t('upload_too_large', { size: formatMegabytes(chosenFile.size), max: formatMegabytes(INBOX_MAX_UPLOAD_BYTES) })
          : exceedsHostedUploadLimit(chosenFile.size)
            ? tooLargeMessage(chosenFile.size)
            : null
      if (problem) {
        setFile(undefined)
        toast({ title: t('upload_rejected_title'), description: problem, variant: 'destructive' })
        return
      }
      setFile(chosenFile)
    } finally {
      setPreparingFile(false)
    }
  }

  const submit = async () => {
    if (!input) return
    setSaving(true)
    try {
      if (applyToAllVendor && input.svarstyp === 'levererar_sjalv') {
        await submitBulkAnswer(input, bulkCount, t, (outcome) => toast(outcome.toast), onAnswered)
      } else {
        await submitAnswer(input, t, (outcome) => toast(outcome.toast), onAnswered, undefined, file)
      }
    } finally {
      setSaving(false)
    }
  }

  // Shared by "choose a document" and "upload a document": both teach bertil the same rule.
  const classificationFields = (
    <>
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
          <Select value={kategori} onValueChange={(v) => {
            setKategori(v as Kategori)
            setCategoryChanged(true)
          }}>
            <SelectTrigger aria-label={t('field_kategori')}>
              <SelectValue>{kategori ? t(`kategori_${kategori}`) : t('field_kategori_choose')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {KATEGORIER.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`kategori_option_${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`bas-${post.transaction_id}`}>{t('field_bas_konto')} {optionalSuffix}</Label>
          <Input
            id={`bas-${post.transaction_id}`}
            inputMode="numeric"
            maxLength={4}
            value={basKonto}
            onChange={(e) => setBasKontoOverride(e.target.value)}
            aria-invalid={!basKontoValid}
            aria-describedby={isAccountSuggestion ? `bas-suggestion-${post.transaction_id}` : undefined}
          />
          {isAccountSuggestion && (
            <p id={`bas-suggestion-${post.transaction_id}`} className="text-xs text-muted-foreground">
              {t('field_bas_konto_suggestion')}
            </p>
          )}
          {!basKontoValid && <p className="text-xs text-destructive">{t('field_bas_konto_invalid')}</p>}
        </div>
        <div className="space-y-2">
          <Label>{t('field_momstyp')} {optionalSuffix}</Label>
          <Select
            value={momstyp ?? NONE}
            onValueChange={(v) => setMomstyp(v === NONE ? null : (v as Momstyp))}
          >
            <SelectTrigger aria-label={`${t('field_momstyp')} ${optionalSuffix}`}>
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
    </>
  )

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
          ...(uploadEnabled ? [{ value: 'uppladdat_underlag' as const, label: t('mode_uppladdat_underlag') }] : []),
          ...(leverarSjalvEnabled ? [{ value: 'levererar_sjalv' as const, label: t('mode_levererar_sjalv') }] : []),
          ...(reglerarSkuldEnabled ? [{ value: 'reglerar_skuld' as const, label: t('mode_reglerar_skuld') }] : []),
          { value: 'fel_bolag', label: t('mode_fel_bolag') },
          { value: 'osaker', label: t('mode_osaker') },
        ]}
      />

      {mode === 'val_kandidat' && (
        <div className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">{t('candidates_legend')}</legend>
            {showCheckboxes && <p className="text-[12.5px] text-muted-foreground">{t('candidates_legend_multi_hint')}</p>}
            {candidates.length === 0 && (
              <div className="space-y-2">
                <p className="text-[12.5px] text-muted-foreground">{t('candidates_none')}</p>
                {uploadEnabled && (
                  <Button variant="outline" size="sm" onClick={() => setMode('uppladdat_underlag')}>
                    <Upload className="mr-2 h-4 w-4" />
                    {t('candidates_none_upload')}
                  </Button>
                )}
              </div>
            )}
            {candidates.map((k) => (
              <CandidateOption
                key={k.sha256 || k.filnamn}
                name={`kandidat-${post.transaction_id}`}
                candidate={k}
                checked={chosen.has(k.sha256)}
                useCheckbox={showCheckboxes}
                onSelect={() => toggleCandidate(k.sha256)}
              />
            ))}
            <label className="flex items-start gap-3 text-[13px]">
              {showCheckboxes ? (
                <Checkbox
                  className="mt-0.5 border-foreground"
                  checked={noneChosen}
                  onCheckedChange={(v) => (v === true ? selectNone() : setNoneChosen(false))}
                />
              ) : (
                <input
                  type="radio"
                  className={RADIO_CLASS}
                  name={`kandidat-${post.transaction_id}`}
                  checked={noneChosen}
                  onChange={selectNone}
                />
              )}
              <span>{candidates.length === 0 ? t('candidate_none_needed') : t('candidate_none_of_them')}</span>
            </label>
            {selectedCandidates.length > 1 && (
              <p className="text-[12.5px] text-muted-foreground" aria-live="polite">
                {t('candidates_selected_sum', {
                  sum: formatCurrency(Math.abs(selectedSum), post.valuta),
                  belopp: formatCurrency(Math.abs(post.belopp), post.valuta),
                })}
                {missingBeloppCount > 0
                  ? ` ${t('candidates_selected_sum_missing_belopp', { count: missingBeloppCount })}`
                  : selectedDiff !== 0
                    ? ` ${t('candidates_selected_sum_diff', { diff: formatCurrency(Math.abs(selectedDiff), post.valuta) })}`
                    : ''}
              </p>
            )}
          </fieldset>

          {classificationFields}
        </div>
      )}

      {mode === 'uppladdat_underlag' && (
        <div className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">{t('upload_legend')}</legend>
            <p className="text-[12.5px] text-muted-foreground">{t('upload_description')}</p>
            <input
              ref={fileInputRef}
              type="file"
              accept={UPLOAD_ACCEPT}
              className="hidden"
              aria-label={t('upload_choose')}
              onChange={(e) => {
                const picked = e.target.files?.[0]
                if (picked) void chooseFile(picked)
                e.target.value = ''
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={saving}>
                {preparingFile ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                {file ? t('upload_change') : t('upload_choose')}
              </Button>
              {file && (
                <span className="min-w-0 truncate text-[13px]">
                  {file.name} <span className="text-xs text-muted-foreground tabular-nums">({formatMegabytes(file.size)})</span>
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t('upload_formats')}</p>
          </fieldset>
          {classificationFields}
        </div>
      )}

      {mode === 'reglerar_skuld' && (
        <div className="space-y-6">
          <p className="text-[13px] text-muted-foreground">{t('reglerar_skuld_description')}</p>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">{t('reglerar_skuld_search_legend')}</legend>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                value={verifikatQuery}
                onChange={(e) => setVerifikatQuery(e.target.value)}
                aria-label={t('reglerar_skuld_search_legend')}
                aria-describedby={`reglerar-sok-hint-${post.transaction_id}`}
                className="max-w-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void searchVerifikat()}
                disabled={verifikatSearching || !verifikatQuery.trim()}
              >
                {verifikatSearching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('reglerar_skuld_search_button')}
              </Button>
            </div>
            <p id={`reglerar-sok-hint-${post.transaction_id}`} className="text-xs text-muted-foreground">
              {t('reglerar_skuld_search_hint')}
            </p>
            {verifikatSearchError &&<p className="text-xs text-destructive">{verifikatSearchError}</p>}
            {verifikatResults.length > 0 && (
              <div className="space-y-2">
                {verifikatResults.map((v) => (
                  <RadioRow
                    key={v.id}
                    name={`reglerar-verifikat-${post.transaction_id}`}
                    checked={selectedVerifikat?.id === v.id}
                    onSelect={() => selectVerifikat(v)}
                    label={t('reglerar_skuld_verifikat_row', { label: v.label, datum: formatDate(v.date), beskrivning: v.description })}
                  />
                ))}
              </div>
            )}
            {verifikatSearched && verifikatResults.length === 0 && !verifikatSearching && !verifikatSearchError && (
              <p className="text-[12.5px] text-muted-foreground">{t('reglerar_skuld_no_results')}</p>
            )}
          </fieldset>

          {selectedVerifikat && (
            <div className="space-y-2">
              <Label htmlFor={`reglerar-konto-${post.transaction_id}`}>{t('reglerar_skuld_account_label')}</Label>
              {selectedVerifikat.accountCandidates.length > 1 ? (
                <Select value={reglerarBasKonto || undefined} onValueChange={(v) => setSkuldkontoOverride(v)}>
                  <SelectTrigger aria-label={t('reglerar_skuld_account_label')}>
                    <SelectValue>{reglerarBasKonto || t('reglerar_skuld_account_choose')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {selectedVerifikat.accountCandidates.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`reglerar-konto-${post.transaction_id}`}
                  inputMode="numeric"
                  maxLength={4}
                  value={reglerarBasKonto}
                  onChange={(e) => setSkuldkontoOverride(e.target.value)}
                  aria-invalid={!reglerarBasKontoValid}
                />
              )}
              {selectedVerifikat.accountCandidates.length === 0 && (
                <p className="text-xs text-attn">{t('reglerar_skuld_no_liability_account')}</p>
              )}
              {!reglerarBasKontoValid && reglerarBasKonto.trim() !== '' && (
                <p className="text-xs text-destructive">{t('reglerar_skuld_account_invalid')}</p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor={`reglerar-motpart-${post.transaction_id}`}>{t('field_motpart')}</Label>
            <Input
              id={`reglerar-motpart-${post.transaction_id}`}
              value={motpart}
              onChange={(e) => setMotpart(e.target.value)}
            />
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

      {mode === 'levererar_sjalv' && (
        <div className="space-y-4">
          <p className="text-[13px] text-muted-foreground">{t('levererar_sjalv_description')}</p>
          <label className="flex items-center gap-3 text-[13px]">
            <Checkbox
              className="border-foreground"
              checked={applyToAllVendor}
              onCheckedChange={(v) => setApplyToAllVendor(v === true)}
            />
            {t('levererar_sjalv_apply_to_all', { motpart: post.motpart })}
          </label>
          {applyToAllVendor && (
            <p className="ml-8 text-xs text-muted-foreground">{t('levererar_sjalv_count', { count: bulkCount })}</p>
          )}
        </div>
      )}

      {mode === 'osaker' && <p className="text-[13px] text-muted-foreground">{t('osaker_description')}</p>}

      <div className="flex flex-col items-end gap-2">
        <p className={cn('text-xs', disabledReason ? 'text-attn' : 'text-muted-foreground')} aria-live="polite">
          {disabledReason ?? t('save_ready')}
        </p>
        <Button onClick={() => void submit()} disabled={!canSubmit}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {mode === 'osaker' ? t('submit_osaker') : mode === 'uppladdat_underlag' ? t('submit_uppladdat_underlag') : mode === 'levererar_sjalv' ? t('submit_levererar_sjalv') : t('submit')}
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
  useCheckbox,
  onSelect,
}: {
  name: string
  candidate: Kandidat
  checked: boolean
  useCheckbox: boolean
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
        {useCheckbox ? (
          <Checkbox
            className="mt-1 border-foreground"
            checked={checked}
            disabled={!selectable}
            onCheckedChange={() => onSelect()}
            aria-label={candidate.filnamn}
          />
        ) : (
          <input
            type="radio"
            className={RADIO_CLASS}
            name={name}
            checked={checked}
            disabled={!selectable}
            onChange={onSelect}
            aria-label={candidate.filnamn}
          />
        )}
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
