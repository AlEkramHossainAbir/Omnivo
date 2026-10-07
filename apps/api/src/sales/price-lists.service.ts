import { Inject, Injectable } from '@nestjs/common';
import type {
  ErrorCode,
  PriceList,
  PriceListInput,
  PriceListItemPage,
  SetPriceListItemsInput,
  UpdatePriceListInput,
} from '@omnivo/contracts';
import {
  parties,
  priceListItems,
  priceLists,
  products,
  productUnits,
  productVariants,
} from '@omnivo/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { containsPattern } from '../common/db/search.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';

type PriceListRow = typeof priceLists.$inferSelect;

// The two counts the page shows next to a list. Correlated subqueries: a workspace has a few lists.
// The outer table by its name: Drizzle would print ${priceLists.id} as a bare "id", which inside
// the subquery means the inner row's own column.
const itemCount = sql<number>`(
  SELECT count(*)::int FROM ${priceListItems} i
   WHERE i.tenant_id = price_lists.tenant_id AND i.price_list_id = price_lists.id
)`;
// Archived customers too: they still point at the list
const customerCount = sql<number>`(
  SELECT count(*)::int FROM ${parties} p
   WHERE p.tenant_id = price_lists.tenant_id AND p.price_list_id = price_lists.id
)`;

// A row's place in the items page: the product's name, then the variant and the unit. The last
// two make it unique (they are the row's key inside one list).
const cursorSchema = z.tuple([z.string(), z.uuid(), z.uuid()]);

function toPriceList(row: PriceListRow, counts: { itemCount: number; customerCount: number }) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    itemCount: counts.itemCount,
    customerCount: counts.customerCount,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  } satisfies PriceList;
}

function nameTaken(): AppError {
  return new AppError(409, 'price_list_name_taken', 'Another price list already has this name.', {
    fieldErrors: { name: ['price_list_name_taken'] },
  });
}

