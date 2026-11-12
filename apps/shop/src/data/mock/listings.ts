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
  // Step 26d: the price before the sale, struck through; undefined: no sale
  compareAtPrice?: string;
  // Step 26d: the slug whose photo the card shows. The mock has 22 photos for 62 listings, so another
  // pack size of a product shows that product's photo; undefined: the listing's own slug
  photo?: string;
}

// Exported in step 26b: products.ts makes the product page's listing with it, so that listing has
// the same id and photo rules as every card
export function listing(product: MockProduct): ShopListing {
  return {
    id: `lst-${product.slug}`,
    slug: product.slug,
    name: product.name,
    packSize: product.packSize,
    images: [{ url: `/mock/products/${product.photo ?? product.slug}.png`, alt: product.name }],
    price: product.price,
    compareAtPrice: product.compareAtPrice ?? null,
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
    categoryId: 'cat-hair-care',
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
    categoryId: 'cat-skin-care',
  }),
  listing({
    slug: 'himalaya-anti-dandruff-shampoo-180ml',
    name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
    packSize: '180(±)10ml',
    price: '229',
    categoryId: 'cat-hair-care',
  }),
  listing({
    slug: 'himalaya-anti-dandruff-twin-pack',
    name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo, twin pack',
    packSize: '180(±)10ml',
    price: '270',
    categoryId: 'cat-hair-care',
    badges: ['new', 'buy_one_get_one'],
    discount: null,
  }),
  listing({
    slug: 'himalaya-oil-control-lemon-face-wash-100ml',
    name: 'Himalaya Oil Control Lemon Face Wash',
    packSize: '100ml',
    price: '200',
    categoryId: 'cat-skin-care',
  }),
  listing({
    slug: 'himalaya-anti-hair-fall-shampoo-180ml',
    name: 'Himalaya Anti Hair Fall Shampoo',
    packSize: '180(±)10ml',
    price: '270',
    categoryId: 'cat-hair-care',
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

// Step 26d: a listing on the shelves only (not on the home page). Most real listings have no sale,
// so here undefined means no ribbon: with the design's "৳10 OFF" on every card, the Offer chip would
// leave every card on the page and show nothing
function shelf(product: MockProduct): ShopListing {
  return listing({ ...product, discount: product.discount ?? null });
}

// Step 26d: the rest of the shop, so a category has more than one page (20 cards a page) and every
// filter has something to drop: other pack sizes of the products above, with their photos. Some
// have a sale, a percent ribbon, a price with paisa, no stock, or a Bangla name (the search must
// find "নিম" as well as "neem")
export const shelfListings: ShopListing[] = [
  shelf({
    slug: 'sprite-cold-drink-250ml',
    name: 'Cold drinks (Sprite)',
    packSize: '250ml',
    price: '25',
    categoryId: 'cat-beverages',
    photo: 'sprite-cold-drink-500ml',
  }),
  shelf({
    slug: 'sprite-cold-drink-1-25ltr',
    name: 'Cold drinks (Sprite)',
    packSize: '1.25ltr',
    price: '90',
    categoryId: 'cat-beverages',
    photo: 'sprite-cold-drink-500ml',
  }),
  shelf({
    slug: 'sprite-cold-drink-2-25ltr',
    name: 'Cold drinks (Sprite)',
    packSize: '2.25ltr',
    price: '150',
    categoryId: 'cat-beverages',
    photo: 'sprite-cold-drink-500ml',
    inStock: false,
  }),
  shelf({
    slug: 'davidoff-rich-aroma-coffee-100gm',
    name: 'Davidoff Rich Aroma Coffee',
    packSize: '100gm',
    price: '1250',
    categoryId: 'cat-beverages',
    photo: 'davidoff-espresso-coffee',
  }),
  shelf({
    slug: 'davidoff-fine-aroma-coffee-100gm',
    name: 'Davidoff Fine Aroma Coffee',
    packSize: '100gm',
    price: '1180',
    categoryId: 'cat-beverages',
    photo: 'davidoff-espresso-coffee',
    compareAtPrice: '1350',
    discount: { kind: 'amount', value: '170' },
  }),
  shelf({
    slug: 'ispahani-mirzapore-bestleaf-100gm',
    name: 'Ispahani Mirzapore Bestleaf',
    packSize: '100gm',
    price: '66',
    categoryId: 'cat-tea',
    photo: 'ispahani-mirzapore-bestleaf-200gm',
  }),
  shelf({
    slug: 'ispahani-mirzapore-bestleaf-1kg',
    name: 'Ispahani Mirzapore Bestleaf',
    packSize: '1kg',
    price: '610',
    categoryId: 'cat-tea',
    photo: 'ispahani-mirzapore-bestleaf-400gm',
    discount: { kind: 'percent', value: 5 },
  }),
  shelf({
    slug: 'seylon-family-blend-tea-200gm',
    name: 'Seylon Family Blend Tea',
    packSize: '200gm',
    price: '108',
    categoryId: 'cat-tea',
    photo: 'seylon-family-blend-tea-400gm',
  }),
  shelf({
    slug: 'seylon-family-blend-tea-1kg',
    name: 'Seylon Family Blend Tea',
    packSize: '1kg',
    price: '495',
    categoryId: 'cat-tea',
    photo: 'seylon-family-blend-tea-400gm',
  }),
  shelf({
    slug: 'seylon-family-blend-tea-bags-100',
    name: 'Seylon Family Blend Tea Bags',
    packSize: '100 bags',
    price: '260',
    categoryId: 'cat-tea',
    photo: 'seylon-family-blend-tea-400gm',
    badges: ['new'],
  }),
  shelf({
    slug: 'aci-pure-turmeric-100gm',
    name: 'ACI Pure Turmeric (Holud) Powder',
    packSize: '100gm',
    price: '70',
    categoryId: 'cat-food',
    photo: 'aci-pure-turmeric-200gm',
  }),
  shelf({
    slug: 'aci-pure-turmeric-500gm',
    name: 'ACI Pure Turmeric (Holud) Powder',
    packSize: '500gm',
    price: '300',
    categoryId: 'cat-food',
    photo: 'aci-pure-turmeric-200gm',
  }),
  shelf({
    slug: 'aci-pure-turmeric-1kg',
    name: 'ACI Pure Turmeric (Holud) Powder',
    packSize: '1kg',
    price: '580',
    categoryId: 'cat-food',
    photo: 'aci-pure-turmeric-200gm',
    inStock: false,
  }),
  shelf({
    slug: 'aci-pure-holud-gura-50gm',
    name: 'এসিআই পিওর হলুদ গুঁড়া',
    packSize: '50gm',
    price: '38',
    categoryId: 'cat-food',
    photo: 'aci-pure-turmeric-200gm',
  }),
  shelf({
    slug: 'pusti-plus-full-cream-milk-500gm',
    name: 'Pusti Plus Instant Full Cream Milk Powder',
    packSize: '500gm',
    price: '490',
    categoryId: 'cat-food',
    photo: 'pusti-plus-full-cream-milk-1kg',
  }),
  shelf({
    slug: 'pusti-plus-full-cream-milk-2-5kg',
    name: 'Pusti Plus Instant Full Cream Milk Powder',
    packSize: '2.5kg',
    price: '2350',
    categoryId: 'cat-food',
    photo: 'pusti-plus-full-cream-milk-1kg',
    compareAtPrice: '2450',
    discount: { kind: 'amount', value: '100' },
  }),
  shelf({
    slug: 'dano-daily-pushti-milk-500gm',
    name: 'Dano Daily Pushti Milk',
    packSize: '500gm',
    price: '400',
    categoryId: 'cat-food',
    photo: 'dano-daily-pushti-milk-1kg',
  }),
  shelf({
    slug: 'dano-daily-pushti-milk-2kg',
    name: 'Dano Daily Pushti Milk',
    packSize: '2kg',
    price: '1540',
    categoryId: 'cat-food',
    photo: 'dano-daily-pushti-milk-1kg',
    discount: { kind: 'percent', value: 5 },
  }),
  shelf({
    slug: 'zero-cal-stevia-100-sachets',
    name: 'Zero Cal Stevia 100 Sachets',
    packSize: '100 sachets',
    price: '339.50',
    categoryId: 'cat-diabetic',
    photo: 'zero-cal-stevia-30-sachets',
  }),
  shelf({
    slug: 'zero-cal-stevia-200-sachets',
    name: 'Zero Cal Stevia 200 Sachets',
    packSize: '200 sachets',
    price: '620',
    categoryId: 'cat-diabetic',
    photo: 'zero-cal-stevia-box',
  }),
  shelf({
    slug: 'sis-low-gi-sugar-700gm',
    name: 'SIS Low GI Sugar Singapore',
    packSize: '700gm',
    price: '1650',
    categoryId: 'cat-diabetic',
    photo: 'sis-low-gi-sugar-350gm',
  }),
  shelf({
    slug: 'cyprina-apple-juice-250ml',
    name: 'Cyprina Apple Juice',
    packSize: '250ml',
    price: '160',
    categoryId: 'cat-diabetic',
    photo: 'cyprina-apple-juice-1ltr',
  }),
  shelf({
    slug: 'cyprina-mango-orange-apple-juice-250ml',
    name: 'Cyprina Natural Mango Orange & Apple Juice',
    packSize: '250ml',
    price: '180',
    categoryId: 'cat-diabetic',
    photo: 'cyprina-mango-orange-apple-juice-1ltr',
  }),
  shelf({
    slug: 'domex-lime-fresh-500ml',
    name: 'Domex Lime Fresh Toilet Cleaner',
    packSize: '500ml',
    price: '75',
    categoryId: 'cat-household',
    photo: 'domex-lime-fresh-750ml',
  }),
  shelf({
    slug: 'domex-lime-fresh-1ltr',
    name: 'Domex Lime Fresh Toilet Cleaner',
    packSize: '1ltr',
    price: '128',
    categoryId: 'cat-household',
    photo: 'domex-lime-fresh-750ml',
  }),
  shelf({
    slug: 'domex-lime-fresh-twin-pack',
    name: 'Domex Lime Fresh Toilet Cleaner, twin pack',
    packSize: '2 × 750ml',
    price: '185',
    categoryId: 'cat-household',
    photo: 'domex-lime-fresh-750ml',
    badges: ['buy_one_get_one'],
  }),
  shelf({
    slug: 'domex-ocean-fresh-750ml',
    name: 'Domex Ocean Fresh Toilet Cleaner',
    packSize: '750ml',
    price: '98',
    categoryId: 'cat-household',
    photo: 'domex-lime-fresh-750ml',
  }),
  shelf({
    slug: 'tresemme-hair-fall-defense-340ml',
    name: 'TRESemmé HD Hair Fall Defense Shampoo',
    packSize: '340ml',
    price: '520',
    categoryId: 'cat-hair-care',
    photo: 'tresemme-hair-fall-defense-580ml',
  }),
  shelf({
    slug: 'tresemme-hair-fall-defense-1ltr',
    name: 'TRESemmé HD Hair Fall Defense Shampoo',
    packSize: '1ltr',
    price: '1450',
    categoryId: 'cat-hair-care',
    photo: 'tresemme-hair-fall-defense-580ml',
    compareAtPrice: '1650',
    discount: { kind: 'amount', value: '200' },
  }),
  shelf({
    slug: 'tresemme-keratin-smooth-shampoo-580ml',
    name: 'TRESemmé Keratin Smooth Shampoo',
    packSize: '580ml',
    price: '850',
    categoryId: 'cat-hair-care',
    photo: 'tresemme-hair-fall-defense-580ml',
  }),
  shelf({
    slug: 'himalaya-anti-dandruff-shampoo-80ml',
    name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
    packSize: '80ml',
    price: '110',
    categoryId: 'cat-hair-care',
    photo: 'himalaya-anti-dandruff-shampoo-180ml',
  }),
  shelf({
    slug: 'himalaya-anti-dandruff-shampoo-400ml',
    name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
    packSize: '400ml',
    price: '460',
    categoryId: 'cat-hair-care',
    photo: 'himalaya-anti-dandruff-shampoo-180ml',
  }),
  shelf({
    slug: 'himalaya-anti-hair-fall-shampoo-80ml',
    name: 'Himalaya Anti Hair Fall Shampoo',
    packSize: '80ml',
    price: '125',
    categoryId: 'cat-hair-care',
    photo: 'himalaya-anti-hair-fall-shampoo-180ml',
  }),
  shelf({
    slug: 'himalaya-anti-hair-fall-shampoo-400ml',
    name: 'Himalaya Anti Hair Fall Shampoo',
    packSize: '400ml',
    price: '520',
    categoryId: 'cat-hair-care',
    photo: 'himalaya-anti-hair-fall-shampoo-180ml',
    inStock: false,
  }),
  shelf({
    slug: 'himalaya-vitamin-c-face-wash-50ml',
    name: 'Himalaya Brightening Vitamin-C Orange Face Wash',
    packSize: '50ml',
    price: '85',
    categoryId: 'cat-skin-care',
    photo: 'himalaya-vitamin-c-face-wash-100ml',
  }),
  shelf({
    slug: 'himalaya-vitamin-c-face-wash-150ml',
    name: 'Himalaya Brightening Vitamin-C Orange Face Wash',
    packSize: '150ml',
    price: '229',
    categoryId: 'cat-skin-care',
    photo: 'himalaya-vitamin-c-face-wash-100ml',
  }),
  shelf({
    slug: 'himalaya-oil-control-lemon-face-wash-50ml',
    name: 'Himalaya Oil Control Lemon Face Wash',
    packSize: '50ml',
    price: '99',
    categoryId: 'cat-skin-care',
    photo: 'himalaya-oil-control-lemon-face-wash-100ml',
  }),
  shelf({
    slug: 'himalaya-oil-control-lemon-face-wash-150ml',
    name: 'Himalaya Oil Control Lemon Face Wash',
    packSize: '150ml',
    price: '270',
    categoryId: 'cat-skin-care',
    photo: 'himalaya-oil-control-lemon-face-wash-100ml',
    discount: { kind: 'percent', value: 10 },
  }),
  shelf({
    slug: 'himalaya-purifying-neem-face-wash-50ml',
    name: 'Himalaya Purifying Neem Face Wash',
    packSize: '50ml',
    price: '99',
    categoryId: 'cat-skin-care',
    photo: 'himalaya-purifying-neem-face-wash-150ml',
  }),
  shelf({
    slug: 'himalaya-purifying-neem-face-wash-100ml',
    name: 'Himalaya Purifying Neem Face Wash',
    packSize: '100ml',
    price: '175',
    categoryId: 'cat-skin-care',
    photo: 'himalaya-purifying-neem-face-wash-150ml',
  }),
  shelf({
    slug: 'himalaya-purifying-neem-face-wash-200ml',
    name: 'হিমালয়া পিউরিফাইং নিম ফেসওয়াশ',
    packSize: '200ml',
    price: '330',
    categoryId: 'cat-skin-care',
    photo: 'himalaya-purifying-neem-face-wash-150ml',
    badges: ['new'],
  }),
];
