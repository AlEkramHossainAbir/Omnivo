import { extname, join } from 'node:path';

import {
  percentOfMoney,
  type RouteRequest,
  type routes,
  type ShopCategory,
  type ShopListing,
  type StorefrontSale,
  type StorefrontSection,
} from '@omnivo/contracts';

import { mockCheckoutSettings } from '../src/data/mock/checkout';
import { mockHome } from '../src/data/mock/home';
import { mockCatalog, mockProductPage } from '../src/data/mock/products';
import { mockCategories, mockShop } from '../src/data/mock/shop';
import { DESCRIPTIONS } from './seed-words';

// Step 26h: what the seed makes, worked out from the mock shop (apps/shop/src/data/mock) before
// anything is sent. The mock is the Figma design's shop, so the real shop the seed makes looks
// like the one `pnpm dev` shows with no API: the same 62 listings, categories, photos, hero, Mega
// Sale banner and three rows. Pure functions only (no fetch, no clock of its own), so
// seed-plan.spec.ts checks every body against its contract without an API.

// The photos are the mock's own files, served by the mock shop from public/
export const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

export interface SeedPhoto {
  // "/mock/products/sprite-cold-drink-500ml.png": the mock's address, and the key the seed keeps
  // the uploaded photo's id under
  url: string;
  file: string;
  contentType: 'image/png' | 'image/jpeg';
}

export interface SeedListing {
  slug: string;
  // The stock item's name in the ERP: the shop's name with its pack size, as a shopkeeper names
  // a product ("Cold drinks (Sprite) 500ml"). The listing keeps the shop's shorter name
  productName: string;
  name: string;
  packSize: string;
  // '' = the product's own code (P-00001), what a new product gets without a SKU
  sku: string;
  // The variant's sale price: what the shop shows struck out while a sale runs
  regularPrice: string;
  sale: StorefrontSale | null;
  badges: ShopListing['badges'];
  // The mock's category id ("cat-tea"); the seed swaps it for the real one
  categoryKey: string;
  photos: { url: string; alt: string }[];
  descriptionSections: StorefrontSection[];
  // null = none in stock, so the shop shows "Out of stock" as the mock does
  stock: string | null;
  // The opening stock's cost per piece. Not the shop's business, but a stock entry needs one, and
  // a margin report on the demo workspace then says something
  unitCost: string;
}

// The shop's own price rules (listingPricing) turn these into what the mock shows:
// - a struck-out price in the mock = a "sell at" sale from the struck-out price, so the card shows
//   the mock's price and the struck-out one ("৳229", "৳299") and the ribbon says the difference;
// - a percent ribbon without a struck-out price = a percent sale on the mock's price;
// - the "৳10 OFF" ribbon the mock puts on most cards is the design's placeholder, with no struck-out
//   price beside it; a real ribbon always comes from a sale, so those cards get no sale (the user's
//   choice, 26h.8)
function pricing(listing: ShopListing, saleUntil: string | null) {
  if (listing.compareAtPrice !== null) {
    return {
      regularPrice: listing.compareAtPrice,
      sale: {
        kind: 'price',
        value: listing.price,
        startsAt: null,
        endsAt: saleUntil,
      } satisfies StorefrontSale,
    };
  }
  if (listing.discount?.kind === 'percent') {
    return {
      regularPrice: listing.price,
      sale: {
        kind: 'percent',
        value: String(listing.discount.value),
        startsAt: null,
        endsAt: saleUntil,
      } satisfies StorefrontSale,
    };
  }
  return { regularPrice: listing.price, sale: null };
}

// The product page's photos, each once: the mock's design product shows its two photos twice
// (Figma's four thumbnails), which a real listing may not (storefront_image_twice)
function photosOf(images: readonly { url: string; alt: string }[]): SeedListing['photos'] {
  const seen = new Set<string>();
  return images.filter((image) => {
    if (seen.has(image.url)) return false;
    seen.add(image.url);
    return true;
  });
}

// `now` decides when the design product's sale ends (1 day 12 hours later, like the mock's)
export function seedListings(now: Date): SeedListing[] {
  return mockCatalog.map((listing) => {
    const page = mockProductPage(listing.slug, now);
    if (page === null) throw new Error(`the mock has no product page for ${listing.slug}`);
    const { product } = page;
    const { regularPrice, sale } = pricing(listing, product.saleUntil);
    return {
      slug: listing.slug,
      productName: listing.name.endsWith(listing.packSize)
        ? listing.name
        : `${listing.name} ${listing.packSize}`,
      name: listing.name,
      packSize: listing.packSize,
      sku: product.sku ?? '',
      regularPrice,
      sale,
      badges: listing.badges,
      categoryKey: listing.categoryId,
      photos: photosOf(product.images),
      descriptionSections: DESCRIPTIONS[listing.slug] ?? [],
      stock: listing.inStock ? '48' : null,
      unitCost: percentOfMoney(regularPrice, '70'),
    };
  });
}

// The mock lists a category after its parent, so creating them in this order always has the
// parent's real id ready (seed-plan.spec.ts checks it)
export const seedCategories: readonly ShopCategory[] = mockCategories;

