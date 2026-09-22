/**
 * Filing one underlag file into Accounted's document archive.
 *
 * Two callers need exactly this: a person uploading a document bertil could
 * not find (`POST /svar/underlag`, task 1481) and bertil delivering one of
 * its own found candidates ahead of the export that references it
 * (`POST /export/underlag`, task 1483). Both must apply the same MIME
 * allowlist, the same size cap and the same dedupe-by-hash, because they
 * write into the same archive under the same retention rules; a second copy
 * of this validation is exactly how the two drifted apart once already
 * (task 1483 review round 1: one route said "innehål", the other "innehåll").
 * One function, two callers.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { MAX_DOCUMENT_SIZE, uploadDocument } from '@/lib/core/documents/document-service'
import type { DocumentUploadSource } from '@/types'
import { UNDERLAG_UPLOAD_MIME_TYPES } from './contract'

export interface UnderlagFile {
  name: string
  type: string
  size: number
  buffer: ArrayBuffer
}

export type UnderlagUploadResult =
  | { ok: true; document: Awaited<ReturnType<typeof uploadDocument>> }
  | {
      ok: false
      status: number
      code:
        | 'UNDERLAG_FILE_MISSING'
        | 'UNDERLAG_UNSUPPORTED_TYPE'
        | 'UNDERLAG_TOO_LARGE'
        | 'UNDERLAG_INVALID_CONTENT'
        | 'UNDERLAG_UPLOAD_FAILED'
      message: string
      details?: Record<string, unknown>
    }

/**
 * Validate and archive one underlag file. Everything that can be refused is
 * refused before `uploadDocument` runs, exactly as `/svar/underlag` already
 * did inline; this is that same sequence, pulled out so a second caller
 * cannot drift from it.
 */
export async function acceptUnderlagFile(
  ctx: { supabase: SupabaseClient; userId: string; companyId: string; log: { error: (msg: string, meta?: Record<string, unknown>) => void } },
  file: UnderlagFile,
  uploadSource: DocumentUploadSource,
): Promise<UnderlagUploadResult> {
  if (file.size === 0) {
    return { ok: false, status: 400, code: 'UNDERLAG_FILE_MISSING', message: 'Ingen fil vald.' }
  }
  if (!(UNDERLAG_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
    return {
      ok: false,
      status: 400,
      code: 'UNDERLAG_UNSUPPORTED_TYPE',
      message: 'Filtypen stöds inte. Ladda upp en PDF eller en bild.',
    }
  }
  if (file.size > MAX_DOCUMENT_SIZE) {
    return {
      ok: false,
      status: 400,
      code: 'UNDERLAG_TOO_LARGE',
      message: 'Filen är för stor.',
      details: { max_bytes: MAX_DOCUMENT_SIZE },
    }
  }

  try {
    const document = await uploadDocument(
      ctx.supabase,
      ctx.userId,
      ctx.companyId,
      { name: file.name, buffer: file.buffer, type: file.type },
      // A retry of the same file (a re-run export client, a re-picked disk
      // file) converges on the archived original instead of a copy.
      { upload_source: uploadSource, dedupeByContent: true, extractionOwner: 'none' },
    )
    return { ok: true, document }
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (/kunde inte verifieras|matchar inte den angivna filtypen/i.test(message)) {
      return {
        ok: false,
        status: 400,
        code: 'UNDERLAG_INVALID_CONTENT',
        message: 'Filens innehåll stämmer inte med filtypen.',
      }
    }
    ctx.log.error('underlagsjakt: uploading underlag failed', { error: message })
    return { ok: false, status: 500, code: 'UNDERLAG_UPLOAD_FAILED', message: 'Dokumentet kunde inte sparas.' }
  }
}
