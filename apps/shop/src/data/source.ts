import { mockSource } from './mock/mock-source';
import type { ShopSource } from './types';

// Step 26a: the only door the pages use to get data. Today it is the mock; step 26b adds a source
// that reads the public API (/public/v1) for the shop the request's Host names, and this file picks
// it. No page or component imports the mock directly (src/boundaries.spec.ts), so swapping the
// source cannot leave one page on fake data.
export const shopSource: ShopSource = mockSource;
