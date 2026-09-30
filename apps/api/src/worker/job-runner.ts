import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { OutboxEventType } from '@omnivo/db';
import { type Job, UnrecoverableError, Worker } from 'bullmq';

import {
  type OutboxEvent,
  outboxPayloadSchemas,
  PermanentJobError,
} from '../common/outbox/outbox.js';
import { runWithRequest } from '../common/request/request-context.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
import type { WorkerConfig } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { EventHandlers } from './handlers.js';
import { OutboxRelay } from './outbox-relay.js';
import {
  eventJobDataSchema,
  type EventJobData,
  isOutboxEventType,
  OUTBOX_CLEANUP,
  QUEUE_NAMES,
  Queues,
} from './queues.js';

// How many jobs of one queue run at the same time in one worker process. Jobs spend most of their
// time waiting (for SMTP, for Postgres), so a few in parallel use one CPU well.
const CONCURRENCY = 5;

// Takes jobs from the queues and runs the matching handler, inside the event's tenant.
@Injectable()
export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(JobRunner.name);
  private workers: Worker[] = [];

  constructor(
    @Inject(CONFIG) private readonly config: WorkerConfig,
    private readonly handlers: EventHandlers,
    private readonly queues: Queues,
    private readonly relay: OutboxRelay,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.workers = QUEUE_NAMES.map((name) => {
      const worker = new Worker(name, (job) => this.process(job), {
        connection: { url: this.config.redisUrl },
        concurrency: CONCURRENCY,
      });
      // Without an 'error' listener, a lost Redis connection would be an unhandled 'error' event
      // and crash the process. BullMQ reconnects by itself; we only log.
      worker.on('error', (error) => {
        this.logger.warn(`queue ${name}: ${error.message}`);
      });
      return worker;
    });
    await this.queues.scheduleCleanup();
  }

  // close() stops taking new jobs and waits for the running ones, before the database closes
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }

  private async process(job: Job): Promise<void> {
    if (job.name === OUTBOX_CLEANUP) {
      const deleted = await this.relay.deletePublished();
      this.logger.log(`outbox cleanup: ${String(deleted)} old rows deleted`);
      return;
    }
    // A job we cannot read will never become readable: no retries
    if (!isOutboxEventType(job.name)) throw new UnrecoverableError(`Unknown job ${job.name}`);
    const data = eventJobDataSchema.safeParse(job.data);
    if (!data.success) throw new UnrecoverableError(`Job ${String(job.id)} has broken data`);
    await this.dispatch(job, job.name, data.data);
  }

  // The schema and the handler are both picked by the same `type`, so the payload that reaches a
  // handler is the one its event type promises. worker/handlers.ts checks the wiring at compile
  // time: each event type maps to a handler of exactly that type.
  private async dispatch(job: Job, type: OutboxEventType, data: EventJobData): Promise<void> {
    const payload = outboxPayloadSchemas[type].safeParse(data.payload);
    if (!payload.success) throw new UnrecoverableError(`${type} ${data.eventId}: broken payload`);
    const event: OutboxEvent<OutboxEventType> = {
      id: data.eventId,
      tenantId: data.tenantId,
      type,
      payload: payload.data,
      requestId: data.requestId,
    };
    const handler = this.handlers.for(type);
    // Every log line names the event and the tenant (system-design §4.5), never the payload
    const label = `${type} ${event.id} (tenant ${event.tenantId})`;
    const started = performance.now();

    try {
      await this.inContext(event, () => handler.handle(event));
      this.logger.log(`${label} done in ${String(Math.round(performance.now() - started))} ms`);
    } catch (error) {
      // attemptsMade counts the attempts that already failed, not this one — hence + 1
      const permanent = error instanceof PermanentJobError;
      const lastAttempt = permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      this.logger.warn(
        `${label} failed (attempt ${String(job.attemptsMade + 1)}): ${String(error)}`,
      );
      if (lastAttempt && handler.onGiveUp) {
        const onGiveUp = handler.onGiveUp.bind(handler);
        // A failure here must not hide the real error, which BullMQ stores on the job
        await this.inContext(event, () => onGiveUp(event)).catch((giveUpError: unknown) => {
          this.logger.error(`${label} onGiveUp failed: ${String(giveUpError)}`);
        });
      }
      throw permanent ? new UnrecoverableError(error.message) : error;
    }
  }

  // The same context an HTTP request has: the tenant (for withTenant, audit, emit) and, when the
  // event came from a request, that request's id (for audit rows)
  private inContext<R>(event: OutboxEvent<OutboxEventType>, fn: () => Promise<R>): Promise<R> {
    return runWithTenant(event.tenantId, () =>
      event.requestId === null
        ? fn()
        : runWithRequest({ id: event.requestId, ipAddress: null, userAgent: null }, fn),
    );
  }
}
