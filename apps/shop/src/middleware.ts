import { defineMiddleware } from 'astro:middleware';

import { ShopMissingError } from './data/api/shop-api';
import { sourceFor } from './data/source';
import { problemResponse } from './server/problem';

// Step 26f.5: runs before every page and API route. It gives the request its data source (the one
// for the shop its host names), and stops a host that is no launched shop before any page runs,
// because every page draws the shop's header and footer and would fail without a shop.
export const onRequest = defineMiddleware(async (context, next) => {
  const source = sourceFor(context.url);
  context.locals.source = source;

  try {
    // The page asks for the shop again; the API source's cache answers that one, and the mock
    // answers at once, so the check costs one request per host every 30 seconds
    await source.shop();
    context.locals.shopMissing = false;
  } catch (error) {
    // Any other failure (the API down) is the page's normal 500: only "no such shop" is answered
    // here
    if (!(error instanceof ShopMissingError)) throw error;
    context.locals.shopMissing = true;
    // A script (the cart drawer, the checkout) reads problem JSON, like every other refusal
    if (context.url.pathname.startsWith('/api/')) {
      return problemResponse(404, 'storefront_not_found', 'No shop has this address.');
    }
    // 26f.5's decision c: the 404 page, without a shop's frame (pages/404.astro). A rewrite, not a
    // redirect: the address stays the one the shopper typed, and Astro answers its 404 page with
    // the 404 status, so a search engine keeps nothing. A rewrite from `next()` does not run this
    // middleware again, so it cannot loop
    return next('/404');
  }
  return next();
});
