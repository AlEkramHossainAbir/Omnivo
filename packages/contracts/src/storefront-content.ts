import { z } from 'zod';

import { errorCode } from './errors.js';
import {
  compareMoney,
  isMoneyAmount,
  isZeroMoney,
  percentOfMoney,
  subtractMoney,
} from './money.js';
import type { ShopDiscount } from './storefront.js';

// Step 26f: what the tenant writes for the shop, kept the way the ERP stores it. storefront.ts is
// what the shop reads (answers); this file is the raw material those answers are built from: a
// listing's sale, its description and its photos. The API turns them into the shop's shapes with
// the functions below, and step 26g's forms use the same functions for their preview, so the form
// and the shop can never disagree on a price or a paragraph.

// ---------------------------------------------------------------------------------------------
// The sale

// How the tenant typed the offer. Kept as typed, not turned into one final price, because each
// means something different when the regular price changes later:
// - percent: "10% off". A new regular price of ৳260 sells at ৳234.
// - amount: "৳21 off". ৳260 sells at ৳239.
// - price: "sell at ৳229". ৳260 still sells at ৳229.
export const STOREFRONT_SALE_KINDS = ['percent', 'amount', 'price'] as const;

// A whole percent, 1 to 99: the shop's ribbon says "10% OFF" (shopDiscountSchema has the same
// range). 0% is no sale, and 100% gives the goods away, which a form typo should never do
const salePercentSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d?$/, errorCode('storefront_sale_percent'));

// An amount in taka, more than zero. Whether it is under the regular price is checked by the API
// (step 26g), because only the API knows that price
const saleMoneySchema = z
  .string()
  .trim()
  .refine(isMoneyAmount, errorCode('money_format'))
  .refine(
    (value) => !isMoneyAmount(value) || !isZeroMoney(value),
    errorCode('storefront_sale_zero'),
  );

const saleTimeSchema = z.iso.datetime({ offset: true }).nullable();

export const storefrontSaleSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('percent'), value: salePercentSchema }),
    z.object({ kind: z.literal('amount'), value: saleMoneySchema }),
    z.object({ kind: z.literal('price'), value: saleMoneySchema }),
  ])
  .and(
    z.object({
      // null: the sale has started already / runs until the tenant turns it off. With an end, the
      // product page shows the countdown (CLAUDE.md → Product page, top)
      startsAt: saleTimeSchema,
      endsAt: saleTimeSchema,
    }),
  )
  // An end before (or at) its start is a sale that never runs. Compared as dates: the two strings
  // may have different offsets
  .refine(
    (sale) =>
      sale.startsAt === null ||
      sale.endsAt === null ||
      Date.parse(sale.startsAt) < Date.parse(sale.endsAt),
    { message: errorCode('storefront_sale_dates'), path: ['endsAt'] },
  );

export type StorefrontSaleKind = (typeof STOREFRONT_SALE_KINDS)[number];
export type StorefrontSale = z.infer<typeof storefrontSaleSchema>;

// The four price fields of a shop listing (shopListingSchema), worked out from the regular price
export interface ListingPricing {
  price: string;
  compareAtPrice: string | null;
  discount: ShopDiscount | null;
  saleUntil: string | null;
}

