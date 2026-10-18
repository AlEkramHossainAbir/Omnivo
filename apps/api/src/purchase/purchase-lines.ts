import {
  defaultLineDescription,
  type ErrorCode,
  fitsDecimals,
  isQuantity,
  toBaseQuantity,
} from '@omnivo/contracts';
import { warehouses } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import {
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type VariantInfo,
} from '../inventory/stock-lines.js';

// What every purchase document checks the same way (step 17a): the warehouse the goods are for and
// the items on its lines. 17b's purchase order and goods receipt use them too.

// An active warehouse of this workspace. A draft that already has this warehouse keeps it (keptId)
// even if it was archived since, like a sales draft keeps its archived customer: the person can
// still finish it. FOR SHARE: an archive waits until we commit.
export async function assertWarehouse(
  tx: Transaction,
  warehouseId: string,
  keptId: string | null = null,
): Promise<void> {
  const [row] = await tx
    .select({ id: warehouses.id, archivedAt: warehouses.archivedAt })
    .from(warehouses)
    .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, warehouseId)))
    .for('share');
  if (!row || (row.archivedAt !== null && row.id !== keptId)) {
    const code: ErrorCode = 'purchase_warehouse_invalid';
    throw new AppError(409, code, 'Pick an active warehouse.', {
      fieldErrors: { warehouseId: [code] },
    });
  }
}

// A purchase line's item as the form sends it
export interface PurchaseItemInput {
  variantId: string;
  unitId: string;
  quantity: string;
  description: string | null;
}

// The item checked against its product, with the quantity in the base unit
export interface ResolvedPurchaseItem {
  variant: VariantInfo;
  unitId: string;
  quantity: string;
  factor: string;
  baseQuantity: string;
  description: string;
}

// Every rule of a purchase line's item the contract cannot check: an active product or service of
// this workspace (a service is bought too: a repair, a transport contract), a unit that is its base
// unit or one of its packs, and a quantity that fits the unit. All problems come back at once,
// each under its own field, like resolveSalesLines().
export async function resolvePurchaseItems(
  tx: Transaction,
  lines: readonly PurchaseItemInput[],
): Promise<ResolvedPurchaseItem[]> {
  const variants = await loadVariants(
    tx,
    lines.map((line) => line.variantId),
  );
  const issues: LineIssue[] = [];
  const resolved: ResolvedPurchaseItem[] = [];
  lines.forEach((line, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: linePath(index, field), code });
    };
    const variant = variants.get(line.variantId);
    if (variant === undefined || variant.archived) {
      at('variantId', 'purchase_item_invalid');
      return;
    }
    const unit =
      line.unitId === variant.baseUnitId
        ? { factor: '1', decimals: variant.baseDecimals }
        : variant.units.find((pack) => pack.unitId === line.unitId);
    if (unit === undefined) {
      at('unitId', 'stock_unit_invalid');
      return;
    }
    if (!fitsDecimals(line.quantity, unit.decimals)) {
      at('quantity', 'stock_quantity_decimals');
      return;
    }
    const baseQuantity = toBaseQuantity(line.quantity, unit.factor, variant.baseDecimals);
    if (!isQuantity(baseQuantity)) {
      at('quantity', 'quantity_format');
      return;
    }
    resolved.push({
      variant,
      unitId: line.unitId,
      quantity: line.quantity,
      factor: unit.factor,
      baseQuantity,
      description: line.description ?? defaultLineDescription(variant),
    });
  });
  if (issues.length > 0) throw linesError(issues);
  return resolved;
}
