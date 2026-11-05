-- Custom SQL migration file, put your code below! --
-- Step 19b: every active device has a key of its own (devices.secret), and a revoked device has
-- none. The device's copy is encrypted with a random data key, and this key wraps it, so the copy
-- opens online without a PIN. Revoking a device deletes the key: from then on only the PIN opens
-- that copy, until the device reaches the server and deletes it.

-- 1) The database makes the key, with pgcrypto's gen_random_bytes (the operating system's secure
--    random source). pgcrypto ships with Postgres and is a "trusted" extension, like pg_trgm in
--    0020, so the database owner (omnivo_migrator) may create it. The default is set here and not
--    in the Drizzle schema: drizzle-kit would write it before the extension exists. Set after the
--    column was added (0049), it is only for new rows: every device registered from now on.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE devices ALTER COLUMN secret SET DEFAULT gen_random_bytes(32);

-- 2) The devices registered before this step, once per workspace: devices has FORCE ROW LEVEL
--    SECURITY (0044), so without app.tenant_id this UPDATE would see no row. Only the active ones:
--    a revoked device never gets a key again. Each row calls gen_random_bytes on its own, so no
--    two devices share a key. A raw UPDATE of one column: version and updated_at stay, so a rename
--    open on the Devices page does not fail on its version, and the 0048 trigger lets an active
--    row change.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE devices
       SET secret = gen_random_bytes(32)
     WHERE tenant_id = t
       AND revoked_at IS NULL
       AND secret IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- 3) The rules, for every code path (the API, a script, a hand-written UPDATE):
--    - an active device has a key, and a revoked one has none. So a revoke that forgets the key
--      fails, instead of leaving a key the server could still give out. A NOT NULL alone would
--      not do: a revoked device must have none.
--    - a key is exactly 32 bytes, an AES-256 key. The app refuses any other length too.
--    A CHECK sees every row, whatever the RLS, so both are checked for every workspace here.
ALTER TABLE devices
  ADD CONSTRAINT devices_secret_check CHECK ((secret IS NULL) = (revoked_at IS NOT NULL));
ALTER TABLE devices
  ADD CONSTRAINT devices_secret_length_check CHECK (secret IS NULL OR octet_length(secret) = 32);
