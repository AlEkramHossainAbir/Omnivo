import { Inject, Injectable } from '@nestjs/common';
import {
  type ErrorCode,
  type Product,
  type ProductInput,
  type ProductPage,
  type ProductSort,
  todayIn,
  type UpdateProductInput,
} from '@omnivo/contracts';
import {
  productBarcodes,
  productCategories,
  products,
  productUnits,
  productVariants,
  stockMovements,
  tenantSettings,
  units,
} from '@omnivo/db';
import { and, asc, eq, inArray, notInArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  barcodeRows,
  checkProduct,
  findTaken,
  insertProducts,
  issuesError,
  loadProductContext,
  type ProductIssue,
  replaceUnits,
  resolveSkus,
  skuAt,
  takenIssues,
} from './product-write.js';

type ProductRow = typeof products.$inferSelect;

// Rows that hold on to a variant (and so to its product). Deleting either is refused while one of
// them exists; the API turns the foreign key's error into product_in_use / product_variant_in_use.
// reorder_levels is not here: a variant's levels go with it (ON DELETE CASCADE).
const VARIANT_IN_USE = [
  'batches_variant_fk',
  'serials_variant_fk',
  'stock_movements_variant_fk',
  'stock_balances_variant_fk',
  'stock_adjustment_lines_variant_fk',
  'stock_transfer_lines_variant_fk',
] as const;

// The list's orders. Each sorts by one key and then the id, so the order is total and a cursor
// (the last row's key and id) says exactly where the next page starts — never OFFSET.
const ORDERS = {
  name: { key: sql`lower(p.name)`, desc: false },
  '-name': { key: sql`lower(p.name)`, desc: true },
  code: { key: sql`lower(p.code)`, desc: false },
  '-code': { key: sql`lower(p.code)`, desc: true },
  // updated_at::text keeps the microseconds; a JavaScript Date would round them away, and a
  // cursor a few microseconds off skips or repeats a row
  '-updated': { key: sql`p.updated_at`, desc: true },
} satisfies Record<ProductSort, { key: SQL; desc: boolean }>;

const cursorSchema = z.tuple([z.string(), z.uuid()]);

const summaryRowSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  category_id: z.uuid().nullable(),
  base_unit_id: z.uuid(),
  tracking: z.string(),
  has_variants: z.boolean(),
  variant_count: z.number().int(),
  min_price: z.string().nullable(),
  max_price: z.string().nullable(),
  archived_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime(),
  sort_key: z.string(),
});

