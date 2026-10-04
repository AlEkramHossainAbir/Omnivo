import {
  type CustomFieldValues,
  customFieldsInputSchema,
  type ErrorCode,
  isErrorCode,
  type ProductInput,
  sameFactor,
  standardFactor,
  variantSku,
} from '@omnivo/contracts';
import {
  customFieldDefinitions,
  productBarcodes,
  productCategories,
  products,
  productUnits,
  productVariants,
  units,
} from '@omnivo/db';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// What both the API (one product from the form) and the import job (thousands from a CSV) need
// to check a product against the database and write it. One place, so a product that the form
// refuses is refused by the import too — with the same error codes on the same paths.

type UnitRow = typeof units.$inferSelect;

// A problem on one field, by the form's path: "units.0.factor", "customFields.gsm"
export interface ProductIssue {
  path: string;
  code: ErrorCode;
}

// The workspace's units, categories and active product fields: read once per request or per
// import, not once per product
export interface ProductContext {
  units: Map<string, UnitRow>;
  categoryIds: Set<string>;
  fields: (typeof customFieldDefinitions.$inferSelect)[];
}

export async function loadProductContext(tx: Transaction): Promise<ProductContext> {
  const tenantId = getTenantId();
  const [unitRows, categoryRows, fieldRows] = await Promise.all([
    tx.select().from(units).where(eq(units.tenantId, tenantId)),
    tx
      .select({ id: productCategories.id })
      .from(productCategories)
      .where(eq(productCategories.tenantId, tenantId)),
    tx
      .select()
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.tenantId, tenantId),
          eq(customFieldDefinitions.entity, 'product'),
          isNull(customFieldDefinitions.archivedAt),
        ),
      )
      .orderBy(customFieldDefinitions.id),
  ]);
  return {
    units: new Map(unitRows.map((row) => [row.id, row])),
    categoryIds: new Set(categoryRows.map((row) => row.id)),
    fields: fieldRows,
  };
}

// The checks the contract cannot do, because they need the workspace's data: the units exist and
// are active, a standard conversion is exactly right, the category exists, the custom fields fit
// the workspace's fields. `keepUnits`: units the product already uses stay allowed after being
// archived ("products that use it keep it"). `saved`: the product's stored custom fields — the
// values of archived fields are kept, the form never sends them.
export function checkProduct(
  input: ProductInput,
  context: ProductContext,
  keepUnits: ReadonlySet<string> = new Set(),
  saved: CustomFieldValues = {},
): { issues: ProductIssue[]; customFields: CustomFieldValues } {
  const issues: ProductIssue[] = [];
  const usable = (id: string): UnitRow | undefined => {
    const unit = context.units.get(id);
    return unit && (unit.archivedAt === null || keepUnits.has(id)) ? unit : undefined;
  };

  if (input.categoryId !== null && !context.categoryIds.has(input.categoryId)) {
    issues.push({ path: 'categoryId', code: 'product_category_invalid' });
  }
  const base = usable(input.baseUnitId);
  if (!base) issues.push({ path: 'baseUnitId', code: 'product_unit_invalid' });
  input.units.forEach((pack, index) => {
    const unit = usable(pack.unitId);
    if (!unit) {
      issues.push({ path: `units.${String(index)}.unitId`, code: 'product_unit_invalid' });
      return;
    }
    // A dozen is 12 pieces in every product. Only a pack (no ratio) or another dimension (eggs
    // sold by the piece and bought by the kg) takes the number the person typed.
    const standard = base ? standardFactor(unit, base) : null;
    if (standard !== null && base && !sameFactor(standard, pack.factor)) {
      issues.push({ path: `units.${String(index)}.factor`, code: 'product_factor_standard' });
    }
  });

  const parsed = customFieldsInputSchema(context.fields).safeParse(input.customFields);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        path: ['customFields', ...issue.path.map(String)].join('.'),
        code: isErrorCode(issue.message) ? issue.message : 'invalid_value',
      });
    }
  }
  const activeKeys = new Set(context.fields.map((field) => field.key));
  const kept = Object.fromEntries(Object.entries(saved).filter(([key]) => !activeKeys.has(key)));
  return { issues, customFields: { ...kept, ...(parsed.data ?? {}) } };
}

// resolveSkus() gives one SKU per variant, so a missing one is a bug here, never the person's input
export function skuAt(skus: readonly string[], position: number): string {
  const sku = skus[position];
  if (sku === undefined) throw new Error(`No SKU for variant ${String(position)}`);
  return sku;
}

