import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { OUTBOX_EVENT_TYPES, type OutboxEventType, type outboxEvents } from '@omnivo/db';
import { Queue } from 'bullmq';
import { z } from 'zod';

import type { WorkerConfig } from '../config.js';
import { CONFIG } from '../infra/tokens.js';

export const QUEUE_NAMES = ['email', 'jobs', 'couriers'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

// Two queues, so a slow or broken mail server never holds up workspace setup. Each queue gets its
// own workers, and the email queue can get a rate limit later (a mail provider allows N per second).
// satisfies: a new event type without a queue does not compile. Step 28a: a third, for the
// couriers: a courier's API that answers slowly (15 seconds, then a retry minutes later) must not
// hold up a workspace's setup or a report.
const QUEUE_OF = {
  'workspace.created': 'email',
  'invitation.issued': 'email',
  'document.email_requested': 'email',
  'report.schedule_email': 'email',
  'workspace.setup_requested': 'jobs',
  'member.joined': 'jobs',
  'workspace.chart_requested': 'jobs',
  'report.export_requested': 'jobs',
  'workspace.catalog_requested': 'jobs',
  'product.import_requested': 'jobs',
  'stock.below_reorder': 'jobs',
  'workspace.stock_accounts_requested': 'jobs',
  'workspace.tax_rates_requested': 'jobs',
  'document.file_requested': 'jobs',
  'pos.sold_short': 'jobs',
  'pos.shift_variance': 'jobs',
  'report.schedule_due': 'jobs',
  'storefront.image_uploaded': 'jobs',
  'storefront.order_confirmed': 'jobs',
  'storefront.payment_paid': 'jobs',
  'storefront.shipment_requested': 'couriers',
} satisfies Record<OutboxEventType, QueueName>;

// The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
export const OUTBOX_CLEANUP = 'outbox.cleanup';

// Step 21c: every 5 minutes, look for the scheduled reports that are due (decision 9). Like the
// cleanup, a scheduler adds it, not a request.
export const REPORT_SCHEDULE_SWEEP = 'report-schedules.sweep';

// Step 27a: every 5 minutes, delete the shop orders that never got their phone code (decision 19)
export const PENDING_ORDER_SWEEP = 'storefront-orders.sweep';

// Step 28a: every 15 minutes, ask the couriers about the parcels on their way (decision 9)
export const SHIPMENT_POLL = 'storefront-shipments.poll';

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
const SWEEP_MS = 5 * 60 * 1000;
const POLL_MS = 15 * 60 * 1000;
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
      couriers: new Queue('couriers', { connection }),
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
      // Step 28a: the couriers' queue has its own tries and pauses (config.ts's courierRetry)
      const retry = name === 'couriers' ? this.config.courierRetry : this.config.retry;
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
            attempts: retry.attempts,
            backoff: { type: 'exponential', delay: retry.backoffMs },
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

  // The same, for the report schedules' sweep. Every 5 minutes, so a schedule at 08:00 goes out by
  // 08:05 (decision 13: whole hours only, so nothing promises a minute).
  async scheduleReportSweep(): Promise<void> {
    await this.queues.jobs.upsertJobScheduler(
      'report-schedules-sweep',
      { every: SWEEP_MS },
      { name: REPORT_SCHEDULE_SWEEP },
    );
  }

  // Step 27a: the same, for the shop's pending orders. Every 5 minutes: an order is kept at most
  // that long past its hour, and nothing depends on the minute it goes
  async schedulePendingOrderSweep(): Promise<void> {
    await this.queues.jobs.upsertJobScheduler(
      'storefront-orders-sweep',
      { every: SWEEP_MS },
      { name: PENDING_ORDER_SWEEP },
    );
  }

  // Step 28a: the same, for the couriers' poll. On the jobs queue: one run is quick database work
  // around a call per parcel, and a poll held up by a report is only a little late
  async scheduleShipmentPoll(): Promise<void> {
    await this.queues.jobs.upsertJobScheduler(
      'storefront-shipments-poll',
      { every: POLL_MS },
      { name: SHIPMENT_POLL },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(QUEUE_NAMES.map((name) => this.queues[name].close()));
  }
}
