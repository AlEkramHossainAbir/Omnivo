import { describe, expect, it } from 'vitest';

import {
  listingPricing,
  renderSections,
  sectionsSummary,
  STOREFRONT_IMAGES_MAX,
  storefrontImagesSchema,
  storefrontSaleSchema,
  storefrontSectionsSchema,
  type StorefrontSale,
} from './storefront-content.js';
import { SHOP_GALLERY_MAX } from './storefront.js';

// A neem face wash at ৳250, on a Sunday afternoon in Dhaka
const NOW = new Date('2026-11-15T10:00:00+06:00');
const ALWAYS = { startsAt: null, endsAt: null };

type SaleDates = Pick<StorefrontSale, 'startsAt' | 'endsAt'>;

function sale(
  kind: StorefrontSale['kind'],
  value: string,
  dates: SaleDates = ALWAYS,
): StorefrontSale {
  return storefrontSaleSchema.parse({ kind, value, ...dates });
}

describe('listing pricing', () => {
  it('sells at the regular price without a sale', () => {
    expect(listingPricing('250.0000', null, NOW)).toEqual({
      price: '250.0000',
      compareAtPrice: null,
      discount: null,
      saleUntil: null,
    });
  });

  it('takes a percent off, to the paisa, and the ribbon says the percent', () => {
    expect(listingPricing('249.9500', sale('percent', '10'), NOW)).toEqual({
      // 10% of ৳249.95 is ৳24.995, rounded half up to ৳25.00
      price: '224.9500',
      compareAtPrice: '249.9500',
      discount: { kind: 'percent', value: 10 },
      saleUntil: null,
    });
  });

  it('takes an amount off', () => {
    const pricing = listingPricing('250.0000', sale('amount', '21'), NOW);
    expect(pricing.price).toBe('229.0000');
    expect(pricing.discount).toEqual({ kind: 'amount', value: '21.0000' });
  });

  it('sells at a set price, and the ribbon says the taka it saves', () => {
    const pricing = listingPricing('250.0000', sale('price', '229'), NOW);
    expect(pricing.price).toBe('229.0000');
    expect(pricing.compareAtPrice).toBe('250.0000');
    expect(pricing.discount).toEqual({ kind: 'amount', value: '21.0000' });
  });

  it('keeps a set price when the regular price changes, and a percent follows it', () => {
    expect(listingPricing('260.0000', sale('price', '229'), NOW).price).toBe('229.0000');
    expect(listingPricing('260.0000', sale('percent', '10'), NOW).price).toBe('234.0000');
  });

  it('shows no sale that would take nothing off, or everything', () => {
    // The regular price fell under the set sale price
    expect(listingPricing('220.0000', sale('price', '229'), NOW).compareAtPrice).toBeNull();
    expect(listingPricing('220.0000', sale('price', '220'), NOW).compareAtPrice).toBeNull();
    // ৳300 off a ৳250 face wash
    expect(listingPricing('250.0000', sale('amount', '300'), NOW).price).toBe('250.0000');
    expect(listingPricing('250.0000', sale('amount', '250'), NOW).price).toBe('250.0000');
  });

  it('runs a sale only between its dates, and the end is the countdown', () => {
    const dates = { startsAt: '2026-11-15T09:00:00+06:00', endsAt: '2026-11-16T23:59:00+06:00' };
    const live = listingPricing('250.0000', sale('amount', '21', dates), NOW);
    expect(live.price).toBe('229.0000');
    expect(live.saleUntil).toBe(dates.endsAt);

    const early = new Date('2026-11-15T08:59:59+06:00');
    expect(listingPricing('250.0000', sale('amount', '21', dates), early).discount).toBeNull();
    // The end itself is no longer the sale: the countdown has reached zero
    const end = new Date(dates.endsAt);
    expect(listingPricing('250.0000', sale('amount', '21', dates), end).discount).toBeNull();
  });
});

describe('sale schema', () => {
  it('takes a whole percent from 1 to 99', () => {
    for (const value of ['1', '10', '99', ' 15 ']) {
      expect(storefrontSaleSchema.safeParse({ kind: 'percent', value, ...ALWAYS }).success).toBe(
        true,
      );
    }
    for (const value of ['0', '100', '7.5', '05', '', '-5']) {
      const result = storefrontSaleSchema.safeParse({ kind: 'percent', value, ...ALWAYS });
      expect(result.error?.issues[0]?.message).toBe('storefront_sale_percent');
    }
  });

  it('refuses an amount or a price of zero, and one that is not money', () => {
    for (const kind of ['amount', 'price'] as const) {
      const zero = storefrontSaleSchema.safeParse({ kind, value: '0.00', ...ALWAYS });
      expect(zero.error?.issues.map((issue) => issue.message)).toEqual(['storefront_sale_zero']);
      const words = storefrontSaleSchema.safeParse({ kind, value: 'twenty', ...ALWAYS });
      expect(words.error?.issues.map((issue) => issue.message)).toEqual(['money_format']);
    }
  });

  it('refuses an end at or before the start, whatever their offsets', () => {
    const backwards = storefrontSaleSchema.safeParse({
      kind: 'amount',
      value: '21',
      startsAt: '2026-11-16T00:00:00+06:00',
      // The same moment, written in UTC
      endsAt: '2026-11-15T18:00:00Z',
    });
    expect(backwards.error?.issues[0]).toMatchObject({
      message: 'storefront_sale_dates',
      path: ['endsAt'],
    });
  });
});

