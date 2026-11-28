import { Injectable } from '@nestjs/common';
import { lowestPriceOf, multiplyMoney, posBelowCostLines } from '@omnivo/contracts';
import { stockValues, tenantSettings } from '@omnivo/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { PermissionService } from '../rbac/permission.service.js';

// One line as the check reads it: its place on the document (0-based, the form's lines.N), its
// variant, its quantity in the base unit and its net (after its discount, without VAT)
export interface CostFloorLine {
  index: number;
  variantId: string;
  baseQuantity: string;
  net: string;
}

// The cost floor of a sales order and an invoice: the same rule as the POS (posBelowCostLines in
// the contracts), checked when an order is confirmed and when an invoice is posted, like the credit
// limit. A line must sell for at least what its goods cost now (the variant's average cost × the
// base quantity, to the paisa) plus the workspace's lowest margin. A service and a variant never
// bought have no cost, and never stop a document.
//
// Unlike a POS sale, nothing happened yet, so the API refuses: 409 sales_below_cost, with the
// lines under their price boxes. Someone with sales.cost.override sees a dialog and sends the same
// request again with overrideBelowCost: true; the audit log keeps a row of it.
@Injectable()
export class CostFloorService {
  constructor(private readonly permissions: PermissionService) {}

  async check(
    tx: Transaction,
    input: {
      lines: readonly CostFloorLine[];
      overrideBelowCost: boolean;
      entityType: 'sales_order' | 'invoice';
      entityId: string;
    },
  ): Promise<void> {
    if (input.lines.length === 0) return;
    const tenantId = getTenantId();
    const [settings] = await tx
      .select({ margin: tenantSettings.minMarginPercent })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    const margin = settings?.margin ?? '0';
    const rows = await tx
      .select({ variantId: stockValues.variantId, unitCost: stockValues.unitCost })
      .from(stockValues)
      .where(
        and(
          eq(stockValues.tenantId, tenantId),
          inArray(stockValues.variantId, [...new Set(input.lines.map((line) => line.variantId))]),
          isNotNull(stockValues.unitCost),
        ),
      );
    const costOf = new Map(
      rows.flatMap((row) => (row.unitCost === null ? [] : [[row.variantId, row.unitCost]])),
    );
    const costs = input.lines.map((line) => {
      const unitCost = costOf.get(line.variantId);
      return unitCost === undefined ? null : multiplyMoney(line.baseQuantity, unitCost);
    });
    const below = posBelowCostLines(
      input.lines.map((line, at) => ({ net: line.net, cost: costs[at] ?? null })),
      margin,
    ).flatMap((at) => {
      const line = input.lines[at];
      const cost = costs[at];
      return line === undefined || cost === undefined || cost === null
        ? []
        : [{ line, lowest: lowestPriceOf(cost, margin) }];
    });
    if (below.length === 0) return;

    // "line 2 at 680.0000, at least 700.0000": the English detail and the audit row, counted from 1
    const text = below
      .map(
        ({ line, lowest }) => `line ${String(line.index + 1)} at ${line.net}, at least ${lowest}`,
      )
      .join('; ');
    if (!input.overrideBelowCost) {
      throw new AppError(
        409,
        'sales_below_cost',
        `These lines sell for less than their buying price${margin === '0.00' ? '' : ' plus the lowest margin'}: ${text}.`,
        {
          // The lines' numbers as the form counts them, for the dialog ("Lines 2 and 4")
          params: {
            lines: below.map(({ line }) => String(line.index + 1)).join(', '),
            count: below.length,
            margin,
          },
          fieldErrors: Object.fromEntries(
            below.map(({ line }) => [
              `lines.${String(line.index)}.unitPrice`,
              ['sales_below_cost'],
            ]),
          ),
        },
      );
    }
    const access = await this.permissions.ofCurrentUser();
    if (!access.permissions.includes('sales.cost.override')) {
      throw new AppError(
        403,
        'cost_override_forbidden',
        'Selling below the buying price needs the sales.cost.override permission.',
        { params: { permissions: 'sales.cost.override' } },
      );
    }
    // Next to the document's own "confirmed" or "posted" row: a filter on this action lists every
    // sale below cost in the workspace, like credit_limit.overridden
    await audit(tx, {
      action: 'cost_floor.overridden',
      entityType: input.entityType,
      entityId: input.entityId,
      changes: created({ belowCost: text, minMarginPercent: margin }),
    });
  }
}
