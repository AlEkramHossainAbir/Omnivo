import type {
  PublicShop,
  ShopCartQuote,
  ShopCartQuoteRequest,
  ShopCategory,
  ShopHome,
  ShopProductPage,
} from '@omnivo/contracts';

// What every data source answers. Its own file, so the mock can implement it without importing
// source.ts, which imports the mock (a circle .dependency-cruiser.cjs refuses)
export interface ShopSource {
  shop(): Promise<PublicShop>;
  categories(): Promise<ShopCategory[]>;
  home(): Promise<ShopHome>;
  // Step 26b: one product's page. null: no published listing has this slug, so the page answers
  // 404. Not an error: an old link or a typo is normal traffic
  product(slug: string): Promise<ShopProductPage | null>;
  // Step 26b: today's prices for a cart. The route checks the request first
  // (shopCartQuoteRequestSchema), so a source never sees a quantity of 0 or one listing twice
  quote(request: ShopCartQuoteRequest): Promise<ShopCartQuote>;
}
