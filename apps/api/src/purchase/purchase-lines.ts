import {
  defaultLineDescription,
  type ErrorCode,
  fitsDecimals,
  isQuantity,
  lineAmounts,
  type PartyRef,
  type SalesLineInput,
  toBaseQuantity,
} from '@omnivo/contracts';
import { parties, taxRates, warehouses } from '@omnivo/db';
import { and, eq, inArray } from 'drizzle-orm';

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
import type { ResolvedSalesLine } from '../sales/sales-lines.js';

// What every purchase document checks the same way (step 17a): the warehouse the goods are for and
// the items on its lines. Step 17b adds the supplier and the priced line of a purchase order.

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

// Step 17b: the supplier a document is written for: a supplier of this workspace, and not
// archived. A draft that already has this supplier keeps it (keptId), like assertCustomer() of the
// sales documents. FOR SHARE: an archive, a delete or "drop the supplier side" (SuppliersService
// locks the party FOR UPDATE) waits until we commit, and then sees this document.
export async function assertSupplier(
  tx: Transaction,
  supplierId: string,
  keptId: string | null = null,
): Promise<PartyRef> {
  const [row] = await tx
    .select({
      id: parties.id,
      code: parties.code,
      name: parties.name,
      archivedAt: parties.archivedAt,
    })
    .from(parties)
    .where(
      and(
        eq(parties.tenantId, getTenantId()),
        eq(parties.id, supplierId),
        eq(parties.isSupplier, true),
      ),
    )
    .for('share');
  if (!row || (row.archivedAt !== null && row.id !== keptId)) {
    const code: ErrorCode = 'purchase_supplier_invalid';
    throw new AppError(409, code, 'Pick an active supplier.', {
      fieldErrors: { supplierId: [code] },
    });
  }
  return { id: row.id, code: row.code, name: row.name };
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
  const { resolved, issues } = await checkPurchaseItems(tx, lines);
  if (issues.length > 0) throw linesError(issues);
  return resolved.flatMap((item) => (item === null ? [] : [item]));
}

// resolvePurchaseItems() without the throw: one entry per line (null where the line has a
// problem) and the problems, so a caller with more to check can report everything at once.
// keptVariantIds: items that stay usable after they are archived (step 17c: a bill bills goods a
// receipt already brought in, or a service already ordered).
async function checkPurchaseItems(
  tx: Transaction,
  lines: readonly PurchaseItemInput[],
  keptVariantIds: ReadonlySet<string> = new Set(),
): Promise<{ resolved: (ResolvedPurchaseItem | null)[]; issues: LineIssue[] }> {
  const variants = await loadVariants(
    tx,
    lines.map((line) => line.variantId),
  );
  const issues: LineIssue[] = [];
  const resolved = lines.map((line, index): ResolvedPurchaseItem | null => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: linePath(index, field), code });
      return null;
    };
    const variant = variants.get(line.variantId);
    if (variant === undefined || (variant.archived && !keptVariantIds.has(variant.variantId))) {
      return at('variantId', 'purchase_item_invalid');
    }
    const unit =
      line.unitId === variant.baseUnitId
        ? { factor: '1', decimals: variant.baseDecimals }
        : variant.units.find((pack) => pack.unitId === line.unitId);
    if (unit === undefined) return at('unitId', 'stock_unit_invalid');
    if (!fitsDecimals(line.quantity, unit.decimals))
      return at('quantity', 'stock_quantity_decimals');
    const baseQuantity = toBaseQuantity(line.quantity, unit.factor, variant.baseDecimals);
    if (!isQuantity(baseQuantity)) return at('quantity', 'quantity_format');
    return {
      variant,
      unitId: line.unitId,
      quantity: line.quantity,
      factor: unit.factor,
      baseQuantity,
      description: line.description ?? defaultLineDescription(variant),
    };
  });
  return { resolved, issues };
}

// Step 17b: a purchase order line, priced like a sales line (decision 6): the item checked as on
// every purchase line, the VAT rate an active one of this workspace (keptRateIds: the rates the
// order's lines already use stay usable after they are archived, like resolveSalesLines()), and
// the amounts worked out with the contract's lineAmounts(), the function the form totals with.
// The result has a sales line's shape, so salesLineValues() and toSalesLine() store and read it.
// Step 17c: a bill passes keptVariantIds too (checkPurchaseItems()).
export async function resolvePurchaseLines(
  tx: Transaction,
  lines: readonly SalesLineInput[],
  pricesIncludeVat: boolean,
  keptRateIds: ReadonlySet<string> = new Set(),
  keptVariantIds: ReadonlySet<string> = new Set(),
): Promise<ResolvedSalesLine[]> {
  const { resolved, issues } = await checkPurchaseItems(tx, lines, keptVariantIds);
  const rateIds = [...new Set(lines.map((line) => line.taxRateId))];
  const rateRows = await tx
    .select({
      id: taxRates.id,
      name: taxRates.name,
      kind: taxRates.kind,
      rate: taxRates.rate,
      archivedAt: taxRates.archivedAt,
    })
    .from(taxRates)
    .where(and(eq(taxRates.tenantId, getTenantId()), inArray(taxRates.id, rateIds)));
  const rates = new Map(rateRows.map((row) => [row.id, row]));
  const priced = lines.map((line, index): ResolvedSalesLine | null => {
    const rate = rates.get(line.taxRateId);
    if (rate === undefined || (rate.archivedAt !== null && !keptRateIds.has(rate.id))) {
      issues.push({ path: linePath(index, 'taxRateId'), code: 'tax_rate_invalid' });
      return null;
    }
    const item = resolved[index];
    if (item === undefined || item === null) return null;
    return {
      ...item,
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discount: line.discount,
      taxRate: { id: rate.id, name: rate.name, kind: rate.kind, rate: rate.rate },
      amounts: lineAmounts(
        {
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountType: line.discountType,
          discount: line.discount,
          rate: rate.rate,
        },
        pricesIncludeVat,
      ),
    };
  });
  // Every problem of every line at once, items and rates together
  if (issues.length > 0) throw linesError(issues);
  return priced.flatMap((line) => (line === null ? [] : [line]));
}