// What the shopper pays now, and what the card and the product page show for it. `regular` is the
// listing's own price or the variant's sale price (decision 2), `now` the server's clock (a
// parameter, so a test can fix it). A sale outside its dates is no sale. So is one that would not
// take anything off any more: a "sell at ৳229" after the regular price fell to ৳220 would show a
// struck-out ৳220 under a higher ৳229, so the shop shows ৳220 alone instead.
export function listingPricing(
  regular: string,
  sale: StorefrontSale | null,
  now: Date,
): ListingPricing {
  const noSale: ListingPricing = {
    price: regular,
    compareAtPrice: null,
    discount: null,
    saleUntil: null,
  };
  if (sale === null) return noSale;
  const time = now.getTime();
  if (sale.startsAt !== null && time < Date.parse(sale.startsAt)) return noSale;
  if (sale.endsAt !== null && time >= Date.parse(sale.endsAt)) return noSale;

  // How much comes off, to the paisa. A percent rounds half up (percentOfMoney): 10% of ৳249.95
  // is ৳25.00, not ৳24.995
  const off =
    sale.kind === 'percent'
      ? percentOfMoney(regular, sale.value)
      : sale.kind === 'amount'
        ? sale.value
        : subtractMoney(regular, sale.value);
  const price = subtractMoney(regular, off);
  // Nothing off, or everything off (and more): not a sale the shop can show
  if (compareMoney(off, '0') <= 0 || compareMoney(price, '0') <= 0) return noSale;

  return {
    price,
    compareAtPrice: regular,
    // The ribbon says it the way the tenant thought of it: "10% OFF" for a percent, the taka for
    // the other two ("৳21 OFF" for "sell at ৳229" from ৳250). The taka as regular − price, so it
    // has the 4 decimals of every other amount here even when the tenant typed "21"
    discount:
      sale.kind === 'percent'
        ? { kind: 'percent', value: Number(sale.value) }
        : { kind: 'amount', value: subtractMoney(regular, price) },
    saleUntil: sale.endsAt,
  };
}

// ---------------------------------------------------------------------------------------------
// The description and the text pages

// The tenant writes sections, never HTML (decision 6, made safer): each has a heading and a text
// box. The text box knows three things, enough for every description Figma shows:
// - a blank line starts a new paragraph,
// - lines that start with "- " are a bulleted list, lines that start with "1. " a numbered one,
// - **words** are bold, and [words](https://…) or [words](/pages/terms) is a link.
// The server writes the HTML from that (renderSections). Every character the tenant typed is
// escaped first, so no tag, attribute or script of theirs can reach the shop, and no HTML cleaner
// (sanitize-html) is needed at all.
export const STOREFRONT_SECTIONS_MAX = 12;
export const STOREFRONT_HEADING_MAX = 120;
export const STOREFRONT_BODY_MAX = 5000;

export const storefrontSectionSchema = z.object({
  heading: z
    .string()
    .trim()
    .min(1, errorCode('required'))
    .max(STOREFRONT_HEADING_MAX, errorCode('too_long')),
  body: z
    .string()
    .trim()
    .min(1, errorCode('required'))
    .max(STOREFRONT_BODY_MAX, errorCode('too_long')),
});

// A listing may have none (the product page then leaves out its Overview card). A text page needs
// at least one; its own schema (step 26g) says so
export const storefrontSectionsSchema = z
  .array(storefrontSectionSchema)
  .max(STOREFRONT_SECTIONS_MAX, errorCode('too_long'));

export type StorefrontSection = z.infer<typeof storefrontSectionSchema>;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

// A link or bold words, matched on the text before it is escaped. A link's address is https:// or a
// path on the shop's own site ("/pages/terms"), never "//other.site" (a link to another site that
// looks like a path), javascript: or data:, and it has no spaces, brackets or quotes, so it ends
// where the ")" is and cannot leave the href's quotes. Bold is the shortest run between two "**"
// on one line, so "**a** and **b**" is two bold words, not one long one.
const INLINE =
  /\[([^\]\n]+)\]\((https:\/\/[^\s()"'<>]+|\/(?!\/)[^\s()"'<>]*)\)|\*\*([^*\n]+?)\*\*/g;

function renderInline(text: string): string {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, linkText, href, bold] = match;
    html += escapeHtml(text.slice(last, match.index));
    if (bold !== undefined) {
      html += `<strong>${escapeHtml(bold)}</strong>`;
    } else if (linkText !== undefined && href !== undefined) {
      // Another site's page gets no referrer and no window.opener, like every outside link in the
      // shop (the tracking page's courier link)
      const rel = href.startsWith('https://') ? ' rel="noopener noreferrer"' : '';
      html += `<a href="${escapeHtml(href)}"${rel}>${escapeHtml(linkText)}</a>`;
    }
    last = match.index + whole.length;
  }
  return html + escapeHtml(text.slice(last));
}

const BULLET = /^[-*]\s+/;
const NUMBERED = /^\d{1,3}[.)]\s+/;

