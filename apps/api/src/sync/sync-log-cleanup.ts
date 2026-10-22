import { Inject, Injectable } from '@nestjs/common';
import { type Db, syncChanges, syncCommands } from '@omnivo/db';
import { lt, sql } from 'drizzle-orm';

import { RELAY_DB } from '../infra/tokens.js';

// How long the change log keeps a line (decision 26), and since step 18b how long the push keeps
// the answer to a command (18b's decision 25). The pull gives a cursor older than one day
// less than this a full pull instead (SyncService): its lines may already be gone, and one day
// covers a transaction that ran long and wrote its line before the cursor's watermark was taken.
export const SYNC_LOG_DAYS = 30;

// The worker's half of the change log: the hourly job deletes the lines older than SYNC_LOG_DAYS
// of every tenant in one statement. It runs as omnivo_worker (RELAY_DB, migration 0044's
// sync_prune policy), like the outbox's cleanup: the API's role may not delete a line at all.
// Provided by WorkerModule only; the HTTP process never has it.
@Injectable()
export class SyncLogCleanup {
  constructor(@Inject(RELAY_DB) private readonly db: Db) {}

  // sync_changes_created_idx finds the old lines. An hour's worth each time, so one statement
  // is small enough; no batching.
  async deleteOld(): Promise<number> {
    const result = await this.db
      .delete(syncChanges)
      .where(lt(syncChanges.createdAt, sql`now() - make_interval(days => ${SYNC_LOG_DAYS})`));
    // postgres-js gives the number of rows deleted; RETURNING them would bring every id back
    return result.count;
  }

  // Step 18b: the answers to pushed commands, the same way (sync_commands_created_idx, migration
  // 0046's sync_prune policy). A device sends a command again minutes after a lost answer, not a
  // month later.
  async deleteOldAnswers(): Promise<number> {
    const result = await this.db
      .delete(syncCommands)
      .where(lt(syncCommands.createdAt, sql`now() - make_interval(days => ${SYNC_LOG_DAYS})`));
    return result.count;
  }
}
