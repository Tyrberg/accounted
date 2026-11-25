/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/locked-period-attachments
 *
 * Archive an ALREADY-UPLOADED storage object as underlag on a verifikat in a
 * closed or locked fiscal period (founder-approved 2026-11-09).
 *
 * The ordinary paths (upload with journal_entry_id, /documents/{id}/link) are
 * refused there by enforce_period_lock_documents. This route is the one
 * sanctioned exception and is deliberately narrow:
 *
 *   - The period is never unlocked; the verifikat itself is never written.
 *   - The route downloads the object from the `documents` bucket and hashes
 *     the stored bytes itself: the sha256 in the archive and the audit trail
 *     is the server's, never the caller's.
 *   - attach_document_to_locked_period_entry (migration 20261116120000)
 *     inserts the document_attachments row, enforces one sha256 per
 *     verifikat (a re-run returns the existing link, 200 + created=false),
 *     and writes the LOCKED_PERIOD_ATTACH audit_log row with actor, API key,
 *     file, sha256 and reason.
 *   - Nothing is deleted. The object must already belong to a document row
 *     in the company (the upload); the RPC locks that row, and the
 *     block_shared_document_storage_deletion trigger then refuses to delete
 *     any sibling row whose object is retained on a verifikat, so the
 *     archived bytes cannot be removed through the original upload.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable, but only partially:
 * a dry run checks the storage path, that the verifikat exists in the company
 * and the stored file type, and hashes the object. It never calls the RPC, so
 * the role, entry-status (NOT_POSTED), period-state (period_open) and
 * duplicate checks only run on the real call.
 */

import { z } from 'zod'
import { ok, created } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import {
  ALLOWED_DOCUMENT_TYPES,
  DOCUMENTS_BUCKET,
  computeSHA256,
  detectFileMagic,
  isCompanyScopedDocumentPath,
} from '@/lib/core/documents/document-service'

