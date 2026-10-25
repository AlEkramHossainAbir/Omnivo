import { Inject, Injectable } from '@nestjs/common';
import {
  SYNC_ENTITIES,
  SYNC_PROTOCOL,
  type SyncChange,
  type SyncEntity,
  type SyncPull,
  type syncPullQuerySchema,
} from '@omnivo/contracts';
import { syncChanges, warehouses } from '@omnivo/db';
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { DevicesService } from './devices.service.js';
import {
  type DeltaCursor,
  decodeSyncCursor,
  encodeSyncCursor,
  type FullCursor,
  type SyncCursor,
} from './sync-cursor.js';
import { SYNC_LOG_DAYS } from './sync-log-cleanup.js';
import { LOADERS, type SyncScope } from './sync-rows.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// A cursor older than this gets a full pull (decision 26): one day less than the log keeps
const CURSOR_MAX_AGE_MS = (SYNC_LOG_DAYS - 1) * DAY_MS;

// The database's view of "now", read in one statement:
//   xmin  the oldest transaction still running (pg_snapshot_xmin). Every transaction below it has
//         ended, so its lines are all in the log and will never change. The watermark (decision 25).
//   now   the database's clock, as ISO text: the page's serverTime and the cursor's issuedAt
const clockSchema = z.object({ xmin: z.string(), now: z.iso.datetime() });

interface Page {
  changes: SyncChange[];
  cursor: SyncCursor;
  hasMore: boolean;
  // Part of a full pull (the contract's `full`): the device drops what it did not get by the end
  full: boolean;
}

@Injectable()
export class SyncService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly devices: DevicesService,
  ) {}

  async pull(query: z.output<typeof syncPullQuerySchema>): Promise<SyncPull> {
    // First, before the device: an app built for another protocol must reload whatever else is
    // wrong (decision 18)
    if (query.protocol !== SYNC_PROTOCOL) {
      throw new AppError(409, 'sync_protocol_mismatch', 'Reload the app to sync again.');
    }
    const cursor = decodeSyncCursor(query.cursor);
    // One transaction per page, READ COMMITTED like every request. It writes nothing until the
    // last page's last_sync_at, so it has no transaction id of its own while it reads: it never
    // holds back its own watermark, or anyone else's.
    return this.withTenant(async (tx) => {
      const device = await this.devices.forSync(tx, query.deviceId);
      const clock = await readClock(tx);
      const scope = await this.scopeOf(tx, device.branchId);

      const page =
        cursor === undefined || this.restartsFull(cursor, device.branchId, clock.now)
          ? await fullPage(tx, scope, startFull(device.branchId, clock), query.limit)
          : cursor.kind === 'full'
            ? await fullPage(tx, scope, cursor, query.limit)
            : await deltaPage(tx, scope, cursor, clock, query.limit);

      // The device finished a pull: by the database's clock (decision 19), and without touching
      // version or updated_at (decision 32), so a raw statement: Drizzle's update() would set
      // updated_at through $onUpdate. Step 18c: with the sign-in it pulled with (decision 13),
      // here and not on the first page, so the pages before still write nothing. The CASE: a
      // revoke that committed while this waited keeps its session_id (migration 0048 refuses a
      // change); its last_sync_at may still move.
      if (!page.hasMore) {
        await tx.execute(
          sql`UPDATE devices SET last_sync_at = now(),
                     session_id = CASE WHEN revoked_at IS NULL
                                       THEN ${currentPrincipal().sessionId}::uuid
                                       ELSE session_id END
               WHERE tenant_id = ${getTenantId()}::uuid AND id = ${device.id}::uuid`,
        );
      }
      return {
        changes: page.changes,
        cursor: encodeSyncCursor(page.cursor),
        hasMore: page.hasMore,
        full: page.full,
        serverTime: clock.now,
      };
    });
  }

  // A full pull starts when the device has no cursor, and when its cursor no longer fits: made
  // for another protocol, for another branch (the device moved), or older than the log keeps.
  // Only a cursor between pulls is checked for age (`to` null): a pull in progress reads lines
  // its first page already found in the log.
  private restartsFull(cursor: SyncCursor, branchId: string, now: string): boolean {
    if (cursor.protocol !== SYNC_PROTOCOL || cursor.branchId !== branchId) return true;
    return (
      cursor.kind === 'delta' &&
      cursor.to === null &&
      Date.parse(now) - Date.parse(cursor.issuedAt) > CURSOR_MAX_AGE_MS
    );
  }

  // The device's branch's warehouses. The active ones are what it keeps; all of them, archived
  // too, filter the stock lines of the log (18a.2's facts): a stock row that reaches zero in a
  // warehouse archived right after must still reach the device as a delete.
  private async scopeOf(
    tx: Transaction,
    branchId: string,
  ): Promise<SyncScope & { allWarehouseIds: string[] }> {
    const tenantId = getTenantId();
    const rows = await tx
      .select({ id: warehouses.id, archivedAt: warehouses.archivedAt })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.branchId, branchId)));
    return {
      tenantId,
      branchId,
      warehouseIds: rows.filter((row) => row.archivedAt === null).map((row) => row.id),
      allWarehouseIds: rows.map((row) => row.id),
    };
  }
}

async function readClock(tx: Transaction): Promise<z.infer<typeof clockSchema>> {
  const [clock] = z.array(clockSchema).parse(
    await tx.execute(sql`
      SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin,
             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`),
  );
  if (!clock) throw new Error('The clock query returned no row');
  return clock;
}

