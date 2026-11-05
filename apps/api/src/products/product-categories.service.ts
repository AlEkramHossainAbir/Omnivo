import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateProductCategoryInput,
  ProductCategory,
  UpdateProductCategoryInput,
} from '@omnivo/contracts';
import { productCategories, products } from '@omnivo/db';
import { and, asc, count, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type CategoryRow = typeof productCategories.$inferSelect;

function toCategory(row: CategoryRow, productCount: number): ProductCategory {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    productCount,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nameTaken(): AppError {
  return new AppError(409, 'category_name_taken', 'This place already has a category so named.', {
    fieldErrors: { name: ['category_name_taken'] },
  });
}

function parentInvalid(): AppError {
  return new AppError(409, 'category_parent_invalid', 'Pick a category from the list.', {
    fieldErrors: { parentId: ['category_parent_invalid'] },
  });
}

// The chart's lock (accounts.service.ts), for the same two races: two moves in opposite
// directions, and a new category under one that is being deleted. Categories change rarely, so
// making one tenant's changes wait for each other costs nothing. The import job takes it too
// before it adds categories (import.handler.ts).
export async function lockCategoryTree(tx: Transaction): Promise<void> {
  const key = `product_categories:${getTenantId()}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

@Injectable()
export class ProductCategoriesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<ProductCategory[]> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const counts = tx
        .select({ categoryId: products.categoryId, total: count().as('total') })
        .from(products)
        .where(eq(products.tenantId, tenantId))
        .groupBy(products.categoryId)
        .as('counts');
      const rows = await tx
        // coalesce: a category without products has no row in `counts` — 0, not null
        .select({
          category: productCategories,
          total: sql<number>`coalesce(${counts.total}, 0)`.mapWith(Number),
        })
        .from(productCategories)
        .leftJoin(counts, eq(counts.categoryId, productCategories.id))
        .where(eq(productCategories.tenantId, tenantId))
        .orderBy(asc(productCategories.name));
      return rows.map((row) => toCategory(row.category, row.total));
    });
  }

  async create(input: CreateProductCategoryInput): Promise<ProductCategory> {
    try {
      return await this.withTenant(async (tx) => {
        await lockCategoryTree(tx);
        const parent = input.parentId === null ? null : await this.find(tx, input.parentId);
        if (input.parentId !== null && !parent) throw parentInvalid();
        const [row] = await tx
          .insert(productCategories)
          .values({
            tenantId: getTenantId(),
            parentId: input.parentId,
            name: input.name,
            createdBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Category insert returned no row');
        await audit(tx, {
          action: 'product_category.created',
          entityType: 'product_category',
          entityId: row.id,
          changes: created({ name: row.name, parent: parent?.name ?? null }),
        });
        return toCategory(row, 0);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'product_categories_sibling_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdateProductCategoryInput): Promise<ProductCategory> {
    try {
      return await this.withTenant(async (tx) => {
        await lockCategoryTree(tx);
        const before = await this.find(tx, id, true);
        if (!before) throw notFound('Category');
        if (before.version !== input.version) throw versionConflict();
        const parentBefore = before.parentId === null ? null : await this.find(tx, before.parentId);
        const parentAfter =
          input.parentId === before.parentId
            ? parentBefore
            : await this.moveTarget(tx, id, input.parentId);
        const [after] = await tx
          .update(productCategories)
          .set({
            parentId: input.parentId,
            name: input.name,
            version: sql`${productCategories.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(productCategories.tenantId, getTenantId()), eq(productCategories.id, id)))
          .returning();
        if (!after) throw notFound('Category');
        await audit(tx, {
          action: 'product_category.updated',
          entityType: 'product_category',
          entityId: id,
          changes: diff(
            { name: before.name, parent: parentBefore?.name ?? null },
            { name: after.name, parent: parentAfter?.name ?? null },
          ),
        });
        const [counted] = await tx
          .select({ total: count() })
          .from(products)
          .where(and(eq(products.tenantId, getTenantId()), eq(products.categoryId, id)));
        return toCategory(after, counted?.total ?? 0);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'product_categories_sibling_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        await lockCategoryTree(tx);
        const before = await this.find(tx, id, true);
        if (!before) throw notFound('Category');
        if (before.version !== version) throw versionConflict();
        await tx
          .delete(productCategories)
          .where(and(eq(productCategories.tenantId, getTenantId()), eq(productCategories.id, id)));
        await audit(tx, {
          action: 'product_category.deleted',
          entityType: 'product_category',
          entityId: id,
          changes: diff({ name: before.name }, { name: null }),
        });
      });
    } catch (error) {
      // The FKs are the checks: sub-categories (the parent FK) and products (theirs)
      if (isForeignKeyViolation(error, 'product_categories_parent_fk')) {
        throw new AppError(
          409,
          'category_has_children',
          'Move or delete the sub-categories first.',
        );
      }
      if (isForeignKeyViolation(error, 'products_category_fk')) {
        throw new AppError(409, 'category_in_use', 'Move the products to another category first.');
      }
      throw error;
    }
  }

  // The new parent, after checking the move does not put the category under itself. The tree
  // lock makes sure no other move is half done while we walk up.
  private async moveTarget(
    tx: Transaction,
    id: string,
    parentId: string | null,
  ): Promise<CategoryRow | null> {
    if (parentId === null) return null;
    const parent = await this.find(tx, parentId);
    if (!parent) throw parentInvalid();
    const loop = await tx.execute(sql`
      WITH RECURSIVE up AS (
        SELECT id, parent_id FROM product_categories
         WHERE tenant_id = ${getTenantId()}::uuid AND id = ${parentId}::uuid
        UNION ALL
        SELECT c.id, c.parent_id FROM product_categories c
          JOIN up ON c.id = up.parent_id
         WHERE c.tenant_id = ${getTenantId()}::uuid
      )
      SELECT 1 FROM up WHERE id = ${id}::uuid LIMIT 1`);
    if (loop.length > 0) {
      throw new AppError(409, 'category_parent_loop', 'A category cannot go under itself.', {
        fieldErrors: { parentId: ['category_parent_loop'] },
      });
    }
    return parent;
  }

  private async find(tx: Transaction, id: string, forUpdate = false) {
    const query = tx
      .select()
      .from(productCategories)
      .where(and(eq(productCategories.tenantId, getTenantId()), eq(productCategories.id, id)));
    const [row] = forUpdate ? await query.for('update') : await query;
    return row ?? null;
  }
}
