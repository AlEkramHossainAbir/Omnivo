import { type OutboxEventType, outboxEvents } from '@omnivo/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { currentRequest } from '../request/request-context.js';
import type { Transaction } from '../tenant/with-tenant.js';

// What each event carries: ids, never copies of data. The worker reads the current rows when the
// job runs, so a payload cannot go stale, and nothing private (an email, a token) sits in the
// outbox table, in Redis or in a backup. satisfies: a new event type without a schema does not
// compile.
export const outboxPayloadSchemas = {
  'workspace.created': z.object({ userId: z.uuid() }),
  'workspace.setup_requested': z.object({ userId: z.uuid() }),
  // actorUserId: who sent or resent it — their name goes in the email, and they hear if it fails
  'invitation.issued': z.object({ invitationId: z.uuid(), actorUserId: z.uuid() }),
  // inviterId is null when the invitation's creator is unknown (an old row)
  'member.joined': z.object({ membershipId: z.uuid(), inviterId: z.uuid().nullable() }),
  // Nothing to carry: the workspace is the event's tenant, and its business type is on its row
  'workspace.chart_requested': z.object({}),
  // The report_exports row says which report, which dates and for whom
  'report.export_requested': z.object({ exportId: z.uuid() }),
  // Like the chart's: the workspace and its business type say everything
  'workspace.catalog_requested': z.object({}),
  // The product_imports row says which file, and who uploaded it
  'product.import_requested': z.object({ importId: z.uuid() }),
  // A posting took these variants down to their reorder level in this warehouse (step 13). The
  // worker counts them again when it runs: one that was refilled meanwhile is not reported.
  'stock.below_reorder': z.object({
    warehouseId: z.uuid(),
    variantIds: z.array(z.uuid()).min(1).max(500),
  }),
  // Like the chart's: the workspace and its business type say everything (step 14)
  'workspace.stock_accounts_requested': z.object({}),
  // Like the chart's: the rates are the same for every workspace (step 15a)
  'workspace.tax_rates_requested': z.object({}),
} satisfies Record<OutboxEventType, z.ZodObject>;

export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;

// An event as the worker's handlers see it: the outbox row with a checked payload
export interface OutboxEvent<T extends OutboxEventType> {
  id: string;
  tenantId: string;
  type: T;
  payload: OutboxPayload<T>;
  requestId: string | null;
}

// Hand work to the worker. Call it with the SAME transaction that makes the change: if the change
// rolls back, the event is gone too, and if it commits, the event is safely stored — even if the
// process dies a millisecond later. Never publish to the queue straight from a request.
export async function emit<T extends OutboxEventType>(
  tx: Transaction,
  type: T,
  payload: OutboxPayload<T>,
): Promise<void> {
  await tx.insert(outboxEvents).values({
    // Like audit(): the tenant comes from the transaction's own context, so the event always
    // belongs to the tenant whose data changed. Without a context: NULL → NOT NULL error.
    tenantId: sql`NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    type,
    // parse drops any field the schema does not know. A caller cannot slip extra data (a name, an
    // email) into the outbox by passing a wider object.
    payload: outboxPayloadSchemas[type].parse(payload),
    requestId: currentRequest()?.id ?? null,
  });
}

// What the worker does with one event type. Handlers live in their feature folder (invitations/,
// setup/) and know nothing about BullMQ; worker/handlers.ts wires each one to its event type.
export interface EventHandler<T extends OutboxEventType> {
  // Runs inside the event's tenant context (getTenantId() works). Must be idempotent: a job can
  // run twice (a retry after a crash), and the second run must not send, create or count anything
  // twice.
  handle(event: OutboxEvent<T>): Promise<void>;
  // Runs once, after the last attempt failed — to record the failure where a person will see it
  onGiveUp?(event: OutboxEvent<T>): Promise<void>;
}

// Throw this when running the job again cannot help (the data it needs is gone or broken). The
// worker then skips the remaining retries and goes straight to onGiveUp.
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';
}
