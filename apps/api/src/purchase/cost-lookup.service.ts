import { Inject, Injectable } from '@nestjs/common';
import type { CostLookup, CostLookupInput } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { ValueAccess } from '../inventory/value-access.js';

const rowSchema = z.object({
  variant_id: z.uuid(),
  unit_id: z.uuid(),
  cost: z.string().nullable(),
});

// The cost a new purchase line starts with (step 17a, decision 20). The person may change it on
// the line: this is only where it starts.
//   cost  the company-wide average cost of the variant (step 14) × the unit's factor; else none
//         (null): a product never bought, or a service, which has no stock and so no average
// 17b puts the last purchase price before the average.
@Injectable()
export class CostLookupService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly values: ValueAccess,
  ) {}

  async lookup(input: CostLookupInput): Promise<CostLookup> {
    const tenantId = getTenantId();
    // The average comes from the books, so only someone with inventory.stock.value gets it, like
    // the stock page's costs (step 14). Everyone else gets every item, with no cost: the form still
    // learns which items are valid, and the person types the cost.
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
      const rows = z.array(rowSchema).parse(
        await tx.execute(sql`
          WITH wanted(ord, variant_id, unit_id) AS (VALUES ${wanted})
          SELECT w.variant_id::text AS variant_id, w.unit_id::text AS unit_id,
                 ${
                   canSee
                     ? sql`round(sv.unit_cost * CASE WHEN w.unit_id = p.base_unit_id THEN 1
                                                     ELSE pu.factor END, 4)::text`
                     : sql`NULL::text`
                 } AS cost
            FROM wanted w
            JOIN product_variants v ON v.tenant_id = ${tenantId}::uuid AND v.id = w.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            LEFT JOIN product_units pu
              ON pu.tenant_id = p.tenant_id AND pu.product_id = p.id AND pu.unit_id = w.unit_id
            LEFT JOIN stock_values sv ON sv.tenant_id = v.tenant_id AND sv.variant_id = v.id
           WHERE w.unit_id = p.base_unit_id OR pu.unit_id IS NOT NULL
           ORDER BY w.ord`),
      );
      return {
        items: rows.map((row) => ({
          variantId: row.variant_id,
          unitId: row.unit_id,
          cost: row.cost,
          source: row.cost === null ? null : 'average_cost',
        })),
      };
    });
  }
}