// Named price lists (step 15a): "Dealer", "Wholesale". Archived, never deleted — a sales line
// (step 15b) remembers the list its price came from.
@Injectable()
export class PriceListsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<PriceList[]> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select({ list: priceLists, itemCount, customerCount })
        .from(priceLists)
        .where(eq(priceLists.tenantId, getTenantId()))
        .orderBy(asc(sql`lower(${priceLists.name})`));
      return rows.map((row) => toPriceList(row.list, row));
    });
  }

  get(id: string): Promise<PriceList> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: PriceListInput): Promise<PriceList> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(priceLists)
          .values({
            tenantId: getTenantId(),
            name: input.name,
            description: input.description,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Price list insert returned no row');
        await audit(tx, {
          action: 'price_list.created',
          entityType: 'price_list',
          entityId: row.id,
          changes: created({ name: row.name, description: row.description }),
        });
        return toPriceList(row, { itemCount: 0, customerCount: 0 });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'price_lists_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  async update(id: string, input: UpdatePriceListInput): Promise<PriceList> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        await this.write(tx, id, { name: input.name, description: input.description });
        await audit(tx, {
          action: 'price_list.updated',
          entityType: 'price_list',
          entityId: id,
          changes: diff(
            { name: before.name, description: before.description },
            { name: input.name, description: input.description },
          ),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'price_lists_tenant_name_idx')) throw nameTaken();
      throw error;
    }
  }

  // Archived: no new customer picks it, and its customers' sales lines (step 15b) fall back to the
  // products' own prices. Its prices stay, so restoring it brings everything back.
  setArchived(id: string, version: number, archived: boolean): Promise<PriceList> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) !== archived) {
        await this.write(tx, id, { archivedAt: archived ? new Date() : null });
        await audit(tx, {
          action: archived ? 'price_list.archived' : 'price_list.restored',
          entityType: 'price_list',
          entityId: id,
        });
      }
      return this.read(tx, id);
    });
  }

  items(
    id: string,
    query: { limit: number; cursor?: string | undefined; search?: string | undefined },
  ): Promise<PriceListItemPage> {
    const tenantId = getTenantId();
    const after = decodeCursor(query.cursor, cursorSchema);
    const nameKey = sql<string>`lower(${products.name})`;
    return this.withTenant(async (tx) => {
      const [list] = await tx
        .select({ id: priceLists.id })
        .from(priceLists)
        .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.id, id)));
      if (!list) throw notFound('Price list');
      const search =
        query.search === undefined || query.search === ''
          ? undefined
          : containsPattern(query.search);
      const rows = await tx
        .select({
          variantId: priceListItems.variantId,
          unitId: priceListItems.unitId,
          productId: priceListItems.productId,
          productCode: products.code,
          productName: products.name,
          nameKey,
          sku: productVariants.sku,
          optionValues: productVariants.optionValues,
          price: priceListItems.price,
          updatedAt: priceListItems.updatedAt,
        })
        .from(priceListItems)
        .innerJoin(
          products,
          and(
            eq(products.tenantId, priceListItems.tenantId),
            eq(products.id, priceListItems.productId),
          ),
        )
        .innerJoin(
          productVariants,
          and(
            eq(productVariants.tenantId, priceListItems.tenantId),
            eq(productVariants.id, priceListItems.variantId),
          ),
        )
        .where(
          and(
            eq(priceListItems.tenantId, tenantId),
            eq(priceListItems.priceListId, id),
            search === undefined
              ? undefined
              : sql`(lower(${products.name}) LIKE ${search} OR lower(${products.code}) LIKE ${search}
                     OR lower(${productVariants.sku}) LIKE ${search})`,
            after === undefined
              ? undefined
              : sql`(${nameKey}, ${priceListItems.variantId}, ${priceListItems.unitId})
                      > (${after[0]}, ${after[1]}::uuid, ${after[2]}::uuid)`,
          ),
        )
        .orderBy(nameKey, asc(priceListItems.variantId), asc(priceListItems.unitId))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.nameKey, last.variantId, last.unitId]);
      return {
        items: page.items.map((row) => ({
          variantId: row.variantId,
          unitId: row.unitId,
          productId: row.productId,
          productCode: row.productCode,
          productName: row.productName,
          sku: row.sku,
          optionValues: row.optionValues,
          price: row.price,
          updatedAt: row.updatedAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  // A batch of prices: each change sets one price, or ('' → null) takes it out of the list. Every
  // row is saved on its own — no version — so two people can price different items of one list at
  // the same time. The batch is all or nothing: one wrong unit and nothing is saved.
  setItems(id: string, input: SetPriceListItemsInput): Promise<PriceList> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // FOR SHARE: the list is not archived while we write into it
      const [list] = await tx
        .select({ archivedAt: priceLists.archivedAt })
        .from(priceLists)
        .where(and(eq(priceLists.tenantId, tenantId), eq(priceLists.id, id)))
        .for('share');
      if (!list) throw notFound('Price list');
      if (list.archivedAt !== null) {
        throw new AppError(
          409,
          'price_list_invalid',
          'Restore the price list to change its prices.',
        );
      }

      // Each variant with its product and the units it is sold in: the base unit and its packs.
      // FOR SHARE on the products: a product save that drops a pack (and deletes its prices, in
      // ProductsService.update) waits for us, or we wait for it and see the pack gone.
      const variantIds = [...new Set(input.changes.map((change) => change.variantId))];
      const variants = await tx
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          baseUnitId: products.baseUnitId,
        })
        .from(productVariants)
        .innerJoin(
          products,
          and(
            eq(products.tenantId, productVariants.tenantId),
            eq(products.id, productVariants.productId),
          ),
        )
        .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.id, variantIds)))
        .for('share', { of: products });
      const productIds = [...new Set(variants.map((variant) => variant.productId))];
      const packs =
        productIds.length === 0
          ? []
          : await tx
              .select({ productId: productUnits.productId, unitId: productUnits.unitId })
              .from(productUnits)
              .where(
                and(
                  eq(productUnits.tenantId, tenantId),
                  inArray(productUnits.productId, productIds),
                ),
              );
      const variantOf = new Map(variants.map((variant) => [variant.id, variant]));
      const sold = new Set([
        ...variants.map((variant) => `${variant.productId}:${variant.baseUnitId}`),
        ...packs.map((pack) => `${pack.productId}:${pack.unitId}`),
      ]);

      const fieldErrors: Record<string, ErrorCode[]> = {};
      const rows = input.changes.flatMap((change, index) => {
        const variant = variantOf.get(change.variantId);
        if (!variant) {
          fieldErrors[`changes.${String(index)}.variantId`] = ['product_variant_unknown'];
          return [];
        }
        // A price per carton of a product that is never sold by the carton could never be used
        if (!sold.has(`${variant.productId}:${change.unitId}`)) {
          fieldErrors[`changes.${String(index)}.unitId`] = ['price_list_unit_invalid'];
          return [];
        }
        return [{ ...change, productId: variant.productId }];
      });
      const [first] = Object.values(fieldErrors).flat();
      if (first !== undefined) {
        throw new AppError(
          409,
          first,
          'Some prices are for an item or unit this list cannot hold.',
          {
            fieldErrors,
          },
        );
      }

      const removed = rows.filter((row) => row.price === null);
      if (removed.length > 0) {
        await tx.delete(priceListItems).where(
          and(
            eq(priceListItems.tenantId, tenantId),
            eq(priceListItems.priceListId, id),
            sql`(${priceListItems.variantId}, ${priceListItems.unitId}) IN (${sql.join(
              removed.map((row) => sql`(${row.variantId}::uuid, ${row.unitId}::uuid)`),
              sql`, `,
            )})`,
          ),
        );
      }
      const set = rows.flatMap((row) => (row.price === null ? [] : [{ ...row, price: row.price }]));
      if (set.length > 0) {
        await tx
          .insert(priceListItems)
          .values(
            set.map((row) => ({
              tenantId,
              priceListId: id,
              productId: row.productId,
              variantId: row.variantId,
              unitId: row.unitId,
              price: row.price,
              updatedBy: currentPrincipal().userId,
            })),
          )
          // The key is the row: setting a price that is already there changes it
          .onConflictDoUpdate({
            target: [
              priceListItems.tenantId,
              priceListItems.priceListId,
              priceListItems.variantId,
              priceListItems.unitId,
            ],
            set: {
              price: sql`excluded.price`,
              updatedAt: sql`now()`,
              updatedBy: sql`excluded.updated_by`,
            },
          });
      }
      // How many, not which: a batch can hold 500 prices, and the audit row is for people
      await audit(tx, {
        action: 'price_list.prices_changed',
        entityType: 'price_list',
        entityId: id,
        changes: created({ set: set.length, removed: removed.length }),
      });
      return this.read(tx, id);
    });
  }

  private async lock(tx: Transaction, id: string): Promise<PriceListRow> {
    const [row] = await tx
      .select()
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, getTenantId()), eq(priceLists.id, id)))
      .for('update');
    if (!row) throw notFound('Price list');
    return row;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<PriceListRow, 'name' | 'description' | 'archivedAt'>>,
  ): Promise<void> {
    await tx
      .update(priceLists)
      .set({
        ...fields,
        version: sql`${priceLists.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(priceLists.tenantId, getTenantId()), eq(priceLists.id, id)));
  }

  private async read(tx: Transaction, id: string): Promise<PriceList> {
    const [row] = await tx
      .select({ list: priceLists, itemCount, customerCount })
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, getTenantId()), eq(priceLists.id, id)));
    if (!row) throw notFound('Price list');
    return toPriceList(row.list, row);
  }
}
