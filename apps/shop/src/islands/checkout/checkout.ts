import {
  errorCode,
  shopCartQuoteRequestSchema,
  shopOrderRequestSchema,
  subtractMoney,
  type Problem,
  type ShopCartQuote,
  type ShopCartQuoteRequest,
  type ShopDiscount,
  type ShopOrderRequestInput,
} from '@omnivo/contracts';
import { z } from 'zod';

import type { CartLine } from '../../lib/cart';
import type { CheckoutErrorCode, CheckoutWords } from './words';

// Step 26c: the checkout island's plain logic, out of the components so vitest can test it
// without a browser. Zod and the contracts are allowed here: this file is part of the checkout's
// own chunk, which only /checkout loads (decision 1, src/boundaries.spec.ts).

// The form's fields. The same rules as the order request (one schema, so a name the form accepts
// is never refused by the server), with two changes for a form that starts empty:
// - zoneId: no radio is picked at first, so the value is '' until one is. An empty zone says
//   "Pick a delivery location", not the generic "too short" that min(1) would give
// - termsAccepted: a checkbox is true or false. The request's z.literal(true) would make the
//   form's starting value `false` a type error; the button stays disabled until it is ticked,
//   and the request is only built when it is (orderRequest below)
export const checkoutFormSchema = z.object({
  name: shopOrderRequestSchema.shape.name,
  phone: shopOrderRequestSchema.shape.phone,
  address: shopOrderRequestSchema.shape.address,
  zoneId: z.string().min(1, errorCode('shop_zone_unknown')),
  paymentMethod: shopOrderRequestSchema.shape.paymentMethod,
  termsAccepted: z.boolean(),
});

// What the inputs hold (the phone as typed) and what a valid form gives (the phone made plain)
export type CheckoutFormInput = z.input<typeof checkoutFormSchema>;
export type CheckoutFormValues = z.output<typeof checkoutFormSchema>;
export type CheckoutField = keyof CheckoutFormInput;

const FIELDS = new Set<string>(Object.keys(checkoutFormSchema.shape));

function isField(name: string): name is CheckoutField {
  return FIELDS.has(name);
}

// Puts the browser's values into a word the server translated with its placeholders kept
// ("One less {{name}}" → "One less Neem Face Wash")
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

function hasWords(words: CheckoutWords, code: string): code is CheckoutErrorCode {
  // hasOwn, not `in`: 'toString' is in every object
  return Object.hasOwn(words.errors, code);
}

// The sentence for an error code. A code the page has no sentence for (a newer server) falls back
// to "Enter a valid value", never to the code itself
export function errorText(
  words: CheckoutWords,
  code: string,
  values: Record<string, string> = {},
): string {
  return fill(hasWords(words, code) ? words.errors[code] : words.errors.invalid_value, values);
}

// The promo box's text, checked with the quote request's own rule (trimmed, upper case, letters,
// digits and dashes). `unwrap()` takes the rule out of its optional(). null: the box is empty, so
// Apply does nothing
const couponCodeSchema = shopCartQuoteRequestSchema.shape.couponCode.unwrap();

export function parseCouponCode(
  text: string,
): { ok: true; code: string } | { ok: false; error: 'shop_coupon_format' } | null {
  if (text.trim() === '') return null;
  const parsed = couponCodeSchema.safeParse(text);
  return parsed.success
    ? { ok: true, code: parsed.data }
    : { ok: false, error: 'shop_coupon_format' };
}

// "10%" or "৳50", the same way the discount ribbon writes them (ListingMarks.astro)
export function discountText(discount: ShopDiscount, money: (value: string) => string): string {
  return discount.kind === 'amount' ? money(discount.value) : `${String(discount.value)}%`;
}

// A quote request as a string: the quote on screen answers the request with the same key. Lines
// in the cart's order, the zone and the code exactly as sent
export function quoteKey(request: ShopCartQuoteRequest): string {
  return JSON.stringify([request.lines, request.zoneId ?? null, request.couponCode ?? null]);
}

