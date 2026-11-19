import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  publicOrderPlacedSchema,
  type ShopOrderRequestInput,
  setupSchema,
  type StorefrontSettings,
  type StorefrontSettingsFormValues,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
import type postgres from 'postgres';
import { expect } from 'vitest';

import { eventually, TEST_SHOP_KEY } from './app.js';
import { bearer, type SignedIn } from './http.js';
import { lastMailTo } from './mailpit.js';
import { addCategory, addListing, createProduct, launchShop, tenantIdOf } from './storefront.js';

// Step 27a: what the order tests share. The order routes are the shop server's (auth: 'shop'), so
// every call here sends the key and a shopper's address, the way apps/shop's server will (27a.5).

// The headers the shop's server sends for one shopper. Each test gives its own address: the
// limits count per address across the whole API (Redis), so two tests must never share one
export function shopHeaders(host: string, client: string): Record<string, string> {
  return { 'x-shop-host': host, 'x-shop-key': TEST_SHOP_KEY, 'x-shop-client-address': client };
}

// A shopper's IPv4 address of its own for each n (10.0.2.89 for 601). A real address, built from
// whole bytes: "203.0.113.601" is not an IP address, so the API would not use it (ShopClient) and
// every such test would count under one address, the test process's own. Not IPv6: the limits
// count a whole /64 as one shopper (addressKey), so 2001:db8::1 and ::2 would be one
export function clientAddress(n: number): string {
  return `10.0.${String(Math.floor(n / 256))}.${String(n % 256)}`;
}

export function shopPost(
  app: NestFastifyApplication,
  url: string,
  headers: Record<string, string>,
  payload: object,
) {
  return app.inject({ method: 'POST', url: `/public/v1${url}`, headers, payload });
}

// A whole order request. Only the cart, the phone and the total change from test to test
export function orderRequest(
  listingId: string,
  quantity: number,
  phone: string,
  expectedTotal: string,
): ShopOrderRequestInput {
  return {
    lines: [{ listingId, quantity }],
    zoneId: 'inside_dhaka',
    name: 'Nusrat Jahan',
    phone,
    address: 'House 12, Road 5, Mirpur 10, Dhaka',
    paymentMethod: 'cod',
    termsAccepted: true,
    expectedTotal,
  };
}

// Places an order that must succeed, and gives back its token (the shop keeps it in a cookie)
export async function placeOrder(
  app: NestFastifyApplication,
  headers: Record<string, string>,
  request: ShopOrderRequestInput,
): Promise<string> {
  const res = await shopPost(app, '/orders', headers, request);
  expect(res.statusCode, res.body).toBe(201);
  return publicOrderPlacedSchema.parse(res.json()).token;
}

// A Bangladeshi mobile number of its own for each n (01711000001, 01711000002, …), so every test
// has phones no other test uses: the phone limit and the SMS inbox are per phone
export function phoneOf(n: number): string {
  return `01711${String(n).padStart(6, '0')}`;
}

// The SMS go to Mailpit as emails to <phone>@sms.invalid (MailSmsSender)
export function smsAddress(phone: string): string {
  return `${phone}@sms.invalid`;
}

// The six digits of the newest code SMS to this phone. `after`: the id of an SMS already read, to
// wait for the next one (a resend) instead of reading the old one again
export async function codeFor(
  mailUrl: string,
  phone: string,
  after?: string,
): Promise<{ code: string; id: string }> {
  return eventually(async () => {
    const sms = await lastMailTo(mailUrl, smsAddress(phone));
    if (after !== undefined) expect(sms.id).not.toBe(after);
    // The code is the first thing in its SMS, in ASCII digits in both languages (shop-sms.ts)
    const code = /^(\d{6}) /.exec(sms.text)?.[1];
    expect(code, sms.text).toBeDefined();
    return { code: code ?? '', id: sms.id };
  });
}

// The tracking token from the confirm SMS: the link's last part
export async function trackingTokenFor(mailUrl: string, phone: string): Promise<string> {
  return eventually(async () => {
    const sms = await lastMailTo(mailUrl, smsAddress(phone));
    const token = /\/t\/([\w-]{22})$/.exec(sms.text.trim())?.[1];
    expect(token, sms.text).toBeDefined();
    return token ?? '';
  });
}