describe('sections', () => {
  it('writes paragraphs, lists and bold words', () => {
    const html = renderSections([
      {
        heading: 'Specifications',
        body: 'A soap-free herbal cleanser.\nFor every day.\n\n- **Brand:** Himalaya\n- **Size:** 150ml\n\n1. Wet the face\n2. Rinse',
      },
    ]);
    expect(html).toBe(
      '<section><h2>Specifications</h2>' +
        '<p>A soap-free herbal cleanser.<br>For every day.</p>' +
        '<ul><li><strong>Brand:</strong> Himalaya</li><li><strong>Size:</strong> 150ml</li></ul>' +
        '<ol><li>Wet the face</li><li>Rinse</li></ol>' +
        '</section>',
    );
  });

  it('escapes everything the tenant typed', () => {
    const html = renderSections([
      {
        heading: '<script>alert(1)</script>',
        body: 'Neem & Turmeric <img src=x onerror=alert(1)> "quoted"',
      },
    ]);
    expect(html).toBe(
      '<section><h2>&lt;script&gt;alert(1)&lt;/script&gt;</h2>' +
        '<p>Neem &amp; Turmeric &lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;</p></section>',
    );
  });

  it('links to https and to the shop only, and never lets a link leave its quotes', () => {
    const html = renderSections([
      {
        heading: 'Contact',
        body: [
          'See [our terms](/pages/terms) and [bKash](https://www.bkash.com/help?a=1&b=2).',
          '[evil](javascript:alert(1)) [other](//evil.example) [data](data:text/html,x)',
          '[quote](https://x.example/"onmouseover="alert(1))',
        ].join('\n'),
      },
    ]);
    expect(html).toContain('<a href="/pages/terms">our terms</a>');
    expect(html).toContain(
      '<a href="https://www.bkash.com/help?a=1&amp;b=2" rel="noopener noreferrer">bKash</a>',
    );
    // Not links: they stay as the words the tenant typed
    expect(html).toContain('[evil](javascript:alert(1))');
    expect(html).toContain('[other](//evil.example)');
    expect(html).toContain('[data](data:text/html,x)');
    expect(html).not.toContain('onmouseover="');
    expect(html.match(/<a /g)).toHaveLength(2);
  });

  it('keeps a mixed block a paragraph, and drops empty lines and Windows line ends', () => {
    const html = renderSections([
      { heading: 'Use', body: '- Wet the face\nThen rinse\r\n\r\n\r\n   \n- One\r\n- Two' },
    ]);
    expect(html).toBe(
      '<section><h2>Use</h2><p>- Wet the face<br>Then rinse</p>' +
        '<ul><li>One</li><li>Two</li></ul></section>',
    );
  });

  it('writes nothing for no sections', () => {
    expect(renderSections([])).toBe('');
  });

  it('allows up to 12 sections, each with a heading and some text', () => {
    const section = { heading: 'Benefits', body: 'Cleans deeply.' };
    expect(storefrontSectionsSchema.safeParse(Array(12).fill(section)).success).toBe(true);
    expect(storefrontSectionsSchema.safeParse(Array(13).fill(section)).success).toBe(false);
    const blank = storefrontSectionsSchema.safeParse([{ heading: '  ', body: 'x' }]);
    expect(blank.error?.issues[0]?.message).toBe('required');
  });
});

describe('sections summary', () => {
  it('is the first section as plain words', () => {
    expect(
      sectionsSummary([
        {
          heading: 'Overview',
          body: '**Soap-free** face wash.\n\n- Controls oil\n- [Neem](/c/neem)',
        },
        { heading: 'More', body: 'Not this.' },
      ]),
    ).toBe('Soap-free face wash. Controls oil Neem');
  });

  it('cuts a long text at a word, with an ellipsis', () => {
    const summary = sectionsSummary([{ heading: 'x', body: 'Neem face wash '.repeat(20) }], 30);
    expect(summary).toBe('Neem face wash Neem face wash…');
    expect(summary.length).toBeLessThanOrEqual(30);
  });

  it('is empty without sections', () => {
    expect(sectionsSummary([])).toBe('');
  });
});

describe('images', () => {
  it('keeps as many photos as the gallery shows', () => {
    expect(STOREFRONT_IMAGES_MAX).toBe(SHOP_GALLERY_MAX);
    const photo = { id: '0193a1b2-3c4d-7e8f-9a0b-1c2d3e4f5a6b', alt: 'Neem face wash, front' };
    expect(storefrontImagesSchema.safeParse(Array(4).fill(photo)).success).toBe(true);
    expect(storefrontImagesSchema.safeParse(Array(5).fill(photo)).success).toBe(false);
  });

  it('needs words for a screen reader', () => {
    const result = storefrontImagesSchema.safeParse([
      { id: '0193a1b2-3c4d-7e8f-9a0b-1c2d3e4f5a6b', alt: ' ' },
    ]);
    expect(result.error?.issues[0]?.message).toBe('required');
  });
});
