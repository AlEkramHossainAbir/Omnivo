import type { ShopListing, ShopProduct, ShopProductPage } from '@omnivo/contracts';

import {
  diabeticListings,
  featuredListings,
  himalayaListings,
  listing,
  trendingListings,
} from './listings';

// Step 26b: the product pages. One product is the Figma design's (product_details 37:3521) with
// its four photos and its description; every other listing gets a plain page made from its card,
// so no card in the mock links to a 404.

// The design's sale ends "01 : 12 : 10 : 32" from now: 1 day, 12 hours, 10 minutes, 32 seconds
const SALE_LEFT_MS = (((1 * 24 + 12) * 60 + 10) * 60 + 32) * 1000;

const NEEM_SLUG = 'himalaya-purifying-neem-face-wash-150ml';
const NEEM_NAME = 'Himalaya Purifying Neem Face Wash';

const neemListing: ShopListing = {
  ...listing({
    slug: NEEM_SLUG,
    // Figma's page title has the size in the name; the description's first heading does not
    name: `${NEEM_NAME} 150ml`,
    packSize: '150ml',
    price: '229',
    categoryId: 'cat-cosmetics',
    badges: ['most_picked'],
    // ৳299 − ৳229: the ribbon says what the struck-out price says
    discount: { kind: 'amount', value: '70' },
  }),
  compareAtPrice: '299',
};

// The description as the ERP will send it (shopProductSchema.descriptionHtml): a <section> per
// block, each with an <h2>. The words are Figma's (37:3612). Kept as one string on purpose: it is
// what the page gets from the API, not markup the shop writes.
const NEEM_DESCRIPTION = `<section>
<h2>${NEEM_NAME}</h2>
<p>Refresh and purify your skin every day with ${NEEM_NAME}. Enriched with the natural goodness of Neem &amp; Turmeric, this soap-free face wash effectively removes impurities, controls excess oil, and helps prevent pimples while maintaining your skin's natural moisture.</p>
</section>
<section>
<h2>Specifications</h2>
<ul>
<li><strong>Product Type:</strong> Face Wash</li>
<li><strong>Brand:</strong> Himalaya</li>
<li><strong>Skin Type:</strong> Suitable for all skin types (Best for Normal, Oily &amp; Pimple-Prone Skin)</li>
<li><strong>Category:</strong> Daily Facial Cleanser</li>
<li><strong>Formula:</strong> Soap-Free Herbal Cleanser</li>
</ul>
</section>
<section>
<h2>Key Benefits</h2>
<ul>
<li>Deeply cleanses dirt, impurities, and excess oil</li>
<li>Helps prevent pimples and future breakouts</li>
<li>Controls excess oil without drying the skin</li>
<li>Maintains the skin's natural moisture balance</li>
<li>Removes dead skin cells for a fresh, healthy glow</li>
<li>Soothes irritated skin with the goodness of Turmeric</li>
<li>Leaves skin clean, refreshed, and soft after every wash</li>
</ul>
</section>
<section>
<h2>Main Ingredients</h2>
<ul>
<li><strong>Neem:</strong> Naturally antibacterial and antifungal, helps purify skin, fight acne-causing bacteria, and reduce blemishes.</li>
<li><strong>Turmeric:</strong> Known for its anti-inflammatory and antiseptic properties that soothe the skin and promote an even-looking complexion.</li>
</ul>
</section>
<section>
<h2>Why Choose ${NEEM_NAME}?</h2>
<ul>
<li>Soap-free formula for gentle daily cleansing</li>
<li>Dermatologically tested</li>
<li>Free from Parabens, SLS/SLES, Phthalates, Artificial Colors &amp; Artificial Fragrances</li>
<li>100% Cruelty-Free skincare</li>
<li>Suitable for daily morning and evening use</li>
</ul>
</section>
<section>
<h2>How to Use</h2>
<ol>
<li>Moisten your face with water.</li>
<li>Apply a small amount of ${NEEM_NAME}.</li>
<li>Gently massage using circular motions until it forms a rich lather.</li>
<li>Rinse thoroughly with water.</li>
<li>Pat your face dry with a clean towel.</li>
<li>For best results, use twice daily.</li>
</ol>
</section>
<section>
<h2>Product Details</h2>
<p>${NEEM_NAME} is a herbal, soap-free facial cleanser specially formulated to keep your skin clean, fresh, and healthy. Its unique blend of Neem and Turmeric effectively removes excess oil, dirt, and impurities while helping prevent acne and pimple breakouts. Unlike ordinary cleansers, it deeply purifies the skin without stripping away its essential moisture, making it ideal for everyday use. The gentle formula keeps your skin feeling refreshed, soft, and naturally healthy after every wash.</p>
</section>`;

const neemProduct: Omit<ShopProduct, 'saleUntil'> = {
  ...neemListing,
  // Figma's four thumbnails (37:3563 to 37:3569) are one photo, straight and tilted, twice
  images: [
    { url: `/mock/products/${NEEM_SLUG}.png`, alt: `${NEEM_NAME} 150ml, front` },
    { url: `/mock/products/${NEEM_SLUG}-2.png`, alt: `${NEEM_NAME}, tube tilted` },
    { url: `/mock/products/${NEEM_SLUG}.png`, alt: `${NEEM_NAME} 150ml, front` },
    { url: `/mock/products/${NEEM_SLUG}-2.png`, alt: `${NEEM_NAME}, tube tilted` },
  ],
  sku: 'MD2346',
  unitName: 'Piece',
  descriptionHtml: NEEM_DESCRIPTION,
};

// Every listing the mock shop sells: the home page's and the product page's. The quote looks a
// cart's ids up here, so a listing added to the cart from any page can be priced
export const mockCatalog: ShopListing[] = [
  ...featuredListings,
  ...himalayaListings,
  ...trendingListings,
  ...diabeticListings,
  neemListing,
];

const RELATED_MAX = 12;

// `now` is a parameter so a test can fix the clock. The mock's sale always ends 1 day 12 hours
// after the page is asked for: a fixed date would pass one day, and the countdown would vanish from
// the mock without any code changing
export function mockProductPage(slug: string, now: Date): ShopProductPage | null {
  if (slug === NEEM_SLUG) {
    return {
      product: {
        ...neemProduct,
        saleUntil: new Date(now.getTime() + SALE_LEFT_MS).toISOString(),
      },
      // The design's "Related Products" row is the Himalaya shelf of the home page, then the rest
      // of the category: Figma's row has more than its five cards (the right arrow is on), and
      // with five that fit, both arrows would be off
      related: [
        ...himalayaListings,
        ...mockCatalog.filter(
          (other) =>
            other.categoryId === neemListing.categoryId &&
            other.id !== neemListing.id &&
            !himalayaListings.includes(other),
        ),
      ].slice(0, RELATED_MAX),
    };
  }

  const found = mockCatalog.find((candidate) => candidate.slug === slug);
  if (!found) return null;
  return {
    product: {
      ...found,
      // A plain page: the card's one photo, no SKU, no description (the page leaves out the
      // Overview card for '')
      sku: null,
      unitName: 'Piece',
      descriptionHtml: '',
    },
    // The same category, as the real API will choose them, without the product itself
    related: mockCatalog
      .filter((other) => other.categoryId === found.categoryId && other.id !== found.id)
      .slice(0, RELATED_MAX),
  };
}
