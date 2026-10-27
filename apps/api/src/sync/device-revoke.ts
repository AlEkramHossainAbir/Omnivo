import { devices, sessions } from '@omnivo/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { audit } from '../common/audit/audit.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// The same type as DevicesService's DeviceRow, written here so the two files do not import each
// other
type DeviceRow = typeof devices.$inferSelect;

// Step 18c, decision 3: revoking stops the sync, and ends the sign-in the device used last. Two
// callers, so it is a plain function and not a service: DevicesService.revoke (one device) and
// MembersService.remove (every device of the person removed), each in its own transaction.
//
// The rows must be locked FOR UPDATE by the caller, in the order of their ids.
export async function revokeDevices(tx: Transaction, rows: readonly DeviceRow[]): Promise<void> {
  const revokedBy = currentPrincipal().userId;
  const ended: string[] = [];
  for (const row of rows) {
    // revoked_at IS NULL: a device revoked already keeps who and when (migration 0048 refuses a
    // change anyway). A plain update, so version and updated_at move like any other change.
    // Step 19b: the device's key goes in the same update, for good. The server can then never
    // open that copy again; migration 0050's check refuses a revoke that keeps it.
    const [after] = await tx
      .update(devices)
      .set({
        revokedAt: sql`now()`,
        revokedBy,
        secret: null,
        version: sql`${devices.version} + 1`,
        updatedBy: revokedBy,
      })
      .where(
        and(eq(devices.tenantId, getTenantId()), eq(devices.id, row.id), isNull(devices.revokedAt)),
      )
      .returning({ revokedAt: devices.revokedAt });
    if (!after?.revokedAt) continue;
    if (row.sessionId !== null) ended.push(row.sessionId);
    await audit(tx, {
      action: 'device.revoked',
      entityType: 'device',
      entityId: row.id,
      changes: { revokedAt: { from: null, to: after.revokedAt.toISOString() } },
    });
  }
  // The sign-in of that browser ends with the revoke, in the same transaction: its refresh tokens
  // go with it (ON DELETE CASCADE), so the browser cannot get a new access token. The one it has
  // works for its last minutes on online pages; the pull and the push stop at once. sessions has
  // no RLS (it is every workspace's), and a session_id is only ever written by the device's own
  // person, so this never ends someone else's sign-in. The column keeps the id: it says which
  // sign-in the device had, and the trigger keeps a revoked row as it is.
  if (ended.length > 0) await tx.delete(sessions).where(inArray(sessions.id, ended));
}

// Every active device of one person in this workspace, locked in the order of their ids so two
// removals of the same person never wait for each other in a circle
export function activeDevicesOf(tx: Transaction, userId: string): Promise<DeviceRow[]> {
  return tx
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.tenantId, getTenantId()),
        eq(devices.userId, userId),
        isNull(devices.revokedAt),
      ),
    )
    .orderBy(asc(devices.id))
    .for('update');
}