function startFull(branchId: string, clock: z.infer<typeof clockSchema>): FullCursor {
  return {
    kind: 'full',
    protocol: SYNC_PROTOCOL,
    branchId,
    issuedAt: clock.now,
    watermark: clock.xmin,
    entity: 0,
    after: null,
  };
}

// One page of a full pull: entity after entity in SYNC_ENTITIES order, as many rows as fit. Each
// loader is asked for one row more than fits, so a page knows whether anything is left without
// counting. When the last entity is done, the cursor turns into a delta cursor from the
// watermark taken when the full pull started: the changes made while it ran come next.
async function fullPage(
  tx: Transaction,
  scope: SyncScope,
  cursor: FullCursor,
  limit: number,
): Promise<Page> {
  const changes: SyncChange[] = [];
  let remaining = limit;
  let { entity, after } = cursor;
  for (let name = SYNC_ENTITIES[entity]; name !== undefined; name = SYNC_ENTITIES[entity]) {
    const rows = await LOADERS[name](tx, scope, { by: 'page', after, limit: remaining + 1 });
    const taken = rows.slice(0, remaining);
    changes.push(...taken.map((row) => row.change));
    if (rows.length > remaining) {
      // More of this entity. With nothing taken (the page was already full), `after` stays.
      after = taken.at(-1)?.sort ?? after;
      return { changes, cursor: { ...cursor, entity, after }, hasMore: true, full: true };
    }
    remaining -= rows.length;
    entity += 1;
    after = null;
  }
  const next: DeltaCursor = {
    kind: 'delta',
    protocol: cursor.protocol,
    branchId: cursor.branchId,
    issuedAt: cursor.issuedAt,
    from: cursor.watermark,
    to: null,
    after: null,
  };
  return { changes, cursor: next, hasMore: false, full: true };
}

// One page of a delta pull: the log's lines between the cursor's watermarks, each key sent once
// in its current state, or as a delete when its row is gone or out of the device's scope.
async function deltaPage(
  tx: Transaction,
  scope: SyncScope & { allWarehouseIds: string[] },
  cursor: DeltaCursor,
  clock: z.infer<typeof clockSchema>,
  limit: number,
): Promise<Page> {
  // The first page of a pull fixes where it stops: the oldest transaction running now. xmin never
  // goes back, but a cursor is the client's: `to` is never below `from`.
  const to = cursor.to ?? (BigInt(clock.xmin) < BigInt(cursor.from) ? cursor.from : clock.xmin);
  const issuedAt = cursor.to === null ? clock.now : cursor.issuedAt;

  const conditions: (SQL | undefined)[] = [
    eq(syncChanges.tenantId, scope.tenantId),
    sql`${syncChanges.xid} >= ${cursor.from}::xid8`,
    sql`${syncChanges.xid} < ${to}::xid8`,
    cursor.after === null
      ? undefined
      : sql`(${syncChanges.xid}, ${syncChanges.id}) > (${cursor.after[0]}::xid8, ${cursor.after[1]}::bigint)`,
    // An entity a later protocol dropped stays in old lines; this server does not send it
    inArray(syncChanges.entity, [...SYNC_ENTITIES]),
    // The other branches' stock is skipped here, without reading it (decision 30)
    scope.allWarehouseIds.length === 0
      ? isNull(syncChanges.warehouseId)
      : or(
          isNull(syncChanges.warehouseId),
          inArray(syncChanges.warehouseId, scope.allWarehouseIds),
        ),
  ];
  // sync_changes_tenant_xid_idx serves the filter and the order. One line more than fits says
  // whether more are left.
  const lines = await tx
    .select({
      id: syncChanges.id,
      entity: syncChanges.entity,
      key: syncChanges.entityKey,
      xid: syncChanges.xid,
    })
    .from(syncChanges)
    .where(and(...conditions))
    .orderBy(asc(syncChanges.xid), asc(syncChanges.id))
    .limit(limit + 1);
  const served = lines.slice(0, limit);

  // A key is in the log once per statement that wrote it; the page sends it once (the contract)
  const keysOf = new Map<SyncEntity, Set<string>>();
  for (const line of served) {
    const keys = keysOf.get(line.entity) ?? new Set<string>();
    keys.add(line.key);
    keysOf.set(line.entity, keys);
  }
  // In SYNC_ENTITIES order, like a full pull: the lists a product points at come before it
  const changes: SyncChange[] = [];
  for (const entity of SYNC_ENTITIES) {
    const keys = keysOf.get(entity);
    if (!keys) continue;
    const rows = await LOADERS[entity](tx, scope, { by: 'keys', keys: [...keys] });
    for (const row of rows) {
      changes.push(row.change);
      keys.delete(row.change.key);
    }
    // What is left was named by the log but is not there to send: deleted, or out of scope
    for (const key of keys) changes.push({ op: 'delete', entity, key });
  }

  const last = served.at(-1);
  if (lines.length > limit && last !== undefined) {
    return {
      changes,
      cursor: { ...cursor, to, issuedAt, after: [last.xid, last.id] },
      hasMore: true,
      full: false,
    };
  }
  return {
    changes,
    cursor: { ...cursor, from: to, to: null, issuedAt, after: null },
    hasMore: false,
    full: false,
  };
}
