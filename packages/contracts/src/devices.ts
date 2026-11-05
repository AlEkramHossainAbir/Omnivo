import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { deviceNameSchema, deviceSchema } from './sync.js';

// Step 18c: the devices of a workspace. Step 18a registers one (sync.registerDevice); here people
// see them, rename them, move their own to another branch and revoke them.
//
//   GET  /me/devices              the signed-in person's own devices in this workspace
//   GET  /devices                 every device of the workspace (core.device.manage)
//   PATCH /devices/:id            rename (your own, or any with core.device.manage)
//   PUT  /devices/:id/branch      move it to another branch (your own only)
//   POST /devices/:id/revoke      stop it for good (your own, or any with core.device.manage)
//
// A revoked device stays in the list as Revoked, for the audit. It is never restored: the same
// browser signing in again makes a new device with a new id.

// A device as the lists show it: the row, plus the names a person reads instead of ids
export const deviceListItemSchema = deviceSchema.extend({
  // The person the device belongs to, also after they left the workspace
  userName: z.string(),
  branchName: z.string(),
  // Who revoked it: the person themself, someone with core.device.manage, or the person who
  // removed them from the workspace. null while it is active.
  revokedByName: z.string().nullable(),
});
export type DeviceListItem = z.infer<typeof deviceListItemSchema>;

// A person has a few devices (a browser at work, one at home, a phone), so their own list is one
// answer, not pages
export const myDeviceListSchema = z.object({ items: z.array(deviceListItemSchema) });
export type MyDeviceList = z.infer<typeof myDeviceListSchema>;

export const DEVICE_STATUSES = ['active', 'revoked'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

// 'lastSync' is the oldest sync first, with the devices that never synced before all others:
// the order an owner wants when looking for the devices that are behind
export const DEVICE_SORTS = ['name', '-name', 'lastSync', '-lastSync'] as const;
export type DeviceSort = (typeof DEVICE_SORTS)[number];

export const deviceListQuerySchema = pageQuerySchema.extend({
  // Part of the device's name or of its person's name
  search: z.string().trim().max(100).optional(),
  branchId: z.uuid().optional(),
  status: z.enum(DEVICE_STATUSES).default('active'),
  sort: z.enum(DEVICE_SORTS).default('name'),
});
export type DeviceListQuery = z.input<typeof deviceListQuerySchema>;

export const devicePageSchema = pageOf(deviceListItemSchema);
export type DevicePage = z.infer<typeof devicePageSchema>;

export const renameDeviceInputSchema = z.object({
  name: deviceNameSchema,
  version: versionSchema,
});
export type RenameDeviceInput = z.infer<typeof renameDeviceInputSchema>;
export type RenameDeviceFormValues = z.input<typeof renameDeviceInputSchema>;

export const moveDeviceInputSchema = z.object({
  // The form's empty select sends '' — "not chosen", with the same message as registering
  branchId: z.uuid(errorCode('device_branch_invalid')),
  version: versionSchema,
});
export type MoveDeviceInput = z.infer<typeof moveDeviceInputSchema>;
export type MoveDeviceFormValues = z.input<typeof moveDeviceInputSchema>;

// The time limits of working offline (step 18 decision 7). Constants, not a setting: they are a
// rule of the sync engine, like the 30 days the change log is kept.
//
// After 24 hours without a sync, the app warns. After 7 days, it stops saving new work on the
// device until it syncs again (work already waiting is still sent). A device that has been away
// that long has prices, stock and credit limits a week old, and the longer its outbox waits, the
// more of it the server may refuse.
export const SYNC_WARN_AFTER_HOURS = 24;
export const SYNC_BLOCK_AFTER_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;

export type SyncAge = 'fresh' | 'warn' | 'blocked';

// How long ago the last sync was, as the limits see it. The caller works out the time passed:
// the device from its own clock (it has no other offline), a list of devices from the server's.
// A time below zero (a clock set back) counts as fresh.
export function syncAge(msSinceLastSync: number): SyncAge {
  if (msSinceLastSync >= SYNC_BLOCK_AFTER_DAYS * 24 * HOUR_MS) return 'blocked';
  if (msSinceLastSync >= SYNC_WARN_AFTER_HOURS * HOUR_MS) return 'warn';
  return 'fresh';
}

const deviceParamsSchema = z.object({ id: z.uuid() });

// Rename, move and revoke have no permission on the route: your own device needs none, and
// someone else's needs core.device.manage. The service checks which one it is. Another person's
// device without the permission answers device_not_found, like in step 18a.
export const deviceRoutes = {
  mine: defineRoute({
    method: 'GET',
    path: '/me/devices',
    summary: "The signed-in person's devices in the active workspace, revoked ones too",
    auth: 'bearer',
    status: 200,
    response: myDeviceListSchema,
  }),
  list: defineRoute({
    method: 'GET',
    path: '/devices',
    summary: 'Every device of the active workspace, one page at a time',
    auth: 'bearer',
    permission: 'core.device.manage',
    status: 200,
    query: deviceListQuerySchema,
    response: devicePageSchema,
  }),
  rename: defineRoute({
    method: 'PATCH',
    path: '/devices/:id',
    summary: 'Rename a device',
    auth: 'bearer',
    status: 200,
    params: deviceParamsSchema,
    body: renameDeviceInputSchema,
    response: deviceListItemSchema,
  }),
  // Only from the device itself, after it synced (decision 2): the app checks that its outbox is
  // empty before it asks, because the server cannot see the outbox. The next pull is a full pull
  // of the new branch.
  move: defineRoute({
    method: 'PUT',
    path: '/devices/:id/branch',
    summary: 'Move your own device to another branch',
    auth: 'bearer',
    status: 200,
    params: deviceParamsSchema,
    body: moveDeviceInputSchema,
    response: deviceListItemSchema,
  }),
  // No version: revoking is final, and a rename a moment earlier does not change the decision.
  // Revoking a revoked device answers it as it is.
  revoke: defineRoute({
    method: 'POST',
    path: '/devices/:id/revoke',
    summary: 'Revoke a device: it stops syncing, and its data and sign-in are removed',
    auth: 'bearer',
    status: 200,
    params: deviceParamsSchema,
    response: deviceListItemSchema,
  }),
};
