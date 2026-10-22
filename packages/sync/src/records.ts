import type { Product, SyncCustomer } from '@omnivo/contracts';

import type { CustomerRecord, ProductRecord } from './database.js';

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

// The archived variants are searched too, their SKUs and their barcodes, like the server's search
// (products.service.ts): the products page finds the same products on the device as it did
// from the server.
export function productRecord(key: string, gen: number, data: Product): ProductRecord {
  const barcodes = [
    ...data.variants.map((variant) => variant.barcode),
    ...data.units.map((unit) => unit.barcode),
  ].filter((code) => code !== null);
  return {
    key,
    gen,
    data,
    sortName: data.name.toLowerCase(),
    sortCode: data.code.toLowerCase(),
    text: searchText([data.name, data.code, ...data.variants.map((variant) => variant.sku)]),
    barcodes: [...new Set(barcodes)],
    variantIds: data.variants.map((variant) => variant.id),
  };
}

// The server searches the phone as typed (digits have no case); lower case changes nothing in it
export function customerRecord(key: string, gen: number, data: SyncCustomer): CustomerRecord {
  return {
    key,
    gen,
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