const Body = z
  .object({
    storage_path: z.string().min(1).max(1024),
    file_name: z.string().trim().min(1).max(255).optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()

const LockedPeriodAttachment = z.object({
  created: z.boolean(),
  document_id: z.string().uuid(),
  journal_entry_id: z.string().uuid(),
  file_name: z.string(),
  storage_path: z.string(),
  sha256_hash: z.string(),
  created_at: z.string(),
})

registerEndpoint({
  operation: 'journal_entries.locked_period_attach',
  method: 'POST',
  path: '/api/v1/companies/:companyId/journal-entries/:id/locked-period-attachments',
  summary: 'Archive an already-uploaded file as underlag on a verifikat in a locked or closed period.',
  description:
    'Links an object that already exists in the documents storage bucket (under documents/{companyId}/) to a posted or reversed verifikat whose fiscal period is closed or locked. The period stays locked and the verifikat is not modified (no lines, amounts, date, number or status change). The server downloads the object and computes its SHA-256; the same SHA-256 can only be linked once per verifikat, and a repeat call returns the existing link with created=false (HTTP 200) instead of an error. The object must already belong to a document row in the company (the upload), and after archiving no document sharing that object can be deleted. Every new link writes an audit_log row (action LOCKED_PERIOD_ATTACH, table_name journal_entries, record_id = the verifikat) holding the acting user, API key id and name, time, file name, storage path, SHA-256 and the reason. Nothing is ever deleted.',
  useWhen:
    'Underlag that belongs to an already-closed or locked year must be archived against its verifikat, and the ordinary upload/link was refused with "Cannot attach documents to entries in a locked/closed fiscal period".',
  doNotUseFor:
    'Verifikat in an open period: use POST /documents (with journal_entry_id) or /documents/:id/link instead; this route answers CONFLICT (period_open). Changing or unlinking an existing link: not possible on any path.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'storage_path must be the exact object key and must start with documents/{companyId}/. Legacy keys outside the company prefix are rejected.',
    'storage_path must be the object of a document the company already holds (an uploaded document row, e.g. from POST /documents without journal_entry_id). An object with no document row answers 404 (resource: document).',
    'Once archived, the original upload can no longer be deleted (DELETE /documents/:id answers 409): its stored file is retained underlag on the verifikat.',
    'Only PDF, JPEG, PNG and WebP content is accepted (checked from the bytes, not the file name).',
    'reason is required and is stored verbatim in the audit trail (max 500 characters).',
    'created=false means the same bytes were already linked to this verifikat (by this or any other path); no new row and no new audit entry were written. The duplicate check runs first, so this also applies in an open period: bytes already linked through the ordinary path answer 200 created=false, not CONFLICT (period_open).',
    'A dry run only checks the path, that the verifikat exists, the file type and the hash. Role, entry status, period state and duplicate checks run on the real call only.',
  ],
  example: {
    request: {
      storage_path: 'documents/3f1c…/9a2e…/1700000000000_kvitto.pdf',
      file_name: 'kvitto.pdf',
      reason: 'Underlag till stängt räkenskapsår',
    },
    response: {
      data: {
        created: true,
        document_id: '0e9c…',
        journal_entry_id: 'a8f1…',
        file_name: 'kvitto.pdf',
        storage_path: 'documents/3f1c…/9a2e…/1700000000000_kvitto.pdf',
        sha256_hash: '5d41…',
        created_at: '2026-11-16T10:00:00.000Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'documents:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: Body },
  response: { success: dataEnvelope(LockedPeriodAttachment) },
})

/** RPC error prefix (migration 20261116120000) to v1 code + details. */
const RPC_ERRORS: Record<string, { code: string; details: Record<string, unknown> }> = {
  LOCKED_ATTACH_INVALID: { code: 'VALIDATION_ERROR', details: { reason: 'invalid_input' } },
  LOCKED_ATTACH_FORBIDDEN: { code: 'FORBIDDEN', details: { reason: 'write_access_required' } },
  LOCKED_ATTACH_NOT_FOUND: { code: 'NOT_FOUND', details: { resource: 'journal_entry' } },
  LOCKED_ATTACH_SOURCE_NOT_FOUND: {
    code: 'NOT_FOUND',
    details: {
      resource: 'document',
      field: 'storage_path',
      remediation: 'The storage object must belong to an uploaded document in the company (e.g. POST /documents without journal_entry_id).',
    },
  },
  LOCKED_ATTACH_NOT_POSTED: { code: 'CONFLICT', details: { reason: 'entry_not_posted' } },
  LOCKED_ATTACH_PERIOD_OPEN: {
    code: 'CONFLICT',
    details: {
      reason: 'period_open',
      remediation: 'The fiscal period is open: use POST /documents with journal_entry_id or /documents/:id/link.',
    },
  },
}

function lastSegment(path: string): string {
  const segment = path.split('/').pop() ?? ''
  // Storage keys are `{timestamp}_{name}`; strip the timestamp for display.
  return segment.replace(/^\d{10,}_/, '') || segment
}

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'journal_entries.locked_period_attach',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'journal entry id must be a UUID.' },
      })
    }
    const entryId = idParse.data
    const companyId = ctx.companyId!

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const parsed = Body.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    if (!isCompanyScopedDocumentPath(body.storage_path, companyId)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'storage_path', message: `storage_path must start with documents/${companyId}/.` },
      })
    }

    const { data: entry, error: entryErr } = await ctx.supabase
      .from('journal_entries')
      .select('id')
      .eq('id', entryId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (entryErr) {
      ctx.log.error('locked_period_attach entry pre-check failed', entryErr as Error, { entryId })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'entry_check' },
      })
    }
    if (!entry) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'journal_entry' },
      })
    }

    // The download is the existence proof AND the source of the sha256.
    const { data: blob, error: downloadErr } = await ctx.supabase.storage
      .from(DOCUMENTS_BUCKET)
      .download(body.storage_path)
    if (downloadErr || !blob) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'storage_object', field: 'storage_path' },
      })
    }
    const buffer = await blob.arrayBuffer()
    const mimeType = detectFileMagic(new Uint8Array(buffer))
    if (buffer.byteLength === 0 || !mimeType || !ALLOWED_DOCUMENT_TYPES.includes(mimeType)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'storage_path',
          message: `The stored object is not one of: ${ALLOWED_DOCUMENT_TYPES.join(', ')}.`,
        },
      })
    }
    const sha256Hash = await computeSHA256(buffer)
    const fileName = body.file_name ?? lastSegment(body.storage_path)

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          journal_entry_id: entryId,
          file_name: fileName,
          storage_path: body.storage_path,
          sha256_hash: sha256Hash,
          file_size_bytes: buffer.byteLength,
          mime_type: mimeType,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data, error } = await ctx.supabase.rpc('attach_document_to_locked_period_entry', {
      p_company_id: companyId,
      p_journal_entry_id: entryId,
      p_storage_path: body.storage_path,
      p_file_name: fileName,
      p_file_size_bytes: buffer.byteLength,
      p_mime_type: mimeType,
      p_sha256_hash: sha256Hash,
      p_reason: body.reason,
      p_actor_user_id: ctx.userId,
      p_api_key_id: ctx.apiKeyId ?? null,
      p_api_key_name: ctx.apiKeyName ?? null,
    })

    if (error) {
      const message = (error as { message?: string }).message ?? ''
      const prefix = message.split(':')[0]
      const mapped = RPC_ERRORS[prefix]
      if (mapped) {
        return v1ErrorResponseFromCode(mapped.code, ctx.log, {
          requestId: ctx.requestId,
          details: mapped.details,
        })
      }
      ctx.log.error('locked_period_attach RPC failed', error as unknown as Error, { entryId })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'attach' },
      })
    }

    const result = LockedPeriodAttachment.parse(data)
    return result.created
      ? created(result, { requestId: ctx.requestId })
      : ok(result, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
