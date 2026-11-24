import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';

import type { WorkerConfig } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { SMS_QUEUE, smsJobSchema } from '../sms/sms-job.js';
import { SMS_SENDER, type SmsSender } from '../sms/sms-sender.js';

// Step 27a: the worker's side of the SMS queue. Its own BullMQ worker next to the outbox queues
// (job-runner.ts): an SMS job is not an outbox event, and a slow SMS provider must not hold up the
// emails or the jobs. It lives in worker/, not in sms/, because only worker/ may run a BullMQ
// Worker (.dependency-cruiser.cjs, queue-only-in-worker).
@Injectable()
export class SmsRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SmsRunner.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: WorkerConfig,
    @Inject(SMS_SENDER) private readonly sender: SmsSender,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker(SMS_QUEUE, (job) => this.process(job), {
      connection: { url: this.config.redisUrl },
      concurrency: 5,
    });
    this.worker.on('error', (error) => {
      this.logger.warn(`queue ${SMS_QUEUE}: ${error.message}`);
    });
    // The job's id only: its data is a phone and a code
    this.worker.on('failed', (job, error) => {
      this.logger.warn(`SMS ${String(job?.id)} failed: ${error.message}`);
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job): Promise<void> {
    const message = smsJobSchema.safeParse(job.data);
    // A job we cannot read will never become readable: no retries
    if (!message.success) throw new UnrecoverableError(`SMS ${String(job.id)} has broken data`);
    await this.sender.send(message.data);
  }
}
