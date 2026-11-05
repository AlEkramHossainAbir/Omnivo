-- Custom SQL migration file, put your code below! --
-- A revoke is final (step 18c, decisions 3 and 4): the device is never restored, and the same
-- browser signing in again makes a new device. The API never changes a revoked device, but this
-- guard makes the rule hold for every code path, a script or a hand-written UPDATE too.
CREATE FUNCTION devices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 1) Every revoke from now on names who did it: the device list shows it, and the audit log
  --    alone is not enough once its rows are old. A CHECK cannot say "from now on" (0047's
  --    check goes one way only), so a device revoked before step 18c keeps its NULL.
  IF NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NULL
     AND (TG_OP = 'INSERT' OR OLD.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'device % is revoked without the person who revoked it', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'devices_revoked_by_required';
  END IF;

  -- 2) A revoked device stays as it was when it was revoked: no "un-revoke", no rename, no move,
  --    no new sign-in linked to it. last_sync_at may still change: a pull that started before
  --    the revoke may finish after it, and that harms nothing. version and updated_at are
  --    bookkeeping, not facts about the device.
  IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NOT NULL
     AND (NEW.tenant_id, NEW.user_id, NEW.name, NEW.branch_id, NEW.session_id,
          NEW.revoked_at, NEW.revoked_by)
         IS DISTINCT FROM
         (OLD.tenant_id, OLD.user_id, OLD.name, OLD.branch_id, OLD.session_id,
          OLD.revoked_at, OLD.revoked_by) THEN
    RAISE EXCEPTION 'device % is revoked and cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'devices_revoked_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER devices_guard
  BEFORE INSERT OR UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION devices_guard();
