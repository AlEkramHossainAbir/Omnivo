import { setTimeout as sleep } from 'node:timers/promises';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type Db, outboxEvents } from '@omnivo/db';
import { asc, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { WorkerConfig } from '../config.js';
import { CONFIG, RELAY_DB } from '../infra/tokens.js';
import { Queues } from './queues.js';

// Waits, but wakes up at once when the worker shuts down
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    // aborted: the worker is stopping
  }
}

// Rejects after ms, unless the signal says the race is already over
function timeLimit(ms: number, signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Redis did not take the jobs within ${String(ms)} ms`));
    }, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
    });
  });
}

// Moves committed outbox rows onto the queue. It is the only code that reads the outbox, and it
// uses its own database role (omnivo_worker) because it must see the rows of every tenant.
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly stopping = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(RELAY_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly queues: Queues,
  ) {}

  onApplicationBootstrap(): void {
    // Not awaited: the loop runs for the life of the process. Nest's bootstrap would never finish.
    this.loop = this.run();
  }

  // Before the queues and the database close: let the current batch finish, then stop
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { batchSize, idleMs } = this.config.relay;
    while (!this.stopping.signal.aborted) {
      let published = 0;
      try {
        published = await this.publishBatch();
      } catch (error) {
        // Redis or Postgres is down. The rows stay unpublished (the transaction rolled back), so
        // nothing is lost: the next round takes the same rows again.
        this.logger.warn(`publishing outbox events failed: ${String(error)}`);
      }
      // A full batch means more rows are probably waiting: go again at once. Otherwise sleep.
      if (published < batchSize) await pause(idleMs, this.stopping.signal);
    }
  }

  // One round: claim, publish, mark — all in one transaction. Public for the tests.
  async publishBatch(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt))
        // Oldest first: a resend is published after the invitation it resends
        .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
        .limit(this.config.relay.batchSize)
        // FOR UPDATE: another relay (a second worker process) cannot take the same rows.
        // SKIP LOCKED: it does not wait for them either — it takes the next unlocked rows. So any
        // number of workers can run the relay side by side without publishing a row twice.
        .for('update', { skipLocked: true });
      if (rows.length === 0) return 0;

      // Redis first, then the mark. If the mark fails after Redis took the jobs, the rows are
      // published again next round — and the queue ignores them, because the job id is the row id.
      // The other order could lose an event: marked as published, but never on the queue.
      // With a time limit: while Redis is unreachable BullMQ waits for it indefinitely, and this
      // transaction would hold its row locks all that time. Giving up rolls back and frees them.
      // If Redis takes the jobs after we gave up, nothing breaks: the rows are still unpublished,
      // the next round adds them again, and BullMQ ignores the repeats (same job ids).
      const done = new AbortController();
      try {
        await Promise.race([
          this.queues.publish(rows),
          timeLimit(this.config.relay.publishTimeoutMs, done.signal),
        ]);
      } finally {
        done.abort();
      }
      await tx
        .update(outboxEvents)
        .set({ publishedAt: sql`now()` })
        .where(
          inArray(
            outboxEvents.id,
            rows.map((row) => row.id),
          ),
        );
      return rows.length;
    });
  }

  // The hourly job: published rows older than the retention period go. Unpublished rows are never
  // deleted, however old — they are work that has not been done yet.
  async deletePublished(): Promise<number> {
    const rows = await this.db
      .delete(outboxEvents)
      .where(
        lt(
          outboxEvents.publishedAt,
          sql`now() - make_interval(days => ${this.config.outboxRetentionDays})`,
        ),
      )
      .returning({ id: outboxEvents.id });
    return rows.length;
  }
}
