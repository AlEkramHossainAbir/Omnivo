import {
  type PriceLookupItem,
  priceListItemKey,
  type Product,
  startingPrice,
} from '@omnivo/contracts';

import type { LocalCopy } from './copy.js';
import { openRows } from './sealed.js';

// The sales price lookup on the device (step 18b, decision 19): the same answer as
// POST /sales-prices/lookup, from the copy, for the order form without a connection. Step 19b:
// the few rows it needs are read from IndexedDB by their clear ids, then opened.

// The products of some variants, by variant, with one index read (`*variantIds`)
export async function productsOfVariants(
  copy: LocalCopy,
  variantIds: readonly string[],
): Promise<Map<string, Product>> {
  const rows = await copy.db.products.where('variantIds').anyOf(variantIds).distinct().toArray();
  const products = await openRows(copy, 'products', rows);
  return new Map(
    rows.flatMap((row, index) => {
      const product = products[index];
      return product ? row.variantIds.map((id) => [id, product] as const) : [];
    }),
  );
}

// priceListId: the customer's list, or null. Like the server: the list counts only while it is
// active (the device keeps the items of active lists only, 18a); a unit that is neither the
// product's base unit nor one of its packs drops out, like an unknown variant; the VAT rate is
// the product's own while it is active, else the workspace's default; no rate at all drops the
// item (a workspace whose rates are not made yet).
export async function lookUpPrices(
  copy: LocalCopy,
  priceListId: string | null,
  items: readonly { variantId: string; unitId: string }[],
): Promise<PriceLookupItem[]> {
  const { db } = copy;
  const listRow = priceListId === null ? undefined : await db.priceLists.get(priceListId);
  const list = listRow && (await copy.open('priceLists', listRow.key, listRow.box));
  const activeList = list?.archivedAt === null ? list.id : null;
  const rates = await openRows(copy, 'taxRates', await db.taxRates.toArray());
  const defaultRate = rates.find((rate) => rate.isDefault);
  const products = await productsOfVariants(
    copy,
    items.map((item) => item.variantId),
  );
  // Every item's price at once, by its key; undefined where the list has none
  const listItems =
    activeList === null
      ? []
      : await db.priceListItems.bulkGet(
          items.map((item) => priceListItemKey({ priceListId: activeList, ...item })),
        );
  const found: PriceLookupItem[] = [];
  for (const [index, item] of items.entries()) {
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
    const listRow = listItems[index];
    const listItem = listRow && (await copy.open('priceListItems', listRow.key, listRow.box));
    found.push({
      ...item,
      ...startingPrice({
        listPrice: listItem?.price ?? null,
        salePrice: variant.salePrice,
        factor,
      }),
      taxRateId,
    });
  }
  return found;
}