// Any six digits but this one
export function wrongCode(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

export interface OrderShop {
  tenantId: string;
  host: string;
  warehouseId: string;
  // Neem Face Wash at ৳229, with `stock` pieces in the shop's warehouse
  listingId: string;
  productId: string;
  variantId: string;
  // For a test that lists one more product of its own (addShopProduct)
  unitId: string;
  categoryId: string;
}

// A workspace set up as a retail business, with a launched shop at <slug>.localhost (one zone,
// Inside Dhaka at ৳80, minimum order ৳300, free delivery from ৳1,000: launchShop) that lists one
// product with `stock` pieces on hand
export async function orderShop(
  app: NestFastifyApplication,
  sql: postgres.Sql,
  who: SignedIn,
  shop: { slug: string; name: string; stock: number },
): Promise<OrderShop> {
  const auth = { headers: bearer(who.accessToken) };
  const setup = await app.inject({
    method: 'POST',
    url: '/setup',
    payload: { industry: 'retail' },
    ...auth,
  });
  expect(setup.statusCode, setup.body).toBe(200);
  await eventually(async () => {
    const res = await app.inject({ method: 'GET', url: '/setup', ...auth });
    expect(setupSchema.parse(res.json()).status).toBe('ready');
  });
  const warehouses = await app.inject({ method: 'GET', url: '/warehouses', ...auth });
  const warehouseId = warehouseListSchema.parse(warehouses.json()).items[0]?.id ?? '';
  const units = await app.inject({ method: 'GET', url: '/units', ...auth });
  const pcs =
    unitListSchema.parse(units.json()).items.find((unit) => unit.code === 'pcs')?.id ?? '';
  const tenantId = await tenantIdOf(sql, shop.slug);
  await launchShop(sql, { tenantId, subdomain: shop.slug, name: shop.name, warehouseId });
  const face = await addCategory(sql, tenantId, { slug: 'face-wash', name: 'Face wash' });
  const product = await createProduct(app, who, pcs, 'Neem Face Wash', '229');
  const variantId = product.variants[0]?.id ?? '';
  await setStock(sql, { tenantId, warehouseId, productId: product.id, variantId }, shop.stock);
  const listingId = await addListing(sql, tenantId, {
    product,
    categoryId: face,
    slug: 'neem-face-wash',
    publishedDaysAgo: 1,
  });
  return {
    tenantId,
    host: `${shop.slug}.localhost:4331`,
    warehouseId,
    listingId,
    productId: product.id,
    variantId,
    unitId: pcs,
    categoryId: face,
  };
}

// One more listed product with `stock` pieces, for a test that must know every hold on it: the
// shop's first product is held by every other test's orders
export async function addShopProduct(
  app: NestFastifyApplication,
  sql: postgres.Sql,
  who: SignedIn,
  shop: OrderShop,
  product: { name: string; slug: string; price: string; stock: number },
): Promise<{ listingId: string; productId: string; variantId: string }> {
  const made = await createProduct(app, who, shop.unitId, product.name, product.price);
  const variantId = made.variants[0]?.id ?? '';
  await setStock(
    sql,
    { tenantId: shop.tenantId, warehouseId: shop.warehouseId, productId: made.id, variantId },
    product.stock,
  );
  const listingId = await addListing(sql, shop.tenantId, {
    product: made,
    categoryId: shop.categoryId,
    slug: product.slug,
    publishedDaysAgo: 1,
  });
  return { listingId, productId: made.id, variantId };
}

// The pieces on hand, straight in stock_balances: the shop only reads them, and the tests need a
// known number without a goods receipt. A product without batches has one row per warehouse
// (batch_id NULL; the key treats NULLs as equal), so a second call changes that row
export async function setStock(
  sql: postgres.Sql,
  at: { tenantId: string; warehouseId: string; productId: string; variantId: string },
  quantity: number,
): Promise<void> {
  await sql`
    INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, quantity)
    VALUES (${at.tenantId}, ${at.warehouseId}, ${at.productId}, ${at.variantId}, ${quantity})
    ON CONFLICT ON CONSTRAINT stock_balances_key DO UPDATE SET quantity = EXCLUDED.quantity`;
}

// Step 27b: what the Shop settings form sends for a shop as it is saved, with only the delivery
// charge's service changed ('' = "Made on the first order"). A zone keeps its id when the id is one
// the form could send: the one launchShop writes (inside_dhaka) has an underscore, which the form's
// rule refuses, so it goes as a new zone and the save gives it an id of its own. Read the zone's id
// again after a save that went through
export function deliveryServiceUpdate(
  shop: StorefrontSettings,
  deliveryVariantId: string,
): StorefrontSettingsFormValues {
  return {
    subdomain: shop.subdomain,
    name: shop.name,
    language: shop.language,
    hotline: shop.hotline,
    address: shop.address,
    facebookUrl: shop.facebookUrl ?? '',
    instagramUrl: shop.instagramUrl ?? '',
    xUrl: shop.xUrl ?? '',
    linkedinUrl: shop.linkedinUrl ?? '',
    defaultWarehouseId: shop.defaultWarehouseId ?? '',
    deliveryZones: shop.deliveryZones.map((zone) => ({
      ...zone,
      id: /^[a-z0-9-]{1,32}$/.test(zone.id) ? zone.id : null,
    })),
    freeDeliveryFrom: shop.freeDeliveryFrom ?? '',
    minimumOrder: shop.minimumOrder ?? '',
    paymentMethods: shop.paymentMethods,
    deliveryVariantId,
    version: shop.version,
  };
}
