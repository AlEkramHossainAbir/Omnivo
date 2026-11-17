import {
  type ShopPaymentMethod,
  type ShopTextPageSlug,
  slugFromName,
  STOREFRONT_DEFAULT_THEME,
  STOREFRONT_HERO_DEFAULT_COLORS,
  type StorefrontBanner,
  type StorefrontCategory,
  type StorefrontCollectionSummary,
  type StorefrontHero,
  type StorefrontImage,
  type StorefrontListing,
  type StorefrontSale,
  type StorefrontSection,
  type StorefrontSettings,
  type StorefrontUpload,
} from '@omnivo/contracts';

import { findVariant } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// Step 26g: what the mock keeps of the online shop, and the garments workspace's open shop. A file
// of its own with a type import only of workspace-data.ts, which makes and seeds the shop: the
// rules (storefront-data.ts) import workspace-data.ts's record(), so one file would be an import
// cycle (21c's report-schedule-seed.ts does the same).
//
// The garments workspace has Rahman Fashion, open for 12 days: Men (Polo shirts, T-shirts), Women
// (empty) and Kids; two navy polo shirts and a T-shirt in the shop, a white polo shirt as a draft
// with no photo, and two kids' styles with no stock in the Main store. The pharma workspace has
// no shop, so a test can set one up from the start and open it.
//
// Step 26h adds the shop's look: a drawn logo and the default colors, an Eid hero, and under the
// product grid a winter sale banner and three collections (one all in the shop, one partly, one
// with only the draft, so the shop hides it); Terms & Condition and About Us are written.

// The settings row, as the table keeps it: readiness and the shop's address are worked out on read
export type MockShop = Omit<StorefrontSettings, 'shopUrl' | 'readiness'>;

// Step 26h: the logo and the two colors. In the API they are columns of the settings row and share
// its version (decision 12); kept beside it here, so Shop settings' answer stays as it was, and a
// save of either one raises MockShop's version
export interface MockTheme {
  logoImageId: string | null;
  brandColor: string;
  accentColor: string;
}

export type MockCategory = Omit<StorefrontCategory, 'listingCount'>;

export interface MockListing {
  id: string;
  productId: string;
  variantId: string;
  categoryId: string;
  slug: string;
  name: string;
  packSize: string;
  // 4 decimals, as Postgres keeps money ("299.0000"); null = the variant's sale price
  priceOverride: string | null;
  sale: StorefrontSale | null;
  badges: StorefrontListing['badges'];
  images: StorefrontImage[];
  descriptionSections: StorefrontSection[];
  seoTitle: string | null;
  seoDescription: string | null;
  publishedAt: string | null;
  version: number;
  updatedAt: string;
}

// One uploaded photo, from its upload address to the job's answer (26g.2's storefront_images row
// plus the attachment). `url` is the uploaded file itself, standing in for the job's small WebP;
// `outcome` is what the pretend job found when the file arrived, shown once readyAt has passed
export interface MockPhoto {
  id: string;
  contentType: string;
  sizeBytes: number;
  url: string | null;
  outcome:
    | { kind: 'ready'; width: number; height: number }
    | { kind: 'failed'; code: Extract<StorefrontUpload, { status: 'failed' }>['code'] }
    | null;
  // null until "complete": the attachment is still pending, and the screen sees "uploading"
  readyAt: number | null;
}

// Step 26h: a banner as storefront_banners keeps it: the pictures without their files' addresses,
// which are worked out on read (viewOf). The hero has its words and colors too
interface KeptPictures {
  desktopImage: StorefrontImage;
  phoneImage: StorefrontImage;
}
export type MockBanner = Omit<StorefrontBanner, 'desktopImage' | 'phoneImage'> & KeptPictures;
export type MockHero = Omit<StorefrontHero, 'desktopImage' | 'phoneImage'> & KeptPictures;

// A collection with its listings in their order (storefront_collection_items); the counts are
// worked out on read
export type MockCollection = Omit<
  StorefrontCollectionSummary,
  'listingCount' | 'publishedCount'
> & {
  listingIds: string[];
};

// One block of the home page, in storefront_home_blocks' order: what it shows, by id
export interface MockHomeBlock {
  kind: 'banner' | 'collection';
  id: string;
}

// A written text page (storefront_pages). A page not written has no entry
export interface MockPage {
  sections: StorefrontSection[];
  version: number;
  updatedAt: string;
}

