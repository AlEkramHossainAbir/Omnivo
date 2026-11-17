import { describe, expect, it } from 'vitest';

import { createUploadInputSchema } from './attachments.js';
import { PERMISSION_GROUP_OF } from './permissions.js';
import {
  createStorefrontCategoryInputSchema,
  createStorefrontSettingsInputSchema,
  createStorefrontUploadInputSchema,
  slugFromName,
  STOREFRONT_SLUG_MAX,
  storefrontRoutes,
  storefrontSubdomainSchema,
  updateStorefrontCategoryInputSchema,
  updateStorefrontListingInputSchema,
  updateStorefrontSettingsInputSchema,
  type StorefrontListingFormValues,
} from './storefront-admin.js';

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
const CATEGORY = '2dab8e74-9f40-4da0-9c73-5b6e4f3a2c33';

describe('the shop subdomain', () => {
  it('lower-cases and trims what the tenant typed', () => {
    expect(storefrontSubdomainSchema.parse('  Nirvor-Pharmacy ')).toBe('nirvor-pharmacy');
  });

  it.each([
    ['ab', 'too_short'],
    ['nirvor pharmacy', 'storefront_subdomain_format'],
    ['-nirvor', 'storefront_subdomain_format'],
    ['nirvor-', 'storefront_subdomain_format'],
    // Two hyphens in a row: also keeps out "xn--", an internationalized name in disguise
    ['xn--nirvor', 'storefront_subdomain_format'],
    ['নির্ভর', 'storefront_subdomain_format'],
    ['a'.repeat(64), 'too_long'],
  ])('refuses %s with %s', (label, code) => {
    expect(errorsOf(storefrontSubdomainSchema.safeParse(label))['']).toContain(code);
  });

  // app and api are the ERP's and the API's own hosts on staging (app.omnivosoft.com)
  it.each(['app', 'api', 'www', 'files', 'media', 'shop'])('keeps %s for Omnivo', (label) => {
    expect(errorsOf(storefrontSubdomainSchema.safeParse(label))['']).toEqual([
      'storefront_subdomain_reserved',
    ]);
  });
});

describe('slugs from names', () => {
  it.each([
    ['Neem Face Wash 150ml', 'neem-face-wash-150ml'],
    ['  Diabetic care & sugar-free  ', 'diabetic-care-sugar-free'],
    ['Café Latte', 'cafe-latte'],
    ['Himalaya — Herbals', 'himalaya-herbals'],
    // No Latin letter: the form asks for a slug instead of making one up
    ['নিম ফেস ওয়াশ', ''],
    ['নিম Neem', 'neem'],
  ])('makes %j into %j', (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });

  it('cuts a long name at 100 without a hyphen at the end', () => {
    const slug = slugFromName(`${'a'.repeat(99)} b`);
    expect(slug).toBe('a'.repeat(99));
    expect(slug.length).toBeLessThanOrEqual(STOREFRONT_SLUG_MAX);
  });
});

describe('a shop category', () => {
  it('takes its slug from the name when the box is empty, and the top level as null', () => {
    expect(
      createStorefrontCategoryInputSchema.parse({
        parentId: '',
        name: 'Diabetic Corner',
        slug: '',
      }),
    ).toEqual({ parentId: null, name: 'Diabetic Corner', slug: 'diabetic-corner' });
  });

  it('keeps a slug the tenant typed, lower-cased', () => {
    expect(
      createStorefrontCategoryInputSchema.parse({
        parentId: CATEGORY,
        name: 'ডায়াবেটিক কর্নার',
        slug: 'Diabetic',
      }).slug,
    ).toBe('diabetic');
  });

  it('asks for a slug when a Bangla name has nothing to make one from', () => {
    const result = createStorefrontCategoryInputSchema.safeParse({
      parentId: '',
      name: 'ডায়াবেটিক কর্নার',
      slug: '',
    });
    expect(errorsOf(result)).toEqual({ slug: ['storefront_slug_required'] });
  });

  it('refuses a slug with spaces on the slug box', () => {
    expect(
      errorsOf(
        updateStorefrontCategoryInputSchema.safeParse({
          parentId: '',
          name: 'Tea',
          slug: 'green tea',
          version: 2,
        }),
      ),
    ).toEqual({ slug: ['storefront_slug_format'] });
  });

  // Step 26h: /c/all is "All Products", answered before any category, so "all" would hide this one
  it.each([
    ['typed', 'All', 'all'],
    ['made from the name', 'All', ''],
  ])('refuses the slug "all" (%s) on the slug box', (_how, name, slug) => {
    const result = createStorefrontCategoryInputSchema.safeParse({ parentId: '', name, slug });
    expect(errorsOf(result)).toEqual({ slug: ['storefront_slug_reserved'] });
    const update = updateStorefrontCategoryInputSchema.safeParse({
      parentId: '',
      name,
      slug,
      version: 3,
    });
    expect(errorsOf(update)).toEqual({ slug: ['storefront_slug_reserved'] });
  });

  it('still takes a longer slug that starts with all', () => {
    expect(
      createStorefrontCategoryInputSchema.parse({ parentId: '', name: 'All Natural', slug: '' })
        .slug,
    ).toBe('all-natural');
  });
});

