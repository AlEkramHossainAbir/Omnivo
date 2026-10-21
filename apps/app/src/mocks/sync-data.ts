import {
  addQuantity,
  type Device,
  isZeroQuantity,
  priceListItemKey,
  type RegisterDeviceInput,
  stockKey,
  SYNC_PROTOCOL,
  syncCategorySchema,
  type SyncChange,
  type SyncEntity,
  type SyncPull,
  syncSettingsSchema,
  type SyncStock,
  type SyncUpsert,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
// Type-only: workspace-data.ts imports this file for emptySync(), and a type import is erased
// when the code is built, so it makes no circle
import type { WorkspaceData } from './workspace-data';

// The mock's sync engine (step 18a): the devices, and pulls worked out from the mock's own data.
// The API has a change log written by triggers; the mock has plain arrays that a hundred handlers
// change. So instead of a log, the mock remembers what each finished pull left the device with,
// and the next pull sends the difference. Every mock write (a new customer, an archived product, a
// posted stock adjustment) then reaches the device without one line in its handler.

// The rows a device holds, by `${entity}|${key}`, each with the row as JSON. Comparing JSON is
// enough: the mock builds a row's fields in the same order every time.
type Rows = Map<string, { entity: SyncEntity; key: string; json: string }>;

interface Finished {
  deviceId: string;
  branchId: string;
  rows: Rows;
}

// A pull that has more pages: what is still to send, and what the device holds when it is done
interface Paging {
  deviceId: string;
  changes: SyncChange[];
  full: boolean;
  finished: Finished;
}

export interface MockSync {
  devices: Device[];
  // A finished pull's cursor → what it left the device with. Only the newest one per device is
  // kept. A cursor the mock does not know starts a full pull, like a cursor older than the API's
  // change log: that is what happens after a reload, which starts the mock over but keeps the
  // device's copy in IndexedDB.
  finished: Map<string, Finished>;
  // A page's cursor → the rest of its pull
  paging: Map<string, Paging>;
  // When a stock row last changed. Movements have dates, not times, and a row's updatedAt must
  // stay the same while its quantity does, or every pull would send every stock row again.
  stamps: Map<string, { quantity: string; at: string }>;
}

export function emptySync(): MockSync {
  return { devices: [], finished: new Map(), paging: new Map(), stamps: new Map() };
}

function now(): string {
  return new Date().toISOString();
}

// --- Devices ------------------------------------------------------------------------------------

// The API's register (decision 37): the same id by the same person returns the device as it is,
// so a retry after a lost answer is not a second device; another person's id is refused.
// branchCode is set only for a new device: the handler writes its audit row with it.
export function registerDevice(
  data: WorkspaceData,
  userId: string,
  input: RegisterDeviceInput,
): { device: Device; branchCode: string | null } {
  const known = data.sync.devices.find((device) => device.id === input.id);
  if (known) {
    if (known.userId !== userId) throw new MockProblem(409, 'device_id_invalid');
    return { device: known, branchCode: null };
  }
  const branch = data.branches.find(
    (candidate) => candidate.id === input.branchId && candidate.archivedAt === null,
  );
  if (!branch) {
    throw new MockProblem(409, 'device_branch_invalid', {
      branchId: ['device_branch_invalid'],
    });
  }
  const device: Device = {
    id: input.id,
    name: input.name,
    branchId: branch.id,
    userId,
    lastSyncAt: null,
    revokedAt: null,
    createdAt: now(),
    version: 1,
  };
  data.sync.devices.push(device);
  return { device, branchCode: branch.code };
}

// The device a pull names: the signed-in person's own, and not revoked
function deviceFor(data: WorkspaceData, userId: string, id: string): Device {
  const device = data.sync.devices.find((candidate) => candidate.id === id);
  if (device?.userId !== userId) throw new MockProblem(404, 'device_not_found');
  if (device.revokedAt !== null) throw new MockProblem(403, 'device_revoked');
  return device;
}

// --- The rows a device keeps --------------------------------------------------------------------

// The stock in the branch's active warehouses, from the movements: one row per variant and batch,
// none at zero, none of an archived product (the API's stock loader)
function stockRows(
  data: WorkspaceData,
  warehouseIds: ReadonlySet<string>,
  activeProducts: ReadonlySet<string>,
): SyncStock[] {
  const totals = new Map<string, SyncStock>();
  for (const movement of data.stock.movements) {
    if (!warehouseIds.has(movement.warehouseId) || !activeProducts.has(movement.productId)) {
      continue;
    }
    const key = stockKey(movement);
    const before = totals.get(key);
    if (before) {
      before.quantity = addQuantity(before.quantity, movement.quantity);
      continue;
    }
    const batch = data.stock.batches.find((candidate) => candidate.id === movement.batchId);
    totals.set(key, {
      warehouseId: movement.warehouseId,
      productId: movement.productId,
      variantId: movement.variantId,
      batchId: movement.batchId,
      lotNumber: batch?.lotNumber ?? null,
      manufacturedOn: batch?.manufacturedOn ?? null,
      expiresOn: batch?.expiresOn ?? null,
      // addQuantity gives 4 decimals, like the API's NUMERIC(19,4)
      quantity: addQuantity('0', movement.quantity),
      updatedAt: '',
    });
  }
  return [...totals.entries()]
    .filter(([, row]) => !isZeroQuantity(row.quantity))
    .map(([key, row]) => {
      const stamp = data.sync.stamps.get(key);
      if (stamp?.quantity === row.quantity) return { ...row, updatedAt: stamp.at };
      const at = now();
      data.sync.stamps.set(key, { quantity: row.quantity, at });
      return { ...row, updatedAt: at };
    });
}

// Every row the device of this branch keeps, in the order of SYNC_ENTITIES: what a list points at
// comes before the list
function rowsOf(data: WorkspaceData, tenantId: string, branchId: string): SyncUpsert[] {
  const { catalog, sales, stock } = data;
  const products = catalog.products.filter((product) => product.archivedAt === null);
  const activeProducts = new Set(products.map((product) => product.id));
  const activeLists = new Set(
    sales.priceLists.filter((list) => list.archivedAt === null).map((list) => list.id),
  );
  const warehouses = stock.warehouses.filter(
    (warehouse) => warehouse.branchId === branchId && warehouse.archivedAt === null,
  );
  const warehouseIds = new Set(warehouses.map((warehouse) => warehouse.id));
  return [
    // The schemas' parse keeps only the fields the device needs: the settings a sale uses, a
    // category without its product count
    {
      op: 'upsert',
      entity: 'settings',
      key: tenantId,
      data: syncSettingsSchema.parse(data.settings),
    },
    ...catalog.units.map((unit) => ({
      op: 'upsert' as const,
      entity: 'unit' as const,
      key: unit.id,
      data: unit,
    })),
    ...catalog.categories.map((category) => ({
      op: 'upsert' as const,
      entity: 'product_category' as const,
      key: category.id,
      data: syncCategorySchema.parse(category),
    })),
    ...sales.taxRates.map((rate) => ({
      op: 'upsert' as const,
      entity: 'tax_rate' as const,
      key: rate.id,
      data: rate,
    })),
    ...warehouses.map((warehouse) => ({
      op: 'upsert' as const,
      entity: 'warehouse' as const,
      key: warehouse.id,
      data: warehouse,
    })),
    ...sales.priceLists.map((list) => ({
      op: 'upsert' as const,
      entity: 'price_list' as const,
      key: list.id,
      data: list,
    })),
    ...sales.groups.map((group) => ({
      op: 'upsert' as const,
      entity: 'customer_group' as const,
      key: group.id,
      data: group,
    })),
    ...products.map((product) => ({
      op: 'upsert' as const,
      entity: 'product' as const,
      key: product.id,
      data: product,
    })),
    // A price of an active list, for an active product
    ...sales.priceItems
      .filter((item) => activeLists.has(item.priceListId) && activeProducts.has(item.productId))
      .map((item) => ({
        op: 'upsert' as const,
        entity: 'price_list_item' as const,
        key: priceListItemKey(item),
        data: item,
      })),
    ...sales.customers
      .filter((customer) => customer.archivedAt === null)
      .map((customer) => ({
        op: 'upsert' as const,
        entity: 'customer' as const,
        key: customer.id,
        data: customer,
      })),
    ...stockRows(data, warehouseIds, activeProducts).map((row) => ({
      op: 'upsert' as const,
      entity: 'stock' as const,
      key: stockKey(row),
      data: row,
    })),
  ];
}

function rowKey(change: SyncChange): string {
  return `${change.entity}|${change.key}`;
}

// The difference between what the device holds and what it should hold: the rows that are new or
// changed, then the keys of the rows that left (deleted, archived, moved to another branch, at zero)
function changesSince(before: Rows, upserts: readonly SyncUpsert[], rows: Rows): SyncChange[] {
  const changed = upserts.filter(
    (change) => before.get(rowKey(change))?.json !== rows.get(rowKey(change))?.json,
  );
  const gone = [...before]
    .filter(([id]) => !rows.has(id))
    .map(([, row]): SyncChange => ({ op: 'delete', entity: row.entity, key: row.key }));
  return [...changed, ...gone];
}

// --- The pull -----------------------------------------------------------------------------------

export function pull(
  data: WorkspaceData,
  tenantId: string,
  userId: string,
  query: { deviceId: string; protocol: number; cursor?: string | undefined; limit: number },
): SyncPull {
  // The protocol first, like the API: an old app is told to reload before anything else
  if (query.protocol !== SYNC_PROTOCOL) throw new MockProblem(409, 'sync_protocol_mismatch');
  const device = deviceFor(data, userId, query.deviceId);
  const { sync } = data;
  let paging = query.cursor === undefined ? undefined : sync.paging.get(query.cursor);
  if (query.cursor !== undefined) sync.paging.delete(query.cursor);
  if (!paging) {
    const upserts = rowsOf(data, tenantId, device.branchId);
    const rows: Rows = new Map(
      upserts.map((change) => [
        rowKey(change),
        { entity: change.entity, key: change.key, json: JSON.stringify(change.data) },
      ]),
    );
    const before = query.cursor === undefined ? undefined : sync.finished.get(query.cursor);
    // A device that moved to another branch starts again, like the API (its cursor holds the
    // branch): another branch's stock must not stay on it
    const delta = before?.deviceId === device.id && before.branchId === device.branchId;
    paging = {
      deviceId: device.id,
      changes: delta ? changesSince(before.rows, upserts, rows) : upserts,
      full: !delta,
      finished: { deviceId: device.id, branchId: device.branchId, rows },
    };
  }
  const page = paging.changes.slice(0, query.limit);
  const rest = paging.changes.slice(query.limit);
  const serverTime = now();
  const cursor = crypto.randomUUID();
  if (rest.length > 0) {
    sync.paging.set(cursor, { ...paging, changes: rest });
  } else {
    // The newest finished pull of this device is the only one kept: an older cursor would only
    // come back from a lost answer, and a full pull is the right answer to that
    for (const [key, finished] of sync.finished) {
      if (finished.deviceId === device.id) sync.finished.delete(key);
    }
    sync.finished.set(cursor, paging.finished);
    // Only the last page sets it, like the API: a pull that stops halfway has not synced
    device.lastSyncAt = serverTime;
  }
  return { changes: page, cursor, hasMore: rest.length > 0, full: paging.full, serverTime };
}
