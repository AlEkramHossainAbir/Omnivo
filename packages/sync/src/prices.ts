import {
  type PriceLookupItem,
  priceListItemKey,
  type Product,
  startingPrice,
} from '@omnivo/contracts';

import type { SyncDatabase } from './database.js';

// The sales price lookup on the device (step 18b, decision 19): the same answer as
// POST /sales-prices/lookup, from the copy, for the order form without a connection.

// The products of some variants, by variant, with one index read (`*variantIds`)
export async function productsOfVariants(
  db: SyncDatabase,
  variantIds: readonly string[],
): Promise<Map<string, Product>> {
  const records = await db.products.where('variantIds').anyOf(variantIds).distinct().toArray();
  return new Map(
    records.flatMap((record) => record.variantIds.map((id) => [id, record.data] as const)),
  );
}

// priceListId: the customer's list, or null. Like the server: the list counts only while it is
// active (the device keeps the items of active lists only, 18a); a unit that is neither the
// product's base unit nor one of its packs drops out, like an unknown variant; the VAT rate is
// the product's own while it is active, else the workspace's default; no rate at all drops the
// item (a workspace whose rates are not made yet).
export async function lookUpPrices(
  db: SyncDatabase,
  priceListId: string | null,
  items: readonly { variantId: string; unitId: string }[],
): Promise<PriceLookupItem[]> {
  const list = priceListId === null ? undefined : await db.priceLists.get(priceListId);
  const activeList = list?.data.archivedAt === null ? list.data.id : null;
  const rates = (await db.taxRates.toArray()).map((record) => record.data);
  const defaultRate = rates.find((rate) => rate.isDefault);
  const products = await productsOfVariants(
    db,
    items.map((item) => item.variantId),
  );
  const found: PriceLookupItem[] = [];
  for (const item of items) {
    const product = products.get(item.variantId);
    const variant = product?.variants.find((one) => one.id === item.variantId);
    if (!product || !variant) continue;
    const factor =
      item.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === item.unitId)?.factor;
    if (factor === undefined) continue;
    const own = rates.find((rate) => rate.id === product.taxRateId && rate.archivedAt === null);
    const taxRateId = own?.id ?? defaultRate?.id;
    if (taxRateId === undefined) continue;
    const listItem =
      activeList === null
        ? undefined
        : await db.priceListItems.get(priceListItemKey({ priceListId: activeList, ...item }));
    found.push({
      ...item,
      ...startingPrice({
        listPrice: listItem?.data.price ?? null,
        salePrice: variant.salePrice,
        factor,
      }),
      taxRateId,
    });
  }
  return found;
}
