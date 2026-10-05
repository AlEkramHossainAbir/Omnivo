import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { OUTBOX_EVENT_TYPES, type OutboxEventType, type outboxEvents } from '@omnivo/db';
import { Queue } from 'bullmq';
import { z } from 'zod';

import type { WorkerConfig } from '../config.js';
import { CONFIG } from '../infra/tokens.js';

export const QUEUE_NAMES = ['email', 'jobs'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

// Two queues, so a slow or broken mail server never holds up workspace setup. Each queue gets its
// own workers, and the email queue can get a rate limit later (a mail provider allows N per second).
// satisfies: a new event type without a queue does not compile.
const QUEUE_OF = {
  'workspace.created': 'email',
  'invitation.issued': 'email',
  'workspace.setup_requested': 'jobs',
  'member.joined': 'jobs',
  'workspace.chart_requested': 'jobs',
  'report.export_requested': 'jobs',
  'workspace.catalog_requested': 'jobs',
  'product.import_requested': 'jobs',
  'stock.below_reorder': 'jobs',
} satisfies Record<OutboxEventType, QueueName>;

// The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
export const OUTBOX_CLEANUP = 'outbox.cleanup';

// What a job carries: the outbox row minus its bookkeeping. The job name is the event type.
// Redis is data from outside this process, so the worker checks this shape before using it.
export const eventJobDataSchema = z.object({
  eventId: z.uuid(),
  tenantId: z.uuid(),
  payload: z.unknown(),
  requestId: z.string().nullable(),
});
export type EventJobData = z.infer<typeof eventJobDataSchema>;

export function isOutboxEventType(value: string): value is OutboxEventType {
  return OUTBOX_EVENT_TYPES.some((type) => type === value);
}

type OutboxRow = typeof outboxEvents.$inferSelect;

const HOUR_MS = 60 * 60 * 1000;
const DAY_S = 24 * 60 * 60;

@Injectable()
export class Queues implements OnApplicationShutdown {
  private readonly logger = new Logger(Queues.name);
  private readonly queues: Record<QueueName, Queue>;

  constructor(@Inject(CONFIG) private readonly config: WorkerConfig) {
    // enableOfflineQueue: false — commands are not parked in memory while Redis is away. That alone
    // does not make add() fail fast (BullMQ first waits for the connection), so the relay also
    // puts a time limit on each publish (outbox-relay.ts).
    const connection = { url: config.redisUrl, enableOfflineQueue: false };
    this.queues = {
      email: new Queue('email', { connection }),
      jobs: new Queue('jobs', { connection }),
    };
    // As in job-runner.ts: without a listener, every failed reconnect is an "unhandled error"
    // printed by ioredis. The relay already reports the failures that matter.
    for (const name of QUEUE_NAMES) {
      this.queues[name].on('error', (error) => {
        this.logger.warn(`queue ${name}: ${error.message}`);
      });
    }
  }

  async publish(rows: readonly OutboxRow[]): Promise<void> {
    for (const name of QUEUE_NAMES) {
      const jobs = rows
        .filter((row) => QUEUE_OF[row.type] === name)
        .map((row) => ({
          name: row.type,
          data: {
            eventId: row.id,
            tenantId: row.tenantId,
            payload: row.payload,
            requestId: row.requestId,
          } satisfies EventJobData,
          opts: {
            // The outbox id as the job id: BullMQ ignores an add() whose id already exists. If the
            // relay publishes a row twice (it pushed to Redis, then crashed before marking the row),
            // the second add is a no-op while the first job is still kept.
            jobId: row.id,
            attempts: this.config.retry.attempts,
            backoff: { type: 'exponential', delay: this.config.retry.backoffMs },
            // Keep finished jobs for a day and failed ones for a week (ages in seconds), so they
            // can be inspected; after that Redis would only fill up with them
            removeOnComplete: { age: DAY_S },
            removeOnFail: { age: 7 * DAY_S },
          },
        }));
      // One round trip per queue for the whole batch
      if (jobs.length > 0) await this.queues[name].addBulk(jobs);
    }
  }

  // upsert: every worker process calls this on start. With the same id there is still exactly one
  // schedule, however many workers run or restart.
  async scheduleCleanup(): Promise<void> {
    await this.queues.jobs.upsertJobScheduler(
      'outbox-cleanup',
      { every: HOUR_MS },
      { name: OUTBOX_CLEANUP },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(QUEUE_NAMES.map((name) => this.queues[name].close()));
  }
}
