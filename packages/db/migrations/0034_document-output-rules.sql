-- Custom SQL migration file, put your code below! --
-- 1) The three new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002).
--    The worker draws a PDF and sends an email as omnivo_app inside the document's tenant, like
--    every job, so omnivo_worker needs no grant (as in 0018).
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['document_files', 'document_emails', 'document_shares'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- 2) A customer who opens a share link has no login and no workspace, so there is no tenant
--    context yet. The pattern of invitation_by_token (0010): SELECT only, and only the one row
--    whose hash is exactly the value the API set. Without the token no row is visible. Everything
--    after the lookup (stamping the opening, loading the document, asking for its PDF) runs in the
--    link's tenant with tenant_isolation.
CREATE POLICY share_by_token ON document_shares
  FOR SELECT
  USING (token_hash = NULLIF(current_setting('app.share_token_hash', true), ''));

-- 3) A ready PDF never changes: its row is the cache, and a download of the same look must get the
--    same file. Before that, the worker finishes the row (ready or failed), and a new request after
--    a failure sets it back to pending. Which document, which language, the look (model and
--    fingerprint) and who asked first never change: the file must always be the drawing of the
--    model its fingerprint names. A row may be deleted (a later cleanup of old files).
CREATE FUNCTION document_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ready' THEN
    RAISE EXCEPTION 'document file % is ready and cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_files_ready_immutable';
  END IF;
  IF (NEW.tenant_id, NEW.kind, NEW.document_id, NEW.language, NEW.fingerprint, NEW.model,
      NEW.requested_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.kind, OLD.document_id, OLD.language, OLD.fingerprint, OLD.model,
      OLD.requested_by, OLD.created_at) THEN
    RAISE EXCEPTION 'document file % cannot move to another document, language or look', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_files_identity_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_files_guard
  BEFORE UPDATE ON document_files
  FOR EACH ROW EXECUTE FUNCTION document_files_guard();

-- 4) An email is a record of what was sent to a customer. It is never deleted, and only the
--    worker's answer changes it, once: pending to sent or failed. Sending again makes a new row.
CREATE FUNCTION document_emails_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'pending'
     OR to_jsonb(NEW) - ARRAY['status', 'sent_at'] <> to_jsonb(OLD) - ARRAY['status', 'sent_at'] THEN
    RAISE EXCEPTION 'document email % cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_emails_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_emails_guard
  BEFORE UPDATE OR DELETE ON document_emails
  FOR EACH ROW EXECUTE FUNCTION document_emails_guard();

-- 5) A share link is never deleted: the list shows the links that were turned off or ended, with
--    when the customer opened them. Only its openings and turning it off change it. A link that is
--    off stays off (turning it on again would bring back a link the person meant to kill), and the
--    first opening is written once. last_opened_at is not checked for order: two openings at the
--    same moment may commit in either order, and the API writes greatest(last_opened_at, now()).
CREATE FUNCTION document_shares_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR to_jsonb(NEW) - ARRAY['revoked_at', 'first_opened_at', 'last_opened_at']
     <> to_jsonb(OLD) - ARRAY['revoked_at', 'first_opened_at', 'last_opened_at']
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.first_opened_at IS NOT NULL
         AND NEW.first_opened_at IS DISTINCT FROM OLD.first_opened_at) THEN
    RAISE EXCEPTION 'document share % cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_shares_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_shares_guard
  BEFORE UPDATE OR DELETE ON document_shares
  FOR EACH ROW EXECUTE FUNCTION document_shares_guard();
