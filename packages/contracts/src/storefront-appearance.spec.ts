import { describe, expect, it } from 'vitest';

import { storefrontRoutes } from './storefront-admin.js';
import {
  contrastRatio,
  createStorefrontCollectionInputSchema,
  CONTRAST_LARGE_TEXT,
  CONTRAST_TEXT,
  formatContrast,
  relativeLuminance,
  saveStorefrontHeroInputSchema,
  saveStorefrontPageInputSchema,
  SHOP_CREAM,
  SHOP_WHITE,
  STOREFRONT_COLLECTION_ITEMS_MAX,
  STOREFRONT_DEFAULT_THEME,
  STOREFRONT_HERO_DEFAULT_COLORS,
  storefrontAppearanceRoutes,
  storefrontLinkHref,
  storefrontLinkSchema,
  storefrontLinkTarget,
  updateStorefrontCollectionInputSchema,
  updateStorefrontThemeInputSchema,
  type StorefrontHeroFormValues,
  type StorefrontLinkTarget,
} from './storefront-appearance.js';

// The error codes of a failed parse, by the path of the box they belong to
function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) {
    const key = issue.path.map(String).join('.');
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

const PHOTO = '0b8f6c52-7d2e-4b8e-9a51-3f4c2d1e0a11';
const PHOTO_2 = '1c9a7d63-8e3f-4c9f-8b62-4a5d3e2f1b22';
const LISTING = '2dab8e74-9f40-4da0-9c73-5b6e4f3a2c33';
const LISTING_2 = '3ebc9f85-a051-4eb1-8d84-6c7f5a4b3d44';

describe('contrast', () => {
  it('is 21:1 for black on white and 1:1 for a color on itself, in either order', () => {
    expect(contrastRatio('#000000', SHOP_WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(SHOP_WHITE, '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#005859', '#005859')).toBe(1);
  });

  // The ratios CLAUDE.md gives for the Figma colors
  it('matches the design system for the default colors', () => {
    const { brandColor, accentColor } = STOREFRONT_DEFAULT_THEME;
    expect(contrastRatio(brandColor, SHOP_CREAM)).toBeCloseTo(7.5, 1);
    expect(contrastRatio(brandColor, accentColor)).toBeCloseTo(6.1, 1);
  });

  it('reads upper-case hex the same as lower-case', () => {
    expect(relativeLuminance('#B8EF69')).toBe(relativeLuminance('#b8ef69'));
  });

  // NaN compares false with everything, so a color that is not #rrggbb passes no check
  it.each(['red', '#fff', 'b8ef69', ''])('never lets %j pass', (color) => {
    expect(contrastRatio(color, '#000000') >= CONTRAST_LARGE_TEXT).toBe(false);
  });

  it('shows the ratio cut to one decimal, never rounded up to a pass', () => {
    expect(formatContrast(4.47)).toBe('4.4:1');
    expect(formatContrast(4.5)).toBe('4.5:1');
    expect(formatContrast(21)).toBe('21.0:1');
  });
});

describe('the logo and the colors', () => {
  it('takes the defaults, and lower-cases what was typed', () => {
    expect(
      updateStorefrontThemeInputSchema.parse({
        version: 4,
        logoImageId: null,
        brandColor: ' #005859',
        accentColor: '#B8EF69',
      }),
    ).toEqual({ version: 4, logoImageId: null, brandColor: '#005859', accentColor: '#b8ef69' });
  });

  it.each(['005859', '#05859', '#00585z', 'teal'])('refuses %j as a color', (color) => {
    const result = updateStorefrontThemeInputSchema.safeParse({
      version: 4,
      logoImageId: null,
      brandColor: color,
      accentColor: '#b8ef69',
    });
    expect(errorsOf(result).brandColor).toContain('storefront_color_format');
  });

  // A light blue is fine as a button, but names and titles in it on cream are hard to read
  it('refuses a brand color too light for text on cream, on the brand box', () => {
    expect(contrastRatio('#7c9cf2', SHOP_CREAM)).toBeLessThan(CONTRAST_TEXT);
    const result = updateStorefrontThemeInputSchema.safeParse({
      version: 4,
      logoImageId: null,
      brandColor: '#7c9cf2',
      accentColor: '#0b0f17',
    });
    expect(errorsOf(result)).toEqual({ brandColor: ['storefront_brand_contrast'] });
  });

  it('refuses an accent too close to the brand, on the accent box', () => {
    const result = updateStorefrontThemeInputSchema.safeParse({
      version: 4,
      logoImageId: null,
      brandColor: '#005859',
      accentColor: '#2a8a6b',
    });
    expect(errorsOf(result)).toEqual({ accentColor: ['storefront_accent_contrast'] });
  });
});

describe('banner links', () => {
  it.each([
    '/c/skin-care',
    '/c/all?offer=1',
    '/p/himalaya-neem-face-wash-150ml',
    '/pages/about',
    'https://www.facebook.com/nirvor.pharmacy',
  ])('takes %s', (href) => {
    expect(storefrontLinkSchema.parse(href)).toBe(href);
  });

  it.each([
    ['', 'required'],
    // Another site that looks like a path, in both spellings a browser accepts
    ['//evil.example', 'storefront_link_format'],
    ['/\\evil.example', 'storefront_link_format'],
    ['javascript:alert(1)', 'storefront_link_format'],
    ['http://nirvor.com', 'storefront_link_format'],
    ['https://', 'storefront_link_format'],
    ['https://nirvor', 'storefront_link_format'],
    ['/c/skin care', 'storefront_link_format'],
    ['/c/"onmouseover="', 'storefront_link_format'],
    [`/${'a'.repeat(300)}`, 'too_long'],
  ])('refuses %j with %s', (href, code) => {
    expect(errorsOf(storefrontLinkSchema.safeParse(href))['']).toContain(code);
  });

  const TARGETS: [string, StorefrontLinkTarget][] = [
    ['/c/skin-care', { kind: 'category', slug: 'skin-care' }],
    ['/p/neem-face-wash', { kind: 'listing', slug: 'neem-face-wash' }],
    ['/c/all', { kind: 'all' }],
    ['/c/all?offer=1', { kind: 'offers' }],
    ['https://example.com/eid', { kind: 'other', href: 'https://example.com/eid' }],
  ];

  it.each(TARGETS)('reads %s back as the target that makes it', (href, target) => {
    expect(storefrontLinkTarget(href)).toEqual(target);
    expect(storefrontLinkHref(target)).toBe(href);
  });

  // Saving the form again must not drop the part after the "?"
  it('keeps an address with more to it as the tenant typed it', () => {
    expect(storefrontLinkTarget('/c/skin-care?sort=name')).toEqual({
      kind: 'other',
      href: '/c/skin-care?sort=name',
    });
    expect(storefrontLinkTarget('/c/skin-care/')).toEqual({
      kind: 'other',
      href: '/c/skin-care/',
    });
  });
});

// A hero form as a new hero starts, filled in
const HERO: StorefrontHeroFormValues = {
  version: null,
  href: '/c/cosmetics',
  headline: 'Get 10% cash-back on shopping ৳150',
  line: '',
  eyebrow: 'Exclusive offer',
  buttonLabel: 'Get 10% cashback',
  desktopImage: { id: PHOTO, alt: 'Make-up and skin care products' },
  phoneImage: { id: PHOTO_2, alt: 'Make-up and skin care products' },
  ...STOREFRONT_HERO_DEFAULT_COLORS,
};

describe('the hero', () => {
  it('starts with colors that pass, and saves an empty line as none', () => {
    const hero = saveStorefrontHeroInputSchema.parse(HERO);
    expect(hero.line).toBeNull();
    expect(hero.eyebrow).toBe('Exclusive offer');
    expect(hero.version).toBeNull();
  });

  it('needs a headline, a button label and the photos’ alt texts', () => {
    const result = saveStorefrontHeroInputSchema.safeParse({
      ...HERO,
      headline: ' ',
      buttonLabel: '',
      phoneImage: { id: PHOTO_2, alt: '' },
    });
    expect(errorsOf(result)).toEqual({
      headline: ['required'],
      buttonLabel: ['required'],
      'phoneImage.alt': ['required'],
    });
  });

  it('refuses button words that do not stand out from the button', () => {
    const result = saveStorefrontHeroInputSchema.safeParse({
      ...HERO,
      buttonColor: '#e7d1b2',
      buttonTextColor: '#c49a6c',
    });
    expect(errorsOf(result)).toEqual({ buttonTextColor: ['storefront_button_contrast'] });
  });

  // The headline is large text: 3:1 is enough, so a mid-tone panel passes where 4.5 would not
  it('lets the white headline sit on a mid-tone panel, but not on a pale one', () => {
    expect(contrastRatio('#c0602a', SHOP_WHITE)).toBeGreaterThan(CONTRAST_LARGE_TEXT);
    expect(contrastRatio('#c0602a', SHOP_WHITE)).toBeLessThan(CONTRAST_TEXT);
    expect(
      saveStorefrontHeroInputSchema.safeParse({ ...HERO, panelColor: '#c0602a' }).success,
    ).toBe(true);
    const pale = saveStorefrontHeroInputSchema.safeParse({ ...HERO, panelColor: '#eee0d8' });
    expect(errorsOf(pale)).toEqual({ panelColor: ['storefront_panel_contrast'] });
  });
});

describe('a collection', () => {
  it('keeps its listings in the order given', () => {
    expect(
      createStorefrontCollectionInputSchema.parse({
        title: 'Hot & Trending Right Now',
        icon: 'fire',
        listingIds: [LISTING_2, LISTING],
      }).listingIds,
    ).toEqual([LISTING_2, LISTING]);
  });

  it('needs at least one listing', () => {
    const result = createStorefrontCollectionInputSchema.safeParse({
      title: 'Diabetic Corner',
      icon: null,
      listingIds: [],
    });
    expect(errorsOf(result)).toEqual({ listingIds: ['storefront_collection_empty'] });
  });

  it('refuses a listing twice, on the second one', () => {
    const result = updateStorefrontCollectionInputSchema.safeParse({
      version: 2,
      title: 'Diabetic Corner',
      icon: null,
      listingIds: [LISTING, LISTING_2, LISTING],
    });
    expect(errorsOf(result)).toEqual({ 'listingIds.2': ['storefront_listing_twice'] });
  });

  it('holds at most as many listings as the shop shows in a row', () => {
    const ids = Array.from(
      { length: STOREFRONT_COLLECTION_ITEMS_MAX + 1 },
      (_, index) => `${String(index).padStart(8, '0')}-7d2e-4b8e-9a51-3f4c2d1e0a11`,
    );
    const result = createStorefrontCollectionInputSchema.safeParse({
      title: 'Everything',
      icon: null,
      listingIds: ids,
    });
    expect(errorsOf(result)).toEqual({ listingIds: ['too_long'] });
  });
});

describe('a text page', () => {
  it('needs a section: Delete is the way to take a page away', () => {
    expect(
      errorsOf(saveStorefrontPageInputSchema.safeParse({ version: null, sections: [] })),
    ).toEqual({ sections: ['storefront_page_empty'] });
  });

  it('takes a first save without a version', () => {
    expect(
      saveStorefrontPageInputSchema.parse({
        version: null,
        sections: [{ heading: 'Returns', body: 'Unopened items within 7 days.' }],
      }).version,
    ).toBeNull();
  });
});

describe('the Appearance routes', () => {
  it('all need storefront.manage', () => {
    for (const route of Object.values(storefrontAppearanceRoutes)) {
      expect(route.permission).toBe('storefront.manage');
    }
  });

  // One method and path is one handler: none may meet one of 26g's routes or another of these
  it('do not take a path the Storefront routes have', () => {
    const paths = [
      ...Object.values(storefrontRoutes),
      ...Object.values(storefrontAppearanceRoutes),
    ].map((route) => `${route.method} ${route.path}`);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
