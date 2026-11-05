import type { Product } from '@omnivo/contracts';
import { productBarcodes, type products, productUnits, productVariants } from '@omnivo/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

type ProductRow = typeof products.$inferSelect;

// Whole products from their rows: the variants, packs and barcodes of all of them in three
// queries, however many there are. The product page reads one; the sync's pull (step 18a) reads a
// page of up to 1000, and three queries per product would be 3000 round trips. The answer keeps the
// order of `rows`.
export async function productsOf(tx: Transaction, rows: ProductRow[]): Promise<Product[]> {
  if (rows.length === 0) return [];
  const tenantId = getTenantId();
  const ids = rows.map((row) => row.id);
  const [variants, packs, barcodes] = await Promise.all([
    tx
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.productId, ids)))
      .orderBy(asc(productVariants.position)),
    tx
      .select()
      .from(productUnits)
      .where(and(eq(productUnits.tenantId, tenantId), inArray(productUnits.productId, ids)))
      .orderBy(asc(productUnits.position)),
    tx
      .select()
      .from(productBarcodes)
      .where(and(eq(productBarcodes.tenantId, tenantId), inArray(productBarcodes.productId, ids))),
  ]);
  const variantsOf = groupBy(variants, (variant) => variant.productId);
  const packsOf = groupBy(packs, (pack) => pack.productId);
  // A barcode belongs to a variant (no unit) or to a pack (its unit). A pack's unit is unique per
  // product only, so the pack's map is keyed by the product too.
  const variantBarcode = new Map(
    barcodes.flatMap((barcode) =>
      barcode.unitId === null ? [[barcode.variantId, barcode.code]] : [],
    ),
  );
  const packBarcode = new Map(
    barcodes.flatMap((barcode) =>
      barcode.unitId === null ? [] : [[`${barcode.productId}:${barcode.unitId}`, barcode.code]],
    ),
  );
  return rows.map((row) => {
    const ownPacks = packsOf.get(row.id) ?? [];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      categoryId: row.categoryId,
      description: row.description,
      baseUnitId: row.baseUnitId,
      salesUnitId: ownPacks.find((pack) => pack.isSalesDefault)?.unitId ?? null,
      purchaseUnitId: ownPacks.find((pack) => pack.isPurchaseDefault)?.unitId ?? null,
      tracking: row.tracking,
      hasExpiry: row.hasExpiry,
      taxRateId: row.taxRateId,
      options: row.options,
      variants: (variantsOf.get(row.id) ?? []).map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        optionValues: variant.optionValues,
        barcode: variantBarcode.get(variant.id) ?? null,
        salePrice: variant.salePrice,
        archivedAt: variant.archivedAt?.toISOString() ?? null,
      })),
      units: ownPacks.map((pack) => ({
        unitId: pack.unitId,
        factor: pack.factor,
        barcode: packBarcode.get(`${row.id}:${pack.unitId}`) ?? null,
      })),
      customFields: row.customFields,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

// The rows of each product, in the order the query gave them
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
