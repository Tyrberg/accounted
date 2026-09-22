/**
 * Underlagsjakt: answer bertil's "which document belongs to this payment?"
 * questions in Accounted instead of on the command line.
 *
 * bertil (a separate system) hunts for underlag for outgoing payments and
 * exports what it could not decide under a versioned contract (see
 * lib/contract.ts). This extension reads that export, shows one row per
 * payment with the readable account name, the candidates and their evidence,
 * and collects one of four answers per row: the right document (or none,
 * with motpart/kategori/BAS-konto/momstyp as the CLI's --svara), a document
 * the user uploads on the spot when bertil found none, "gäller annat bolag",
 * or "osäker". The answers go back to bertil as the contract's
 * answer file, where they become rules.
 *
 * Nothing here books anything. Wrong-company payments are collected as a
 * decision (company, invoice addressee, settlement) and handed on; the
 * receivable, VAT and re-invoice wait for the accountant.
 *
 * Built as an extension on purpose: this repository is a fork that tracks
 * erp-mafia/accounted, so core stays untouched.
 */
import { NextResponse } from 'next/server'
import type { ApiRouteDefinition, Extension, ExtensionContext } from '@/lib/extensions/types'
import { requireWritePermission } from '@/lib/auth/require-write'
import { MAX_DOCUMENT_SIZE, uploadDocument } from '@/lib/core/documents/document-service'
import {
  ANSWER_VERSION,
  SUPPORTED_EXPORT_VERSIONS,
  UNDERLAG_UPLOAD_MIME_TYPES,
  buildAnswerFile,
  buildBeslut,
  buildUppladdatBeslut,
  bulkSvarInputSchema,
  leverarSjalvEnabled,
  multiKandidatEnabled,
  parseExport,
  svarInputSchema,
  uppladdatInputSchema,
} from './lib/contract'
import {
  EXPORT_KEY,
  LEVERANS_KEY,
  KVITTENS_KEY,
  SVAR_KEY,
  bolagChoices,
  bulkTargets,
  felBolagRows,
  findPost,
  loadLeveransJournal,
  loadState,
  markDelivered,
  markDeliveredManual,
  markOffered,
  markUnderlagHittat,
  openPosts,
  pendingBeslut,
  reconcileWithExport,
  recordAnswer,
  recordSvarHandover,
  waitingRows,
  withdrawAnswer,
  type ImportKalla,
  type StoredExport,
} from './lib/store'
import { authenticateLeverans, leveransTargetsCompany } from './lib/leverans'
import { kopplaTillTransaktion } from './lib/koppla'

const EXTENSION_ID = 'underlagsjakt'

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

function fail(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message, ...details } }, { status })
}

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() }
  } catch {
    return { ok: false }
  }
}

