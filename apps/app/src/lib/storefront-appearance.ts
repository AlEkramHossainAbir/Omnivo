import {
  routes,
  STOREFRONT_HERO_DEFAULT_COLORS,
  type StorefrontBanner,
  type StorefrontBannerFormValues,
  type StorefrontCollection,
  type StorefrontHero,
  type StorefrontHeroFormValues,
  type StorefrontHomeBlock,
  type StorefrontPage,
  type StorefrontPageFormValues,
  type StorefrontTheme,
  type StorefrontThemeFormValues,
} from '@omnivo/contracts';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 26h: the reads and the form values of Shop appearance, a collection, and the text pages.
// Its own file, like storefront.ts: only these pages load it. The keys start with
// ['storefront', tenantId] like the rest of the menu, so useStorefrontRefresh() reads them again
// after any save (a collection's count on the Appearance page changes when a listing is published).

// ---------------------------------------------------------------------------------------------
// Reads

export function storefrontAppearanceQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'appearance'],
    queryFn: () => call(routes.storefrontAppearance.getAppearance),
  });
}

export function storefrontCollectionQuery(tenantId: string, id: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'collection', id],
    queryFn: () => call(routes.storefrontAppearance.getCollection, { params: { id } }),
  });
}

export function storefrontPagesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'pages'],
    queryFn: async () => (await call(routes.storefrontAppearance.listPages)).items,
  });
}

export function storefrontPageQuery(tenantId: string, slug: StorefrontPage['slug']) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'page', slug],
    queryFn: () => call(routes.storefrontAppearance.getPage, { params: { slug } }),
  });
}

// The product pickers (a collection's "Product to add", a link to a product): the catalog's own
// list, drafts too, 20 at a time, A to Z. The search also matches the slug (26g), which is how a
// saved "/p/<slug>" link finds its listing's name again
export function storefrontListingSearchQuery(tenantId: string, search: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'listing-search', search],
    queryFn: async () =>
      (
        await call(routes.storefront.listListings, {
          query: { limit: 20, sort: 'name', ...(search !== '' && { search }) },
        })
      ).items,
    // A new search keeps the old matches on screen until its answer comes: no flash of "Nothing"
    placeholderData: keepPreviousData,
  });
}

// The two product cards of the colors' preview: the shop's own listings that are in the shop,
// the last changed first. Two rows, so it costs nothing next to the page's own read
export function storefrontPreviewListingsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'preview-listings'],
    queryFn: async () =>
      (
        await call(routes.storefront.listListings, {
          query: { limit: 2, status: 'published', sort: '-updated' },
        })
      ).items,
  });
}

// ---------------------------------------------------------------------------------------------
// Form values

export function themeFormValues(theme: StorefrontTheme): StorefrontThemeFormValues {
  return {
    version: theme.version,
    logoImageId: theme.logo?.id ?? null,
    brandColor: theme.brandColor,
    accentColor: theme.accentColor,
  };
}

// A picture box before anything is uploaded. The id stays '' until the upload has one; the schema
// then refuses it (an id is a uuid), and the box says "Upload a picture" (PictureField)
const NO_PICTURE = { id: '', alt: '' };

// A new hero starts from the Figma hero's colors (they pass both checks) and empty words.
// version null = "there is no hero yet" (decision 13)
export function heroFormValues(hero: StorefrontHero | null): StorefrontHeroFormValues {
  if (hero === null) {
    return {
      version: null,
      href: '',
      headline: '',
      line: '',
      eyebrow: '',
      buttonLabel: '',
      desktopImage: NO_PICTURE,
      phoneImage: NO_PICTURE,
      ...STOREFRONT_HERO_DEFAULT_COLORS,
    };
  }
  return {
    version: hero.version,
    href: hero.href,
    headline: hero.headline,
    // The API keeps "no line" as null; the box shows it empty, and '' goes back as null
    line: hero.line ?? '',
    eyebrow: hero.eyebrow ?? '',
    buttonLabel: hero.buttonLabel,
    desktopImage: { id: hero.desktopImage.id, alt: hero.desktopImage.alt },
    phoneImage: { id: hero.phoneImage.id, alt: hero.phoneImage.alt },
    backgroundColor: hero.backgroundColor,
    panelColor: hero.panelColor,
    buttonColor: hero.buttonColor,
    buttonTextColor: hero.buttonTextColor,
  };
}

export function bannerFormValues(banner: StorefrontBanner | null): StorefrontBannerFormValues {
  if (banner === null) return { href: '', desktopImage: NO_PICTURE, phoneImage: NO_PICTURE };
  return {
    href: banner.href,
    desktopImage: { id: banner.desktopImage.id, alt: banner.desktopImage.alt },
    phoneImage: { id: banner.phoneImage.id, alt: banner.phoneImage.alt },
  };
}

// The collection's form: the update schema's fields. A new one has no version; the create route
// never reads it (the page leaves it out), and 1 passes the update schema's check meanwhile
export interface CollectionFormValues {
  version: number;
  title: string;
  icon: 'fire' | null;
  listingIds: string[];
}

export function collectionFormValues(
  collection: StorefrontCollection | null,
): CollectionFormValues {
  if (collection === null) return { version: 1, title: '', icon: null, listingIds: [] };
  return {
    version: collection.version,
    title: collection.title,
    icon: collection.icon,
    listingIds: collection.listings.map((listing) => listing.id),
  };
}

export function pageFormValues(page: StorefrontPage): StorefrontPageFormValues {
  return { version: page.version, sections: page.sections };
}

// ---------------------------------------------------------------------------------------------
// The home page's blocks

// What a block is called in labels ("Move Hot & Trending Right Now up"). A banner has no title:
// it is named by the words of its computer picture (26h.5 decision 35)
export function homeBlockKey(block: StorefrontHomeBlock): string {
  return block.kind === 'banner'
    ? `banner-${block.banner.id}`
    : `collection-${block.collection.id}`;
}

export function homeBlockId(block: StorefrontHomeBlock): string {
  return block.kind === 'banner' ? block.banner.id : block.collection.id;
}

// Whether "Add picture banner" and "Add collection" can add one more (decision 6). The API
// checks again under its lock; the page only says why a button is disabled
export function homeRoom(
  blocks: readonly StorefrontHomeBlock[],
  limits: { banners: number; collections: number; blocks: number },
): { banner: 'ok' | 'banners' | 'blocks'; collection: 'ok' | 'collections' | 'blocks' } {
  const banners = blocks.filter((block) => block.kind === 'banner').length;
  const collections = blocks.length - banners;
  const full = blocks.length >= limits.blocks;
  return {
    banner: full ? 'blocks' : banners >= limits.banners ? 'banners' : 'ok',
    collection: full ? 'blocks' : collections >= limits.collections ? 'collections' : 'ok',
  };
}
