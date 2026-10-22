import {
  MAX_PUSH_BYTES,
  MAX_PUSH_COMMANDS,
  type SyncPush,
  type SyncResult,
} from '@omnivo/contracts';

import { writeChanges } from './apply.js';
import type { OutboxEntry, SyncDatabase } from './database.js';
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

const encoder = new TextEncoder();

// The commands to send now, oldest first (decision 13). A command waits while an earlier command
// on the same customer is still on the device: refused (it needs the person), or in this batch
// (it needs its answer first). So the order for a new customer goes in the push after the
// customer's, and two changes to one customer arrive in the order they were made. Commands on
// other customers go on. The batch stops at 50 commands or 512 KB of JSON; the first command
// always goes, so a big order is never stuck.
export function pickBatch(entries: readonly OutboxEntry[]): OutboxEntry[] {
  const held = new Set<string>();
  const batch: OutboxEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (batch.length === MAX_PUSH_COMMANDS) break;
    const free = entry.status === 'waiting' && !held.has(entry.customerId);
    held.add(entry.customerId);
    if (!free) continue;
    const size = encoder.encode(JSON.stringify(entry.command)).length;
    if (batch.length > 0 && bytes + size > MAX_PUSH_BYTES) break;
    bytes += size;
    batch.push(entry);
  }
  return batch;
}

// Takes the next batch and marks it as being sent, in one transaction: a form that opens one of
// these commands now sees that it cannot rewrite it (outbox.ts → isOpen). `sent` stays true from
// here on: the server may run it even if its answer never comes.
export async function takeBatch(db: SyncDatabase): Promise<OutboxEntry[]> {
  return db.transaction('rw', db.outbox, async () => {
    const batch = pickBatch(await db.outbox.toArray());
    const sending = batch.map((entry) => ({ ...entry, status: 'sending' as const, sent: true }));
    await db.outbox.bulkPut(sending);
    return sending;
  });
}

// The push failed as a whole (no connection, a server error): its commands wait for the next
// sync. They stay `sent`, so they go again as they are.
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

// The answers, in one transaction with the rows they bring: an accepted command leaves the outbox
// in the same moment its customer is written, so a list never shows it twice or not at all. A
// refused one stays, with its error, until the person fixes or discards it (decision 7).
export async function applyAnswers(
  db: SyncDatabase,
  batch: readonly OutboxEntry[],
  answer: SyncPush,
): Promise<PushOutcome> {
  const results = new Map<string, SyncResult>(answer.results.map((result) => [result.id, result]));
  return db.transaction('rw', [...db.syncTables(), db.meta, db.outbox, db.notices], async () => {
    const { generation } = await readPullState(db);
    const outcome = { ...NO_PUSH };
    for (const entry of batch) {
      if (entry.seq === undefined) continue;
      const result = results.get(entry.command.id);
      if (!result) {
        // Not answered: the server stopped part way (it never does; the contract answers every
        // command). It is sent again.
        await db.outbox.update(entry.seq, { status: 'waiting' });
        continue;
      }
      if (result.status === 'rejected') {
        outcome.rejected += 1;
        await db.outbox.update(entry.seq, { status: 'failed', error: result.error });
        continue;
      }
      outcome.accepted += 1;
      // The rows as they are on the server now, at the generation of the running pull: a full
      // pull that is half way keeps them (apply.ts)
      await writeChanges(db, result.changes, generation);
      await db.outbox.delete(entry.seq);
      const kept = result.notices.filter((notice) => notice.code === 'kept_server_value');
      if (kept.length > 0) {
        outcome.kept += 1;
        await db.notices.put({
          commandId: entry.command.id,
          customerId: entry.customerId,
          name: entry.name,
          fields: kept.flatMap((notice) => notice.fields),
          at: answer.serverTime,
        });
      }
    }
    return outcome;
  });
}
