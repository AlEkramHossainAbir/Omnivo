import type { ShopSource } from './data/types';

// Step 26f.5: what src/middleware.ts gives every page and route, as Astro.locals (or `locals` in an
// API route). Astro's own types read the global App namespace; without this, Astro.locals.source
// would not type-check. `declare global` because the import makes this file a module, and a
// namespace declared in a module would be the module's own, which Astro never sees
declare global {
  namespace App {
    interface Locals {
      // The data source for the shop this request's host names
      source: ShopSource;
      // True when the host is no launched shop: the middleware has drawn the 404 page in the
      // page's place (pages/404.astro), and that page must not ask the source for a shop it does
      // not have
      shopMissing: boolean;
    }
  }
}
