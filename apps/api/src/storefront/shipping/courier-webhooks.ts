import { timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { type Db, courierAccounts, storefrontShipments } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../../common/http/app-error.js';
import { runWithTenant } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import { COURIERS, DB, WITH_TENANT } from '../../infra/tokens.js';
import type { ApiCourierProvider, CourierAdapters } from '../../shipping/courier.js';
import { SmsQueue } from '../../sms/sms-queue.js';
import { tokenHash } from '../orders/order-secrets.js';
import { ShipmentNews } from './shipment-news.js';

const lookupSchema = z.object({ tenant_id: z.uuid(), webhook_token_hash: z.string() });

function tokenInvalid(): AppError {
  return new AppError(
    401,
    'courier_webhook_token_invalid',
    'This webhook token is not right. Paste the token from Shop couriers.',
  );
}

// "Bearer <token>" as the courier's panel sends it, or null
export function bearerOf(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1] ?? null;
}

// Step 28a (decisions 8 and 22): a courier's webhook. The courier knows only the account's id (in
// the address) and its token (the Authorization header), so:
// 1. courier_account_for_webhook (0078) finds the workspace and the token's hash for the id, with
//    no workspace set yet. The same 401 for an unknown id, a manual account, another provider's
//    account and a wrong token: the caller learns nothing about which ids exist
// 2. the token is compared with the hash in constant time, before the body is read at all
// 3. inside the workspace: the account's last webhook time (the page shows it, decision 16), then
//    in a transaction of its own the parcel by the courier's id or by our invoice, only among this
//    account's parcels. The body never says which workspace or account it is for
// A body we cannot read, or one about a parcel we do not know, is answered "success" all the same:
// a refusal would only make the courier send it again and again, and then stop sending.
@Injectable()
export class CourierWebhooks {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(COURIERS) private readonly couriers: CourierAdapters,
    private readonly news: ShipmentNews,
    private readonly sms: SmsQueue,
  ) {}

  async receive(
    provider: ApiCourierProvider,
    accountId: string,
    authorization: string | undefined,
    body: unknown,
  ): Promise<void> {
    const token = bearerOf(authorization);
    if (token === null) throw tokenInvalid();
    const rows = await this.db.execute(
      sql`SELECT tenant_id::text AS tenant_id, webhook_token_hash
          FROM courier_account_for_webhook(${accountId}::uuid, ${provider})`,
    );
    const found = lookupSchema.safeParse(rows[0]);
    if (!found.success) throw tokenInvalid();
    // Two SHA-256 digests in hex: always one length, as timingSafeEqual needs
    const sent = Buffer.from(tokenHash(token), 'hex');
    const kept = Buffer.from(found.data.webhook_token_hash, 'hex');
    if (sent.length !== kept.length || !timingSafeEqual(sent, kept)) throw tokenInvalid();

    const notice = this.couriers[provider].readNotice(body);
    const tenantId = found.data.tenant_id;
    const now = new Date();
    // Step 28b: the last webhook time commits on its own, before the news. The UPDATE locks the
    // account's row, and the news then waits for the parcel's order; a member's move on that order
    // (Mark delivered's COD receipt, Packed, Book courier) holds the order and reads the account
    // FOR SHARE. In one transaction the two waited for each other, and Postgres killed the webhook
    // (found by cod.int.spec.ts's race). A webhook whose news then fails still arrived
    await runWithTenant(tenantId, () =>
      this.withTenant(async (tx) => {
        await tx
          .update(courierAccounts)
          .set({ lastWebhookAt: now })
          .where(and(eq(courierAccounts.tenantId, tenantId), eq(courierAccounts.id, accountId)));
      }),
    );
    const sms = await runWithTenant(tenantId, () =>
      this.withTenant(async (tx) => {
        const by =
          notice.consignmentId !== null
            ? eq(storefrontShipments.consignmentId, notice.consignmentId)
            : notice.invoice !== null
              ? eq(storefrontShipments.invoice, notice.invoice)
              : null;
        if (by === null) return null;
        const [parcel] = await tx
          .select({ id: storefrontShipments.id })
          .from(storefrontShipments)
          .where(
            and(
              eq(storefrontShipments.tenantId, tenantId),
              eq(storefrontShipments.courierAccountId, accountId),
              by,
            ),
          );
        return parcel === undefined
          ? null
          : this.news.apply(tx, parcel.id, [notice], 'webhook', now);
      }),
    );
    // After the commit; never throws (SmsQueue.send)
    if (sms !== null) await this.sms.send(sms);
  }
}
