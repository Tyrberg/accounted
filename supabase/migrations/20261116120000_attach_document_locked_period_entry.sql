-- Archive underlag against a verifikat in a closed/locked fiscal period
-- (founder-approved 2026-11-09, part 1 of 2: the write path; part 2 is the
-- backoffice run that uses it).
--
-- Problem: enforce_period_lock_documents() (migration 20240101000017) rejects
-- every INSERT/UPDATE of a document_attachments row whose journal_entry_id
-- points at an entry in a closed or locked period. That correctly stops the
-- ordinary upload/link flows from touching a closed year, but it also means
-- underlag that genuinely belongs to an already-closed year can never be
-- archived against its verifikat. BFL 7 kap requires the underlag to be kept
-- with the verifikation; the link is what makes it findable.
--
-- Envelope (strictly bounded, same carve-out shape as the inline rättelse
-- precedent 20260723210000):
--   * The period is NOT unlocked, not even temporarily: fiscal_periods is
--     never written. The ordinary path keeps raising.
--   * One audited SECURITY DEFINER write path, service_role only. The caller
--     (the /api/v1 route) downloads the storage object and hashes the actual
--     stored bytes server-side, which is both the existence proof and the
--     source of the sha256; the RPC re-checks that the path sits under the
--     company's documents/<companyId>/ prefix.
--   * INSERT only. The carve-out in enforce_period_lock_documents() is bound
--     to TG_OP = 'INSERT' AND to the exact journal_entry_id the RPC set in a
--     transaction-local GUC, so it cannot re-link an existing row and cannot
--     be reused for another verifikat in the same transaction.
--   * The verifikat is not written: no lines, amounts, dates, number or
--     status change. The entry row is not even locked FOR UPDATE; concurrent
--     calls serialize on an advisory lock keyed by the entry id.
--   * sha256 duplicate guard per verifikat: the same sha256 can never be
--     linked twice to the same verifikat through this path. A re-run returns
--     the existing link (created = false) instead of raising.
--   * Audit trail in audit_log (action LOCKED_PERIOD_ATTACH, table_name
--     journal_entries, record_id = the verifikat): who, which API key, when,
--     verifikat, file, storage path, sha256, reason and the period state.
--     write_audit_log() additionally records the document_attachments INSERT.
--   * Nothing is deleted, and the archived bytes cannot be deleted through
--     another row either. The storage object must already belong to a
--     document_attachments row in the company (the upload that put it there);
--     the RPC locks that row FOR KEY SHARE, and the new BEFORE DELETE trigger
--     block_shared_document_storage_deletion() refuses to delete any row
--     whose storage object (either key layout) is held by a row linked to a
--     verifikat. Without both, deleting the original unlinked upload
--     (deleteDocument) would remove the shared object while the archived link
--     and its audit trail survive pointing at nothing. The row lock closes
--     the race: a delete that wins first leaves no source row (the RPC
--     refuses), an archive that wins first makes the delete's trigger see the
--     linked sibling (the delete is refused).
--
-- pg-test: tests/pg/attach-document-locked-period.pg.test.ts

-- =============================================================================
-- 1. audit_log action
-- =============================================================================
-- Current list verbatim (last replaced by 20260825150000) plus the new action.

ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action = ANY (ARRAY[
    'INSERT','UPDATE','DELETE','COMMIT','REVERSE','CORRECT',
    'LOCK_PERIOD','CLOSE_PERIOD','DOCUMENT_DELETE_BLOCKED',
    'RETENTION_BLOCK','SECURITY_EVENT','INTEGRITY_FAILURE',
    'COMMITTED_AT_OVERRIDE','RESET_SNAPSHOT','LOCKED_PERIOD_ATTACH'
  ])) NOT VALID;

