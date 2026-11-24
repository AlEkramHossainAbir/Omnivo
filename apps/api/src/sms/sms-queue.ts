import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';

import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { SMS_JOB, SMS_QUEUE, type SmsJob, smsJobSchema } from './sms-job.js';

// How long one hand-over to Redis may take. BullMQ waits for its connection before it adds a job,
// so with Redis away an add would wait as long as the shopper does; this ends it, as the outbox
// relay's publishTimeoutMs does
const ADD_TIMEOUT_MS = 3_000;

// Step 27a: the API's side of the SMS queue. Only the order routes use it, and only after their
// transaction has committed: an SMS for an order that rolled back would carry a code for nothing.
@Injectable()
export class SmsQueue implements OnApplicationShutdown {
  private readonly logger = new Logger(SmsQueue.name);
  private queue: Queue | null = null;

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  // Made on the first SMS, not when the API starts: most API processes never send one, and a queue
  // made at start would hold a Redis connection open (and try it in tests that have no Redis)
  private get sms(): Queue {
    if (this.queue === null) {
      this.queue = new Queue(SMS_QUEUE, {
        connection: { url: this.config.redisUrl, enableOfflineQueue: false },
      });
      // As in worker/queues.ts: without a listener, every failed reconnect is an unhandled error
      this.queue.on('error', (error) => {
        this.logger.warn(`queue ${SMS_QUEUE}: ${error.message}`);
      });
    }
    return this.queue;
  }

  // Never throws. The order is saved by now, and the shopper can ask for the code again after
  // SHOP_CODE_RESEND_SECONDS (or track the order with /track): failing the whole answer for a lost
  // SMS would only make them place the order twice. The log never names the phone or the text
  async send(message: SmsJob): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.sms.add(SMS_JOB, smsJobSchema.parse(message), {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          // Gone from Redis the moment it is sent, or has failed for good: the text is a secret
          removeOnComplete: true,
          removeOnFail: true,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`no answer from Redis in ${String(ADD_TIMEOUT_MS)} ms`));
          }, ADD_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch (error) {
      this.logger.error(
        `An SMS was not queued: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close();
  }
}
