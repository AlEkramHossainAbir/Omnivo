import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import {
  addMoney,
  compareMoney,
  includedTaxOf,
  isMoneyAmount,
  multiplyMoney,
  percentOfMoney,
  requiredPriceSchema,
  subtractMoney,
  sumMoney,
} from './money.js';
import { isQuantity, quantitySchema } from './quantities.js';
import { stockUnitSchema, variantRefSchema } from './stock.js';

// What quotations and orders (step 15b) and invoices (15c) share: a line with a product, a price,
// a discount and a VAT rate, and the arithmetic that turns it into amounts. The arithmetic lives
// here, not in the API, so the form shows the same total the server stores, to the paisa.

// The most lines one quotation or order holds. A distributor's order for a pharmacy runs to a few
// hundred items. A delivery may split a line over two batches, and MAX_STOCK_LINES (500) leaves
// room for that.
export const MAX_SALES_LINES = 300;

// A discount is a percent of the line (12.5%) or an amount off the whole line (৳250)
export const DISCOUNT_TYPES = ['percent', 'amount'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

// At most 2 decimals: the line is worked out to the paisa, so ৳10.555 off could not be shown.
// '' (an empty box) is no discount.
const DISCOUNT = /^\d{1,15}(?:\.\d{1,2})?$/;

const discountSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || DISCOUNT.test(value), errorCode('money_format'))
  .transform((value) => (value === '' ? '0' : value));

// ---------------------------------------------------------------------------------------------
// The arithmetic

// What a line is worth, each to the paisa:
//   gross     quantity × price, as typed
//   discount  what the discount takes off gross
//   net       before VAT, after the discount: what the sales account gets (15c)
//   vat       the VAT on the line: what the VAT account gets (15c)
//   total     what the customer pays for the line: net + vat
export interface LineAmounts {
  gross: string;
  discount: string;
  net: string;
  vat: string;
  total: string;
}

export interface LineAmountInput {
  quantity: string;
  unitPrice: string;
  discountType: DiscountType;
  discount: string;
  // The VAT rate in percent: "15.00"
  rate: string;
}

// pricesIncludeVat: the document's copy of the workspace setting (step 15a). A shop's price of
// ৳115 at 15% holds ৳15 of VAT; a factory's price of ৳100 gets ৳15 added. The discount comes off
// the price as typed, before the VAT is worked out, so a 10% discount is 10% of what the customer
// sees in both cases.
export function lineAmounts(line: LineAmountInput, pricesIncludeVat: boolean): LineAmounts {
  const gross = multiplyMoney(line.quantity, line.unitPrice);
  const discount =
    line.discountType === 'percent'
      ? percentOfMoney(gross, line.discount)
      : sumMoney([line.discount]);
  const afterDiscount = subtractMoney(gross, discount);
  if (pricesIncludeVat) {
    const vat = includedTaxOf(afterDiscount, line.rate);
    return { gross, discount, net: subtractMoney(afterDiscount, vat), vat, total: afterDiscount };
  }
  const vat = percentOfMoney(afterDiscount, line.rate);
  return { gross, discount, net: afterDiscount, vat, total: addMoney(afterDiscount, vat) };
}

// The same, for a line that is still being typed: null until every box holds a complete value, so
// the form's totals never throw on "1." or an empty price
export function draftLineAmounts(
  line: { quantity: string; unitPrice: string; discountType: DiscountType; discount: string },
  rate: string | null,
  pricesIncludeVat: boolean,
): LineAmounts | null {
  const discount = line.discount.trim() === '' ? '0' : line.discount.trim();
  if (
    rate === null ||
    !isQuantity(line.quantity.trim()) ||
    !isMoneyAmount(line.unitPrice.trim()) ||
    !DISCOUNT.test(discount)
  ) {
    return null;
  }
  return lineAmounts(
    {
      quantity: line.quantity.trim(),
      unitPrice: line.unitPrice.trim(),
      discountType: line.discountType,
      discount,
      rate,
    },
    pricesIncludeVat,
  );
}

export interface DocumentTotals {
  discount: string;
  net: string;
  vat: string;
  total: string;
}

// A document's totals are the sums of its lines, each already rounded. Working the VAT out once on
// the whole document could differ by a paisa from the lines, and the lines are what is printed.
export function documentTotals(lines: readonly LineAmounts[]): DocumentTotals {
  return {
    discount: sumMoney(lines.map((line) => line.discount)),
    net: sumMoney(lines.map((line) => line.net)),
    vat: sumMoney(lines.map((line) => line.vat)),
    total: sumMoney(lines.map((line) => line.total)),
  };
}

// What a line says when the person typed no description: the product, and the variant's options
// ("Polo shirt — M, Navy blue"). The API writes it; the form shows it as the box's placeholder.
export function defaultLineDescription(variant: {
  productName: string;
  optionValues: readonly string[];
}): string {
  return variant.optionValues.length === 0
    ? variant.productName
    : `${variant.productName} — ${variant.optionValues.join(', ')}`;
}

// ---------------------------------------------------------------------------------------------
// What a line sends

interface DiscountFields {
  quantity: string;
  unitPrice: string;
  discountType: DiscountType;
  discount: string;
}

