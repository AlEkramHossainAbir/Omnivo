import type { ShopSource } from '../types';
import { mockHome } from './home';
import { mockCategories, mockShop } from './shop';

// The mock answers at once. Still a promise, so the pages are written for the real source, which
// waits for the network
export const mockSource: ShopSource = {
  shop: () => Promise.resolve(mockShop),
  categories: () => Promise.resolve(mockCategories),
  home: () => Promise.resolve(mockHome),
};
