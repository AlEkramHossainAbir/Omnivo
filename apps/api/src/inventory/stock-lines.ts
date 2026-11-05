import {
  type ErrorCode,
  fitsDecimals,
  isQuantity,
  isWholeQuantity,
  type StockLine,
  toBaseQuantity,
  wholeCount,
} from '@omnivo/contracts';
import { batches, products, productUnits, productVariants, units, warehouses } from '@omnivo/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// What a stock line needs to know about its variant: how the product is counted and tracked
export interface VariantInfo {
  variantId: string;
  productId: string;
  productCode: string;
  productName: string;
  optionValues: string[];
  sku: string;
  type: string;
  tracking: string;
  hasExpiry: boolean;
  baseUnitId: string;
  // How many decimals a quantity in the base unit may have (pcs 0, kg 3)
  baseDecimals: number;
  // The product or the variant is archived
  archived: boolean;
  // The packs, in the product's order: a carton = "24", typed with up to `decimals` places
  units: { unitId: string; factor: string; decimals: number }[];
}

// The variants of these ids, with their packs. lock: FOR SHARE on the products while a document
// is posted — until we commit, nobody changes a product's base unit or tracking under us
// (ProductsService locks FOR UPDATE and then checks for movements).
export async function loadVariants(
  tx: Transaction,
  variantIds: readonly string[],
  { lock = false }: { lock?: boolean } = {},
): Promise<Map<string, VariantInfo>> {
  const tenantId = getTenantId();
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return new Map();
  const query = tx
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productCode: products.code,
      productName: products.name,
      optionValues: productVariants.optionValues,
      sku: productVariants.sku,
      type: products.type,
      tracking: products.tracking,
      hasExpiry: products.hasExpiry,
      baseUnitId: products.baseUnitId,
      baseDecimals: units.decimals,
      productArchivedAt: products.archivedAt,
      variantArchivedAt: productVariants.archivedAt,
    })
    .from(productVariants)
    .innerJoin(
      products,
      and(
        eq(products.tenantId, productVariants.tenantId),
        eq(products.id, productVariants.productId),
      ),
    )
    .innerJoin(units, and(eq(units.tenantId, products.tenantId), eq(units.id, products.baseUnitId)))
    .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.id, ids)));
  const rows = lock ? await query.for('share', { of: products }) : await query;

  const productIds = [...new Set(rows.map((row) => row.productId))];
  const packs =
    productIds.length === 0
      ? []
      : await tx
          .select({
            productId: productUnits.productId,
            unitId: productUnits.unitId,
            factor: productUnits.factor,
            decimals: units.decimals,
          })
          .from(productUnits)
          .innerJoin(
            units,
            and(eq(units.tenantId, productUnits.tenantId), eq(units.id, productUnits.unitId)),
          )
          .where(
            and(eq(productUnits.tenantId, tenantId), inArray(productUnits.productId, productIds)),
          )
          .orderBy(asc(productUnits.position));

  return new Map(
    rows.map((row) => [
      row.variantId,
      {
        variantId: row.variantId,
        productId: row.productId,
        productCode: row.productCode,
        productName: row.productName,
        optionValues: row.optionValues,
        sku: row.sku,
        type: row.type,
        tracking: row.tracking,
        hasExpiry: row.hasExpiry,
        baseUnitId: row.baseUnitId,
        baseDecimals: row.baseDecimals,
        archived: row.productArchivedAt !== null || row.variantArchivedAt !== null,
        units: packs
          .filter((pack) => pack.productId === row.productId)
          .map((pack) => ({ unitId: pack.unitId, factor: pack.factor, decimals: pack.decimals })),
      },
    ]),
  );
}

// Many problems at once, each under its own field ("lines.2.quantity"), like a form's errors: the
// person fixes every line in one go instead of meeting them one by one
export interface LineIssue {
  path: string;
  code: ErrorCode;
}

export function linesError(issues: readonly LineIssue[]): AppError {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const issue of issues) (fieldErrors[issue.path] ??= []).push(issue.code);
  const [first] = issues;
  return new AppError(
    409,
    first?.code ?? 'invalid_input',
    'Some lines cannot be used. Check the highlighted fields.',
    { fieldErrors },
  );
}