async function writeGuard(ctx: ExtensionContext): Promise<Response | null> {
  const perm = await requireWritePermission(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
  return perm.ok ? null : perm.response
}

const nowIso = () => new Date().toISOString()

/**
 * The upload answer is off until bertil reads answer version 1.5: an upload
 * files a document bertil cannot take in, and a 1.5 answer file is one a 1.4
 * reader refuses. Switched on with UNDERLAGSJAKT_UPLOAD_ENABLED=true once
 * bertil's mottak_svar_fran_ui understands `uppladdat_underlag`.
 */
function uploadEnabled(): boolean {
  return process.env.UNDERLAGSJAKT_UPLOAD_ENABLED === 'true'
}

/**
 * Names of the user's non-archived companies. A failed read only narrows the
 * company picker (the export's names and free text still work), so it is
 * logged instead of failing the whole view.
 */
async function memberCompanyNames(ctx: ExtensionContext): Promise<string[]> {
  const { data, error } = await ctx.supabase
    .from('company_members')
    .select('company_id, companies!inner(name, archived_at)')
    .eq('user_id', ctx.userId)
    .is('companies.archived_at', null)
  if (error) {
    ctx.log.warn('underlagsjakt: could not read company memberships', { error: error.message })
    return []
  }
  return ((data ?? []) as { companies: { name: string | null } | { name: string | null }[] | null }[])
    .flatMap((row) => (Array.isArray(row.companies) ? row.companies : row.companies ? [row.companies] : []))
    .map((c) => c.name)
    .filter((name): name is string => typeof name === 'string')
}

/**
 * Read an export into a company's workspace state.
 *
 * Shared by the two ways an export arrives: bertil delivering it over the
 * machine path (`POST /export`) and a human picking the file (`POST
 * /export/fil`). One body of rules, so an automatically delivered export is
 * validated, version-checked and reconciled exactly like an uploaded one.
 */
async function importExport(request: Request, ctx: ExtensionContext, via: ImportKalla): Promise<Response> {
  const json = await readJson(request)
  if (!json.ok) return fail(400, 'INVALID_JSON', 'Filen är inte giltig JSON.')

  const parsed = parseExport(json.body)
  if (!parsed.ok) {
    if (parsed.code === 'UNSUPPORTED_VERSION') {
      return fail(
        400,
        'UNSUPPORTED_VERSION',
        `Exportversion ${parsed.version ?? 'saknas'} stöds inte. Stödda versioner: ${SUPPORTED_EXPORT_VERSIONS.join(', ')}.`,
        { version: parsed.version, supported: SUPPORTED_EXPORT_VERSIONS },
      )
    }
    return fail(400, 'INVALID_EXPORT', 'Exporten följer inte kontraktet.', { issues: parsed.issues })
  }

  const state = await loadState(ctx.settings)
  const now = nowIso()
  const stored: StoredExport = { ...parsed.export, imported_at: now, imported_via: via }
  // The list of found documents is a signal, not part of the export we keep.
  delete (stored as { underlag_hittat?: unknown }).underlag_hittat
  const svar = markUnderlagHittat(reconcileWithExport(state.svar, parsed.export), parsed.underlag_hittat, now)
  await ctx.settings.set(EXPORT_KEY, stored)
  await ctx.settings.set(SVAR_KEY, svar)
  ctx.log.info('underlagsjakt export imported', {
    version: stored.export_version,
    via,
    posts: stored.sammanstallningar.reduce((n, s) => n + s.posts.length, 0),
  })

  return NextResponse.json({
    data: { posts: openPosts(stored, svar).length, export_version: stored.export_version },
  })
}

export const underlagsjaktApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/',
    handler: async (_request, ctx) => {
      if (!ctx) return unauthorized()
      const [{ export: exp, svar }, members, leveransHit] = await Promise.all([
        loadState(ctx.settings),
        memberCompanyNames(ctx),
        // Per company, not per box: a box can hold several companies and the
        // delivery is bound to one of them.
        leveransTargetsCompany(ctx.companyId),
      ])
      const pending = pendingBeslut(svar)
      return NextResponse.json({
        data: {
          supported_export_versions: SUPPORTED_EXPORT_VERSIONS,
          answer_version: ANSWER_VERSION,
          underlag_upload_enabled: uploadEnabled(),
          levererar_sjalv_enabled: leverarSjalvEnabled(),
          multi_kandidat_enabled: multiKandidatEnabled(),
          leverans: { till_detta_bolag: leveransHit },
          export: exp
            ? {
                export_version: exp.export_version,
                generated_at: exp.generated_at,
                imported_at: exp.imported_at,
                // Exports stored before the machine path existed carry no
                // source; they can only have come from a file.
                imported_via: exp.imported_via ?? 'fil',
                sammanstallningar: exp.sammanstallningar.map((s) => ({
                  bolag: s.bolag,
                  period: s.period,
                  sammanfattning: s.sammanfattning,
                })),
              }
            : null,
          posts: openPosts(exp, svar),
          answered: Object.entries(svar)
            .map(([transaction_id, rec]) => ({ transaction_id, ...rec }))
            .sort((a, b) => b.besvarad_at.localeCompare(a.besvarad_at)),
          pending_count: pending.length,
          fel_bolag: felBolagRows(svar),
          waiting: waitingRows(svar),
          bolag_choices: bolagChoices(exp, svar, members),
        },
      })
    },
  },
  /**
   * bertil's delivery. `skipAuth` because the dispatcher's auth is a browser
   * session and bertil has none; the handler authenticates the call itself
   * with the delivery token and resolves the company from the server's
   * configuration (see lib/leverans.ts). The URL is the one bertil already
   * posts to (bertil#183), which is why the human file upload moved to
   * /export/fil rather than this path keeping both callers.
   */
  {
    method: 'POST',
    path: '/export',
    skipAuth: true,
    handler: async (request) => {
      const auth = await authenticateLeverans(request)
      if (!auth.ok) return auth.response
      return importExport(request, auth.ctx, 'leverans')
    },
  },
  {
    method: 'POST',
    path: '/export/fil',
    handler: async (request, ctx) => {
      if (!ctx) return unauthorized()
      const denied = await writeGuard(ctx)
      if (denied) return denied
      return importExport(request, ctx, 'fil')
    },
  },
  /**
   * Fetching never acknowledges consumption. Keep offering every pending answer
   * until bertil successfully ingests it and posts its transaction_id and answer_id to
   * /svar/kvittens. Failed ingestion or a lost response can safely be retried.
   */
  {
    method: 'GET',
    path: '/svar',
    skipAuth: true,
    handler: async (request) => {
      const auth = await authenticateLeverans(request)
      if (!auth.ok) return auth.response
      const ctx = auth.ctx

      const now = nowIso()
      const [{ svar }, journal] = await Promise.all([
        loadState(ctx.settings),
        loadLeveransJournal(ctx.settings),
      ])
      const pendingIds = pendingBeslut(svar).map((b) => b.transaction_id)
      const updatedSvar = markOffered(svar, pendingIds, now)
      const beslut = pendingBeslut(updatedSvar)
      // Written on every call, including the ones carrying nothing: a poll is
      // the only evidence the box has that bertil is still running. See
      // LeveransJournal and extensions/general/underlagsjakt/leverans-status.ts.
      await ctx.settings.set(LEVERANS_KEY, recordSvarHandover(journal, beslut.length, now))
      await ctx.settings.set(SVAR_KEY, updatedSvar)
      ctx.log.info('underlagsjakt answers offered', { count: beslut.length })
      return NextResponse.json(buildAnswerFile(beslut))
    },
  },
  /** Machine acknowledgement, sent only after successful ingestion in bertil. */
  {
    method: 'POST',
    path: '/svar/kvittens',
    skipAuth: true,
    handler: async (request) => {
      const auth = await authenticateLeverans(request)
      if (!auth.ok) return auth.response
      const ctx = auth.ctx
      const json = await readJson(request)
      if (!json.ok) return fail(400, 'INVALID_JSON', 'Ogiltig JSON.')
      const id = json.body && typeof json.body === 'object'
        ? (json.body as { transaction_id?: unknown }).transaction_id
        : undefined
      const answerId = json.body && typeof json.body === 'object'
        ? (json.body as { answer_id?: unknown }).answer_id
        : undefined
      if (typeof id !== 'string' || !id.trim()) {
        return fail(400, 'VALIDATION_ERROR', 'transaction_id krävs.')
      }
      if (typeof answerId !== 'string' || !answerId.trim()) {
        return fail(400, 'VALIDATION_ERROR', 'answer_id krävs.')
      }
      const { svar } = await loadState(ctx.settings)
      // Withdrawn, mismatched, or reconciled answers are successful no-ops on retry.
      // Retrying a lost acknowledgement response preserves the original timestamp.
      if (Object.hasOwn(svar, id) && svar[id].levererad_at === null && svar[id].answer_id === answerId) {
        const now = nowIso()
        // Persist machine evidence before marking delivered so a failed write
        // leaves the answer pending and the acknowledgement safe to retry.
        await ctx.settings.set(KVITTENS_KEY, now)
        await ctx.settings.set(SVAR_KEY, markDelivered(svar, [{ id, answerId }], now))
      }
      ctx.log.info('underlagsjakt answer acknowledged', { transaction_id: id })
      return NextResponse.json({ data: { transaction_id: id } })
    },
  },
  {
    method: 'POST',
    path: '/svar',
    handler: async (request, ctx) => {
      if (!ctx) return unauthorized()
      const denied = await writeGuard(ctx)
      if (denied) return denied

      const json = await readJson(request)
      if (!json.ok) return fail(400, 'INVALID_JSON', 'Ogiltig JSON.')
      const input = svarInputSchema.safeParse(json.body)
      if (!input.success) {
        return fail(400, 'VALIDATION_ERROR', 'Svaret är ofullständigt.', {
          issues: input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        })
      }

      if (input.data.svarstyp === 'levererar_sjalv' && !leverarSjalvEnabled()) {
        return fail(403, 'FEATURE_DISABLED', 'Svarstypen "jag levererar underlaget själv" är inte påslagen.')
      }
      if (input.data.svarstyp === 'val_kandidat' && input.data.sha256.length > 1 && !multiKandidatEnabled()) {
        return fail(403, 'FEATURE_DISABLED', 'Att välja flera dokument till samma betalning är inte påslaget.')
      }

      const now = nowIso()
      const state = await loadState(ctx.settings)
      const post = findPost(state.export, input.data.transaction_id)
      if (!post) return fail(404, 'POST_NOT_FOUND', 'Posten finns inte i den inlästa exporten.')

      const answerId = `${now}:${post.transaction_id}`
      const built = buildBeslut(post, input.data, answerId)
      if (!built.ok) {
        return fail(
          400,
          built.code,
          built.code === 'CANDIDATE_NOT_FOUND'
            ? 'Dokumentet finns inte bland postens kandidater.'
            : 'Kandidaten saknar giltig kontrollsumma och kan inte väljas.',
        )
      }

      const recorded = recordAnswer(state.svar, post, built.beslut, built.reglering, ctx.userId, now)
      if (!recorded.ok) return fail(409, recorded.code, 'Svaret är redan erbjudet till bertil och kan inte ändras.')
      await ctx.settings.set(SVAR_KEY, recorded.svar)

      return NextResponse.json({ data: recorded.svar[post.transaction_id] })
    },
  },
  /**
   * "I have the document": the file and the answer arrive in one request, and
   * the answer is only recorded once the file is archived, so bertil is never
   * told about a document Accounted does not hold and Accounted never holds a
   * document bertil is not told about (barring a failed write of the answer
   * itself, which leaves a filed, deduplicated document and a retryable
   * request). Everything that can be refused is refused before the upload.
   */
  {
    method: 'POST',
    path: '/svar/underlag',
    handler: async (request, ctx) => {
      if (!ctx) return unauthorized()
      const denied = await writeGuard(ctx)
      if (denied) return denied
      if (!uploadEnabled()) {
        return fail(403, 'UNDERLAG_UPLOAD_DISABLED', 'Uppladdning av underlag är inte påslagen.')
      }

      let form: FormData
      try {
        form = await request.formData()
      } catch {
        return fail(400, 'VALIDATION_ERROR', 'Ogiltigt formulär.')
      }

      const file = form.get('file')
      if (!(file instanceof File) || file.size === 0) {
        return fail(400, 'UNDERLAG_FILE_MISSING', 'Ingen fil vald.')
      }
      if (!(UNDERLAG_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
        return fail(400, 'UNDERLAG_UNSUPPORTED_TYPE', 'Filtypen stöds inte. Ladda upp en PDF eller en bild.')
      }
      if (file.size > MAX_DOCUMENT_SIZE) {
        return fail(400, 'UNDERLAG_TOO_LARGE', 'Filen är för stor.', { max_bytes: MAX_DOCUMENT_SIZE })
      }

      const field = (name: string) => {
        const v = form.get(name)
        return typeof v === 'string' ? v : undefined
      }
      const nullable = (name: string) => {
        const v = field(name)?.trim()
        return v ? v : null
      }
      const input = uppladdatInputSchema.safeParse({
        svarstyp: 'uppladdat_underlag',
        transaction_id: field('transaction_id'),
        motpart: field('motpart'),
        kategori: field('kategori'),
        bas_konto: nullable('bas_konto'),
        momstyp: nullable('momstyp'),
        begransa_bolag: field('begransa_bolag') === 'true',
        begransa_belopp: field('begransa_belopp') === 'true',
      })
      if (!input.success) {
        return fail(400, 'VALIDATION_ERROR', 'Svaret är ofullständigt.', {
          issues: input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        })
      }

      const state = await loadState(ctx.settings)
      const post = findPost(state.export, input.data.transaction_id)
      if (!post) return fail(404, 'POST_NOT_FOUND', 'Posten finns inte i den inlästa exporten.')
      const existing = state.svar[post.transaction_id]
      if (existing?.levererad_at || existing?.erbjudet_at) {
        return fail(409, 'ALREADY_DELIVERED', 'Svaret är redan erbjudet till bertil och kan inte ändras.')
      }

      let document: Awaited<ReturnType<typeof uploadDocument>>
      try {
        document = await uploadDocument(
          ctx.supabase,
          ctx.userId,
          ctx.companyId,
          { name: file.name, buffer: await file.arrayBuffer(), type: file.type },
          // A retry of the same file converges on the archived original.
          { upload_source: 'file_upload', dedupeByContent: true, extractionOwner: 'none' },
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : ''
        if (/kunde inte verifieras|matchar inte den angivna filtypen/i.test(message)) {
          return fail(400, 'UNDERLAG_INVALID_CONTENT', 'Filens innehåll stämmer inte med filtypen.')
        }
        ctx.log.error('underlagsjakt: uploading underlag failed', { error: message })
        return fail(500, 'UNDERLAG_UPLOAD_FAILED', 'Dokumentet kunde inte sparas.')
      }

      const now = nowIso()
      const beslut = buildUppladdatBeslut(
        post,
        input.data,
        {
          id: document.id,
          filnamn: document.file_name,
          sha256: document.sha256_hash,
          mime_type: document.mime_type,
          storage_path: document.storage_path,
        },
        `${now}:${post.transaction_id}`,
      )
      const recorded = recordAnswer(state.svar, post, beslut, null, ctx.userId, now)
      if (!recorded.ok) return fail(409, recorded.code, 'Svaret är redan erbjudet till bertil och kan inte ändras.')
      await ctx.settings.set(SVAR_KEY, recorded.svar)

      // After the answer is recorded, and never fatal: the document is filed and
      // bertil will be told either way; the pin is what makes it follow the verifikat.
      const koppling = await kopplaTillTransaktion(ctx.supabase, ctx.companyId, post.transaction_id, document.id)
      if (koppling === 'misslyckades') {
        ctx.log.warn('underlagsjakt: could not pin uploaded underlag to a transaction', {
          transaction_id: post.transaction_id,
          document_id: document.id,
        })
      }

      return NextResponse.json({ data: { ...recorded.svar[post.transaction_id], koppling } })
    },
  },
  /**
   * "I will deliver the documents myself, for every payment from this motpart."
   * Records one `levererar_sjalv` answer per affected post, so acknowledgement
   * stays per transaction and no document is ever bound to several payments
   * (task 1435). The affected posts are derived here with `bulkTargets`, the
   * same function the browser counts with; the browser only promises how many
   * (`bekrafta_antal`), and a different count is refused with 409 COUNT_CHANGED.
   */
  {
    method: 'POST',
    path: '/svar/bulk',
    handler: async (request, ctx) => {
      if (!ctx) return unauthorized()
      const denied = await writeGuard(ctx)
      if (denied) return denied

      const json = await readJson(request)
      if (!json.ok) return fail(400, 'INVALID_JSON', 'Ogiltig JSON.')
      const input = bulkSvarInputSchema.safeParse(json.body)
      if (!input.success) {
        return fail(400, 'VALIDATION_ERROR', 'Svaret är ofullständigt.', {
          issues: input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        })
      }
      if (!leverarSjalvEnabled()) {
        return fail(403, 'FEATURE_DISABLED', 'Svarstypen "jag levererar underlaget själv" är inte påslagen.')
      }

      const state = await loadState(ctx.settings)
      const anchor = findPost(state.export, input.data.transaction_id)
      if (!anchor) return fail(404, 'POST_NOT_FOUND', 'Posten finns inte i den inlästa exporten.')

      const targets = bulkTargets(openPosts(state.export, state.svar), anchor)
      if (targets.length !== input.data.bekrafta_antal) {
        return fail(
          409,
          'COUNT_CHANGED',
          `Antalet poster har ändrats: du bekräftade ${input.data.bekrafta_antal}, men ${targets.length} omfattas nu.`,
          { antal: targets.length },
        )
      }

      const now = nowIso()
      let svar = state.svar
      for (const target of targets) {
        const built = buildBeslut(
          target,
          { svarstyp: 'levererar_sjalv', transaction_id: target.transaction_id, motpart: input.data.motpart },
          `${now}:${target.transaction_id}`,
        )
        // levererar_sjalv always builds; the guard keeps the type honest.
        if (!built.ok) return fail(400, built.code, 'Svaret kunde inte byggas.')
        const recorded = recordAnswer(svar, target, built.beslut, built.reglering, ctx.userId, now)
        // Open posts have no answer to be delivered, so this cannot happen; if it
        // ever does, nothing is written rather than half of the posts.
        if (!recorded.ok) return fail(409, recorded.code, 'Svaret är redan erbjudet till bertil och kan inte ändras.')
        svar = recorded.svar
      }

      await ctx.settings.set(SVAR_KEY, svar)
      ctx.log.info('underlagsjakt bulk answer recorded', { count: targets.length, svarstyp: 'levererar_sjalv' })
      return NextResponse.json({ data: { recorded: targets.length, transaction_ids: targets.map((p) => p.transaction_id) } })
    },
  },
  {
    method: 'DELETE',
    path: '/svar/:transactionId',
    handler: async (request, ctx) => {
      if (!ctx) return unauthorized()
      const denied = await writeGuard(ctx)
      if (denied) return denied

      const transactionId = new URL(request.url).searchParams.get('_transactionId') ?? ''
      const state = await loadState(ctx.settings)
      const result = withdrawAnswer(state.svar, transactionId)
      if (!result.ok) {
        return result.code === 'NOT_FOUND'
          ? fail(404, 'NOT_FOUND', 'Svaret finns inte.')
          : fail(409, 'ALREADY_DELIVERED', 'Svaret är redan erbjudet till bertil och kan inte återtas.')
      }
      await ctx.settings.set(SVAR_KEY, result.svar)
      return NextResponse.json({ data: { transaction_id: transactionId } })
    },
  },
  {
    method: 'GET',
    path: '/svarsfil',
    handler: async (_request, ctx) => {
      if (!ctx) return unauthorized()
      const { svar } = await loadState(ctx.settings)
      const file = buildAnswerFile(pendingBeslut(svar))
      const stamp = nowIso().slice(0, 19).replace(/[:T]/g, '-')
      return new NextResponse(JSON.stringify(file, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="underlagsjakt-svar-${stamp}.json"`,
        },
      })
    },
  },
  {
    method: 'POST',
    path: '/svarsfil/levererad',
    handler: async (request, ctx) => {
      if (!ctx) return unauthorized()
      const denied = await writeGuard(ctx)
      if (denied) return denied

      const json = await readJson(request)
      const ids =
        json.ok &&
        json.body &&
        typeof json.body === 'object' &&
        Array.isArray((json.body as { transaction_ids?: unknown }).transaction_ids)
          ? (json.body as { transaction_ids: unknown[] }).transaction_ids.filter(
              (id): id is string => typeof id === 'string',
            )
          : null
      if (!ids || ids.length === 0) {
        return fail(400, 'VALIDATION_ERROR', 'transaction_ids krävs.')
      }

      const state = await loadState(ctx.settings)
      const svar = markDeliveredManual(state.svar, ids, nowIso())
      await ctx.settings.set(SVAR_KEY, svar)
      return NextResponse.json({ data: { pending_count: pendingBeslut(svar).length } })
    },
  },
]

export const underlagsjaktExtension: Extension = {
  id: EXTENSION_ID,
  name: 'Underlagsjakt',
  version: '1.0.0',
  sector: 'general',
  apiRoutes: underlagsjaktApiRoutes,
}
