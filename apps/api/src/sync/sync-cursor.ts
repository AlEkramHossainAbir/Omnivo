import { SYNC_ENTITIES } from '@omnivo/contracts';
import { z } from 'zod';

import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';

// The pull's cursor (decision 13). The contract calls it opaque: the device only stores it and
// sends it back, so what is inside can change without a new protocol. It is JSON in base64url,
// like the lists' cursors, and checked with these schemas when it comes back: a broken or edited
// cursor answers invalid_cursor (400), never a Postgres cast error (500).

// A transaction id (xid8) as text. It can pass 2^53, so it is never a JavaScript number; only the
// database compares two of them.
const xidSchema = z.string().regex(/^\d{1,20}$/);

const common = {
  // SYNC_PROTOCOL when the cursor was made. A cursor of another protocol starts a full pull.
  protocol: z.number().int(),
  // The device's branch when the cursor was made. A device moved to another branch (step 18c)
  // needs other warehouses and stock, so its next pull is a full one.
  branchId: z.uuid(),
  // When the watermark this cursor reads from was taken, by the database's clock. The change log
  // keeps 30 days; a cursor older than that may need lines that are gone (decision 26).
  issuedAt: z.iso.datetime(),
};

// A full pull in progress: every row the device keeps, entity by entity in SYNC_ENTITIES order,
// each in the order of its key columns.
const fullCursorSchema = z.object({
  kind: z.literal('full'),
  ...common,
  // The oldest transaction still running when the full pull started. Everything that committed
  // before it is in the pages; everything from it on comes with the next pull, from the change
  // log. That is why rows read later in the full pull may be newer: never older.
  watermark: xidSchema,
  // The next page starts in SYNC_ENTITIES[entity], after the row whose key columns are `after`
  // (null = at its first row). A stock row's batch may be null.
  entity: z.number().int().min(0).max(SYNC_ENTITIES.length),
  after: z.array(z.uuid().nullable()).min(1).max(3).nullable(),
});
export type FullCursor = z.infer<typeof fullCursorSchema>;

// Changes from the log: the lines of the transactions with `from` <= xid < `to`.
const deltaCursorSchema = z.object({
  kind: z.literal('delta'),
  ...common,
  from: xidSchema,
  // null: the next pull starts here, and its first page takes a new `to`. Set: a pull in
  // progress, which reads up to this `to` until it is done, after the line `after` (its xid and
  // id). Without a fixed `to`, a busy workspace could keep `hasMore` true for ever.
  to: xidSchema.nullable(),
  after: z.tuple([xidSchema, z.number().int()]).nullable(),
});
export type DeltaCursor = z.infer<typeof deltaCursorSchema>;

const syncCursorSchema = z.discriminatedUnion('kind', [fullCursorSchema, deltaCursorSchema]);
export type SyncCursor = z.infer<typeof syncCursorSchema>;

// encodeCursor takes the values of a list's sort columns; this cursor is one object, so it is the
// one value of that list
export function encodeSyncCursor(cursor: SyncCursor): string {
  return encodeCursor([cursor]);
}

export function decodeSyncCursor(cursor: string | undefined): SyncCursor | undefined {
  return decodeCursor(cursor, z.tuple([syncCursorSchema]))?.[0];
}