// The SKUs a product's variants get: the typed one, or one made from the product's code
export function resolveSkus(input: ProductInput, code: string): string[] {
  return input.variants.map((variant) => variant.sku ?? variantSku(code, variant.optionValues));
}

// Which of these codes, SKUs and barcodes another product already uses (case-insensitive for
// codes and SKUs, like their unique indexes). Asked before writing, so the answer can name the
// field; the unique indexes stay the real guard against two saves at the same moment.
export async function findTaken(
  tx: Transaction,
  wanted: { codes: string[]; skus: string[]; barcodes: string[] },
  exceptProductId?: string,
): Promise<{ codes: Set<string>; skus: Set<string>; barcodes: Set<string> }> {
  const tenantId = getTenantId();
  const lower = (values: string[]) => [...new Set(values.map((value) => value.toLowerCase()))];
  const notThis = (column: typeof products.id | typeof productVariants.productId) =>
    exceptProductId === undefined ? undefined : ne(column, exceptProductId);
  const [codes, skus, barcodes] = await Promise.all([
    wanted.codes.length === 0
      ? []
      : tx
          .select({ value: sql<string>`lower(${products.code})` })
          .from(products)
          .where(
            and(
              eq(products.tenantId, tenantId),
              inArray(sql`lower(${products.code})`, lower(wanted.codes)),
              notThis(products.id),
            ),
          ),
    wanted.skus.length === 0
      ? []
      : tx
          .select({ value: sql<string>`lower(${productVariants.sku})` })
          .from(productVariants)
          .where(
            and(
              eq(productVariants.tenantId, tenantId),
              inArray(sql`lower(${productVariants.sku})`, lower(wanted.skus)),
              notThis(productVariants.productId),
            ),
          ),
    wanted.barcodes.length === 0
      ? []
      : tx
          .select({ value: productBarcodes.code })
          .from(productBarcodes)
          .where(
            and(
              eq(productBarcodes.tenantId, tenantId),
              inArray(productBarcodes.code, [...new Set(wanted.barcodes)]),
              exceptProductId === undefined
                ? undefined
                : ne(productBarcodes.productId, exceptProductId),
            ),
          ),
  ]);
  return {
    codes: new Set(codes.map((row) => row.value)),
    skus: new Set(skus.map((row) => row.value)),
    barcodes: new Set(barcodes.map((row) => row.value)),
  };
}

// The taken values as field errors, on the field that holds each
export function takenIssues(
  input: ProductInput,
  code: string,
  skus: string[],
  taken: { codes: Set<string>; skus: Set<string>; barcodes: Set<string> },
): ProductIssue[] {
  const issues: ProductIssue[] = [];
  if (taken.codes.has(code.toLowerCase()))
    issues.push({ path: 'code', code: 'product_code_taken' });
  skus.forEach((sku, index) => {
    if (taken.skus.has(sku.toLowerCase())) {
      issues.push({ path: `variants.${String(index)}.sku`, code: 'product_sku_taken' });
    }
  });
  input.variants.forEach((variant, index) => {
    if (variant.barcode !== null && taken.barcodes.has(variant.barcode)) {
      issues.push({ path: `variants.${String(index)}.barcode`, code: 'barcode_taken' });
    }
  });
  input.units.forEach((pack, index) => {
    if (pack.barcode !== null && taken.barcodes.has(pack.barcode)) {
      issues.push({ path: `units.${String(index)}.barcode`, code: 'barcode_taken' });
    }
  });
  return issues;
}

// A product ready to write: checked, with its code, SKUs and custom fields settled
export interface PreparedProduct {
  input: ProductInput;
  code: string;
  skus: string[];
  customFields: CustomFieldValues;
}

// Postgres takes at most 65,535 values in one statement. A product row has 14 columns, so 1,000
// rows (14,000 values) per INSERT is far below the limit, and 10,000 products take ten statements
// instead of ten thousand.
const CHUNK = 1000;

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += CHUNK) {
    result.push(items.slice(start, start + CHUNK));
  }
  return result;
}

// The rows of a product's units and barcodes, from its input and its variants' new ids
function unitRows(tenantId: string, productId: string, input: ProductInput) {
  return input.units.map((pack, position) => ({
    tenantId,
    productId,
    unitId: pack.unitId,
    position,
    factor: pack.factor,
    isSalesDefault: input.salesUnitId === pack.unitId,
    isPurchaseDefault: input.purchaseUnitId === pack.unitId,
  }));
}