-- =============================================================================
-- 2. Period-lock carve-out for the one audited attach path
-- =============================================================================
-- Body verbatim from 20240101000017 (never replaced since; search_path pinned
-- by 20260304191528) plus ONE branch: while the transaction-local GUC set by
-- attach_document_to_locked_period_entry() names the row's journal_entry_id,
-- an INSERT is allowed. UPDATE (re-linking an existing document) stays
-- blocked unconditionally.

CREATE OR REPLACE FUNCTION public.enforce_period_lock_documents()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_is_closed boolean;
  v_locked_at timestamptz;
BEGIN
  -- Only check if linking to a journal entry
  IF NEW.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Locked-period archive attach (founder-approved 2026-11-09): the RPC has
  -- verified tenant, role, entry status, storage object and sha256 duplicate,
  -- and writes the audit_log row in the same transaction.
  IF TG_OP = 'INSERT'
     AND current_setting('gnubok.allow_locked_period_attach', true) = NEW.journal_entry_id::text THEN
    RETURN NEW;
  END IF;

  SELECT fp.is_closed, fp.locked_at
  INTO v_is_closed, v_locked_at
  FROM public.journal_entries je
  JOIN public.fiscal_periods fp ON fp.id = je.fiscal_period_id
  WHERE je.id = NEW.journal_entry_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot attach documents to entries in a locked/closed fiscal period';
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- 3. attach_document_to_locked_period_entry: the ONE write path
-- =============================================================================
-- Error contract (the route maps the prefix before the colon):
--   LOCKED_ATTACH_INVALID:       bad input (sha256, path, reason, file name)
--   LOCKED_ATTACH_FORBIDDEN:     actor is not a writing member of the company
--   LOCKED_ATTACH_NOT_FOUND:     verifikat not found in the company
--   LOCKED_ATTACH_NOT_POSTED:    verifikat is not posted/reversed
--   LOCKED_ATTACH_PERIOD_OPEN:   period is open; use the ordinary link path
--   LOCKED_ATTACH_SOURCE_NOT_FOUND: no document row in the company holds the
--                                storage object (it was never uploaded as a
--                                document, or has been deleted)

