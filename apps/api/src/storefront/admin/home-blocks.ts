import {
  type ErrorCode,
  STOREFRONT_HOME_BLOCKS_MAX,
  type StorefrontBanner,
  type StorefrontCollectionSummary,
  type StorefrontHomeBlock,
} from '@omnivo/contracts';
import { storefrontHomeBlocks } from '@omnivo/db';
import { asc, eq, sql } from 'drizzle-orm';

import { AppError } from '../../common/http/app-error.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';

// Step 26h: the home page's order (storefront_home_blocks), shared by the banners, the collections
// and Move up / down. A block is a banner or a collection; its key is its place on the page.

// What a block points at. Exactly one of the two, like the table's storefront_home_blocks_one_check
export type HomeBlockRef =
  { bannerId: string; collectionId: null } | { bannerId: null; collectionId: string };

// Every change to the order takes this lock first: adding a banner and a collection at once must
// not both take the place after the last one, and a move must not swap a block that a delete is
// taking away. The page has at most twelve blocks that change rarely, so the wait is nothing
export async function lockHome(tx: Transaction): Promise<void> {
  const key = `storefront_home:${getTenantId()}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

// The blocks in the page's order
export async function homeBlockRefs(tx: Transaction): Promise<HomeBlockRef[]> {
  const rows = await tx
    .select({
      bannerId: storefrontHomeBlocks.bannerId,
      collectionId: storefrontHomeBlocks.collectionId,
    })
    .from(storefrontHomeBlocks)
    .where(eq(storefrontHomeBlocks.tenantId, getTenantId()))
    .orderBy(asc(storefrontHomeBlocks.position));
  // The table's check makes each row one or the other; this tells TypeScript
  return rows.flatMap((row): HomeBlockRef[] => {
    if (row.bannerId !== null) return [{ bannerId: row.bannerId, collectionId: null }];
    if (row.collectionId !== null) return [{ bannerId: null, collectionId: row.collectionId }];
    return [];
  });
}

// A refusal for a full list. No box to put it under: it belongs to the "Add" button
export function full(code: ErrorCode, detail: string): AppError {
  return new AppError(409, code, detail);
}

// Room for one more block. Asked before the banner or collection is made, under lockHome, so the
// answer still holds at the insert. The table's position check (1–12) would refuse a 13th too,
// as a 500: this says it in words
export async function checkHomeRoom(tx: Transaction): Promise<void> {
  if ((await homeBlockRefs(tx)).length >= STOREFRONT_HOME_BLOCKS_MAX) {
    throw full('storefront_home_full', 'The home page has 12 blocks. Remove one first.');
  }
}

// A new banner or collection goes to the end of the page (decision 2: everything is on the page)
export async function appendHomeBlock(tx: Transaction, ref: HomeBlockRef): Promise<void> {
  const blocks = await homeBlockRefs(tx);
  await tx.insert(storefrontHomeBlocks).values({
    tenantId: getTenantId(),
    // The positions are 1, 2, 3… with no gap (writeHomeBlocks keeps them so), so the count is the
    // last one
    position: blocks.length + 1,
    ...ref,
  });
}

// Writes the whole order again, as 1, 2, 3… Used by Move (a swap) and after a delete (the gap
// closes). Delete and insert, not UPDATE: the key is (tenant, position) and not deferrable, so a
// swap in one UPDATE meets the other row's old position and fails with 23505 (proven in 26h.2).
// Twelve rows at most
export async function writeHomeBlocks(tx: Transaction, refs: readonly HomeBlockRef[]) {
  await tx.delete(storefrontHomeBlocks).where(eq(storefrontHomeBlocks.tenantId, getTenantId()));
  if (refs.length === 0) return;
  await tx
    .insert(storefrontHomeBlocks)
    .values(refs.map((ref, index) => ({ tenantId: getTenantId(), position: index + 1, ...ref })));
}

// The page's blocks as the Appearance page shows them. A block whose banner or collection the
// maps do not have is left out; it cannot happen (the FKs cascade), and a half block on the screen
// would be worse than one missing
export function homeBlocksOf(
  refs: readonly HomeBlockRef[],
  banners: ReadonlyMap<string, StorefrontBanner>,
  collections: ReadonlyMap<string, StorefrontCollectionSummary>,
): StorefrontHomeBlock[] {
  return refs.flatMap((ref): StorefrontHomeBlock[] => {
    if (ref.bannerId !== null) {
      const banner = banners.get(ref.bannerId);
      return banner === undefined ? [] : [{ kind: 'banner', banner }];
    }
    const collection = collections.get(ref.collectionId);
    return collection === undefined ? [] : [{ kind: 'collection', collection }];
  });
}
