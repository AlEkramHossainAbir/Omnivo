import { Inject, Injectable } from '@nestjs/common';
import {
  isIndustry,
  PRODUCT_IMPORT_MAX_ERRORS,
  type ProductImportError,
  todayIn,
  trackingDefault,
} from '@omnivo/contracts';
import { productCategories, productImports, tenantSettings, tenants } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { audit, created } from '../common/audit/audit.js';
import { type EventHandler, type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { StorageService } from '../storage/storage.service.js';
import { lockCategoryTree } from './product-categories.service.js';
import { columnOf, type ImportedProduct, readProductsCsv } from './import/csv.js';
import {
  checkProduct,
  findTaken,
  insertProducts,
  loadProductContext,
  type PreparedProduct,
  type ProductIssue,
  resolveSkus,
  takenIssues,
} from './product-write.js';

type ImportRow = typeof productImports.$inferSelect;

// Thrown inside the savepoint when the file is wrong: everything the savepoint did (new
// categories, product codes taken from the series) is undone, and the errors are recorded outside it
class RejectedFile extends Error {
  constructor(readonly errors: ProductImportError[]) {
    super('The file has errors');
  }
}

// A product's problem on its CSV cell. The path is the contract's ("units.0.factor").
function fileErrorOf(issue: ProductIssue, product: ImportedProduct): ProductImportError {
  const path = issue.path.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return { ...columnOf(path, product.rows), code: issue.code };
}

// The order a person fixes a file in: top to bottom, the whole-file problems first
function inFileOrder(errors: readonly ProductImportError[]): ProductImportError[] {
  return errors.toSorted((a, b) => (a.row ?? 0) - (b.row ?? 0));
}

// Reads a product CSV and creates its products: all of them, or none (you chose this). Idempotent
// like every handler: only a 'queued' import is worked on, under a row lock, and the status moves
// on in the same transaction as the products — a second run finds 'done' or 'failed' and stops.
@Injectable()
export class ProductImportHandler implements EventHandler<'product.import_requested'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
    private readonly numbering: NumberingService,
  ) {}

  async handle(event: OutboxEvent<'product.import_requested'>): Promise<void> {
    const tenantId = getTenantId();
    // 1) The file first, outside any transaction: no transaction waits on the network
    const row = await this.withTenant((tx) => this.find(tx, event.payload.importId, false));
    if (!row) throw new PermanentJobError('The import no longer exists');
    if (row.status !== 'queued') return;
    const bytes = await this.storage.get(row.storageKey);
    if (bytes === null) throw new PermanentJobError('The uploaded file is gone');

    // 2) One transaction: check the whole file, then write all of it or record why not
    await this.withTenant(async (tx) => {
      const locked = await this.find(tx, row.id, true);
      if (locked?.status !== 'queued') return;
      const context = await loadProductContext(tx);
      const [tenant] = await tx
        .select({ industry: tenants.industry })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      const industry =
        tenant?.industry !== null && tenant?.industry !== undefined && isIndustry(tenant.industry)
          ? tenant.industry
          : null;
      const file = readProductsCsv(bytes, {
        // Only active units: a new product cannot start with an archived one
        units: [...context.units.values()].filter((unit) => unit.archivedAt === null),
        fields: context.fields,
        defaultTracking: trackingDefault(industry),
      });

      const errors = [...file.errors];
      const prepared = file.products.map((product) => {
        const checked = checkProduct(product.input, context);
        errors.push(...checked.issues.map((issue) => fileErrorOf(issue, product)));
        return { product, customFields: checked.customFields };
      });

      let productCount = 0;
      if (errors.length === 0) {
        try {
          productCount = await tx.transaction((inner) => this.write(inner, locked, prepared));
        } catch (error) {
          if (!(error instanceof RejectedFile)) throw error;
          errors.push(...error.errors);
        }
      }

      const finishedAt = new Date();
      if (errors.length > 0) {
        await tx
          .update(productImports)
          .set({
            status: 'failed',
            rowCount: file.rowCount,
            errorCount: errors.length,
            errors: inFileOrder(errors).slice(0, PRODUCT_IMPORT_MAX_ERRORS),
            finishedAt,
          })
          .where(eq(productImports.id, locked.id));
        await notify(tx, {
          userId: locked.requestedBy,
          type: 'import.failed',
          params: { file: locked.fileName, count: errors.length },
          eventId: event.id,
        });
        return;
      }
      await tx
        .update(productImports)
        .set({ status: 'done', rowCount: file.rowCount, productCount, finishedAt })
        .where(eq(productImports.id, locked.id));
      // The person who uploaded it did it; the worker only carried it out
      await audit(tx, {
        action: 'product.imported',
        entityType: 'product_import',
        entityId: locked.id,
        actorUserId: locked.requestedBy,
        changes: created({ file: locked.fileName, products: productCount }),
      });
      await notify(tx, {
        userId: locked.requestedBy,
        type: 'import.done',
        params: { file: locked.fileName, count: productCount },
        eventId: event.id,
      });
    });
  }

  // After the last attempt (the file vanished, the database was down for every retry): the import
  // is failed and its owner hears it, instead of a spinner that never stops
  async onGiveUp(event: OutboxEvent<'product.import_requested'>): Promise<void> {
    await this.withTenant(async (tx) => {
      const [failed] = await tx
        .update(productImports)
        .set({
          status: 'failed',
          errorCount: 1,
          errors: [{ row: null, column: null, code: 'internal_error' }],
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(productImports.tenantId, getTenantId()),
            eq(productImports.id, event.payload.importId),
            eq(productImports.status, 'queued'),
          ),
        )
        .returning();
      if (!failed) return;
      await notify(tx, {
        userId: failed.requestedBy,
        type: 'import.failed',
        params: { file: failed.fileName, count: 1 },
        eventId: event.id,
      });
    });
  }

  // Inside the savepoint: categories, codes, the checks that need them, and the products
  private async write(
    tx: Transaction,
    row: ImportRow,
    checked: readonly {
      product: ImportedProduct;
      customFields: Record<string, string | boolean>;
    }[],
  ): Promise<number> {
    const categoryIds = await this.categories(
      tx,
      checked.flatMap(({ product }) => (product.categoryPath ? [product.categoryPath] : [])),
    );
    const codes = await this.codes(
      tx,
      checked.filter(({ product }) => product.input.code === null).length,
    );
    let nextCode = 0;
    const prepared: (PreparedProduct & { product: ImportedProduct })[] = checked.map(
      ({ product, customFields }) => {
        const code = product.input.code ?? codes[nextCode++] ?? '';
        const input = {
          ...product.input,
          categoryId: product.categoryPath
            ? (categoryIds.get(pathKey(product.categoryPath)) ?? null)
            : null,
        };
        return { product, input, code, skus: resolveSkus(input, code), customFields };
      },
    );

    // Taken by products already in the workspace, or twice in this file
    const errors: ProductImportError[] = [];
    const taken = await findTaken(tx, {
      codes: prepared.flatMap(({ product, code }) => (product.input.code === null ? [] : [code])),
      skus: prepared.flatMap(({ skus }) => skus),
      barcodes: prepared.flatMap(({ input }) => [
        ...input.variants.flatMap((variant) => (variant.barcode === null ? [] : [variant.barcode])),
        ...input.units.flatMap((pack) => (pack.barcode === null ? [] : [pack.barcode])),
      ]),
    });
    const seenSkus = new Set<string>();
    const seenBarcodes = new Set<string>();
    for (const { product, input, code, skus } of prepared) {
      const issues = takenIssues(input, code, skus, taken);
      skus.forEach((sku, index) => {
        if (seenSkus.has(sku.toLowerCase())) {
          issues.push({ path: `variants.${String(index)}.sku`, code: 'product_sku_taken' });
        }
        seenSkus.add(sku.toLowerCase());
      });
      input.variants.forEach((variant, index) => {
        if (variant.barcode === null) return;
        if (seenBarcodes.has(variant.barcode)) {
          issues.push({ path: `variants.${String(index)}.barcode`, code: 'barcode_taken' });
        }
        seenBarcodes.add(variant.barcode);
      });
      input.units.forEach((pack, index) => {
        if (pack.barcode === null) return;
        if (seenBarcodes.has(pack.barcode)) {
          issues.push({ path: `units.${String(index)}.barcode`, code: 'barcode_taken' });
        }
        seenBarcodes.add(pack.barcode);
      });
      errors.push(...issues.map((issue) => fileErrorOf(issue, product)));
    }
    if (errors.length > 0) throw new RejectedFile(errors);

    const ids = await insertProducts(tx, prepared, row.requestedBy);
    return ids.length;
  }

  // Every category path of the file → its id, making the ones that do not exist yet. Names match
  // in any case, like the unique index ("knit" is the Knit that is already there).
  private async categories(
    tx: Transaction,
    paths: readonly string[][],
  ): Promise<Map<string, string>> {
    const tenantId = getTenantId();
    const result = new Map<string, string>();
    if (paths.length === 0) return result;
    // The categories page's lock: no move or delete runs while the import adds to the tree
    await lockCategoryTree(tx);
    const existing = await tx
      .select({
        id: productCategories.id,
        parentId: productCategories.parentId,
        name: productCategories.name,
      })
      .from(productCategories)
      .where(eq(productCategories.tenantId, tenantId));
    const byPlace = new Map(
      existing.map((category) => [
        `${category.parentId ?? ''}/${category.name.toLowerCase()}`,
        category.id,
      ]),
    );
    // One step down the path: the category of this name under parentId, made if missing
    const step = async (parentId: string | null, name: string): Promise<string> => {
      const place = `${parentId ?? ''}/${name.toLowerCase()}`;
      const found = byPlace.get(place);
      if (found !== undefined) return found;
      const [made] = await tx
        .insert(productCategories)
        .values({ tenantId, parentId, name })
        .returning({ id: productCategories.id });
      if (!made) throw new Error('Category insert returned no row');
      byPlace.set(place, made.id);
      return made.id;
    };
    for (const path of paths) {
      if (result.has(pathKey(path))) continue;
      let parentId: string | null = null;
      for (const name of path) parentId = await step(parentId, name);
      if (parentId !== null) result.set(pathKey(path), parentId);
    }
    return result;
  }

  // `count` codes from the series, skipping any a product already has (typed by hand earlier)
  private async codes(tx: Transaction, count: number): Promise<string[]> {
    if (count === 0) return [];
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    const today = todayIn(settings?.timezone ?? 'Asia/Dhaka');
    const codes: string[] = [];
    while (codes.length < count) {
      const batch = await this.numbering.nextMany(
        tx,
        'inventory.product',
        today,
        count - codes.length,
      );
      const taken = await findTaken(tx, { codes: batch, skus: [], barcodes: [] });
      codes.push(...batch.filter((code) => !taken.codes.has(code.toLowerCase())));
    }
    return codes;
  }

  private async find(tx: Transaction, id: string, forUpdate: boolean) {
    const query = tx
      .select()
      .from(productImports)
      .where(and(eq(productImports.tenantId, getTenantId()), eq(productImports.id, id)));
    const [row] = forUpdate ? await query.for('update') : await query;
    return row ?? null;
  }
}

function pathKey(path: readonly string[]): string {
  return path.map((part) => part.toLowerCase()).join('\u0000');
}
