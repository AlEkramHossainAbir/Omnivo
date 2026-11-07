import type { PublicShop, ShopCategory, ShopHome } from '@omnivo/contracts';

// What every data source answers. Its own file, so the mock can implement it without importing
// source.ts, which imports the mock (a circle .dependency-cruiser.cjs refuses)
export interface ShopSource {
  shop(): Promise<PublicShop>;
  categories(): Promise<ShopCategory[]>;
  home(): Promise<ShopHome>;
}