export interface MockStorefront {
  shop: MockShop | null;
  categories: MockCategory[];
  listings: MockListing[];
  photos: Map<string, MockPhoto>;
  // Step 26h
  theme: MockTheme;
  hero: MockHero | null;
  banners: MockBanner[];
  collections: MockCollection[];
  home: MockHomeBlock[];
  pages: Map<ShopTextPageSlug, MockPage>;
}

export function emptyStorefront(): MockStorefront {
  return {
    shop: null,
    categories: [],
    listings: [],
    photos: new Map(),
    // The table's defaults: the Figma colors and no logo (the Omnivo mark)
    theme: { logoImageId: null, ...STOREFRONT_DEFAULT_THEME },
    hero: null,
    banners: [],
    collections: [],
    home: [],
    pages: new Map(),
  };
}

// A drawn packshot for a seeded photo: the garment's colour behind its name. A data: address, so it
// needs no file and no network; an uploaded photo has the file itself
function packshot(label: string, colour: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><rect width="600" height="600" fill="#F1F3F6"/><path d="M210 140l-90 50 40 90 40-20v220h200V260l40 20 40-90-90-50c-10 30-40 50-90 50s-80-20-90-50z" fill="${colour}"/><text x="300" y="560" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#475467">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// What a listing without a known photo shows (a seeded listing's photo is always known)
export const PLACEHOLDER = packshot('', '#D0D5DD');

// A drawn picture kept like an uploaded one that the job has prepared
function seedPicture(
  data: WorkspaceData,
  url: string,
  size: { width: number; height: number },
  alt: string,
): StorefrontImage {
  const id = crypto.randomUUID();
  data.storefront.photos.set(id, {
    id,
    contentType: 'image/svg+xml',
    sizeBytes: 0,
    url,
    outcome: { kind: 'ready', ...size },
    readyAt: 0,
  });
  return { id, alt };
}

function seedPhoto(
  data: WorkspaceData,
  label: string,
  colour: string,
  alt: string,
): StorefrontImage {
  return seedPicture(data, packshot(label, colour), { width: 600, height: 600 }, alt);
}

// Step 26h: a drawn banner picture, its words in it like a real sale banner, so a test can see
// which picture is where. Plain shapes, no photo: the mock needs no file
function drawnBanner(
  size: { width: number; height: number },
  background: string,
  words: string,
  ink: string,
): string {
  const { width, height } = size;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}"><rect width="${String(width)}" height="${String(height)}" fill="${background}"/><circle cx="${String(width * 0.78)}" cy="${String(height / 2)}" r="${String(height * 0.32)}" fill="${ink}" opacity=".18"/><text x="${String(width * 0.06)}" y="${String(height * 0.58)}" font-family="sans-serif" font-weight="700" font-size="${String(Math.round(height * 0.16))}" fill="${ink}">${words}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// The shop's own mark, drawn: two letters in the brand color on cream, so it shows on the brand
// colored header and on the white footer alike
function drawnLogo(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" rx="80" fill="#F4F5EC"/><text x="200" y="250" font-family="sans-serif" font-weight="700" font-size="150" text-anchor="middle" fill="${STOREFRONT_DEFAULT_THEME.brandColor}">RF</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
}

const POLO_SECTIONS: StorefrontSection[] = [
  {
    heading: 'Fabric',
    body: '- 100% combed cotton pique, 220 GSM\n- Knitted and dyed at our Gazipur factory',
  },
  {
    heading: 'Care',
    body: 'Machine wash cold with like colours. Do not bleach. **Iron on the reverse.**',
  },
];

export function seedStorefront(data: WorkspaceData, garments: boolean): void {
  if (!garments) return;
  const main = data.stock.warehouses.find((place) => place.code === 'MAIN');
  const payments: ShopPaymentMethod[] = ['cod', 'online'];
  const logo = seedPicture(data, drawnLogo(), { width: 400, height: 400 }, 'Rahman Fashion logo');
  data.storefront.shop = {
    subdomain: 'rahman-fashion',
    name: 'Rahman Fashion',
    language: 'en',
    hotline: '09612-345678',
    address: 'House 42, Road 11, Banani, Dhaka 1213',
    facebookUrl: 'https://facebook.com/rahmanfashion',
    instagramUrl: 'https://instagram.com/rahmanfashion',
    xUrl: null,
    linkedinUrl: null,
    defaultWarehouseId: main?.id ?? null,
    deliveryZones: [
      { id: 'zone-1a2b3c4d', name: 'Inside Dhaka', charge: '80.0000' },
      { id: 'zone-5e6f7a8b', name: 'Outside Dhaka', charge: '120.0000' },
    ],
    freeDeliveryFrom: '2000.0000',
    minimumOrder: null,
    paymentMethods: payments,
    launchedAt: daysAgo(12),
    version: 4,
    updatedAt: daysAgo(3),
  };
  data.storefront.theme = { logoImageId: logo.id, ...STOREFRONT_DEFAULT_THEME };

  const category = (
    name: string,
    slug: string,
    position: number,
    parentId: string | null = null,
  ) => {
    const item: MockCategory = {
      id: crypto.randomUUID(),
      parentId,
      slug,
      name,
      position,
      version: 1,
      updatedAt: daysAgo(12),
    };
    data.storefront.categories.push(item);
    return item;
  };
  // Men holds two categories (it cannot be deleted); Kids holds listings (nor can it); Women is
  // empty, the one a test can delete
  const men = category('Men', 'men', 1);
  const polos = category('Polo shirts', 'polo-shirts', 1, men.id);
  const tees = category('T-shirts', 't-shirts', 2, men.id);
  category('Women', 'women', 2);
  const kids = category('Kids', 'kids', 3);

  const byCode = (code: string) => data.catalog.products.find((product) => product.code === code);
  const polo = byCode('ST-118');
  const tee = byCode('P-00001');
  const listing = (
    variantId: string | undefined,
    fields: Partial<MockListing> & Pick<MockListing, 'name' | 'slug' | 'categoryId'>,
    minutesAgo: number,
  ) => {
    const found = variantId === undefined ? undefined : findVariant(data, variantId);
    if (!found) return;
    data.storefront.listings.push({
      id: crypto.randomUUID(),
      productId: found.product.id,
      variantId: found.variant.id,
      packSize: '',
      priceOverride: null,
      sale: null,
      badges: [],
      images: [],
      descriptionSections: [],
      seoTitle: null,
      seoDescription: null,
      publishedAt: daysAgo(12),
      version: 3,
      updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      ...fields,
    });
  };
  // The polo's variant of a size and a colour (its options are Size, then Colour)
  const poloIn = (size: string, colour: string) =>
    polo?.variants.find((item) => item.optionValues.join('|') === `${size}|${colour}`)?.id;
  listing(
    poloIn('M', 'Navy blue'),
    {
      name: 'Pique polo shirt · Navy blue · M',
      slug: 'pique-polo-navy-m',
      categoryId: polos.id,
      packSize: 'Size M',
      sale: { kind: 'percent', value: '10', startsAt: null, endsAt: null },
      badges: ['most_picked'],
      images: [
        seedPhoto(data, 'Pique polo · Navy', '#1F2A44', 'Navy blue pique polo shirt, front'),
        seedPhoto(data, 'Pique polo · Back', '#1F2A44', 'Navy blue pique polo shirt, back'),
      ],
      descriptionSections: POLO_SECTIONS,
    },
    20,
  );
  listing(
    poloIn('L', 'Navy blue'),
    {
      name: 'Pique polo shirt · Navy blue · L',
      slug: 'pique-polo-navy-l',
      categoryId: polos.id,
      packSize: 'Size L',
      images: [seedPhoto(data, 'Pique polo · Navy', '#1F2A44', 'Navy blue pique polo shirt')],
      descriptionSections: POLO_SECTIONS,
    },
    45,
  );
  // A draft with no photo yet: it cannot be shown until one is added
  listing(
    poloIn('M', 'White'),
    {
      name: 'Pique polo shirt · White · M',
      slug: 'pique-polo-white-m',
      categoryId: polos.id,
      packSize: 'Size M',
      publishedAt: null,
      version: 1,
    },
    5,
  );
  listing(
    tee?.variants[0]?.id,
    {
      name: 'Basic crew-neck T-shirt',
      slug: 'basic-crew-neck-t-shirt',
      categoryId: tees.id,
      packSize: '160 GSM cotton',
      priceOverride: '299.0000',
      badges: ['new'],
      images: [seedPhoto(data, 'Crew-neck T-shirt', '#8A94A6', 'Grey crew-neck T-shirt')],
    },
    90,
  );
  // Two kids' styles with no stock in the Main store: "Out of stock" in the catalog
  for (const [code, colour, minutes] of [
    ['ST-20003', '#B25E09', 120],
    ['ST-20007', '#0A7A4B', 150],
  ] as const) {
    const product = byCode(code);
    if (!product) continue;
    listing(
      product.variants[0]?.id,
      {
        name: product.name,
        slug: slugFromName(product.name),
        categoryId: kids.id,
        images: [seedPhoto(data, product.name, colour, product.name)],
      },
      minutes,
    );
  }

  seedAppearance(data, { polos: polos.slug, kids: kids.id });
}

// Step 26h: the hero, the blocks under the product grid and two written pages
function seedAppearance(data: WorkspaceData, place: { polos: string; kids: string }): void {
  const store = data.storefront;
  const desktop = { width: 1400, height: 560 };
  const phone = { width: 1080, height: 660 };
  store.hero = {
    id: crypto.randomUUID(),
    href: `/c/${place.polos}`,
    headline: 'Eid collection: 20% off polo shirts',
    line: 'Combed cotton pique, knitted in Gazipur.',
    eyebrow: 'Eid offer',
    buttonLabel: 'Shop polo shirts',
    desktopImage: seedPicture(
      data,
      drawnBanner(desktop, '#EEE0D8', 'Polo shirts', '#54260A'),
      desktop,
      'Navy and white pique polo shirts on a rail',
    ),
    phoneImage: seedPicture(
      data,
      // No words: the phone hero writes its headline over the picture
      drawnBanner(phone, '#54260A', '', '#EEE0D8'),
      phone,
      'A navy pique polo shirt, folded',
    ),
    ...STOREFRONT_HERO_DEFAULT_COLORS,
    version: 2,
    updatedAt: daysAgo(5),
  };

  const wide = { width: 2560, height: 560 };
  const narrow = { width: 1080, height: 420 };
  const sale: MockBanner = {
    id: crypto.randomUUID(),
    href: '/c/all?offer=1',
    desktopImage: seedPicture(
      data,
      drawnBanner(wide, '#1F2A44', 'WINTER SALE · UP TO 30% OFF', '#FFFFFF'),
      wide,
      'Winter sale, up to 30% off',
    ),
    phoneImage: seedPicture(
      data,
      drawnBanner(narrow, '#1F2A44', 'UP TO 30% OFF', '#FFFFFF'),
      narrow,
      'Winter sale, up to 30% off',
    ),
    version: 1,
    updatedAt: daysAgo(4),
  };
  store.banners.push(sale);

  // The listings by their link name; a seed that lost one leaves it out
  const ids = (...slugsWanted: string[]) =>
    slugsWanted.flatMap((slug) => {
      const found = store.listings.find((listing) => listing.slug === slug);
      return found === undefined ? [] : [found.id];
    });
  const kids = store.listings.filter((listing) => listing.categoryId === place.kids);
  const collection = (title: string, icon: 'fire' | null, listingIds: string[]) => {
    const item: MockCollection = {
      id: crypto.randomUUID(),
      title,
      icon,
      listingIds,
      version: 1,
      updatedAt: daysAgo(4),
    };
    store.collections.push(item);
    return item;
  };
  // All three in the shop; the kids' styles are in the shop too, out of stock; the last one holds
  // only the draft, so the shop hides it and the Home page card says so
  const trending = collection(
    'Hot & Trending Right Now',
    'fire',
    ids('pique-polo-navy-m', 'basic-crew-neck-t-shirt', 'pique-polo-navy-l'),
  );
  const forKids = collection(
    'For the kids',
    null,
    kids.map((listing) => listing.id),
  );
  const coming = collection('Coming soon', null, ids('pique-polo-white-m'));
  store.home = [
    { kind: 'collection', id: trending.id },
    { kind: 'banner', id: sale.id },
    { kind: 'collection', id: forKids.id },
    { kind: 'collection', id: coming.id },
  ];

  store.pages.set('terms', {
    sections: [
      {
        heading: 'Delivery',
        body: '- Inside Dhaka in 2 days, ৳80\n- Outside Dhaka in 3 to 5 days, ৳120\n- Free on orders over ৳2,000',
      },
      {
        heading: 'Returns',
        body: 'Unworn items with their tags come back within **7 days**. Keep the order number.',
      },
    ],
    version: 1,
    updatedAt: daysAgo(10),
  });
  store.pages.set('about', {
    sections: [
      {
        heading: 'Who we are',
        body: 'Rahman Fashion knits, dyes and sews its own shirts at its Gazipur factory since 2009.',
      },
    ],
    version: 1,
    updatedAt: daysAgo(10),
  });
}
