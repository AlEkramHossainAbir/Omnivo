import type { Product, SyncCustomer } from '@omnivo/contracts';

// Step 19b: a product or a customer as the in-memory copy keeps it (copy.ts), opened, with what its
// list needs to search and sort. These were the rows on the disk before step 19b; now the disk
// keeps them sealed, and only this memory has the names.

// The server sorts on lower(name) and lower(code), so the device does too
export interface ProductRecord {
  key: string;
  data: Product;
  sortName: string;
  sortCode: string;
  // The name, the code and the SKUs in lower case, for "contains"
  text: string;
  // Every barcode of the product: its variants' and its packs'. A barcode is matched whole.
  barcodes: string[];
  // Its variants' ids (step 18b): the order form offline finds a line's product by its variant
  variantIds: string[];
}

export interface CustomerRecord {
  key: string;
  data: SyncCustomer;
  sortName: string;
  // The name, the code, the contact person and the phone in lower case, for "contains"
  text: string;
}

// The text a search looks in, in lower case. The parts are joined with a line break, which no
// search box can hold, so a search never matches across two parts ("Shirt" + "M" is not "tm").
export function searchText(parts: readonly (string | null)[]): string {
  return parts
    .filter((part) => part !== null && part !== '')
    .join('\n')
    .toLowerCase();
}

// What the search box holds, ready to compare: lower case for "contains", as typed for a barcode
export interface Needle {
  text: string;
  barcode: string;
}

export function needleOf(search: string): Needle | null {
  const typed = search.trim();
  return typed === '' ? null : { text: typed.toLowerCase(), barcode: typed };
}

// What a product row keeps clear for its indexes (database.ts → ProductRow). The archived
// variants count too, their SKUs and their barcodes, like the server's search
// (products.service.ts): the products page finds the same products on the device as it did
// from the server.
export function productIndex(data: Product): { barcodes: string[]; variantIds: string[] } {
  const barcodes = [
    ...data.variants.map((variant) => variant.barcode),
    ...data.units.map((unit) => unit.barcode),
  ].filter((code) => code !== null);
  return {
    barcodes: [...new Set(barcodes)],
    variantIds: data.variants.map((variant) => variant.id),
  };
}

export function productRecord(key: string, data: Product): ProductRecord {
  return {
    key,
    data,
    sortName: data.name.toLowerCase(),
    sortCode: data.code.toLowerCase(),
    text: searchText([data.name, data.code, ...data.variants.map((variant) => variant.sku)]),
    ...productIndex(data),
  };
}

// The server searches the phone as typed (digits have no case); lower case changes nothing in it
export function customerRecord(key: string, data: SyncCustomer): CustomerRecord {
  return {
    key,
    data,
    sortName: data.name.toLowerCase(),
    text: searchText([data.name, data.code, data.contactPerson, data.phone]),
  };
}

export function productMatches(record: ProductRecord, needle: Needle | null): boolean {
  return (
    needle === null || record.text.includes(needle.text) || record.barcodes.includes(needle.barcode)
  );
}

export function customerMatches(record: CustomerRecord, needle: Needle | null): boolean {
  return needle === null || record.text.includes(needle.text);
}
