/**
 * Underlagsjakt: answer bertil's "which document belongs to this payment?"
 * questions in Accounted instead of on the command line.
 *
 * bertil (a separate system) hunts for underlag for outgoing payments and
 * exports what it could not decide under a versioned contract (see
 * lib/contract.ts). This extension reads that export, shows one row per
 * payment with the readable account name, the candidates and their evidence,
 * and collects one of three answers per row: the right document (or none,
 * with motpart/kategori/BAS-konto/momstyp as the CLI's --svara), "gäller
 * annat bolag", or "osäker". The answers go back to bertil as the contract's
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
import {
  ANSWER_VERSION,
  SUPPORTED_EXPORT_VERSIONS,
  buildAnswerFile,
  buildBeslut,
  parseExport,
  svarInputSchema,
} from './lib/contract'
import {
  EXPORT_KEY,
  LEVERANS_KEY,
  KVITTENS_KEY,
  SVAR_KEY,
  bolagChoices,
  felBolagRows,
  findPost,
  loadLeveransJournal,
  loadState,
  markDelivered,
  openPosts,
  pendingBeslut,
  reconcileWithExport,
  recordAnswer,
  recordSvarHandover,
  withdrawAnswer,
  type ImportKalla,
  type StoredExport,
} from './lib/store'
import { authenticateLeverans, leveransTargetsCompany } from './lib/leverans'

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
  const stored: StoredExport = { ...parsed.export, imported_at: nowIso(), imported_via: via }
  const svar = reconcileWithExport(state.svar, parsed.export)
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
   * until bertil successfully ingests it and posts its transaction_id to
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
      const beslut = pendingBeslut(svar)
      // Written on every call, including the ones carrying nothing: a poll is
      // the only evidence the box has that bertil is still running. See
      // LeveransJournal and extensions/general/underlagsjakt/leverans-status.ts.
      await ctx.settings.set(LEVERANS_KEY, recordSvarHandover(journal, beslut.length, now))
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
      if (typeof id !== 'string' || !id.trim()) {
        return fail(400, 'VALIDATION_ERROR', 'transaction_id krävs.')
      }
      const { svar } = await loadState(ctx.settings)
      // Withdrawn or reconciled answers are successful no-ops on retry.
      // Retrying a lost acknowledgement response preserves the original timestamp.
      if (Object.hasOwn(svar, id) && svar[id].levererad_at === null) {
        const now = nowIso()
        // Persist machine evidence before marking delivered so a failed write
        // leaves the answer pending and the acknowledgement safe to retry.
        await ctx.settings.set(KVITTENS_KEY, now)
        await ctx.settings.set(SVAR_KEY, markDelivered(svar, [id], now))
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

      const state = await loadState(ctx.settings)
      const post = findPost(state.export, input.data.transaction_id)
      if (!post) return fail(404, 'POST_NOT_FOUND', 'Posten finns inte i den inlästa exporten.')

      const built = buildBeslut(post, input.data)
      if (!built.ok) {
        return fail(
          400,
          built.code,
          built.code === 'CANDIDATE_NOT_FOUND'
            ? 'Dokumentet finns inte bland postens kandidater.'
            : 'Kandidaten saknar giltig kontrollsumma och kan inte väljas.',
        )
      }

      const recorded = recordAnswer(state.svar, post, built.beslut, built.reglering, ctx.userId, nowIso())
      if (!recorded.ok) return fail(409, recorded.code, 'Svaret är redan skickat till bertil.')
      await ctx.settings.set(SVAR_KEY, recorded.svar)

      return NextResponse.json({ data: recorded.svar[post.transaction_id] })
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
          : fail(409, 'ALREADY_DELIVERED', 'Svaret är redan skickat till bertil.')
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
      const svar = markDelivered(state.svar, ids, nowIso())
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