// Drizzle's postgres-js driver leaves timestamps of a raw query as Postgres's own text
// ("2026-10-04 09:55:01.12+00"), which is not ISO. The query writes them as ISO itself, in UTC
// with milliseconds — the shape every other answer of the API has.
function isoText(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

// LIKE's own wildcards in what the person typed are meant literally: "10%" finds "10% off"
function containsPattern(search: string): string {
  return `%${search.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// What the audit log shows of a product: what a person would recognise, not ids
interface Snapshot {
  [field: string]: string | number | null;
  code: string;
  name: string;
  type: string;
  category: string | null;
  baseUnit: string | null;
  tracking: string;
  variants: number;
  packs: string | null;
}

@Injectable()
export class ProductsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    search?: string | undefined;
    categoryId?: string | undefined;
    status: 'active' | 'archived';
    sort: ProductSort;
  }): Promise<ProductPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    const order = ORDERS[query.sort];
    const compare = order.desc ? sql`<` : sql`>`;
    const direction = order.desc ? sql`DESC` : sql`ASC`;
    const conditions: SQL[] = [
      sql`p.tenant_id = ${tenantId}::uuid`,
      query.status === 'active' ? sql`p.archived_at IS NULL` : sql`p.archived_at IS NOT NULL`,
    ];
    if (query.categoryId !== undefined) {
      // The category and everything under it: "Finished garments" shows the T-shirts too
      conditions.push(sql`p.category_id IN (
        WITH RECURSIVE down AS (
          SELECT id FROM product_categories WHERE tenant_id = ${tenantId}::uuid AND id = ${query.categoryId}::uuid
          UNION ALL
          SELECT c.id FROM product_categories c JOIN down ON c.parent_id = down.id
           WHERE c.tenant_id = ${tenantId}::uuid
        ) SELECT id FROM down)`);
    }
    if (query.search !== undefined && query.search !== '') {
      const pattern = containsPattern(query.search);
      // A barcode is matched whole: a scan into the search box is the whole code, and part of a
      // barcode means nothing to anyone
      conditions.push(sql`(
        lower(p.name) LIKE ${pattern} OR lower(p.code) LIKE ${pattern}
        OR EXISTS (SELECT 1 FROM product_variants v
                    WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id AND lower(v.sku) LIKE ${pattern})
        OR EXISTS (SELECT 1 FROM product_barcodes b
                    WHERE b.tenant_id = p.tenant_id AND b.product_id = p.id AND b.code = ${query.search}))`);
    }
    if (after !== undefined) {
      const key = query.sort === '-updated' ? sql`${after[0]}::timestamptz` : sql`${after[0]}`;
      conditions.push(sql`(${order.key}, p.id) ${compare} (${key}, ${after[1]}::uuid)`);
    }

    return this.withTenant(async (tx) => {
      const rows = z.array(summaryRowSchema).parse(
        await tx.execute(sql`
          SELECT p.id::text, p.code, p.name, p.type, p.category_id::text, p.base_unit_id::text,
                 p.tracking, jsonb_array_length(p.options) > 0 AS has_variants,
                 s.variant_count, s.min_price, s.max_price,
                 ${isoText(sql`p.archived_at`)} AS archived_at, ${isoText(sql`p.updated_at`)} AS updated_at,
                 ${order.key}::text AS sort_key
            FROM products p
            LEFT JOIN LATERAL (
              SELECT count(*)::int AS variant_count,
                     min(v.sale_price)::text AS min_price, max(v.sale_price)::text AS max_price
                FROM product_variants v
               WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id AND v.archived_at IS NULL
            ) s ON true
           WHERE ${sql.join(conditions, sql` AND `)}
           ORDER BY ${order.key} ${direction}, p.id ${direction}
           LIMIT ${query.limit + 1}`),
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          type: row.type,
          categoryId: row.category_id,
          baseUnitId: row.base_unit_id,
          tracking: row.tracking,
          hasVariants: row.has_variants,
          variantCount: row.variant_count,
          minPrice: row.min_price,
          maxPrice: row.max_price,
          archivedAt: row.archived_at,
          updatedAt: row.updated_at,
        })),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor([last.sort_key, last.id])
            : null,
      };
    });
  }

  get(id: string): Promise<Product> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: ProductInput): Promise<Product> {
    try {
      return await this.withTenant(async (tx) => {
        const context = await loadProductContext(tx);
        const checked = checkProduct(input, context);
        if (checked.issues.length > 0) throw issuesError(checked.issues);
        const code = input.code ?? (await this.newCode(tx));
        const skus = resolveSkus(input, code);
        const taken = await findTaken(tx, { codes: [code], skus, barcodes: barcodesOf(input) });
        const conflicts = takenIssues(input, code, skus, taken);
        if (conflicts.length > 0) throw issuesError(conflicts);

        const [id] = await insertProducts(
          tx,
          [{ input, code, skus, customFields: checked.customFields }],
          currentPrincipal().userId,
        );
        if (id === undefined) throw new Error('Product insert returned no id');
        const product = await this.read(tx, id);
        await audit(tx, {
          action: 'product.created',
          entityType: 'product',
          entityId: id,
          changes: created(await this.snapshot(tx, product)),
        });
        return product;
      });
    } catch (error) {
      throw racedError(error);
    }
  }

  async update(id: string, input: UpdateProductInput): Promise<Product> {
    const tenantId = getTenantId();
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        const old = await this.read(tx, id);
        const context = await loadProductContext(tx);
        const keep = new Set([old.baseUnitId, ...old.units.map((pack) => pack.unitId)]);
        const checked = checkProduct(input, context, keep, before.customFields);
        // An id sent back must be one of this product's own variants, and only once
        const known = new Set(old.variants.map((variant) => variant.id));
        const seen = new Set<string>();
        const unknown: ProductIssue[] = input.variants.flatMap((variant, index) => {
          if (variant.id === null) return [];
          const bad = !known.has(variant.id) || seen.has(variant.id);
          seen.add(variant.id);
          return bad
            ? [{ path: `variants.${String(index)}.id`, code: 'product_variant_unknown' }]
            : [];
        });
        const issues = [...checked.issues, ...unknown];
        if (issues.length > 0) throw issuesError(issues);
        await this.assertMeaningKept(tx, before, input);

        // An empty code on an existing product keeps the one it has
        const code = input.code ?? before.code;
        const skus = resolveSkus(input, code);
        const taken = await findTaken(tx, { codes: [code], skus, barcodes: barcodesOf(input) }, id);
        const conflicts = takenIssues(input, code, skus, taken);
        if (conflicts.length > 0) throw issuesError(conflicts);

        await tx
          .update(products)
          .set({
            code,
            name: input.name,
            type: input.type,
            categoryId: input.categoryId,
            description: input.description,
            baseUnitId: input.baseUnitId,
            tracking: input.tracking,
            hasExpiry: input.hasExpiry,
            options: input.options,
            customFields: checked.customFields,
            version: sql`${products.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(products.tenantId, tenantId), eq(products.id, id)));
        await replaceUnits(tx, id, input);
        const variantIds = await this.replaceVariants(tx, id, input, skus, old);
        await tx
          .delete(productBarcodes)
          .where(and(eq(productBarcodes.tenantId, tenantId), eq(productBarcodes.productId, id)));
        const barcodes = barcodeRows(tenantId, id, input, variantIds);
        if (barcodes.length > 0) await tx.insert(productBarcodes).values(barcodes);

        const product = await this.read(tx, id);
        await audit(tx, {
          action: 'product.updated',
          entityType: 'product',
          entityId: id,
          changes: diff(await this.snapshot(tx, old), await this.snapshot(tx, product)),
        });
        return product;
      });
    } catch (error) {
      if (VARIANT_IN_USE.some((constraint) => isForeignKeyViolation(error, constraint))) {
        throw new AppError(409, 'product_variant_in_use', 'Archive the variant instead.');
      }
      throw racedError(error);
    }
  }

  setArchived(id: string, version: number, archived: boolean): Promise<Product> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) !== archived) {
        await tx
          .update(products)
          .set({
            archivedAt: archived ? new Date() : null,
            version: sql`${products.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(products.tenantId, getTenantId()), eq(products.id, id)));
        await audit(tx, {
          action: archived ? 'product.archived' : 'product.restored',
          entityType: 'product',
          entityId: id,
        });
      }
      return this.read(tx, id);
    });
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== version) throw versionConflict();
        const old = await this.read(tx, id);
        // Variants, packs and barcodes go with it (ON DELETE CASCADE)
        await tx
          .delete(products)
          .where(and(eq(products.tenantId, getTenantId()), eq(products.id, id)));
        const gone = await this.snapshot(tx, old);
        await audit(tx, {
          action: 'product.deleted',
          entityType: 'product',
          entityId: id,
          changes: diff(gone, { code: null, name: null }),
        });
      });
    } catch (error) {
      // A batch, a serial number, a stock movement or a stock document line points at a variant:
      // the product has a history and stays
      if (VARIANT_IN_USE.some((constraint) => isForeignKeyViolation(error, constraint))) {
        throw new AppError(409, 'product_in_use', 'Archive this product instead.');
      }
      throw error;
    }
  }

  // Once a product has stock, its base unit, tracking and type say what that stock means: 120 is
  // 120 pieces, in these batches. Changing them would silently turn it into 120 kg, or stock
  // without batches. FOR UPDATE on the product (lock() above) against StockPostingService's
  // FOR SHARE: no document is posting for it while we look.
  private async assertMeaningKept(
    tx: Transaction,
    before: ProductRow,
    input: UpdateProductInput,
  ): Promise<void> {
    const changed = {
      baseUnitId: input.baseUnitId !== before.baseUnitId,
      tracking: input.tracking !== before.tracking,
      type: input.type !== before.type,
    };
    if (!changed.baseUnitId && !changed.tracking && !changed.type) return;
    const [moved] = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(
        and(eq(stockMovements.tenantId, getTenantId()), eq(stockMovements.productId, before.id)),
      )
      .limit(1);
    if (!moved) return;
    const fieldErrors: Record<string, ErrorCode[]> = {};
    if (changed.baseUnitId) fieldErrors.baseUnitId = ['product_base_unit_locked'];
    if (changed.tracking) fieldErrors.tracking = ['product_tracking_locked'];
    if (changed.type) fieldErrors.type = ['product_type_locked'];
    const [code] = Object.values(fieldErrors).flat();
    throw new AppError(
      409,
      code ?? 'product_base_unit_locked',
      'This product has stock: its base unit, tracking and type stay as they are.',
      { fieldErrors },
    );
  }

  // The next free code: the series may hand out a code someone typed by hand before (P-00007
  // typed on a product, then the series reaches 7). Such numbers are skipped, not refused.
  private async newCode(tx: Transaction): Promise<string> {
    const today = await this.today(tx);
    for (;;) {
      const code = await this.numbering.next(tx, 'inventory.product', today);
      const taken = await findTaken(tx, { codes: [code], skus: [], barcodes: [] });
      if (!taken.codes.has(code.toLowerCase())) return code;
    }
  }

  private async today(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    return todayIn(settings?.timezone ?? 'Asia/Dhaka');
  }

  // Variants on an update: the ones not sent are deleted, the ones sent with an id are changed in
  // place (their id — and from step 13 their stock — stays), the new ones are inserted. Returns
  // every variant's id in the order of input.variants.
  private async replaceVariants(
    tx: Transaction,
    productId: string,
    input: ProductInput,
    skus: string[],
    old: Product,
  ): Promise<string[]> {
    const tenantId = getTenantId();
    const ofProduct = and(
      eq(productVariants.tenantId, tenantId),
      eq(productVariants.productId, productId),
    );
    const keptIds = input.variants.flatMap((variant) => (variant.id === null ? [] : [variant.id]));
    await tx
      .delete(productVariants)
      .where(
        keptIds.length === 0 ? ofProduct : and(ofProduct, notInArray(productVariants.id, keptIds)),
      );
    if (keptIds.length > 0) {
      // Two variants may swap SKUs or values (S ↔ M typed the other way round). Changed one by one,
      // the first update would hit the unique index on the value the second still holds. So first
      // every kept variant gets a value nobody else can have: its own id.
      await tx
        .update(productVariants)
        .set({
          sku: sql`${productVariants.id}::text`,
          optionValues: sql`ARRAY[${productVariants.id}::text]`,
        })
        .where(and(ofProduct, inArray(productVariants.id, keptIds)));
    }
    const archivedAt = new Map(old.variants.map((variant) => [variant.id, variant.archivedAt]));
    const ids: string[] = [];
    for (const [position, variant] of input.variants.entries()) {
      const fields = {
        position,
        sku: skuAt(skus, position),
        optionValues: variant.optionValues,
        salePrice: variant.salePrice,
      };
      if (variant.id === null) {
        const [row] = await tx
          .insert(productVariants)
          .values({
            tenantId,
            productId,
            ...fields,
            archivedAt: variant.archived ? new Date() : null,
          })
          .returning({ id: productVariants.id });
        if (!row) throw new Error('Variant insert returned no row');
        ids.push(row.id);
        continue;
      }
      // An archived variant keeps the day it was archived
      const was = archivedAt.get(variant.id) ?? null;
      await tx
        .update(productVariants)
        .set({
          ...fields,
          archivedAt: variant.archived ? (was === null ? new Date() : new Date(was)) : null,
          updatedAt: new Date(),
        })
        .where(and(ofProduct, eq(productVariants.id, variant.id)));
      ids.push(variant.id);
    }
    return ids;
  }

  private async lock(tx: Transaction, id: string): Promise<ProductRow> {
    const [row] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, getTenantId()), eq(products.id, id)))
      .for('update');
    if (!row) throw notFound('Product');
    return row;
  }

  // The whole product: its row, variants, units and barcodes, in four small queries
  private async read(tx: Transaction, id: string): Promise<Product> {
    const tenantId = getTenantId();
    const [row] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)));
    if (!row) throw notFound('Product');
    const [variants, packs, barcodes] = await Promise.all([
      tx
        .select()
        .from(productVariants)
        .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, id)))
        .orderBy(asc(productVariants.position)),
      tx
        .select()
        .from(productUnits)
        .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.productId, id)))
        .orderBy(asc(productUnits.position)),
      tx
        .select()
        .from(productBarcodes)
        .where(and(eq(productBarcodes.tenantId, tenantId), eq(productBarcodes.productId, id))),
    ]);
    const variantBarcode = new Map(
      barcodes.flatMap((barcode) =>
        barcode.unitId === null ? [[barcode.variantId, barcode.code]] : [],
      ),
    );
    const packBarcode = new Map(
      barcodes.flatMap((barcode) =>
        barcode.unitId === null ? [] : [[barcode.unitId, barcode.code]],
      ),
    );
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      categoryId: row.categoryId,
      description: row.description,
      baseUnitId: row.baseUnitId,
      salesUnitId: packs.find((pack) => pack.isSalesDefault)?.unitId ?? null,
      purchaseUnitId: packs.find((pack) => pack.isPurchaseDefault)?.unitId ?? null,
      tracking: row.tracking,
      hasExpiry: row.hasExpiry,
      options: row.options,
      variants: variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        optionValues: variant.optionValues,
        barcode: variantBarcode.get(variant.id) ?? null,
        salePrice: variant.salePrice,
        archivedAt: variant.archivedAt?.toISOString() ?? null,
      })),
      units: packs.map((pack) => ({
        unitId: pack.unitId,
        factor: pack.factor,
        barcode: packBarcode.get(pack.unitId) ?? null,
      })),
      customFields: row.customFields,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async snapshot(tx: Transaction, product: Product): Promise<Snapshot> {
    const tenantId = getTenantId();
    const unitIds = [product.baseUnitId, ...product.units.map((pack) => pack.unitId)];
    const [unitRows, [category]] = await Promise.all([
      tx
        .select({ id: units.id, code: units.code })
        .from(units)
        .where(and(eq(units.tenantId, tenantId), inArray(units.id, unitIds))),
      product.categoryId === null
        ? [undefined]
        : tx
            .select({ name: productCategories.name })
            .from(productCategories)
            .where(
              and(
                eq(productCategories.tenantId, tenantId),
                eq(productCategories.id, product.categoryId),
              ),
            ),
    ]);
    const codeOf = new Map(unitRows.map((unit) => [unit.id, unit.code]));
    const packs = product.units
      .map((pack) => `${codeOf.get(pack.unitId) ?? '?'} = ${pack.factor.replace(/\.?0+$/, '')}`)
      .join(', ');
    return {
      code: product.code,
      name: product.name,
      type: product.type,
      category: category?.name ?? null,
      baseUnit: codeOf.get(product.baseUnitId) ?? null,
      tracking: product.tracking,
      variants: product.variants.filter((variant) => variant.archivedAt === null).length,
      packs: packs === '' ? null : packs,
    };
  }
}

function barcodesOf(input: ProductInput): string[] {
  return [
    ...input.variants.flatMap((variant) => (variant.barcode === null ? [] : [variant.barcode])),
    ...input.units.flatMap((pack) => (pack.barcode === null ? [] : [pack.barcode])),
  ];
}

// Two saves at the same moment can both pass findTaken(); the unique index then refuses the
// second. The answer is the same as findTaken's, without knowing which variant it was.
function racedError(error: unknown): unknown {
  if (isUniqueViolation(error, 'products_tenant_code_idx')) {
    return new AppError(409, 'product_code_taken', 'Another product uses this code.', {
      fieldErrors: { code: ['product_code_taken'] },
    });
  }
  if (isUniqueViolation(error, 'product_variants_tenant_sku_idx')) {
    return new AppError(409, 'product_sku_taken', 'Another product uses one of these SKUs.');
  }
  if (isUniqueViolation(error, 'product_barcodes_tenant_code_idx')) {
    return new AppError(409, 'barcode_taken', 'Another product uses one of these barcodes.');
  }
  return error;
}
