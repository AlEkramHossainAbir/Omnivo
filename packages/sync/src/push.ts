import {
  MAX_PUSH_BYTES,
  MAX_PUSH_COMMANDS,
  type SyncPush,
  type SyncResult,
} from '@omnivo/contracts';

import { type SealedChanges, sealChanges, writeSealed } from './apply.js';
import type { LocalCopy } from './copy.js';
import type { NoticeRow, OutboxEntry, OutboxRow, SyncDatabase } from './database.js';
import { openEntries, sealEntry, sealNotice } from './sealed.js';
import { readPullState } from './state.js';

// The two halves of one push round (step 18b): which commands go now, and what their answers
// change on the device. The engine sends the request between them.

// What a push did, for the app's toasts
export interface PushOutcome {
  accepted: number;
  rejected: number;
  // Accepted, but the server kept some head-office fields (kept_server_value)
  kept: number;
}

export const NO_PUSH: PushOutcome = { accepted: 0, rejected: 0, kept: 0 };

// The commands to send now, oldest first (decision 13). A command waits while an earlier command
// on the same customer is still on the device: refused (it needs the person), or in this batch
// (it needs its answer first). So the order for a new customer goes in the push after the
// customer's, and two changes to one customer arrive in the order they were made. Commands on
// other customers go on. The batch stops at 50 commands or 512 KB of JSON; the first command
// always goes, so a big order is never stuck. Step 19b: from the rows' clear fields only (the
// command's size is counted when it is saved), so it runs inside takeBatch's transaction.
export function pickBatch(rows: readonly OutboxRow[]): OutboxRow[] {
  const held = new Set<string>();
  const batch: OutboxRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (batch.length === MAX_PUSH_COMMANDS) break;
    const free = row.status === 'waiting' && !held.has(row.customerId);
    held.add(row.customerId);
    if (!free) continue;
    if (batch.length > 0 && bytes + row.bytes > MAX_PUSH_BYTES) break;
    bytes += row.bytes;
    batch.push(row);
  }
  return batch;
}

// Takes the next batch and marks it as being sent, in one transaction: a form that opens one of
// these commands now sees that it cannot rewrite it (outbox.ts → isOpen). `sent` stays true from
// here on: the server may run it even if its answer never comes. The batch is opened after the
// transaction (the commands are what the push sends); status and sent are clear, so marking it
// needs no key.
export async function takeBatch(copy: LocalCopy): Promise<OutboxEntry[]> {
  const { db } = copy;
  const rows = await db.transaction('rw', db.outbox, async () => {
    const batch = pickBatch(await db.outbox.toArray());
    const sending = batch.map((row) => ({ ...row, status: 'sending' as const, sent: true }));
    await db.outbox.bulkPut(sending);
    return sending;
  });
  return openEntries(copy, rows);
}

// The push failed as a whole (no connection, a server error): its commands wait for the next
// sync. They stay `sent`, so they go again as they are. Clear fields only: no key needed.
export async function releaseBatch(db: SyncDatabase, batch: readonly OutboxEntry[]): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    for (const entry of batch) {
      if (entry.seq !== undefined) await db.outbox.update(entry.seq, { status: 'waiting' });
    }
  });
}

// A tab closed in the middle of a push left its commands 'sending'. Called inside the sync lock,
// when no other tab pushes: whatever says 'sending' now is not being sent.
export async function resetSending(db: SyncDatabase): Promise<void> {
  await db.outbox.filter((entry) => entry.status === 'sending').modify({ status: 'waiting' });
}

// What one answer changes, sealed before the transaction (a transaction cannot wait for Web
// Crypto). A command being sent cannot change meanwhile: no form rewrites it (isOpen) and Discard
// leaves it alone, so the row sealed here is still right when the transaction writes it.
type Planned =
  | { kind: 'unanswered'; seq: number }
  | { kind: 'rejected'; row: OutboxRow }
  | { kind: 'accepted'; seq: number; changes: SealedChanges; notice: NoticeRow | null };

async function plan(
  copy: LocalCopy,
  entry: OutboxEntry & { seq: number },
  result: SyncResult | undefined,
  serverTime: string,
): Promise<Planned> {
  // Not answered: the server stopped part way (it never does; the contract answers every
  // command). It is sent again.
  if (!result) return { kind: 'unanswered', seq: entry.seq };
  if (result.status === 'rejected') {
    return {
      kind: 'rejected',
      row: await sealEntry(copy, { ...entry, status: 'failed', error: result.error }),
    };
  }
  const kept = result.notices.filter((notice) => notice.code === 'kept_server_value');
  return {
    kind: 'accepted',
    seq: entry.seq,
    changes: await sealChanges(copy, result.changes),
    notice:
      kept.length === 0
        ? null
        : await sealNotice(copy, {
            commandId: entry.command.id,
            customerId: entry.customerId,
            name: entry.name,
            fields: kept.flatMap((notice) => notice.fields),
            at: serverTime,
          }),
  };
}

// The answers, in one transaction with the rows they bring: an accepted command leaves the outbox
// in the same moment its customer is written, so a list never shows it twice or not at all. A
// refused one stays, with its error, until the person fixes or discards it (decision 7).
export async function applyAnswers(
  copy: LocalCopy,
  batch: readonly OutboxEntry[],
  answer: SyncPush,
): Promise<PushOutcome> {
  const { db } = copy;
  const results = new Map<string, SyncResult>(answer.results.map((result) => [result.id, result]));
  const planned = await Promise.all(
    batch.flatMap((entry) =>
      entry.seq === undefined
        ? []
        : [
            plan(
              copy,
              { ...entry, seq: entry.seq },
              results.get(entry.command.id),
              answer.serverTime,
            ),
          ],
    ),
  );
  const tables = [...db.syncTables(), db.meta, db.marks, db.outbox, db.notices];
  return db.transaction('rw', tables, async () => {
    const { generation } = await readPullState(db);
    const outcome = { ...NO_PUSH };
    for (const item of planned) {
      if (item.kind === 'unanswered') {
        await db.outbox.update(item.seq, { status: 'waiting' });
        continue;
      }
      if (item.kind === 'rejected') {
        outcome.rejected += 1;
        await db.outbox.put(item.row);
        continue;
      }
      outcome.accepted += 1;
      // The rows as they are on the server now, at the generation of the running pull: a full
      // pull that is half way keeps them (apply.ts)
      await writeSealed(db, item.changes, generation);
      await db.outbox.delete(item.seq);
      if (item.notice) {
        outcome.kept += 1;
        await db.notices.put(item.notice);
      }
    }
    return outcome;
  });
}
