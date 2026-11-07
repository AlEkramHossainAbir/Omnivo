import type { ShopHome } from '@omnivo/contracts';

import { diabeticListings, featuredListings, himalayaListings, trendingListings } from './listings';

// Step 26a: the home page of the Figma design, top to bottom
export const mockHome = {
  hero: {
    id: 'bnr-cashback',
    kind: 'hero',
    href: '/c/cosmetics',
    headline: 'Get 10% Cash-back on Shopping ৳150',
    line: 'Shop your favorite brands and save big this season.',
    eyebrow: 'Exclusive offer',
    buttonLabel: 'Get 10% Cashback',
    desktopImage: { url: '/mock/banners/hero-desktop.png', alt: 'Make-up and skin care products' },
    phoneImage: { url: '/mock/banners/hero-phone.jpg', alt: 'Make-up and skin care products' },
    colors: { background: '#eee0d8', panel: '#54260a', button: '#e7d1b2', buttonText: '#8b471f' },
  },
  featured: featuredListings,
  hasMoreFeatured: true,
  blocks: [
    {
      id: 'bnr-mega-sale',
      kind: 'image',
      href: '/c/cosmetics',
      desktopImage: { url: '/mock/banners/mega-sale-desktop.png', alt: 'Himalaya mega sale' },
      phoneImage: { url: '/mock/banners/mega-sale-phone.jpg', alt: 'Himalaya mega sale' },
    },
    {
      kind: 'collection',
      collection: {
        id: 'col-himalaya',
        title: 'Refresh with Himalaya',
        icon: null,
        listings: himalayaListings,
      },
    },
    {
      kind: 'collection',
      collection: {
        id: 'col-trending',
        title: 'Hot & Trending Right Now',
        icon: 'fire',
        listings: trendingListings,
      },
    },
    {
      kind: 'collection',
      collection: {
        id: 'col-diabetic',
        title: 'Diabetic Corner',
        icon: null,
        listings: diabeticListings,
      },
    },
  ],
} satisfies ShopHome;
