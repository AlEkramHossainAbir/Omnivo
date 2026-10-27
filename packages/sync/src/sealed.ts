import type { SyncCommand } from '@omnivo/contracts';

import type { LocalCopy } from './copy.js';
import type { NoticeRow, OutboxEntry, OutboxRow, SealedRow, SyncNoticeRecord } from './database.js';

// Step 19b: rows to and from their sealed form. Type imports only (the copy is a parameter), so the
// forms and pages that save or read the outbox still load no Dexie (see index.ts).

const encoder = new TextEncoder();

// A push stops at MAX_PUSH_BYTES of commands (push.ts). The size is counted when the command is
// saved and kept clear on its row, so a batch is picked without opening every command.
export function commandBytes(command: SyncCommand): number {
  return encoder.encode(JSON.stringify(command)).length;
}

// Every value of a small table, opened. The table's name is in the label each row was sealed
// under (apply.ts), so a row moved to another table does not open.
export function openRows<T>(
  copy: LocalCopy,
  table: string,
  rows: readonly SealedRow<T>[],
): Promise<T[]> {
  return Promise.all(rows.map((row) => copy.open(table, row.key, row.box)));
}

// Sealed under the command's id, not the seq: a new entry has no seq until Dexie adds it. The
// command's id is unique, and changes whenever the command is rewritten (outbox.ts).
export async function sealEntry(copy: LocalCopy, entry: OutboxEntry): Promise<OutboxRow> {
  const { seq, command, status, sent, customerId, key, error, base, name, lines, total, savedAt } =
    entry;
  return {
    // exactOptionalPropertyTypes: a missing seq must be left out, not set to undefined
    ...(seq !== undefined && { seq }),
    commandId: command.id,
    type: command.type,
    status,
    sent,
    customerId,
    key,
    bytes: commandBytes(command),
    box: await copy.seal('outbox', command.id, {
      command,
      error,
      base,
      name,
      lines,
      total,
      savedAt,
    }),
  };
}

export async function openEntry(copy: LocalCopy, row: OutboxRow): Promise<OutboxEntry> {
  const body = await copy.open('outbox', row.commandId, row.box);
  return {
    ...(row.seq !== undefined && { seq: row.seq }),
    status: row.status,
    sent: row.sent,
    customerId: row.customerId,
    key: row.key,
    ...body,
  };
}

export function openEntries(copy: LocalCopy, rows: readonly OutboxRow[]): Promise<OutboxEntry[]> {
  return Promise.all(rows.map((row) => openEntry(copy, row)));
}

export async function sealNotice(copy: LocalCopy, notice: SyncNoticeRecord): Promise<NoticeRow> {
  return {
    commandId: notice.commandId,
    box: await copy.seal('notices', notice.commandId, notice),
  };
}

export function openNotices(
  copy: LocalCopy,
  rows: readonly NoticeRow[],
): Promise<SyncNoticeRecord[]> {
  return Promise.all(rows.map((row) => copy.open('notices', row.commandId, row.box)));
}

// The outbox and the notices that version 3 moved aside (database.ts), sealed back into their
// tables with the same seq: the order of the person's work stays. Sealed first, then one
// transaction. Two tabs may open the copy at once: the transaction moves only the rows still
// waiting, so the second tab writes nothing the first already moved.
export async function sealLegacy(copy: LocalCopy): Promise<void> {
  const { db } = copy;
  const [entries, notices] = await Promise.all([
    db.legacyOutbox.toArray(),
    db.legacyNotices.toArray(),
  ]);
  if (entries.length === 0 && notices.length === 0) return;
  const rows = await Promise.all(entries.map((entry) => sealEntry(copy, entry)));
  const noticeRows = await Promise.all(notices.map((notice) => sealNotice(copy, notice)));
  await db.transaction(
    'rw',
    [db.outbox, db.notices, db.legacyOutbox, db.legacyNotices],
    async () => {
      const seqs = new Set(await db.legacyOutbox.toCollection().primaryKeys());
      const ids = new Set(await db.legacyNotices.toCollection().primaryKeys());
      const moving = rows.filter((row) => row.seq !== undefined && seqs.has(row.seq));
      const movingNotices = noticeRows.filter((row) => ids.has(row.commandId));
      await db.outbox.bulkPut(moving);
      await db.notices.bulkPut(movingNotices);
      await db.legacyOutbox.bulkDelete(moving.flatMap((row) => row.seq ?? []));
      await db.legacyNotices.bulkDelete(movingNotices.map((row) => row.commandId));
    },
  );
}
