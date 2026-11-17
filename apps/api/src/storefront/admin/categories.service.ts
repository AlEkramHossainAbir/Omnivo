import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateStorefrontCategoryInput,
  StorefrontCategory,
  UpdateStorefrontCategoryInput,
} from '@omnivo/contracts';
import { storefrontCategories, storefrontListings } from '@omnivo/db';
import { and, asc, count, eq, isNull, max, sql } from 'drizzle-orm';

import { audit, created, diff } from '../../common/audit/audit.js';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';

type CategoryRow = typeof storefrontCategories.$inferSelect;

function toCategory(row: CategoryRow, listingCount: number): StorefrontCategory {
  return {
    id: row.id,
    parentId: row.parentId,
    slug: row.slug,
    name: row.name,
    position: row.position,
    listingCount,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function slugTaken(): AppError {
  return new AppError(409, 'storefront_slug_taken', 'Another one in the shop has this link.', {
    fieldErrors: { slug: ['storefront_slug_taken'] },
  });
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

// The two unique indexes, by the box each belongs to. Step 26h: and the slug the shop keeps for
// itself. The contract refuses "all" before it gets here (storefront-admin.ts); the check
// (26h.2) is for a request that went around it, and it says so on the box, not as a 500
function uniqueError(error: unknown): AppError | null {
  if (isUniqueViolation(error, 'storefront_categories_slug_idx')) return slugTaken();
  if (isUniqueViolation(error, 'storefront_categories_sibling_name_idx')) return nameTaken();
  if (isCheckViolation(error, 'storefront_categories_slug_reserved_check')) {
    return new AppError(409, 'storefront_slug_reserved', 'The shop keeps this link for itself.', {
      fieldErrors: { slug: ['storefront_slug_reserved'] },
    });
  }
  return null;
}

// The product categories' lock (product-categories.service.ts), for the same races: two moves at
// once, a new category under one being deleted, and two new categories taking one position. The
// tree is tens of rows that change rarely, so one tenant's changes waiting for each other costs
// nothing
async function lockTree(tx: Transaction): Promise<void> {
  const key = `storefront_categories:${getTenantId()}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

// The siblings' order, as the shop lists them: position, then name (26f), then the id so two rows
// never tie
const ORDER = [
  asc(storefrontCategories.position),
  asc(storefrontCategories.name),
  asc(storefrontCategories.id),
] as const;

function underParent(parentId: string | null) {
  return parentId === null
    ? isNull(storefrontCategories.parentId)
    : eq(storefrontCategories.parentId, parentId);
}

// Step 26g: the shop's own categories (26f: not the product categories). A tree, like the
// product categories, plus a link (the slug) and an order the tenant sets with Move up / down.
@Injectable()
export class StorefrontCategoriesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<StorefrontCategory[]> {
    return this.withTenant((tx) => this.all(tx));
  }

  async create(input: CreateStorefrontCategoryInput): Promise<StorefrontCategory> {
    try {
      return await this.withTenant(async (tx) => {
        await lockTree(tx);
        const parent = input.parentId === null ? null : await this.find(tx, input.parentId);
        if (input.parentId !== null && !parent) throw parentInvalid();
        const [row] = await tx
          .insert(storefrontCategories)
          .values({
            tenantId: getTenantId(),
            parentId: input.parentId,
            slug: input.slug,
            // NFC, like every name the shop searches (26f, decision 34)
            name: input.name.normalize('NFC'),
            position: await this.endOf(tx, input.parentId),
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Category insert returned no row');
        await audit(tx, {
          action: 'storefront_category.created',
          entityType: 'storefront_category',
          entityId: row.id,
          changes: created({ name: row.name, slug: row.slug, parent: parent?.name ?? null }),
        });
        return toCategory(row, 0);
      });
    } catch (error) {
      throw uniqueError(error) ?? error;
    }
  }

  async update(id: string, input: UpdateStorefrontCategoryInput): Promise<StorefrontCategory> {
    try {
      return await this.withTenant(async (tx) => {
        await lockTree(tx);
        const before = await this.find(tx, id, true);
        if (!before) throw notFound('Category');
        if (before.version !== input.version) throw versionConflict();
        const moved = input.parentId !== before.parentId;
        const parentBefore = before.parentId === null ? null : await this.find(tx, before.parentId);
        const parentAfter = moved ? await this.moveTarget(tx, id, input.parentId) : parentBefore;
        const [after] = await tx
          .update(storefrontCategories)
          .set({
            parentId: input.parentId,
            slug: input.slug,
            name: input.name.normalize('NFC'),
            // A new parent: the end of its list, with everything under it coming along (the
            // children point at this row, not at a place)
            ...(moved && { position: await this.endOf(tx, input.parentId) }),
            version: sql`${storefrontCategories.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(
            and(eq(storefrontCategories.tenantId, getTenantId()), eq(storefrontCategories.id, id)),
          )
          .returning();
        if (!after) throw notFound('Category');
        await audit(tx, {
          action: 'storefront_category.updated',
          entityType: 'storefront_category',
          entityId: id,
          changes: diff(
            { name: before.name, slug: before.slug, parent: parentBefore?.name ?? null },
            { name: after.name, slug: after.slug, parent: parentAfter?.name ?? null },
          ),
        });
        return toCategory(after, await this.listingCount(tx, id));
      });
    } catch (error) {
      throw uniqueError(error) ?? error;
    }
  }

  // Decision 15: a swap with the sibling above or below, answered with the whole list (two rows
  // changed, and the tree shows them all). The siblings are numbered 1, 2, 3… in their order first:
  // positions may tie (a new category's 0 from 26f's tests, a row made by hand), and swapping two
  // equal numbers would change nothing
  move(id: string, direction: 'up' | 'down', version: number): Promise<StorefrontCategory[]> {
    return this.withTenant(async (tx) => {
      await lockTree(tx);
      const category = await this.find(tx, id, true);
      if (!category) throw notFound('Category');
      if (category.version !== version) throw versionConflict();
      const siblings = await tx
        .select()
        .from(storefrontCategories)
        .where(
          and(eq(storefrontCategories.tenantId, getTenantId()), underParent(category.parentId)),
        )
        .orderBy(...ORDER);
      const from = siblings.findIndex((row) => row.id === id);
      const to = direction === 'up' ? from - 1 : from + 1;
      const neighbour = siblings[to];
      // Already first or last: the button is disabled there, and a second click is a no-op
      if (neighbour === undefined) return this.all(tx);

      const order = siblings.map((row) => row.id);
      order[from] = neighbour.id;
      order[to] = id;
      // Only the rows whose number changes are written, each with its version: a position is
      // part of the row, and a form open on a moved row should know it changed
      for (const [index, rowId] of order.entries()) {
        const row = siblings.find((sibling) => sibling.id === rowId);
        if (row === undefined || row.position === index + 1) continue;
        await tx
          .update(storefrontCategories)
          .set({
            position: index + 1,
            version: sql`${storefrontCategories.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(
            and(
              eq(storefrontCategories.tenantId, getTenantId()),
              eq(storefrontCategories.id, rowId),
            ),
          );
      }
      await audit(tx, {
        action: 'storefront_category.moved',
        entityType: 'storefront_category',
        entityId: id,
        changes: diff({ position: from + 1 }, { position: to + 1 }),
      });
      return this.all(tx);
    });
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        await lockTree(tx);
        const before = await this.find(tx, id, true);
        if (!before) throw notFound('Category');
        if (before.version !== version) throw versionConflict();
        await tx
          .delete(storefrontCategories)
          .where(
            and(eq(storefrontCategories.tenantId, getTenantId()), eq(storefrontCategories.id, id)),
          );
        await audit(tx, {
          action: 'storefront_category.deleted',
          entityType: 'storefront_category',
          entityId: id,
          changes: diff({ name: before.name, slug: before.slug }, { name: null, slug: null }),
        });
      });
    } catch (error) {
      // The foreign keys are the checks (26f: no ON DELETE on either)
      if (isForeignKeyViolation(error, 'storefront_categories_parent_fk')) {
        throw new AppError(
          409,
          'category_has_children',
          'Move or delete the sub-categories first.',
        );
      }
      if (isForeignKeyViolation(error, 'storefront_listings_category_fk')) {
        throw new AppError(
          409,
          'storefront_category_in_use',
          'Move its listings to another category first.',
        );
      }
      throw error;
    }
  }

  // A category of this workspace, for a listing's category box
  async exists(tx: Transaction, id: string): Promise<boolean> {
    return (await this.find(tx, id)) !== null;
  }

  private async all(tx: Transaction): Promise<StorefrontCategory[]> {
    const tenantId = getTenantId();
    const counts = tx
      .select({ categoryId: storefrontListings.categoryId, total: count().as('total') })
      .from(storefrontListings)
      .where(eq(storefrontListings.tenantId, tenantId))
      .groupBy(storefrontListings.categoryId)
      .as('counts');
    const rows = await tx
      .select({
        category: storefrontCategories,
        // coalesce: a category with no listings has no row in `counts`
        total: sql<number>`coalesce(${counts.total}, 0)`.mapWith(Number),
      })
      .from(storefrontCategories)
      .leftJoin(counts, eq(counts.categoryId, storefrontCategories.id))
      .where(eq(storefrontCategories.tenantId, tenantId))
      .orderBy(...ORDER);
    return rows.map((row) => toCategory(row.category, row.total));
  }

  private async listingCount(tx: Transaction, id: string): Promise<number> {
    const [counted] = await tx
      .select({ total: count() })
      .from(storefrontListings)
      .where(
        and(eq(storefrontListings.tenantId, getTenantId()), eq(storefrontListings.categoryId, id)),
      );
    return counted?.total ?? 0;
  }

  // After the last sibling. smallint: tens of categories, never 32,767
  private async endOf(tx: Transaction, parentId: string | null): Promise<number> {
    const [last] = await tx
      .select({ position: max(storefrontCategories.position) })
      .from(storefrontCategories)
      .where(and(eq(storefrontCategories.tenantId, getTenantId()), underParent(parentId)));
    return (last?.position ?? 0) + 1;
  }

  // The new parent, after checking the move does not put the category under itself (the tree
  // lock keeps any other move from being half done while this walks up)
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
        SELECT id, parent_id FROM storefront_categories
         WHERE tenant_id = ${getTenantId()}::uuid AND id = ${parentId}::uuid
        UNION ALL
        SELECT c.id, c.parent_id FROM storefront_categories c
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

  private async find(tx: Transaction, id: string, forUpdate = false): Promise<CategoryRow | null> {
    const query = tx
      .select()
      .from(storefrontCategories)
      .where(
        and(eq(storefrontCategories.tenantId, getTenantId()), eq(storefrontCategories.id, id)),
      );
    const [row] = forUpdate ? await query.for('update') : await query;
    return row ?? null;
  }
}
