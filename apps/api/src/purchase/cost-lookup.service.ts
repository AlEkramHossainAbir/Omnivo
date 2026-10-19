import { Inject, Injectable } from '@nestjs/common';
import type { CostLookup, CostLookupInput, CostLookupItem } from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { ValueAccess } from '../inventory/value-access.js';

const rowSchema = z.object({
  variant_id: z.uuid(),
  unit_id: z.uuid(),
  supplier_price: z.string().nullable(),
  last_price: z.string().nullable(),
  average_cost: z.string().nullable(),
  tax_rate_id: z.uuid().nullable(),
});

// The price of the latest approved purchase order line for the variant (step 17b, decision 19),
// per base unit: the line's net (after its discount, before VAT) ÷ its base quantity. Approved,
// received and closed orders count; a draft or a pending order is not a price anybody agreed to,
// and a cancelled one was never bought. `supplier`: only this supplier's orders.
function lastPrice(supplier: SQL | null): SQL {
  return sql`(
    SELECT pl.net / pl.base_quantity
      FROM purchase_order_lines pl
      JOIN purchase_orders po ON po.tenant_id = pl.tenant_id AND po.id = pl.order_id
     WHERE pl.tenant_id = v.tenant_id AND pl.product_id = p.id AND pl.variant_id = v.id
       AND po.status IN ('approved', 'received', 'closed')
       ${supplier === null ? sql`` : sql`AND po.supplier_id = ${supplier}`}
     ORDER BY po.date DESC, po.created_at DESC, pl.line_no
     LIMIT 1)`;
}

// The cost and VAT rate a new purchase line starts with (step 17a, decision 20; step 17b, decision
// 19). The person may change both on the line: this is only where they start.
//   cost      this supplier's last price, else anyone's last price, else the company-wide average
//             cost (step 14), each × the unit's factor; else none (null): a product never bought,
//             or a service never ordered
//   VAT rate  the product's own rate if it is active, else the workspace default, like the sales
//             price lookup. A requisition has no VAT and ignores it.
@Injectable()
export class CostLookupService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly values: ValueAccess,
  ) {}

  async lookup(input: CostLookupInput): Promise<CostLookup> {
    const tenantId = getTenantId();
    // The average comes from the books, so only someone with inventory.stock.value gets it, like
    // the stock page's costs (step 14). A purchase price is a price people agreed, so everyone who
    // writes purchases gets it (decision 19). An item with neither still comes back, with no cost:
    // the form learns which items are valid, and the person types the cost.
    const canSee = await this.values.canSee();
    return this.withTenant(async (tx) => {
      // One query for every item, in the order they were asked for (ord), like the sales price
      // lookup. A unit that is neither the base unit nor a pack of the product drops out, like an
      // unknown variant. The multiplication is NUMERIC in Postgres: a factor has 6 decimals, and it
      // is rounded once, to the 4 decimals a cost keeps.
      const wanted = sql.join(
        input.items.map(
          (item, index) => sql`(${index}::int, ${item.variantId}::uuid, ${item.unitId}::uuid)`,
        ),
        sql`, `,
      );
      // The unit's factor once, for every source: each is per base unit
      const factor = sql`CASE WHEN w.unit_id = p.base_unit_id THEN 1 ELSE pu.factor END`;
      const rows = z.array(rowSchema).parse(
        await tx.execute(sql`
          WITH wanted(ord, variant_id, unit_id) AS (VALUES ${wanted})
          SELECT w.variant_id::text AS variant_id, w.unit_id::text AS unit_id,
                 ${
                   input.supplierId === null
                     ? sql`NULL::text`
                     : sql`round(${lastPrice(sql`${input.supplierId}::uuid`)} * ${factor}, 4)::text`
                 } AS supplier_price,
                 round(${lastPrice(null)} * ${factor}, 4)::text AS last_price,
                 ${
                   canSee ? sql`round(sv.unit_cost * ${factor}, 4)::text` : sql`NULL::text`
                 } AS average_cost,
                 coalesce(own.id, d.id)::text AS tax_rate_id
            FROM wanted w
            JOIN product_variants v ON v.tenant_id = ${tenantId}::uuid AND v.id = w.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            LEFT JOIN product_units pu
              ON pu.tenant_id = p.tenant_id AND pu.product_id = p.id AND pu.unit_id = w.unit_id
            LEFT JOIN stock_values sv ON sv.tenant_id = v.tenant_id AND sv.variant_id = v.id
            LEFT JOIN tax_rates own
              ON own.tenant_id = p.tenant_id AND own.id = p.tax_rate_id AND own.archived_at IS NULL
            LEFT JOIN tax_rates d ON d.tenant_id = v.tenant_id AND d.is_default
           WHERE w.unit_id = p.base_unit_id OR pu.unit_id IS NOT NULL
           ORDER BY w.ord`),
      );
      return {
        items: rows.flatMap((row): CostLookupItem[] => {
          // No rate at all: a workspace whose setup job has not made its rates yet
          if (row.tax_rate_id === null) return [];
          const [cost, source] =
            row.supplier_price !== null
              ? [row.supplier_price, 'supplier_price']
              : row.last_price !== null
                ? [row.last_price, 'last_price']
                : row.average_cost !== null
                  ? [row.average_cost, 'average_cost']
                  : [null, null];
          return [
            {
              variantId: row.variant_id,
              unitId: row.unit_id,
              cost,
              source,
              taxRateId: row.tax_rate_id,
            },
          ];
        }),
      };
    });
  }
}