// The quote request for the cart, the picked zone ('' = none yet) and the applied code. The keys
// are left out when there is no value (exactOptionalPropertyTypes): the route reads a missing
// zone as "no zone", and an empty string would fail its schema
export function quoteRequest(
  lines: CartLine[],
  zoneId: string,
  couponCode: string | undefined,
): ShopCartQuoteRequest {
  return {
    lines,
    ...(zoneId === '' ? {} : { zoneId }),
    ...(couponCode === undefined ? {} : { couponCode }),
  };
}

// After "A price or the stock changed" (decision 10): the lines whose price is not the one the
// shopper saw, with the old price, so each can say "Was ৳229". A line that went out of stock says
// so on its own; a line that came back in stock had no price before, so it is not "changed"
export function changedPrices(before: ShopCartQuote, after: ShopCartQuote): Map<string, string> {
  const old = new Map(
    before.lines.flatMap((line) =>
      line.status === 'available' ? [[line.listingId, line.unitPrice] as const] : [],
    ),
  );
  const changed = new Map<string, string>();
  for (const line of after.lines) {
    if (line.status !== 'available') continue;
    const was = old.get(line.listingId);
    if (was !== undefined && was !== line.unitPrice) changed.set(line.listingId, was);
  }
  return changed;
}

// "Add ৳60 more": the minimum less the items. Shown only, never sent: the server decides with its
// own numbers (belowMinimum in the quote), the browser only says by how much
export function shortBy(minimum: string, subtotal: string): string {
  return subtractMoney(minimum, subtotal);
}

// The order request: the form's checked values, the same lines, zone and code as the quote on
// screen, and that quote's total as the total the shopper saw. null while the box is not ticked:
// the request type needs `true` there, and the button is disabled then anyway
export function orderRequest(
  values: CheckoutFormValues,
  lines: CartLine[],
  couponCode: string | undefined,
  quote: ShopCartQuote,
): ShopOrderRequestInput | null {
  if (!values.termsAccepted) return null;
  return {
    lines,
    zoneId: values.zoneId,
    ...(couponCode === undefined ? {} : { couponCode }),
    name: values.name,
    phone: values.phone,
    address: values.address,
    paymentMethod: values.paymentMethod,
    termsAccepted: values.termsAccepted,
    expectedTotal: quote.total,
  };
}

// Where a refusal of Confirm Order is shown. A field's own error goes under the field; the rest
// is one line above the button. 400 invalid_input names its fields (fieldErrors, "phone"); the
// order route's refusals name none, but two of them are about one field. A list of pairs, not a
// record, so the form can hand each field to setError() without a cast
export function refusalErrors(problem: Problem): {
  fields: { field: CheckoutField; code: string }[];
  general: string | null;
} {
  const fields: { field: CheckoutField; code: string }[] = [];
  let general: string | null = null;
  for (const [name, codes] of Object.entries(problem.fieldErrors ?? {})) {
    const code = codes[0];
    if (code === undefined) continue;
    if (isField(name)) fields.push({ field: name, code });
    // A line's error ("lines.2.quantity"): the stored cart is not what the server takes. Its own
    // code ("Enter a smaller number") would point at a box the page does not have
    else general ??= 'invalid_input';
  }
  if (problem.code === 'shop_zone_unknown' || problem.code === 'shop_payment_unavailable') {
    fields.push({
      field: problem.code === 'shop_zone_unknown' ? 'zoneId' : 'paymentMethod',
      code: problem.code,
    });
  } else if (problem.code !== 'invalid_input') {
    general = problem.code;
  } else if (fields.length === 0) {
    // invalid_input that names no field of the form: say what it is once
    general ??= 'invalid_input';
  }
  return { fields, general };
}

// A Bangla keyboard types ০–৯; the cart keeps ASCII numbers (the same rule as the cart drawer)
export function parseQuantity(text: string): number | undefined {
  const ascii = text.trim().replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6));
  return /^\d+$/.test(ascii) ? Number(ascii) : undefined;
}
