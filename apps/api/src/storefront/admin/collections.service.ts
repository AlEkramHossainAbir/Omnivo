import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateStorefrontCollectionInput,
  type ErrorCode,
  STOREFRONT_COLLECTION_ICONS,
  STOREFRONT_COLLECTIONS_MAX,
  type StorefrontCollection,
  type StorefrontCollectionSummary,
  type UpdateStorefrontCollectionInput,
} from '@omnivo/contracts';
import { storefrontCollectionItems, storefrontCollections } from '@omnivo/db';
import { and, asc, count, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../../common/audit/audit.js';
import { isForeignKeyViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { isoText } from '../listing-sql.js';
import {
  appendHomeBlock,
  checkHomeRoom,
  full,
  homeBlockRefs,
  lockHome,
  writeHomeBlocks,
} from './home-blocks.js';
import { StorefrontListingsService } from './listings.service.js';
import { notSetUp, StorefrontSettingsService } from './settings.service.js';

// A collection with its two counts, straight from SQL
const summaryRowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  icon: z.enum(STOREFRONT_COLLECTION_ICONS).nullable(),
  version: z.number().int(),
  updated_at: z.iso.datetime(),
  listing_count: z.number().int(),
  published_count: z.number().int(),
});

// "Published" as the launch checklist counts it (settings.service.ts readiness): published, and its
// product and variant not archived in the ERP. The shop shows exactly those; a draft in the row
// waits there until it is published
function summarySql(where: SQL): SQL {
  return sql`
    SELECT c.id::text, c.title, c.icon, c.version, ${isoText(sql`c.updated_at`)} AS updated_at,
           count(i.listing_id)::int AS listing_count,
           (count(i.listing_id) FILTER (
             WHERE l.published_at IS NOT NULL AND p.archived_at IS NULL AND v.archived_at IS NULL
           ))::int AS published_count
      FROM storefront_collections c
      LEFT JOIN storefront_collection_items i
             ON i.tenant_id = c.tenant_id AND i.collection_id = c.id
      LEFT JOIN storefront_listings l ON l.tenant_id = i.tenant_id AND l.id = i.listing_id
      LEFT JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
      LEFT JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
     WHERE c.tenant_id = ${getTenantId()}::uuid AND ${where}
     GROUP BY c.id`;
}

// A listing deleted between the check and the insert (another tab, at that moment): the FK
// refuses the row. Said like the check says it, without a box: which one went is not known here
function listingGone(error: unknown): AppError | null {
  if (!isForeignKeyViolation(error, 'storefront_collection_items_listing_fk')) return null;
  return new AppError(409, 'storefront_listing_invalid', 'A listing is not in the shop.');
}

// The audit's view: the title, the icon and the listings in their order, as text
function snapshot(row: { title: string; icon: string | null }, listingIds: readonly string[]) {
  return { title: row.title, icon: row.icon, listings: listingIds.join(', ') };
}

