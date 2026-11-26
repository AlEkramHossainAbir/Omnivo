import { Inject, Injectable, Logger } from '@nestjs/common';
import { OPEN_SHIPMENT_STATUSES } from '@omnivo/contracts';
import { type Db, courierAccounts, storefrontShipments } from '@omnivo/db';
import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';

import { runWithTenant } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import type { ShippingConfig } from '../../config.js';
import { COURIERS, RELAY_DB, SHIPPING_CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { type CourierAdapters, isApiProvider } from '../../shipping/courier.js';
import { SmsQueue } from '../../sms/sms-queue.js';
import { openKeys } from './courier-keys.js';
import { ShipmentNews, stepStatusOf } from './shipment-news.js';

// How many parcels of one workspace one poll asks about, least recently heard from first. The
// rest wait for the next poll, 15 minutes later: a shop with a thousand parcels on the road is
// covered within a few hours, and no workspace's courier gets hundreds of calls at once (mine)
const BATCH = 100;

// The statuses the poll asks about: the parcels still on their way that the courier knows (the
// booking job has the ones still in `booking`)
const POLLED = OPEN_SHIPMENT_STATUSES.filter((status) => status !== 'booking');

// Step 28a (decision 9): every 15 minutes, ask the courier where each parcel on its way is, for
// the shops whose courier's webhook does not come (never pasted, or the courier's own trouble).
// Two halves on two roles, like 27a's pending-order sweep:
// 1. as omnivo_worker (RELAY_DB): which workspaces have a parcel on its way. 0078 lets it read
//    the workspace and the status of the open parcels only
// 2. as omnivo_app inside each one: its parcels, then one courier call per parcel (outside any
//    transaction), then the answer through ShipmentNews in its own transaction
// A status the parcel has already is no news: only last_synced_at moves, so a parcel asked about
// a hundred times has one step per change, not a hundred. Provided by WorkerModule only.
@Injectable()
export class ShipmentPoll {
  private readonly logger = new Logger(ShipmentPoll.name);

  constructor(
    @Inject(RELAY_DB) private readonly relayDb: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(SHIPPING_CONFIG) private readonly shipping: ShippingConfig,
    @Inject(COURIERS) private readonly couriers: CourierAdapters,
    private readonly news: ShipmentNews,
    private readonly sms: SmsQueue,
  ) {}

  // The number of parcels asked about
  async run(): Promise<number> {
    const tenants = await this.relayDb
      .selectDistinct({ tenantId: storefrontShipments.tenantId })
      .from(storefrontShipments)
      .where(inArray(storefrontShipments.status, [...POLLED]));
    let asked = 0;
    for (const { tenantId } of tenants) {
      try {
        asked += await runWithTenant(tenantId, () => this.poll(tenantId));
      } catch (error) {
        // One workspace's failure must not stop the others; the next poll tries again
        this.logger.warn(`parcels (tenant ${tenantId}): ${String(error)}`);
      }
    }
    return asked;
  }

  private async poll(tenantId: string): Promise<number> {
    const parcels = await this.withTenant((tx) =>
      tx
        .select({ parcel: storefrontShipments, account: courierAccounts })
        .from(storefrontShipments)
        .innerJoin(
          courierAccounts,
          and(
            eq(courierAccounts.tenantId, storefrontShipments.tenantId),
            eq(courierAccounts.id, storefrontShipments.courierAccountId),
          ),
        )
        .where(
          and(
            eq(storefrontShipments.tenantId, tenantId),
            inArray(storefrontShipments.status, [...POLLED]),
            isNotNull(storefrontShipments.consignmentId),
            ne(courierAccounts.provider, 'manual'),
          ),
        )
        .orderBy(
          sql`${storefrontShipments.lastSyncedAt} ASC NULLS FIRST`,
          asc(storefrontShipments.id),
        )
        .limit(BATCH),
    );
    for (const { parcel, account } of parcels) {
      if (!isApiProvider(account.provider) || parcel.consignmentId === null) continue;
      const keys = openKeys(this.shipping.credentialsKey, account);
      // Keys this server cannot open: the account's own "Test connection" says so; nothing to ask
      if (keys === null) continue;
      const answer = await this.couriers[account.provider].status(keys, parcel.consignmentId);
      // No answer, or the keys refused: the next poll asks again. The webhook may still come
      if (answer.kind === 'problem') continue;
      // A word the adapter does not know is kept once by the webhook's way, not every 15 minutes
      // here; the log says which, so the adapter's table can learn it
      if (answer.status === null) {
        this.logger.warn(`${account.provider} said "${answer.word}" about parcel ${parcel.id}`);
      }
      const news =
        answer.status === null || stepStatusOf(parcel.status, answer.status) === parcel.status
          ? []
          : [
              {
                consignmentId: parcel.consignmentId,
                invoice: parcel.invoice,
                raw: { status: answer.word },
                kind: 'status' as const,
                status: answer.status,
                note: null,
                // The courier gives no time with a status: the step is when the poll saw it. A
                // time also keeps its key apart from an earlier step with the same status (in
                // transit, on hold, in transit again)
                at: new Date(),
                // Step 28b: a status answer names no money; the webhook's notice brings it
                collected: null,
                charge: null,
              },
            ];
      const sms = await this.withTenant((tx) => this.news.apply(tx, parcel.id, news, 'poll'));
      if (sms !== null) await this.sms.send(sms);
    }
    return parcels.length;
  }
}