export function barcodeRows(
  tenantId: string,
  productId: string,
  input: ProductInput,
  variantIds: readonly string[],
) {
  const own = input.variants.flatMap((variant, index) => {
    const variantId = variantIds[index];
    return variant.barcode === null || variantId === undefined
      ? []
      : [{ tenantId, productId, variantId, code: variant.barcode, unitId: null }];
  });
  // A pack barcode is only allowed on a simple product (productRules), whose one variant it labels
  const only = variantIds[0];
  const packs = input.units.flatMap((pack) =>
    pack.barcode === null || only === undefined
      ? []
      : [{ tenantId, productId, variantId: only, code: pack.barcode, unitId: pack.unitId }],
  );
  return [...own, ...packs];
}

// Writes new products — one from the form, or thousands from an import — in a handful of
// statements per table. Returns the new ids in the order of `prepared`.
export async function insertProducts(
  tx: Transaction,
  prepared: readonly PreparedProduct[],
  userId: string,
): Promise<string[]> {
  const tenantId = getTenantId();
  const ids: string[] = [];
  for (const part of chunks(prepared)) {
    const inserted = await tx
      .insert(products)
      .values(
        part.map(({ input, code, customFields }) => ({
          tenantId,
          code,
          name: input.name,
          type: input.type,
          categoryId: input.categoryId,
          description: input.description,
          baseUnitId: input.baseUnitId,
          tracking: input.tracking,
          hasExpiry: input.hasExpiry,
          options: input.options,
          customFields,
          createdBy: userId,
          updatedBy: userId,
        })),
      )
      .returning({ id: products.id });
    // INSERT … RETURNING gives the rows back in the order of VALUES
    ids.push(...inserted.map((row) => row.id));
  }

  // Each product with its new id: from here on nothing is looked up by position in two lists
  const written = prepared.map((product, index) => {
    const id = ids[index];
    if (id === undefined) throw new Error('Product insert returned too few rows');
    return { ...product, id };
  });

  const variants = written.flatMap(({ id, input, skus }) =>
    input.variants.map((variant, position) => ({
      tenantId,
      productId: id,
      position,
      sku: skuAt(skus, position),
      optionValues: variant.optionValues,
      salePrice: variant.salePrice,
      archivedAt: variant.archived ? new Date() : null,
    })),
  );
  const variantIds: string[] = [];
  for (const part of chunks(variants)) {
    const inserted = await tx
      .insert(productVariants)
      .values(part)
      .returning({ id: productVariants.id });
    variantIds.push(...inserted.map((row) => row.id));
  }

  const packs = written.flatMap(({ id, input }) => unitRows(tenantId, id, input));
  for (const part of chunks(packs)) await tx.insert(productUnits).values(part);

  // The variants were inserted product by product, so each product's ids are the next slice
  let offset = 0;
  const barcodes = written.flatMap(({ id, input }) => {
    const own = variantIds.slice(offset, offset + input.variants.length);
    offset += input.variants.length;
    return barcodeRows(tenantId, id, input, own);
  });
  for (const part of chunks(barcodes)) await tx.insert(productBarcodes).values(part);
  return ids;
}

// The product's own units again (on an update): delete and insert. Nothing outside the product
// points at these rows — stock and sales lines (steps 13–17) hold a unit id, not a pack row.
export async function replaceUnits(
  tx: Transaction,
  productId: string,
  input: ProductInput,
): Promise<void> {
  const tenantId = getTenantId();
  await tx
    .delete(productUnits)
    .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.productId, productId)));
  const rows = unitRows(tenantId, productId, input);
  if (rows.length > 0) await tx.insert(productUnits).values(rows);
}

// Problems found before writing, as the API's answer: 409 when only "taken" values stand in the
// way (someone else has them — a conflict), 400 for everything the person typed wrong. Every field
// gets its code, so the form shows them all at once.
export function issuesError(issues: readonly ProductIssue[]): AppError {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const issue of issues) (fieldErrors[issue.path] ??= []).push(issue.code);
  const taken = issues.every((issue) => TAKEN.has(issue.code));
  const first = issues[0]?.code ?? 'invalid_input';
  return taken
    ? new AppError(409, first, 'Another product already uses one of these values.', { fieldErrors })
    : new AppError(400, 'invalid_input', 'Check the highlighted fields and try again.', {
        fieldErrors,
      });
}

const TAKEN = new Set<ErrorCode>(['product_code_taken', 'product_sku_taken', 'barcode_taken']);
