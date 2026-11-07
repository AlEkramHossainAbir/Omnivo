import type { ShopBadge, ShopListing } from '@omnivo/contracts';

// Step 26a: the products of the Figma design, with their names, pack sizes and prices. The photos
// are files in public/mock/products/, named after the slug (the guide lists them).
interface MockProduct {
  slug: string;
  name: string;
  packSize: string;
  price: string;
  categoryId: string;
  badges?: ShopBadge[];
  // undefined: the design's "৳10 OFF" ribbon, which almost every card has; null: no ribbon
  discount?: ShopListing['discount'];
  inStock?: boolean;
}

function listing(product: MockProduct): ShopListing {
  return {
    id: `lst-${product.slug}`,
    slug: product.slug,
    name: product.name,
    packSize: product.packSize,
    images: [{ url: `/mock/products/${product.slug}.png`, alt: product.name }],
    price: product.price,
    compareAtPrice: null,
    saleUntil: null,
    discount: product.discount === undefined ? { kind: 'amount', value: '10' } : product.discount,
    badges: product.badges ?? [],
    inStock: product.inStock ?? true,
    categoryId: product.categoryId,
  };
}

const PICKED: ShopBadge[] = ['most_picked'];

export const featuredListings: ShopListing[] = [
  listing({
    slug: 'sprite-cold-drink-500ml',
    name: 'Cold drinks (Sprite)',
    packSize: '500ml',
    price: '50',
    categoryId: 'cat-beverages',
    badges: PICKED,
  }),
  listing({
    slug: 'domex-lime-fresh-750ml',
    name: 'Domex Lime Fresh Toilet Cleaner',
    packSize: '750ml',
    price: '98',
    categoryId: 'cat-household',
  }),
  listing({
    slug: 'tresemme-hair-fall-defense-580ml',
    name: 'TRESemmé HD Hair Fall Defense Shampoo',
    packSize: '580ml',
    price: '850',
    categoryId: 'cat-cosmetics',
    badges: PICKED,
  }),
  listing({
    slug: 'davidoff-espresso-coffee',
    name: 'Davidoff Espresso Coffee',
    packSize: '90(±)10gm',
    price: '1199',
    categoryId: 'cat-beverages',
  }),
  listing({
    slug: 'aci-pure-turmeric-200gm',
    name: 'ACI Pure Turmeric (Holud) Powder',
    packSize: '200gm',
    price: '130',
    categoryId: 'cat-food',
    badges: PICKED,
  }),
];

export const himalayaListings: ShopListing[] = [
  listing({
    slug: 'himalaya-vitamin-c-face-wash-100ml',
    name: 'Himalaya Brightening Vitamin-C Orange Face Wash',
    packSize: '100ml',
    price: '159',
    categoryId: 'cat-cosmetics',
  }),
  listing({
    slug: 'himalaya-anti-dandruff-shampoo-180ml',
    name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
    packSize: '180(±)10ml',
    price: '229',
    categoryId: 'cat-cosmetics',
  }),
  listing({
    slug: 'himalaya-anti-dandruff-twin-pack',
    name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo, twin pack',
    packSize: '180(±)10ml',
    price: '270',
    categoryId: 'cat-cosmetics',
    badges: ['new', 'buy_one_get_one'],
    discount: null,
  }),
  listing({
    slug: 'himalaya-oil-control-lemon-face-wash-100ml',
    name: 'Himalaya Oil Control Lemon Face Wash',
    packSize: '100ml',
    price: '200',
    categoryId: 'cat-cosmetics',
  }),
  listing({
    slug: 'himalaya-anti-hair-fall-shampoo-180ml',
    name: 'Himalaya Anti Hair Fall Shampoo',
    packSize: '180(±)10ml',
    price: '270',
    categoryId: 'cat-cosmetics',
  }),
];

export const trendingListings: ShopListing[] = [
  listing({
    slug: 'ispahani-mirzapore-bestleaf-400gm',
    name: 'Ispahani Mirzapore Bestleaf',
    packSize: '400gm',
    price: '248',
    categoryId: 'cat-tea',
    badges: PICKED,
  }),
  listing({
    slug: 'seylon-family-blend-tea-400gm',
    name: 'Seylon Family Blend Tea',
    packSize: '400gm',
    price: '205',
    categoryId: 'cat-tea',
    badges: PICKED,
  }),
  listing({
    slug: 'ispahani-mirzapore-bestleaf-200gm',
    name: 'Ispahani Mirzapore Bestleaf',
    packSize: '200gm',
    price: '126',
    categoryId: 'cat-tea',
    badges: PICKED,
  }),
  listing({
    slug: 'pusti-plus-full-cream-milk-1kg',
    name: 'Pusti Plus Instant Full Cream Milk Powder',
    packSize: '1kg',
    price: '950',
    categoryId: 'cat-food',
    badges: PICKED,
  }),
  // Out of stock on purpose, so the disabled button is on the page
  listing({
    slug: 'dano-daily-pushti-milk-1kg',
    name: 'Dano Daily Pushti Milk',
    packSize: '1kg',
    price: '780',
    categoryId: 'cat-food',
    badges: PICKED,
    inStock: false,
  }),
];

export const diabeticListings: ShopListing[] = [
  listing({
    slug: 'cyprina-apple-juice-1ltr',
    name: 'Cyprina Apple Juice',
    packSize: '1ltr',
    price: '625',
    categoryId: 'cat-diabetic',
    badges: PICKED,
  }),
  listing({
    slug: 'zero-cal-stevia-30-sachets',
    name: 'Zero Cal Stevia 30 Sachets',
    packSize: '30 sachets',
    price: '120',
    categoryId: 'cat-diabetic',
    badges: PICKED,
  }),
  listing({
    slug: 'sis-low-gi-sugar-350gm',
    name: 'SIS Low GI Sugar Singapore',
    packSize: '350gm',
    price: '860',
    categoryId: 'cat-diabetic',
    badges: PICKED,
  }),
  listing({
    slug: 'zero-cal-stevia-box',
    name: 'Zero Cal Stevia 30 Sachets, gift box',
    packSize: '30 sachets',
    price: '950',
    categoryId: 'cat-diabetic',
    badges: PICKED,
  }),
  listing({
    slug: 'cyprina-mango-orange-apple-juice-1ltr',
    name: 'Cyprina Natural Mango Orange & Apple Juice',
    packSize: '1ltr',
    price: '780',
    categoryId: 'cat-diabetic',
    badges: PICKED,
  }),
];
