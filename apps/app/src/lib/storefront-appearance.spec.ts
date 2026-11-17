import {
  saveStorefrontHeroInputSchema,
  STOREFRONT_HERO_DEFAULT_COLORS,
  type StorefrontBanner,
  type StorefrontCollectionSummary,
  type StorefrontHero,
  type StorefrontHomeBlock,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { bannerFormValues, heroFormValues, homeRoom } from './storefront-appearance';

const IMAGE = {
  id: '0199a3f0-0000-7000-8000-000000000001',
  alt: 'Make-up',
  url: 'https://f/x.webp',
};
const NOW = '2026-11-17T04:00:00.000Z';

const banner = (n: number): StorefrontHomeBlock => ({
  kind: 'banner',
  banner: {
    id: `0199a3f0-0000-7000-8000-00000000010${String(n)}`,
    href: '/c/all',
    desktopImage: IMAGE,
    phoneImage: IMAGE,
    version: 1,
    updatedAt: NOW,
  } satisfies StorefrontBanner,
});
const collection = (n: number): StorefrontHomeBlock => ({
  kind: 'collection',
  collection: {
    id: `0199a3f0-0000-7000-8000-00000000020${String(n)}`,
    title: `Row ${String(n)}`,
    icon: null,
    listingCount: 3,
    publishedCount: 3,
    version: 1,
    updatedAt: NOW,
  } satisfies StorefrontCollectionSummary,
});
const LIMITS = { banners: 2, collections: 2, blocks: 3 };

describe('heroFormValues', () => {
  it('starts a new hero from the Figma colors, with no version (decision 13)', () => {
    const values = heroFormValues(null);
    expect(values.version).toBeNull();
    expect(values).toMatchObject(STOREFRONT_HERO_DEFAULT_COLORS);
    // Empty pictures: the schema refuses them, the box then says "Upload a picture"
    expect(saveStorefrontHeroInputSchema.safeParse(values).success).toBe(false);
  });

  it("puts a saved hero's null line and tag back as empty boxes", () => {
    const hero: StorefrontHero = {
      id: '0199a3f0-0000-7000-8000-000000000301',
      href: '/c/cosmetics',
      headline: 'Get 10% cash-back',
      line: null,
      eyebrow: null,
      buttonLabel: 'Shop now',
      desktopImage: IMAGE,
      phoneImage: IMAGE,
      ...STOREFRONT_HERO_DEFAULT_COLORS,
      version: 4,
      updatedAt: NOW,
    };
    const values = heroFormValues(hero);
    expect(values).toMatchObject({ line: '', eyebrow: '', version: 4 });
    // The picture's address stays out of the form: the API takes {id, alt}
    expect(values.desktopImage).toEqual({ id: IMAGE.id, alt: IMAGE.alt });
    expect(saveStorefrontHeroInputSchema.safeParse(values).success).toBe(true);
  });
});

describe('bannerFormValues', () => {
  it('has empty pictures for a new banner', () => {
    expect(bannerFormValues(null)).toEqual({
      href: '',
      desktopImage: { id: '', alt: '' },
      phoneImage: { id: '', alt: '' },
    });
  });
});

describe('homeRoom', () => {
  it('lets both kinds in while there is room', () => {
    expect(homeRoom([banner(1)], LIMITS)).toEqual({ banner: 'ok', collection: 'ok' });
  });

  it('stops one kind at its own limit', () => {
    expect(homeRoom([banner(1), banner(2)], LIMITS)).toEqual({
      banner: 'banners',
      collection: 'ok',
    });
    expect(homeRoom([collection(1), collection(2)], LIMITS)).toEqual({
      banner: 'ok',
      collection: 'collections',
    });
  });

  it('names the block limit first: it is the one to fix', () => {
    expect(homeRoom([banner(1), banner(2), collection(1)], LIMITS)).toEqual({
      banner: 'blocks',
      collection: 'blocks',
    });
  });
});