// A discount never takes more than the line: not over 100%, not more taka than quantity × price.
// A negative line would be a return, and returns are their own document (15d).
export function salesLineRules<T extends DiscountFields>(line: T, ctx: z.RefinementCtx<T>): void {
  // The boxes are checked by their own schemas; with a bad one there is nothing to compare yet
  if (!isQuantity(line.quantity) || !isMoneyAmount(line.unitPrice)) return;
  const limit =
    line.discountType === 'percent' ? '100' : multiplyMoney(line.quantity, line.unitPrice);
  if (compareMoney(line.discount, limit) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['discount'],
      message: errorCode('sales_discount_too_large'),
    });
  }
}

export const salesLineFieldsSchema = z.object({
  variantId: z.uuid(errorCode('stock_variant_required')),
  // The base unit or one of the product's packs; the quantity and the price are per this unit
  unitId: z.uuid(errorCode('stock_unit_invalid')),
  quantity: quantitySchema,
  // What the line says on the document. null = the product's name with its variant's options
  // ("Polo shirt — M, Navy blue"); a garments merchandiser types "220 GSM pique, buyer's label".
  description: optionalText(300),
  // Per one of the unit, as the workspace types prices (with or without VAT)
  unitPrice: requiredPriceSchema,
  discountType: z.enum(DISCOUNT_TYPES),
  discount: discountSchema,
  taxRateId: z.uuid(errorCode('tax_rate_invalid')),
});

export const salesLineInputSchema = salesLineFieldsSchema.superRefine(salesLineRules);
export type SalesLineInput = z.infer<typeof salesLineInputSchema>;
export type SalesLineFormValues = z.input<typeof salesLineInputSchema>;

// The fields every sales document has. The customer must be an active one when the document is
// written; an existing document keeps its customer even if the customer is archived later.
export const salesDocumentFieldsSchema = z.object({
  customerId: z.uuid(errorCode('sales_customer_required')),
  date: z.iso.date(errorCode('sales_date_required')),
  note: optionalText(500),
  lines: z
    .array(salesLineInputSchema)
    .min(1, errorCode('sales_lines_required'))
    .max(MAX_SALES_LINES),
});

// ---------------------------------------------------------------------------------------------
// What the API sends

// The VAT rate a line used, copied onto the line when it was saved (a snapshot). When the NBR
// changes a rate, only new documents get the new one.
export const taxRateRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.string(),
  rate: z.string(),
});
export type TaxRateRef = z.infer<typeof taxRateRefSchema>;

// Another document this one came from or led to. number is null while that one is a draft.
export const documentRefSchema = z.object({ id: z.uuid(), number: z.string().nullable() });
export type DocumentRef = z.infer<typeof documentRefSchema>;

// A line as the API sends it: the variant now (its name, packs and tracking, for the form), and
// what the line itself keeps (its description, price, discount and VAT rate as they were saved)
export const salesLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  // 'goods' or 'service' (products.ts → PRODUCT_TYPES). A service line (a delivery charge, an
  // embroidery charge) is sold but never delivered: the order page and the delivery form skip it.
  // z.string(), like the product's own type: a newer server's new type must not break an older
  // offline client.
  productType: z.string(),
  tracking: z.string(),
  hasExpiry: z.boolean(),
  units: z.array(stockUnitSchema),
  unitId: z.uuid(),
  quantity: z.string(),
  // The quantity in the base unit: what a delivery counts against
  baseQuantity: z.string(),
  description: z.string(),
  unitPrice: z.string(),
  discountType: z.enum(DISCOUNT_TYPES),
  discount: z.string(),
  taxRate: taxRateRefSchema,
  // lineAmounts() at the time it was saved
  net: z.string(),
  vat: z.string(),
  total: z.string(),
});
export type SalesLine = z.infer<typeof salesLineSchema>;

// ---------------------------------------------------------------------------------------------
// The price a line starts with

// price_list: the customer's price list has this variant in this unit. product: the variant's own
// sale price (per base unit) × the unit's factor.
export const PRICE_SOURCES = ['price_list', 'product'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const priceLookupInputSchema = z.object({
  // null = no customer chosen yet: the products' own prices
  customerId: z.uuid().nullable(),
  items: z
    .array(z.object({ variantId: z.uuid(), unitId: z.uuid() }))
    .min(1)
    .max(MAX_SALES_LINES),
});
export type PriceLookupInput = z.infer<typeof priceLookupInputSchema>;

export const priceLookupItemSchema = z.object({
  variantId: z.uuid(),
  unitId: z.uuid(),
  // Per one of the unit. null = no price anywhere: the person types it (a garments buyer's PO is
  // priced by hand)
  price: z.string().nullable(),
  source: z.enum(PRICE_SOURCES).nullable(),
  // The product's own active rate, or the workspace's default
  taxRateId: z.uuid(),
});
export type PriceLookupItem = z.infer<typeof priceLookupItemSchema>;

export const priceLookupSchema = z.object({
  // The workspace setting now: a new document copies it
  pricesIncludeVat: z.boolean(),
  // An item that is not a variant and unit of this workspace is left out
  items: z.array(priceLookupItemSchema),
});
export type PriceLookup = z.infer<typeof priceLookupSchema>;

// Reading prices needs no permission, like the price lists. POST, not GET: a form asks for up to
// 300 items at once, and that does not fit a URL.
export const salesPriceRoutes = {
  lookup: defineRoute({
    method: 'POST',
    path: '/sales/price-lookup',
    summary: 'The price and VAT rate new sales lines start with, for one customer',
    auth: 'bearer',
    status: 200,
    body: priceLookupInputSchema,
    response: priceLookupSchema,
  }),
};