// A settings form as the page sends it, before the tenant changes anything
const SETTINGS = {
  subdomain: 'nirvor',
  name: 'Nirvor Pharmacy',
  language: 'bn',
  hotline: '09612-345678',
  address: 'House 12, Road 3, Zindabazar, Sylhet',
  facebookUrl: '',
  instagramUrl: '',
  xUrl: '',
  linkedinUrl: '',
  defaultWarehouseId: '',
  deliveryZones: [],
  freeDeliveryFrom: '',
  minimumOrder: '',
  paymentMethods: ['cod'],
} as const;

describe('the shop settings', () => {
  it('turns every empty box into null', () => {
    expect(createStorefrontSettingsInputSchema.parse(SETTINGS)).toMatchObject({
      facebookUrl: null,
      defaultWarehouseId: null,
      freeDeliveryFrom: null,
      minimumOrder: null,
    });
  });

  it('keeps a zone id when it has one, and names a new zone null', () => {
    const parsed = updateStorefrontSettingsInputSchema.parse({
      ...SETTINGS,
      version: 3,
      deliveryZones: [
        { id: 'inside-dhaka', name: 'Inside Dhaka', charge: '80' },
        { id: null, name: 'Sylhet city', charge: '0' },
      ],
    });
    expect(parsed.deliveryZones).toEqual([
      { id: 'inside-dhaka', name: 'Inside Dhaka', charge: '80' },
      { id: null, name: 'Sylhet city', charge: '0' },
    ]);
  });

  it('refuses two zones with one name on the second, and a zone with no charge', () => {
    const result = createStorefrontSettingsInputSchema.safeParse({
      ...SETTINGS,
      deliveryZones: [
        { id: null, name: 'Inside Dhaka', charge: '80' },
        { id: null, name: ' inside dhaka ', charge: '' },
      ],
    });
    expect(errorsOf(result)).toEqual({
      'deliveryZones.1.name': ['storefront_zone_name_taken'],
      'deliveryZones.1.charge': ['required'],
    });
  });

  it('refuses a seventh zone', () => {
    const zones = Array.from({ length: 7 }, (_, index) => ({
      id: null,
      name: `Zone ${String(index + 1)}`,
      charge: '60',
    }));
    expect(
      errorsOf(
        createStorefrontSettingsInputSchema.safeParse({ ...SETTINGS, deliveryZones: zones }),
      ),
    ).toEqual({ deliveryZones: ['too_long'] });
  });

  it.each([
    ['http://facebook.com/nirvor', 'storefront_link_https'],
    ['javascript:alert(1)', 'storefront_link_https'],
    ['facebook.com/nirvor', 'storefront_link_https'],
  ])('refuses the social link %s', (link, code) => {
    expect(
      errorsOf(createStorefrontSettingsInputSchema.safeParse({ ...SETTINGS, facebookUrl: link })),
    ).toEqual({ facebookUrl: [code] });
  });

  it('takes an https social link', () => {
    expect(
      createStorefrontSettingsInputSchema.parse({
        ...SETTINGS,
        instagramUrl: 'https://instagram.com/nirvor.pharmacy',
      }).instagramUrl,
    ).toBe('https://instagram.com/nirvor.pharmacy');
  });

  it('refuses free delivery from ৳0, no way to pay, and keeps a method ticked twice once', () => {
    expect(
      errorsOf(
        createStorefrontSettingsInputSchema.safeParse({
          ...SETTINGS,
          freeDeliveryFrom: '0',
          paymentMethods: [],
        }),
      ),
    ).toEqual({
      freeDeliveryFrom: ['too_small'],
      paymentMethods: ['storefront_payment_required'],
    });
    expect(
      createStorefrontSettingsInputSchema.parse({ ...SETTINGS, paymentMethods: ['cod', 'cod'] })
        .paymentMethods,
    ).toEqual(['cod']);
  });
});