// Step 26h: the rows of hand-picked listings on the home page ("Hot & Trending Right Now"). Each
// is a block of the page from the moment it is made until it is deleted (decision 2).
@Injectable()
export class StorefrontCollectionsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly settings: StorefrontSettingsService,
    private readonly listings: StorefrontListingsService,
  ) {}

  get(id: string): Promise<StorefrontCollection> {
    return this.withTenant(async (tx) => {
      await this.requireShop(tx);
      return this.load(tx, id);
    });
  }

  async create(input: CreateStorefrontCollectionInput): Promise<StorefrontCollection> {
    try {
      return await this.withTenant(async (tx) => {
        await lockHome(tx);
        await this.requireShop(tx);
        const [counted] = await tx
          .select({ total: count() })
          .from(storefrontCollections)
          .where(eq(storefrontCollections.tenantId, getTenantId()));
        if ((counted?.total ?? 0) >= STOREFRONT_COLLECTIONS_MAX) {
          throw full(
            'storefront_collections_full',
            'The shop has 8 collections. Remove one first.',
          );
        }
        await checkHomeRoom(tx);
        await this.checkListings(tx, input.listingIds);
        const [row] = await tx
          .insert(storefrontCollections)
          .values({
            tenantId: getTenantId(),
            title: input.title.normalize('NFC'),
            icon: input.icon,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Collection insert returned no row');
        await this.writeItems(tx, row.id, input.listingIds);
        await appendHomeBlock(tx, { bannerId: null, collectionId: row.id });
        await audit(tx, {
          action: 'storefront_collection.created',
          entityType: 'storefront_collection',
          entityId: row.id,
          changes: created(snapshot(row, input.listingIds)),
        });
        return this.load(tx, row.id);
      });
    } catch (error) {
      throw listingGone(error) ?? error;
    }
  }

  async update(id: string, input: UpdateStorefrontCollectionInput): Promise<StorefrontCollection> {
    try {
      return await this.withTenant(async (tx) => {
        await this.requireShop(tx);
        const before = await this.find(tx, id);
        if (before.version !== input.version) throw versionConflict();
        const listingIdsBefore = await this.itemIds(tx, id);
        await this.checkListings(tx, input.listingIds);
        const [after] = await tx
          .update(storefrontCollections)
          .set({
            title: input.title.normalize('NFC'),
            icon: input.icon,
            // The listings are part of the collection: a form open on it should know they changed
            version: sql`${storefrontCollections.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(
            and(
              eq(storefrontCollections.tenantId, getTenantId()),
              eq(storefrontCollections.id, id),
            ),
          )
          .returning();
        if (!after) throw notFound('Collection');
        await this.writeItems(tx, id, input.listingIds);
        await audit(tx, {
          action: 'storefront_collection.updated',
          entityType: 'storefront_collection',
          entityId: id,
          changes: diff(snapshot(before, listingIdsBefore), snapshot(after, input.listingIds)),
        });
        return this.load(tx, id);
      });
    } catch (error) {
      throw listingGone(error) ?? error;
    }
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      await lockHome(tx);
      const before = await this.find(tx, id);
      if (before.version !== version) throw versionConflict();
      const listingIdsBefore = await this.itemIds(tx, id);
      // Its rows and its block go with it (both FKs cascade, 26f); the listings stay
      await tx
        .delete(storefrontCollections)
        .where(
          and(eq(storefrontCollections.tenantId, getTenantId()), eq(storefrontCollections.id, id)),
        );
      // The block's place is a gap now: 1, 2, 4. Numbered again, or the next block added would go
      // to 4 while a 12th could never be added (the position check stops at 12)
      await writeHomeBlocks(tx, await homeBlockRefs(tx));
      await audit(tx, {
        action: 'storefront_collection.deleted',
        entityType: 'storefront_collection',
        entityId: id,
        changes: diff(snapshot(before, listingIdsBefore), {
          title: null,
          icon: null,
          listings: null,
        }),
      });
    });
  }

  // Every collection of the shop with its counts, by id, for the Appearance page's blocks
  async summaries(tx: Transaction): Promise<Map<string, StorefrontCollectionSummary>> {
    const rows = z.array(summaryRowSchema).parse(await tx.execute(summarySql(sql`true`)));
    return new Map(rows.map((row) => [row.id, toSummary(row)]));
  }

  private async requireShop(tx: Transaction): Promise<void> {
    if ((await this.settings.find(tx, false)) === null) throw notSetUp();
  }

  // The collection's row, locked: its version is what the save compares
  private async find(tx: Transaction, id: string) {
    const [row] = await tx
      .select()
      .from(storefrontCollections)
      .where(
        and(eq(storefrontCollections.tenantId, getTenantId()), eq(storefrontCollections.id, id)),
      )
      .for('update');
    if (!row) throw notFound('Collection');
    return row;
  }

  private async itemIds(tx: Transaction, id: string): Promise<string[]> {
    const rows = await tx
      .select({ listingId: storefrontCollectionItems.listingId })
      .from(storefrontCollectionItems)
      .where(
        and(
          eq(storefrontCollectionItems.tenantId, getTenantId()),
          eq(storefrontCollectionItems.collectionId, id),
        ),
      )
      .orderBy(asc(storefrontCollectionItems.position));
    return rows.map((row) => row.listingId);
  }

  // Every id is a listing of this workspace. The FK would refuse another workspace's id too, but
  // as a 500 naming no box; this names the one to remove (listingIds.3)
  private async checkListings(tx: Transaction, ids: readonly string[]): Promise<void> {
    const found = await this.listings.summaries(tx, ids);
    const fieldErrors: Record<string, ErrorCode[]> = {};
    ids.forEach((listingId, index) => {
      if (!found.has(listingId))
        fieldErrors[`listingIds.${String(index)}`] = ['storefront_listing_invalid'];
    });
    if (Object.keys(fieldErrors).length > 0) {
      throw new AppError(409, 'storefront_listing_invalid', 'A listing is not in the shop.', {
        fieldErrors,
      });
    }
  }

  // The listings in the form's order, as 1, 2, 3…, written again on every save (the order is the
  // list, so a diff of moves would be longer than the list). Delete and insert for the same reason
  // as the home blocks: (collection, position) is unique and not deferrable
  private async writeItems(tx: Transaction, id: string, listingIds: readonly string[]) {
    await tx
      .delete(storefrontCollectionItems)
      .where(
        and(
          eq(storefrontCollectionItems.tenantId, getTenantId()),
          eq(storefrontCollectionItems.collectionId, id),
        ),
      );
    await tx.insert(storefrontCollectionItems).values(
      listingIds.map((listingId, index) => ({
        tenantId: getTenantId(),
        collectionId: id,
        listingId,
        position: index + 1,
      })),
    );
  }

  // The collection's page: its counts and its listings in their order
  private async load(tx: Transaction, id: string): Promise<StorefrontCollection> {
    const [row] = z
      .array(summaryRowSchema)
      .parse(await tx.execute(summarySql(sql`c.id = ${id}::uuid`)));
    if (!row) throw notFound('Collection');
    const ids = await this.itemIds(tx, id);
    const listings = await this.listings.summaries(tx, ids);
    return {
      ...toSummary(row),
      listings: ids.flatMap((listingId) => {
        const listing = listings.get(listingId);
        return listing === undefined ? [] : [listing];
      }),
    };
  }
}

function toSummary(row: z.infer<typeof summaryRowSchema>): StorefrontCollectionSummary {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    listingCount: row.listing_count,
    publishedCount: row.published_count,
    version: row.version,
    updatedAt: row.updated_at,
  };
}