export function linePath(index: number, field: string): string {
  return `lines.${String(index)}.${field}`;
}

// A line as the form sends it. Lot and dates only on lines that bring stock in.
export interface LineInput {
  variantId: string;
  unitId: string;
  quantity: string;
  batchId: string | null;
  serialNumbers: string[];
  lotNumber?: string | null;
  expiresOn?: string | null;
  manufacturedOn?: string | null;
}

// A line checked against its product: the factor and the base quantity worked out, and the
// fields that do not apply to its tracking cleared
export interface ResolvedLine {
  variant: VariantInfo;
  unitId: string;
  quantity: string;
  factor: string;
  baseQuantity: string;
  batchId: string | null;
  lotNumber: string | null;
  expiresOn: string | null;
  manufacturedOn: string | null;
  serialNumbers: string[];
}

// 'in' brings stock in (a lot is typed and becomes a batch when posted); 'out' takes it out or
// moves it (an existing batch is picked). Archived products can still leave — their remaining
// stock has to go somewhere — but nothing new comes in for them.
export type LineMode = 'in' | 'out';

// Every rule of a line that does not depend on what is in stock: the variant is a stocked product
// of this workspace, the unit is its base unit or one of its packs, the quantity fits the unit,
// and the batch or serial numbers match the product's tracking. Stock itself is checked when the
// document is posted (StockPostingService), because a draft moves nothing.
export async function resolveLines(
  tx: Transaction,
  lines: readonly LineInput[],
  mode: LineMode,
  { lock = false }: { lock?: boolean } = {},
): Promise<ResolvedLine[]> {
  const tenantId = getTenantId();
  const variants = await loadVariants(
    tx,
    lines.map((line) => line.variantId),
    { lock },
  );
  const issues: LineIssue[] = [];
  const resolved: ResolvedLine[] = [];

  // The batches named by "out" lines, to check they belong to their line's variant
  const batchIds = [
    ...new Set(lines.flatMap((line) => (line.batchId === null ? [] : [line.batchId]))),
  ];
  const known =
    batchIds.length === 0
      ? []
      : await tx
          .select({ id: batches.id, variantId: batches.variantId })
          .from(batches)
          .where(and(eq(batches.tenantId, tenantId), inArray(batches.id, batchIds)));
  const batchVariant = new Map(known.map((batch) => [batch.id, batch.variantId]));

  lines.forEach((line, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: linePath(index, field), code });
    };
    const variant = variants.get(line.variantId);
    // The same answer for "no such variant", "another workspace's", "a service" and (coming in)
    // "archived": pick a stocked product from the list
    if (variant?.type !== 'goods' || (mode === 'in' && variant.archived)) {
      at('variantId', 'stock_variant_invalid');
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
    const { factor } = unit;
    if (!isQuantity(line.quantity)) {
      at('quantity', 'quantity_format');
      return;
    }
    // 1.5 boxes, or 2.5 pcs: more decimals than the unit allows (a box and a piece allow none)
    if (!fitsDecimals(line.quantity, unit.decimals)) {
      at('quantity', 'stock_quantity_decimals');
      return;
    }
    // Rounded to the base unit's decimals: 3 yards = 2.74 m when metres keep 2
    const baseQuantity = toBaseQuantity(line.quantity, factor, variant.baseDecimals);
    if (!isQuantity(baseQuantity)) {
      // Rounded to nothing: 0.001 of a yard in whole metres
      at('quantity', 'quantity_format');
      return;
    }

    let batchId: string | null = null;
    let lotNumber: string | null = null;
    let expiresOn: string | null = null;
    let manufacturedOn: string | null = null;
    let serialNumbers: string[] = [];

    if (variant.tracking === 'batch') {
      if (mode === 'in') {
        lotNumber = line.lotNumber ?? null;
        expiresOn = line.expiresOn ?? null;
        manufacturedOn = line.manufacturedOn ?? null;
        // The expiry is asked for when the lot is new (StockPostingService.resolveBatches): more of
        // a known lot takes the expiry it already has
        if (lotNumber === null) at('lotNumber', 'stock_lot_required');
      } else {
        batchId = line.batchId;
        if (batchId === null) at('batchId', 'stock_batch_required');
        else if (batchVariant.get(batchId) !== variant.variantId)
          at('batchId', 'stock_batch_invalid');
      }
    }
    if (variant.tracking === 'serial') {
      serialNumbers = line.serialNumbers;
      // One serial number per base unit: 3 phones, 3 IMEIs
      if (!isWholeQuantity(baseQuantity) || wholeCount(baseQuantity) !== serialNumbers.length) {
        at('serialNumbers', 'stock_serial_count');
      }
    }

    resolved.push({
      variant,
      unitId: line.unitId,
      quantity: line.quantity,
      factor,
      baseQuantity,
      batchId,
      lotNumber,
      expiresOn,
      manufacturedOn,
      serialNumbers,
    });
  });

  if (issues.length > 0) throw linesError(issues);
  return resolved;
}