function photo(url: string): SeedPhoto {
  const extension = extname(url);
  if (extension !== '.png' && extension !== '.jpg') throw new Error(`no content type for ${url}`);
  return {
    url,
    file: join(PUBLIC_DIR, url),
    contentType: extension === '.png' ? 'image/png' : 'image/jpeg',
  };
}

const heroImages = mockHome.hero;

// The mock home's one picture banner, Mega Sale. A function, so its type is the banner and never
// undefined inside the functions below (a narrowed const would not stay narrowed there)
function pictureBanner() {
  for (const block of mockHome.blocks) if (block.kind === 'image') return block;
  throw new Error('the mock home has no picture banner');
}
const megaSale = pictureBanner();

// Every file to upload, each once: 22 product photos for 62 listings (another pack size of a
// product shows that product's photo), plus the hero's two and the Mega Sale's two
export function seedPhotos(listings: readonly SeedListing[]): SeedPhoto[] {
  const urls = new Set<string>([
    ...listings.flatMap((listing) => listing.photos.map((image) => image.url)),
    heroImages.desktopImage.url,
    heroImages.phoneImage.url,
    megaSale.desktopImage.url,
    megaSale.phoneImage.url,
  ]);
  return [...urls].map(photo);
}

// The bodies, with the real ids handed in. Types from the routes, so a body that a contract would
// refuse does not type-check (and seed-plan.spec.ts parses each with its schema too)
type Body<R> = RouteRequest<R> extends { body: infer B } ? B : never;
export type SettingsBody = Body<typeof routes.storefront.createSettings>;
export type ListingBody = Body<typeof routes.storefront.updateListing>;
export type HeroBody = Body<typeof routes.storefrontAppearance.saveHero>;
export type BannerBody = Body<typeof routes.storefrontAppearance.createBanner>;

// The mock shop's settings: its name, hotline, address and social pages, and the checkout's two
// zones, free delivery and minimum order, so the real checkout charges what the mock's does
export function settingsBody(subdomain: string, warehouseId: string): SettingsBody {
  return {
    subdomain,
    name: mockShop.name,
    language: mockShop.language,
    hotline: mockShop.hotline,
    address: mockShop.address,
    facebookUrl: mockShop.social.facebook,
    instagramUrl: mockShop.social.instagram,
    xUrl: mockShop.social.x,
    linkedinUrl: mockShop.social.linkedin,
    defaultWarehouseId: warehouseId,
    // id null = new zones, named by the API
    deliveryZones: mockCheckoutSettings.zones.map((zone) => ({
      id: null,
      name: zone.name,
      charge: zone.charge,
    })),
    freeDeliveryFrom: mockCheckoutSettings.freeDeliveryFrom,
    minimumOrder: mockCheckoutSettings.minimumOrder,
    paymentMethods: [...mockCheckoutSettings.paymentMethods],
    // Step 27b: none picked, so the first order with a charge makes "Delivery charge" itself
    deliveryVariantId: null,
  };
}

// The editor's whole form for one listing. Its slug is the mock's, so every link of the mock
// (/p/himalaya-purifying-neem-face-wash-150ml) works on the real shop too
export function listingBody(
  listing: SeedListing,
  version: number,
  categoryId: string,
  imageIds: ReadonlyMap<string, string>,
): ListingBody {
  return {
    version,
    name: listing.name,
    slug: listing.slug,
    packSize: listing.packSize,
    categoryId,
    // '' = the variant's sale price, which the seed set to the regular price
    priceOverride: '',
    sale: listing.sale,
    badges: listing.badges,
    images: listing.photos.map((image) => ({ id: idOf(imageIds, image.url), alt: image.alt })),
    descriptionSections: listing.descriptionSections,
    // '' = the shop's own: the name, and the start of the description
    seoTitle: '',
    seoDescription: '',
  };
}

export function idOf(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`no id for ${key}`);
  return id;
}

// The hero of the mock home, the Figma one. version null = there is no hero yet
export function heroBody(imageIds: ReadonlyMap<string, string>): HeroBody {
  const hero = mockHome.hero;
  return {
    version: null,
    href: hero.href,
    headline: hero.headline,
    line: hero.line,
    eyebrow: hero.eyebrow,
    buttonLabel: hero.buttonLabel,
    desktopImage: { id: idOf(imageIds, hero.desktopImage.url), alt: hero.desktopImage.alt },
    phoneImage: { id: idOf(imageIds, hero.phoneImage.url), alt: hero.phoneImage.alt },
    backgroundColor: hero.colors.background,
    panelColor: hero.colors.panel,
    buttonColor: hero.colors.button,
    buttonTextColor: hero.colors.buttonText,
  };
}

export function megaSaleBody(imageIds: ReadonlyMap<string, string>): BannerBody {
  return {
    href: megaSale.href,
    desktopImage: { id: idOf(imageIds, megaSale.desktopImage.url), alt: megaSale.desktopImage.alt },
    phoneImage: { id: idOf(imageIds, megaSale.phoneImage.url), alt: megaSale.phoneImage.alt },
  };
}

// The three rows under the banner, in the mock's order, each as the listings' slugs
export const seedCollections = mockHome.blocks.flatMap((block) =>
  block.kind === 'collection'
    ? [
        {
          title: block.collection.title,
          icon: block.collection.icon,
          slugs: block.collection.listings.map((listing) => listing.slug),
        },
      ]
    : [],
);