// One block of lines between blank lines: a list when every line is an item, else a paragraph.
// A paragraph keeps the tenant's line breaks (<br>): an address or a phone list on the contact page
// is written one per line
function renderBlock(lines: readonly string[]): string {
  if (lines.every((line) => BULLET.test(line))) {
    const items = lines.map((line) => `<li>${renderInline(line.replace(BULLET, ''))}</li>`);
    return `<ul>${items.join('')}</ul>`;
  }
  if (lines.every((line) => NUMBERED.test(line))) {
    const items = lines.map((line) => `<li>${renderInline(line.replace(NUMBERED, ''))}</li>`);
    return `<ol>${items.join('')}</ol>`;
  }
  return `<p>${lines.map(renderInline).join('<br>')}</p>`;
}

// The HTML the shop draws with its prose style (shopProductSchema.descriptionHtml,
// shopTextPageSchema.html): one <section> with an <h2> per section. No sections: '' (no
// description). Windows line ends (\r\n, from a pasted text) count as plain line ends.
export function renderSections(sections: readonly StorefrontSection[]): string {
  return sections
    .map((section) => {
      const blocks = section.body
        .replace(/\r\n?/g, '\n')
        .split(/\n[ \t]*\n/)
        .map((block) =>
          block
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''),
        )
        .filter((lines) => lines.length > 0)
        .map(renderBlock);
      return `<section><h2>${escapeHtml(section.heading)}</h2>${blocks.join('')}</section>`;
    })
    .join('');
}

// The sections as plain words, for the page's <meta name="description"> when the tenant wrote no
// SEO description: the first section's text without its markup, cut at a word to at most `max`
// characters (search engines show about 155). '' when there is no section.
export function sectionsSummary(sections: readonly StorefrontSection[], max = 155): string {
  const first = sections[0];
  if (first === undefined) return '';
  const words = first.body
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .split('\n')
    .map((line) => line.trim().replace(BULLET, '').replace(NUMBERED, ''))
    .filter((line) => line !== '')
    .join(' ');
  if (words.length <= max) return words;
  // One character is kept for the "…". The cut is at a word's end already when the next character
  // is a space; otherwise it goes back to the last space, so no word is cut in half (a single word
  // longer than `max` is the exception: it is cut)
  const cut = words.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const whole = words[max - 1] === ' ' || lastSpace <= 0 ? cut : cut.slice(0, lastSpace);
  return `${whole.trimEnd()}…`;
}

// ---------------------------------------------------------------------------------------------
// Photos

// A listing shows at most this many: the product page's gallery has four thumbnails in its row
// (SHOP_GALLERY_MAX in storefront.ts, the same number). The first is the card's photo
export const STOREFRONT_IMAGES_MAX = 4;
export const STOREFRONT_ALT_MAX = 200;

// One photo as the ERP keeps it: the id of the uploaded picture (its files live under that id in
// the public storefront/ folder, made by step 26g's image job) and the words a screen reader says
// for it. The API turns the id into an address; the shop never sees a storage key.
export const storefrontImageSchema = z.object({
  id: z.uuid(),
  alt: z
    .string()
    .trim()
    .min(1, errorCode('required'))
    .max(STOREFRONT_ALT_MAX, errorCode('too_long')),
});

export const storefrontImagesSchema = z
  .array(storefrontImageSchema)
  .max(STOREFRONT_IMAGES_MAX, errorCode('too_long'));

export type StorefrontImage = z.infer<typeof storefrontImageSchema>;
