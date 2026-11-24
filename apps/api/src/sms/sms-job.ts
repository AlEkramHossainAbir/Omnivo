import { z } from 'zod';

// Step 27a: one SMS, as the API hands it to the worker. Not an outbox event: an outbox row carries
// ids, never secrets (common/outbox/outbox.ts), and these texts carry the phone code or a tracking
// link. So the API puts the job on its own BullMQ queue right after its transaction commits, and
// the queue deletes the job as soon as it is sent, or has failed for good (sms-queue.ts).

export const SMS_QUEUE = 'sms';
export const SMS_JOB = 'sms.send';

// The worker checks the job like any data from Redis. The phone is shopPhoneSchema's form, the
// only one the orders keep. 480 characters: three SMS parts in English, about seven in Bangla
// (a Bangla SMS part holds 70 characters), far more than any of ours
export const smsJobSchema = z.object({
  to: z.string().regex(/^01[3-9]\d{8}$/),
  text: z.string().min(1).max(480),
});

export type SmsJob = z.infer<typeof smsJobSchema>;
