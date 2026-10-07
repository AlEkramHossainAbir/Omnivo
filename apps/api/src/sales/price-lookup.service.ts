import { Inject, Injectable } from '@nestjs/common';
import type { PriceLookup, PriceLookupInput, PriceLookupItem } from '@omnivo/contracts';
import { parties, priceLists } from '@omnivo/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { pricesIncludeVatNow } from './sales-lines.js';

const rowSchema = z.object({
  variant_id: z.uuid(),
  unit_id: z.uuid(),
  list_price: z.string().nullable(),
  product_price: z.string().nullable(),
  tax_rate_id: z.uuid().nullable(),
});

// The price and VAT rate a new sales line starts with (step 15b). The person may change both on
// the line: this is only where they start.
//   price     the customer's price list, if it is active and has this variant in this unit (15a);
//             else the variant's own sale price (per base unit) × the unit's factor;
//             else none (null): the person types it
//   VAT rate  the product's own rate if it is active, else the workspace default
@Injectable()
export class PriceLookupService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  lookup(input: PriceLookupInput): Promise<PriceLookup> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const pricesIncludeVat = await pricesIncludeVatNow(tx);
      // The customer's list, only while it is active: an archived list falls back to the products'
      // own prices, as 15a promised. Another workspace's customer (or none) has no list.
      const [customer] =
        input.customerId === null
          ? []
          : await tx
              .select({ priceListId: priceLists.id })
              .from(parties)
              .innerJoin(
                priceLists,
                and(
                  eq(priceLists.tenantId, parties.tenantId),
                  eq(priceLists.id, parties.priceListId),
                ),
              )
              .where(
                and(
                  eq(parties.tenantId, tenantId),
                  eq(parties.id, input.customerId),
                  isNull(priceLists.archivedAt),
                ),
              );
      const priceListId = customer?.priceListId ?? null;

      // One query for every item, in the order they were asked for (ord). A unit that is neither
      // the base unit nor a pack of the product drops out, like an unknown variant. The product's
      // price is worked out in Postgres: a factor has 6 decimals (a yard is 0.914400 m), and NUMERIC
      // multiplies it exactly before rounding to the 4 decimals a price keeps.
      const wanted = sql.join(
        input.items.map(
          (item, index) => sql`(${index}::int, ${item.variantId}::uuid, ${item.unitId}::uuid)`,
        ),
        sql`, `,
      );
      const rows = z.array(rowSchema).parse(
        await tx.execute(sql`
          WITH wanted(ord, variant_id, unit_id) AS (VALUES ${wanted})
          SELECT w.variant_id::text AS variant_id, w.unit_id::text AS unit_id,
                 round(pli.price, 4)::text AS list_price,
                 round(v.sale_price * CASE WHEN w.unit_id = p.base_unit_id THEN 1 ELSE pu.factor END,
                       4)::text AS product_price,
                 coalesce(own.id, d.id)::text AS tax_rate_id
            FROM wanted w
            JOIN product_variants v ON v.tenant_id = ${tenantId}::uuid AND v.id = w.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            LEFT JOIN product_units pu
              ON pu.tenant_id = p.tenant_id AND pu.product_id = p.id AND pu.unit_id = w.unit_id
            LEFT JOIN price_list_items pli
              ON pli.tenant_id = v.tenant_id AND pli.price_list_id = ${priceListId}::uuid
             AND pli.variant_id = v.id AND pli.unit_id = w.unit_id
            LEFT JOIN tax_rates own
              ON own.tenant_id = p.tenant_id AND own.id = p.tax_rate_id AND own.archived_at IS NULL
            LEFT JOIN tax_rates d ON d.tenant_id = v.tenant_id AND d.is_default
           WHERE w.unit_id = p.base_unit_id OR pu.unit_id IS NOT NULL
           ORDER BY w.ord`),
      );

      const items = rows.flatMap((row): PriceLookupItem[] => {
        // No rate at all: a workspace whose setup job has not made its rates yet
        if (row.tax_rate_id === null) return [];
        const price = row.list_price ?? row.product_price;
        return [
          {
            variantId: row.variant_id,
            unitId: row.unit_id,
            price,
            source: row.list_price !== null ? 'price_list' : price === null ? null : 'product',
            taxRateId: row.tax_rate_id,
          },
        ];
      });
      return { pricesIncludeVat, items };
    });
  }
}
