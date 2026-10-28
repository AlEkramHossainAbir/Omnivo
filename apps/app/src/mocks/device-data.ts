import type {
  Device,
  DeviceListItem,
  deviceListQuerySchema,
  DevicePage,
  DeviceSort,
  MoveDeviceInput,
  RenameDeviceInput,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { OWNER } from './fixtures';
import { MockProblem } from './mock';
import { releaseHeldBy } from './pos-data';
import { checkVersion, diff, record, type WorkspaceData } from './workspace-data';

// The mock's step 18c (decisions 1–4): the two device lists, rename, move and revoke. The devices
// themselves are sync-data.ts's (registered by the branch dialog, used by pull and push); this file
// adds what the API keeps beside them: the sign-in a device was last used with, and who revoked it.
// The seed of the garments workspace's devices is sync-data.ts's seedDevices(): workspace-data.ts
// calls it, and this file imports workspace-data.ts, so a seed here would be an import circle.

function now(): string {
  return new Date().toISOString();
}

// --- The sign-in of a device (decision 3) -------------------------------------------------------

// The API's devices.session_id: register, a pull and a push write the sign-in they came with, and
// a revoke ends that sign-in. The mock has one sign-in at a time (handlers.ts), so a revoke of a
// device used with it signs this browser out, and a revoke of any other device does not.
export function keepSession(data: WorkspaceData, deviceId: string, sessionId: string): void {
  const device = data.sync.devices.find((candidate) => candidate.id === deviceId);
  // A revoked device keeps the sign-in it had (the 0048 trigger refuses a change)
  if (device?.revokedAt === null) data.sync.sessions.set(deviceId, sessionId);
}

// --- The lists ----------------------------------------------------------------------------------

function nameOf(data: WorkspaceData, userId: string): string {
  return data.people.members.find((member) => member.userId === userId)?.fullName ?? '';
}

function toListItem(data: WorkspaceData, device: Device): DeviceListItem {
  const revokedBy = data.sync.revokedBy.get(device.id);
  return {
    ...device,
    userName: nameOf(data, device.userId),
    branchName: data.branches.find((branch) => branch.id === device.branchId)?.name ?? '',
    revokedByName: revokedBy === undefined ? null : nameOf(data, revokedBy),
  };
}

// The API's mine(): active first, then by name
export function myDevices(data: WorkspaceData): DeviceListItem[] {
  return data.sync.devices
    .filter((device) => device.userId === OWNER.id)
    .toSorted(
      (a, b) =>
        Number(a.revokedAt !== null) - Number(b.revokedAt !== null) || a.name.localeCompare(b.name),
    )
    .map((device) => toListItem(data, device));
}

// 'lastSync': the oldest first, the devices that never synced before all of them; '-lastSync' the
// other way round. Times are ISO strings of one format, so comparing them as text is by time.
function compare(sort: DeviceSort): (a: DeviceListItem, b: DeviceListItem) => number {
  const byName = (a: DeviceListItem, b: DeviceListItem) => a.name.localeCompare(b.name);
  const bySync = (a: DeviceListItem, b: DeviceListItem) =>
    (a.lastSyncAt ?? '').localeCompare(b.lastSyncAt ?? '');
  if (sort === 'name') return byName;
  if (sort === '-name') return (a, b) => byName(b, a);
  if (sort === 'lastSync') return bySync;
  return (a, b) => bySync(b, a);
}

// The API pages with a keyset; the mock's cursor is an offset. The client never reads it.
export function deviceList(
  data: WorkspaceData,
  query: z.output<typeof deviceListQuerySchema>,
): DevicePage {
  const search = query.search?.toLowerCase() ?? '';
  const matches = data.sync.devices
    .map((device) => toListItem(data, device))
    .filter(
      (device) =>
        (query.status === 'active') === (device.revokedAt === null) &&
        (query.branchId === undefined || device.branchId === query.branchId) &&
        (search === '' ||
          device.name.toLowerCase().includes(search) ||
          device.userName.toLowerCase().includes(search)),
    )
    .toSorted(compare(query.sort));
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  const end = start + query.limit;
  return {
    items: matches.slice(start, end),
    nextCursor: end < matches.length ? String(end) : null,
  };
}

// --- Rename, move, revoke -----------------------------------------------------------------------

// The mock's person is the owner, who holds core.device.manage: every device is theirs to rename
// and revoke. Moving is for their own only (decision 2), like the API's lockOwn().
function findDevice(data: WorkspaceData, id: string): Device {
  const device = data.sync.devices.find((candidate) => candidate.id === id);
  if (!device) throw new MockProblem(404, 'device_not_found');
  return device;
}

function assertActive(device: Device): void {
  if (device.revokedAt !== null) throw new MockProblem(403, 'device_revoked');
}

export function renameDevice(
  data: WorkspaceData,
  id: string,
  input: RenameDeviceInput,
): DeviceListItem {
  const device = findDevice(data, id);
  assertActive(device);
  checkVersion(device.version, input.version);
  // The same name: no write and no audit row, like the API
  if (device.name !== input.name) {
    record(data, 'device.renamed', 'device', id, diff({ name: device.name }, { name: input.name }));
    Object.assign(device, { name: input.name, version: device.version + 1 });
  }
  return toListItem(data, device);
}

export function moveDevice(
  data: WorkspaceData,
  id: string,
  input: MoveDeviceInput,
): DeviceListItem {
  const device = findDevice(data, id);
  if (device.userId !== OWNER.id) throw new MockProblem(404, 'device_not_found');
  assertActive(device);
  checkVersion(device.version, input.version);
  const branch = data.branches.find(
    (candidate) => candidate.id === input.branchId && candidate.archivedAt === null,
  );
  if (!branch) {
    throw new MockProblem(409, 'device_branch_invalid', { branchId: ['device_branch_invalid'] });
  }
  if (device.branchId !== branch.id) {
    const before = data.branches.find((candidate) => candidate.id === device.branchId);
    record(
      data,
      'device.moved',
      'device',
      id,
      diff({ branch: before?.code ?? null }, { branch: branch.code }),
    );
    // The next pull is a full pull of the new branch: sync-data.ts's pull compares the branch its
    // cursor was made for
    Object.assign(device, { branchId: branch.id, version: device.version + 1 });
    // Step 20a: its register stays in the old branch, so it is free for another device there
    releaseHeldBy(data, id);
  }
  return toListItem(data, device);
}

// Revoking twice answers the device as it is. `endsSession` tells the handler whether the revoke
// ended the sign-in this browser uses (handlers.ts then answers its refresh with session_ended).
export function revokeDevice(
  data: WorkspaceData,
  id: string,
  sessionId: string,
): { device: DeviceListItem; endsSession: boolean } {
  const device = findDevice(data, id);
  if (device.revokedAt !== null) return { device: toListItem(data, device), endsSession: false };
  const revokedAt = now();
  Object.assign(device, { revokedAt, version: device.version + 1 });
  data.sync.revokedBy.set(id, OWNER.id);
  // Step 20a: a lost or broken PC is revoked, and its counter is free for the next one
  releaseHeldBy(data, id);
  record(data, 'device.revoked', 'device', id, { revokedAt: { from: null, to: revokedAt } });
  return {
    device: toListItem(data, device),
    endsSession: data.sync.sessions.get(id) === sessionId,
  };
}

// Branch archive (decision 20): refused while active devices are in the branch, with how many
export function assertNoActiveDevices(data: WorkspaceData, branchId: string): void {
  const count = data.sync.devices.filter(
    (device) => device.branchId === branchId && device.revokedAt === null,
  ).length;
  if (count > 0) throw new MockProblem(409, 'branch_has_devices', undefined, { count });
}