CREATE OR REPLACE FUNCTION public.attach_document_to_locked_period_entry(
  p_company_id        uuid,
  p_journal_entry_id  uuid,
  p_storage_path      text,
  p_file_name         text,
  p_file_size_bytes   bigint,
  p_mime_type         text,
  p_sha256_hash       text,
  p_reason            text,
  p_actor_user_id     uuid,
  p_api_key_id        uuid DEFAULT NULL,
  p_api_key_name      text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role    text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_reason      text := btrim(coalesce(p_reason, ''));
  v_file_name   text := btrim(coalesce(p_file_name, ''));
  v_sha         text := lower(btrim(coalesce(p_sha256_hash, '')));
  v_legacy_path text;
  v_role        text;
  v_entry       record;
  v_existing    record;
  v_doc_id      uuid;
  v_created_at  timestamptz;
BEGIN
  -- Service role only: the sha256 is trusted because the server computed it
  -- from the stored bytes. A JWT caller could otherwise claim any hash.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'LOCKED_ATTACH_FORBIDDEN: service role required'
      USING ERRCODE = '42501';
  END IF;

  IF v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'LOCKED_ATTACH_INVALID: sha256 must be 64 hex characters';
  END IF;
  IF v_reason = '' OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'LOCKED_ATTACH_INVALID: reason is required (max 500 characters)';
  END IF;
  IF v_file_name = '' OR length(v_file_name) > 255 THEN
    RAISE EXCEPTION 'LOCKED_ATTACH_INVALID: file_name is required (max 255 characters)';
  END IF;
  IF p_storage_path IS NULL
     OR left(p_storage_path, length('documents/' || p_company_id::text || '/'))
        <> 'documents/' || p_company_id::text || '/'
     -- Reject `.`/`..` path segments only; dots inside a file name
     -- (receipt..pdf) are legitimate and preserved by sanitizeFileName().
     OR p_storage_path ~ '(^|/)\.\.?(/|$)' THEN
    RAISE EXCEPTION 'LOCKED_ATTACH_INVALID: storage_path must be under documents/<companyId>/';
  END IF;
  -- The same object under the legacy documents/<userId>/ key layout (see
  -- documentStoragePathCandidates in lib/core/documents/document-service.ts).
  v_legacy_path := 'documents/' || substr(p_storage_path, length('documents/' || p_company_id::text || '/') + 1);

  SELECT cm.role INTO v_role
    FROM public.company_members cm
   WHERE cm.company_id = p_company_id AND cm.user_id = p_actor_user_id;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'LOCKED_ATTACH_FORBIDDEN: actor lacks write access to the company'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize concurrent attaches to the same verifikat without locking (or
  -- writing) the journal_entries row itself.
  PERFORM pg_advisory_xact_lock(hashtextextended('locked_period_attach:' || p_journal_entry_id::text, 0));

  SELECT je.id, je.status, je.voucher_series, je.voucher_number, je.company_id,
         fp.id AS period_id, fp.is_closed, fp.locked_at
    INTO v_entry
    FROM public.journal_entries je
    JOIN public.fiscal_periods fp ON fp.id = je.fiscal_period_id
   WHERE je.id = p_journal_entry_id;

  IF NOT FOUND OR v_entry.company_id <> p_company_id THEN
    RAISE EXCEPTION 'LOCKED_ATTACH_NOT_FOUND: journal entry not found';
  END IF;

  -- Idempotent re-run: the same bytes are already on this verifikat.
  SELECT da.id, da.file_name, da.storage_path, da.created_at
    INTO v_existing
    FROM public.document_attachments da
   WHERE da.journal_entry_id = p_journal_entry_id
     AND da.company_id = p_company_id
     AND da.sha256_hash = v_sha
   ORDER BY da.created_at
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'created', false,
      'document_id', v_existing.id,
      'journal_entry_id', p_journal_entry_id,
      'file_name', v_existing.file_name,
      'storage_path', v_existing.storage_path,
      'sha256_hash', v_sha,
      'created_at', v_existing.created_at
    );
  END IF;

  IF v_entry.status NOT IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'LOCKED_ATTACH_NOT_POSTED: journal entry status is %', v_entry.status;
  END IF;

  IF NOT (v_entry.is_closed OR v_entry.locked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'LOCKED_ATTACH_PERIOD_OPEN: the fiscal period is open; use the ordinary document link';
  END IF;

  -- The object must belong to a document the company already holds, and that
  -- row is locked until commit. A concurrent DELETE of it waits and then hits
  -- block_shared_document_storage_deletion() (it sees the new linked row); a
  -- DELETE that committed first leaves nothing to lock, so the archive is
  -- refused instead of pointing at bytes about to be removed.
  PERFORM 1
     FROM public.document_attachments da
    WHERE da.company_id = p_company_id
      AND da.storage_path IN (p_storage_path, v_legacy_path)
      FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LOCKED_ATTACH_SOURCE_NOT_FOUND: no document in the company holds this storage object';
  END IF;

  PERFORM set_config('gnubok.allow_locked_period_attach', p_journal_entry_id::text, true);

  INSERT INTO public.document_attachments
    (user_id, company_id, storage_path, file_name, file_size_bytes, mime_type,
     sha256_hash, version, is_current_version, uploaded_by, upload_source,
     journal_entry_id)
  VALUES
    (p_actor_user_id, p_company_id, p_storage_path, v_file_name, p_file_size_bytes, p_mime_type,
     v_sha, 1, true, p_actor_user_id, 'api',
     p_journal_entry_id)
  RETURNING id, created_at INTO v_doc_id, v_created_at;

  PERFORM set_config('gnubok.allow_locked_period_attach', '', true);

  INSERT INTO public.audit_log
    (user_id, company_id, actor_id, action, table_name, record_id, new_state, description)
  VALUES
    (p_actor_user_id, p_company_id, p_actor_user_id, 'LOCKED_PERIOD_ATTACH', 'journal_entries',
     p_journal_entry_id,
     jsonb_build_object(
       'document_id', v_doc_id,
       'journal_entry_id', p_journal_entry_id,
       'voucher_series', v_entry.voucher_series,
       'voucher_number', v_entry.voucher_number,
       'file_name', v_file_name,
       'storage_path', p_storage_path,
       'sha256_hash', v_sha,
       'file_size_bytes', p_file_size_bytes,
       'mime_type', p_mime_type,
       'reason', v_reason,
       'api_key_id', p_api_key_id,
       'api_key_name', p_api_key_name,
       'fiscal_period_id', v_entry.period_id,
       'period_is_closed', v_entry.is_closed,
       'period_locked_at', v_entry.locked_at
     ),
     'Underlag ' || v_file_name || ' arkiverat mot verifikat i låst/stängd period: ' || v_reason);

  RETURN jsonb_build_object(
    'created', true,
    'document_id', v_doc_id,
    'journal_entry_id', p_journal_entry_id,
    'file_name', v_file_name,
    'storage_path', p_storage_path,
    'sha256_hash', v_sha,
    'created_at', v_created_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.attach_document_to_locked_period_entry(
  uuid, uuid, text, text, bigint, text, text, text, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_document_to_locked_period_entry(
  uuid, uuid, text, text, bigint, text, text, text, uuid, uuid, text
) TO service_role;

-- =============================================================================
-- 4. block_shared_document_storage_deletion: keep shared archived bytes
-- =============================================================================
-- Several document_attachments rows can point at one storage object (the
-- archive row above shares the original upload's object). deleteDocument()
-- checks only the row it deletes and then removes the object under both key
-- layouts, so deleting an unlinked sibling would destroy underlag that is
-- retained on a verifikat. This new trigger (it does not touch the migration
-- 017 block_document_deletion trigger) refuses that DELETE. The message
-- carries "Bokföringslagen" so deleteDocument() answers 409 linked_to_entry.
-- The sandbox teardown unlinks every row before deleting, so it never fires
-- there.

CREATE OR REPLACE FUNCTION public.block_shared_document_storage_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scoped_prefix text := 'documents/' || OLD.company_id::text || '/';
  v_alt_path      text;
  v_holder        uuid;
BEGIN
  IF OLD.storage_path IS NULL THEN
    RETURN OLD;
  END IF;

  IF left(OLD.storage_path, length(v_scoped_prefix)) = v_scoped_prefix THEN
    v_alt_path := 'documents/' || substr(OLD.storage_path, length(v_scoped_prefix) + 1);
  ELSIF left(OLD.storage_path, length('documents/')) = 'documents/' THEN
    v_alt_path := v_scoped_prefix || substr(OLD.storage_path, length('documents/') + 1);
  END IF;

  SELECT da.journal_entry_id INTO v_holder
    FROM public.document_attachments da
   WHERE da.id <> OLD.id
     AND da.journal_entry_id IS NOT NULL
     AND (da.storage_path = OLD.storage_path OR da.storage_path = v_alt_path)
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot delete document: its stored file is retained underlag on journal entry % (Bokföringslagen)',
      v_holder;
  END IF;

  RETURN OLD;
END;
$$;

-- Both the trigger and the RPC look rows up by storage_path.
CREATE INDEX IF NOT EXISTS idx_document_attachments_storage_path
  ON public.document_attachments (storage_path);

DROP TRIGGER IF EXISTS block_shared_document_storage_deletion ON public.document_attachments;
CREATE TRIGGER block_shared_document_storage_deletion
  BEFORE DELETE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.block_shared_document_storage_deletion();

NOTIFY pgrst, 'reload schema';
