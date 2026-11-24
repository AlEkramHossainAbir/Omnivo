import { Inject, Injectable } from '@nestjs/common';
import { type Db, storefrontSettings } from '@omnivo/db';
import { eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../common/http/app-error.js';
import { setTenantContext, type Transaction } from '../common/tenant/with-tenant.js';
import type { Config } from '../config.js';
import { CONFIG, DB } from '../infra/tokens.js';
import { subdomainOf } from './shop-host.js';

// The one answer for every address that is not a launched shop: no such subdomain, a shop not
// launched yet, a deleted workspace, or a header that is not a host at all. Telling them apart
// would tell a stranger which workspaces are about to open a shop
export function storefrontNotFound(): AppError {
  return new AppError(404, 'storefront_not_found', 'There is no shop at this address.');
}

// What every public read knows about its shop once it is found
export interface ShopScope {
  tenantId: string;
  // Step 27a: the shop's own label ("nirvor"), for the tracking link the confirm SMS carries
  subdomain: string;
  // Where the shop counts its stock (decision 3)
  warehouseId: string;
  // One clock for the whole answer: a sale that ends during the request is either on in every
  // card of it or in none, and the SQL's price (listing-sql.ts) and listingPricing() agree
  now: Date;
}

const tenantRowSchema = z.object({ tenant_id: z.uuid().nullable() });

// Step 26f: how the public API reads the database (decision 15). Every public request is one
// read-only transaction that first becomes omnivo_public (migration 0064), so even a bug in this
// module reads only what the shop's own pages show, and writes nothing.
//
// Step 27a: the order routes go through orders() instead, as omnivo_shop (0071, 27a's decision
// 22): the public reads plus the order tables, and nothing else. Both find the shop the same way.
@Injectable()
export class ShopDb {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  read<T>(
    host: string | undefined,
    fn: (tx: Transaction, shop: ShopScope) => Promise<T>,
  ): Promise<T> {
    // READ ONLY on top of the role's SELECT-only grants: a write here fails twice over
    return this.run(host, sql`omnivo_public`, 'read only', fn);
  }

  // Step 27a: placing an order, its phone code, and the order and tracking pages. Read-write only
  // where it writes: the pages that only show an order pass readOnly, so a bug there cannot change
  // one either
  orders<T>(
    host: string | undefined,
    fn: (tx: Transaction, shop: ShopScope) => Promise<T>,
    { readOnly = false }: { readOnly?: boolean } = {},
  ): Promise<T> {
    return this.run(host, sql`omnivo_shop`, readOnly ? 'read only' : 'read write', fn);
  }

  private run<T>(
    host: string | undefined,
    role: SQL,
    accessMode: 'read only' | 'read write',
    fn: (tx: Transaction, shop: ShopScope) => Promise<T>,
  ): Promise<T> {
    // Before any database work: a host that cannot be a shop of ours costs nothing
    const label = subdomainOf(host, this.config.storefront.baseDomain);
    if (label === null) return Promise.reject(storefrontNotFound());

    return this.db.transaction(
      async (tx) => {
        // LOCAL: only until this transaction ends. The pooled connection is omnivo_app again for
        // the next request, as with set_config(…, true) in setTenantContext. The role is one of
        // the two written above, never a value from the request
        await tx.execute(sql`SET LOCAL ROLE ${role}`);
        // The one look across workspaces, through the database's own function: it answers one id
        // for a launched shop, or NULL
        const [found] = z
          .array(tenantRowSchema)
          .parse(
            await tx.execute(
              sql`SELECT storefront_tenant_for_subdomain(${label})::text AS tenant_id`,
            ),
          );
        const tenantId = found?.tenant_id ?? null;
        if (tenantId === null) throw storefrontNotFound();

        // From here on, the same tenant_isolation as the ERP's own requests
        await setTenantContext(tx, tenantId);
        const [settings] = await tx
          .select({ warehouseId: storefrontSettings.defaultWarehouseId })
          .from(storefrontSettings)
          .where(eq(storefrontSettings.tenantId, tenantId));
        // A launched shop always has its warehouse (storefront_settings_launch_check). No row at
        // all would mean the shop's launch was undone between the two queries: the same 404
        if (settings?.warehouseId == null) throw storefrontNotFound();

        return fn(tx, {
          tenantId,
          subdomain: label,
          warehouseId: settings.warehouseId,
          now: new Date(),
        });
      },
      { accessMode },
    );
  }
}
