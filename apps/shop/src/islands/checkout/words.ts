import type { ErrorCode, ShopCheckoutSettings, ShopPaymentMethod } from '@omnivo/contracts';

import type { ShopLocale } from '../../lib/locale';

// Step 26c (decision 1): the checkout island's words, translated on the server by the Astro page
// and handed to the island as one prop. The island never imports '@omnivo/i18n': its main entry
// starts i18next with every English word (about 150 KB gz), for a page that shows 50 of them.
// Only this file's types reach the browser (`import type` in the island); its code runs in the
// page's frontmatter.

// A word with a value that only the browser knows (a product's name, the coupon's amount) keeps
// its placeholder: t() puts '{{name}}' back where the name goes, and the island's fill() puts the
// value in. i18next does not read placeholders inside a value again, so they survive as text.
// Written out as objects, like the cart drawer's, because the typed t() checks that the options
// name the word's own placeholders
const NAME = { name: '{{name}}' };
const MINIMUM = { minimum: '{{minimum}}' };

export function checkoutWords({ t, money }: ShopLocale, settings: ShopCheckoutSettings) {
  return {
    heading: t('shop.checkout.heading'),
    name: t('shop.checkout.name'),
    phone: t('shop.checkout.phone'),
    address: t('shop.checkout.address'),
    zone: t('shop.checkout.zone'),
    // Known on the server: the settings are part of the page
    freeDeliveryFrom:
      settings.freeDeliveryFrom === null
        ? null
        : t('shop.checkout.freeDeliveryFrom', { amount: money(settings.freeDeliveryFrom) }),
    items: t('shop.checkout.items'),
    outOfStock: t('shop.checkout.outOfStock'),
    priceChanged: t('shop.checkout.priceChanged', { old: '{{old}}' }),
    deliveryCharge: t('shop.checkout.deliveryCharge'),
    free: t('shop.checkout.free'),
    pickZone: t('shop.checkout.pickZone'),
    discount: t('shop.checkout.discount', { code: '{{code}}' }),
    total: t('shop.checkout.total'),
    promo: t('shop.checkout.promo'),
    promoPlaceholder: t('shop.checkout.promoPlaceholder'),
    apply: t('shop.checkout.apply'),
    applying: t('shop.checkout.applying'),
    removeCoupon: t('shop.checkout.removeCoupon'),
    couponApplied: t('shop.checkout.couponApplied', { code: '{{code}}', off: '{{off}}' }),
    payment: t('shop.checkout.payment'),
    termsBefore: t('shop.checkout.termsBefore'),
    termsLink: t('shop.checkout.termsLink'),
    termsAfter: t('shop.checkout.termsAfter'),
    confirm: t('shop.checkout.confirm'),
    placing: t('shop.checkout.placing'),
    orderFailed: t('shop.checkout.orderFailed'),
    belowMinimum: t('shop.checkout.belowMinimum', { minimum: '{{minimum}}', more: '{{more}}' }),
    emptyTitle: t('shop.checkout.emptyTitle'),
    emptyText: t('shop.checkout.emptyText'),
    // The cart drawer's words, for the same parts on this page
    continueShopping: t('shop.cart.continueShopping'),
    loading: t('shop.cart.loading'),
    failed: t('shop.cart.failed'),
    retry: t('shop.cart.retry'),
    decrease: t('shop.cart.decrease', NAME),
    increase: t('shop.cart.increase', NAME),
    quantity: t('shop.cart.quantity', NAME),
    remove: t('shop.cart.remove', NAME),
    removedOne: t('shop.cart.removed', { count: 1, replace: { count: '{{count}}' } }),
    removedOther: t('shop.cart.removed', { count: 2, replace: { count: '{{count}}' } }),
    // The error codes the checkout can show: the form's own checks, the order route's refusals
    // and the promo box. 18 sentences, not the 400 of `errors.*`. `satisfies`: each key must be
    // a real error code, so a typo is a type error, not a missing sentence
    errors: {
      required: t('errors.required'),
      too_long: t('errors.too_long'),
      invalid_value: t('errors.invalid_value'),
      invalid_input: t('errors.invalid_input'),
      malformed_request: t('errors.malformed_request'),
      internal_error: t('errors.internal_error'),
      shop_phone_format: t('errors.shop_phone_format'),
      shop_address_too_short: t('errors.shop_address_too_short'),
      shop_zone_unknown: t('errors.shop_zone_unknown'),
      shop_payment_unavailable: t('errors.shop_payment_unavailable'),
      shop_terms_required: t('errors.shop_terms_required'),
      shop_cart_empty: t('errors.shop_cart_empty'),
      shop_order_below_minimum: t('errors.shop_order_below_minimum', MINIMUM),
      shop_order_changed: t('errors.shop_order_changed'),
      shop_coupon_format: t('errors.shop_coupon_format'),
      shop_coupon_unknown: t('errors.shop_coupon_unknown'),
      shop_coupon_expired: t('errors.shop_coupon_expired'),
      shop_coupon_minimum: t('errors.shop_coupon_minimum', MINIMUM),
    } satisfies Partial<Record<ErrorCode, string>>,
  };
}

export type CheckoutWords = ReturnType<typeof checkoutWords>;
export type CheckoutErrorCode = keyof CheckoutWords['errors'];

// The radio cards, with their labels worked out on the server: "Inside Dhaka — ৳80"
export interface CheckoutChoice<T extends string = string> {
  id: T;
  label: string;
}

export function checkoutChoices({ t, money }: ShopLocale, settings: ShopCheckoutSettings) {
  return {
    zones: settings.zones.map((zone): CheckoutChoice => ({
      id: zone.id,
      label: t('shop.checkout.zoneOption', { name: zone.name, charge: money(zone.charge) }),
    })),
    payments: settings.paymentMethods.map((method): CheckoutChoice<ShopPaymentMethod> => ({
      id: method,
      label: t(`shop.checkout.${method}`),
    })),
  };
}