// A warehouse a new document may use: this workspace's, and not archived. FOR SHARE: nobody
// archives it until we commit (WarehousesService locks it FOR UPDATE).
export async function assertWarehousesActive(
  tx: Transaction,
  places: readonly { field: string; warehouseId: string }[],
): Promise<void> {
  const ids = [...new Set(places.map((place) => place.warehouseId))];
  const rows = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.tenantId, getTenantId()),
        inArray(warehouses.id, ids),
        isNull(warehouses.archivedAt),
      ),
    )
    .for('share');
  const active = new Set(rows.map((row) => row.id));
  const bad = places.filter((place) => !active.has(place.warehouseId));
  if (bad.length > 0) {
    throw new AppError(409, 'stock_warehouse_invalid', 'Pick an active warehouse.', {
      fieldErrors: Object.fromEntries(
        bad.map((place) => [place.field, ['stock_warehouse_invalid']]),
      ),
    });
  }
}

// A stored line, with its variant, in the shape the API sends (StockLine)
export function toStockLine(
  row: {
    id: string;
    unitId: string;
    quantity: string;
    baseQuantity: string;
    batchId: string | null;
    serialNumbers: string[];
    lotNumber?: string | null;
    expiresOn?: string | null;
    manufacturedOn?: string | null;
  },
  variant: VariantInfo,
  batch: { lotNumber: string; expiresOn: string | null; manufacturedOn: string | null } | undefined,
): StockLine {
  return {
    id: row.id,
    variantId: variant.variantId,
    productId: variant.productId,
    productCode: variant.productCode,
    productName: variant.productName,
    optionValues: variant.optionValues,
    sku: variant.sku,
    baseUnitId: variant.baseUnitId,
    tracking: variant.tracking,
    hasExpiry: variant.hasExpiry,
    units: variant.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
    unitId: row.unitId,
    quantity: row.quantity,
    baseQuantity: row.baseQuantity,
    batchId: row.batchId,
    // An "out" line shows its batch's lot; an "in" line its own until the batch exists
    lotNumber: batch?.lotNumber ?? row.lotNumber ?? null,
    expiresOn: batch?.expiresOn ?? row.expiresOn ?? null,
    manufacturedOn: batch?.manufacturedOn ?? row.manufacturedOn ?? null,
    serialNumbers: row.serialNumbers,
  };
}

interface BatchDates {
  id: string;
  lotNumber: string;
  expiresOn: string | null;
  manufacturedOn: string | null;
}

// The lots and dates of the batches some lines point at
export async function batchesOf(
  tx: Transaction,
  batchIds: readonly (string | null)[],
): Promise<Map<string, BatchDates>> {
  const ids = [...new Set(batchIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: batches.id,
      lotNumber: batches.lotNumber,
      expiresOn: batches.expiresOn,
      manufacturedOn: batches.manufacturedOn,
    })
    .from(batches)
    .where(and(eq(batches.tenantId, getTenantId()), inArray(batches.id, ids)));
  return new Map(rows.map((row) => [row.id, row]));
}
