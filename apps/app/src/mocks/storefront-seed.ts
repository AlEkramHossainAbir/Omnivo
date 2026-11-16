import {
  type ShopPaymentMethod,
  slugFromName,
  type StorefrontCategory,
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

// The settings row, as the table keeps it: readiness and the shop's address are worked out on read
export type MockShop = Omit<StorefrontSettings, 'shopUrl' | 'readiness'>;

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

export interface MockStorefront {
  shop: MockShop | null;
  categories: MockCategory[];
  listings: MockListing[];
  photos: Map<string, MockPhoto>;
}

export function emptyStorefront(): MockStorefront {
  return { shop: null, categories: [], listings: [], photos: new Map() };
}

// A drawn packshot for a seeded photo: the garment's colour behind its name. A data: address, so it
// needs no file and no network; an uploaded photo has the file itself
function packshot(label: string, colour: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><rect width="600" height="600" fill="#F1F3F6"/><path d="M210 140l-90 50 40 90 40-20v220h200V260l40 20 40-90-90-50c-10 30-40 50-90 50s-80-20-90-50z" fill="${colour}"/><text x="300" y="560" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#475467">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// What a listing without a known photo shows (a seeded listing's photo is always known)
export const PLACEHOLDER = packshot('', '#D0D5DD');

function seedPhoto(
  data: WorkspaceData,
  label: string,
  colour: string,
  alt: string,
): StorefrontImage {
  const id = crypto.randomUUID();
  data.storefront.photos.set(id, {
    id,
    contentType: 'image/svg+xml',
    sizeBytes: 0,
    url: packshot(label, colour),
    outcome: { kind: 'ready', width: 600, height: 600 },
    readyAt: 0,
  });
  return { id, alt };
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
}