// The listing editor as it opens on a draft
const LISTING: StorefrontListingFormValues = {
  version: 1,
  name: 'Himalaya Neem Face Wash',
  slug: '',
  packSize: '150ml',
  categoryId: CATEGORY,
  priceOverride: '',
  sale: null,
  badges: [],
  images: [],
  descriptionSections: [],
  seoTitle: '',
  seoDescription: '',
};

describe('the listing editor', () => {
  it('fills the slug from the name, and the empty boxes as null', () => {
    expect(updateStorefrontListingInputSchema.parse(LISTING)).toMatchObject({
      slug: 'himalaya-neem-face-wash',
      priceOverride: null,
      seoTitle: null,
      seoDescription: null,
    });
  });

  it('keeps each badge once, in the shop’s order', () => {
    expect(
      updateStorefrontListingInputSchema.parse({
        ...LISTING,
        badges: ['new', 'most_picked', 'new'],
      }).badges,
    ).toEqual(['most_picked', 'new']);
  });

  it('refuses a shop price of ৳0, the same photo twice and a photo without its words', () => {
    const result = updateStorefrontListingInputSchema.safeParse({
      ...LISTING,
      priceOverride: '0',
      images: [
        { id: PHOTO, alt: 'Neem face wash, front' },
        { id: PHOTO_2, alt: ' ' },
        { id: PHOTO, alt: 'Neem face wash, again' },
      ],
    });
    expect(errorsOf(result)).toEqual({
      priceOverride: ['too_small'],
      'images.1.alt': ['required'],
      'images.2': ['storefront_image_twice'],
    });
  });

  it('refuses a fifth photo', () => {
    const images = [PHOTO, PHOTO_2, CATEGORY, '3ebc9f85-a051-4eb1-8d84-6c7f5a4b3d44', PHOTO].map(
      (id, index) => ({ id, alt: `Photo ${String(index + 1)}` }),
    );
    expect(errorsOf(updateStorefrontListingInputSchema.safeParse({ ...LISTING, images }))).toEqual({
      images: ['too_long'],
    });
  });

  it('takes a sale with its dates, and refuses one that ends before it starts', () => {
    expect(
      updateStorefrontListingInputSchema.parse({
        ...LISTING,
        sale: { kind: 'percent', value: '10', startsAt: null, endsAt: '2026-11-30T23:59:00+06:00' },
      }).sale,
    ).toEqual({
      kind: 'percent',
      value: '10',
      startsAt: null,
      endsAt: '2026-11-30T23:59:00+06:00',
    });
    expect(
      errorsOf(
        updateStorefrontListingInputSchema.safeParse({
          ...LISTING,
          sale: {
            kind: 'amount',
            value: '21',
            startsAt: '2026-11-20T00:00:00+06:00',
            endsAt: '2026-11-19T00:00:00+06:00',
          },
        }),
      ),
    ).toEqual({ 'sale.endsAt': ['storefront_sale_dates'] });
  });
});

describe('photo uploads', () => {
  it('takes a phone photo up to 8 MB', () => {
    expect(
      createStorefrontUploadInputSchema.safeParse({
        fileName: 'IMG_2041.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 8 * 1024 * 1024,
      }).success,
    ).toBe(true);
  });

  it('refuses an SVG and a photo over 8 MB, each on its own box', () => {
    expect(
      errorsOf(
        createStorefrontUploadInputSchema.safeParse({
          fileName: 'logo.svg',
          contentType: 'image/svg+xml',
          sizeBytes: 8 * 1024 * 1024 + 1,
        }),
      ),
    ).toEqual({
      contentType: ['file_type_not_allowed'],
      sizeBytes: ['storefront_image_file_too_large'],
    });
  });

  // Through POST /attachments a storefront photo would be a file no image job ever makes ready
  it('is not a purpose of the general upload route', () => {
    expect(
      createUploadInputSchema.safeParse({
        purpose: 'storefront_image',
        fileName: 'IMG_2041.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1000,
      }).success,
    ).toBe(false);
  });
});

describe('the Storefront routes', () => {
  it('all need storefront.manage, which has a group of its own', () => {
    for (const route of Object.values(storefrontRoutes)) {
      expect(route.permission).toBe('storefront.manage');
    }
    expect(PERMISSION_GROUP_OF['storefront.manage']).toBe('storefront');
  });

  // A path like /storefront/listings/candidates would meet /storefront/listings/:id first
  it('keep fixed paths out of the way of an :id', () => {
    const paths = Object.values(storefrontRoutes).map((route) => `${route.method} ${route.path}`);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path).not.toMatch(/\/listings\/(?!:id)[a-z]/);
    }
  });
});
