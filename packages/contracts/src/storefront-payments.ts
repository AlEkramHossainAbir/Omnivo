import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// Step 27d: the shop's own payment gateway account, as the ERP's Shop settings → Payment card reads
// and saves it. The money goes straight to the tenant's SSLCommerz account (system design §14:
// Omnivo keeps the keys and makes the calls, never the money). The password is saved encrypted
// (CREDENTIALS_KEY, decision 4) and never comes back: the card shows that one is saved, and an
// empty box keeps it.

// The gateways the shop can use. One now; a second (bKash's own API) adds a value here and a class
// in the API, and the rest of the shop only knows `online`
export const PAYMENT_GATEWAY_PROVIDERS = ['sslcommerz'] as const;

// SSLCommerz gives every merchant a sandbox store (test cards, no real money) and, after its own
// checks, a live one. Each has its own store id and password, and its own address
export const PAYMENT_GATEWAY_MODES = ['sandbox', 'live'] as const;

// "Test connection" asks the gateway something harmless with the saved account (SSLCommerz's
// transaction query). Its answers:
// - rejected: the gateway answered and refused the store id or the password, or the store is not
//   active (a sandbox store id in live mode is refused the same way)
// - unreachable: no answer in time, or one that is not the gateway's
export const PAYMENT_GATEWAY_TEST_PROBLEMS = ['rejected', 'unreachable'] as const;

// Step 27d.3: the three lists as types, for the API's gateway code (payments/gateway.ts)
export type PaymentGatewayProvider = (typeof PAYMENT_GATEWAY_PROVIDERS)[number];
export type PaymentGatewayMode = (typeof PAYMENT_GATEWAY_MODES)[number];
export type PaymentGatewayTestProblem = (typeof PAYMENT_GATEWAY_TEST_PROBLEMS)[number];

// SSLCommerz's store ids are letters and digits ("nirvo67412bc0d9f1e"); the dash and underscore
// cover other gateways' ids. Trimmed: a store id copied from an email often brings a space. The
// pattern takes an empty box (`*`), because Zod runs every check: with `+` an empty box would say
// "required" and "letters and digits" at once
const storeIdSchema = z
  .string()
  .trim()
  .min(1, errorCode('required'))
  .max(64, errorCode('too_long'))
  .regex(/^[A-Za-z0-9_-]*$/, errorCode('storefront_gateway_store_id_format'));

// Not trimmed: a space at the end may be part of a password, and changing what was pasted would
// save a password that never works. 128 is far more than SSLCommerz's own
const passwordSchema = z.string().max(128, errorCode('too_long'));

const gatewayFieldsSchema = z.object({
  storeId: storeIdSchema,
  mode: z.enum(PAYMENT_GATEWAY_MODES),
  // Where a paid order's money receipt goes: an account that holds money ("SSLCommerz merchant
  // balance", under the bank accounts), because SSLCommerz pays the tenant's bank later in one
  // transfer. The select's "Pick an account" sends '', which is this error. Whether it holds money,
  // the API checks (moneyAccountIds), as for any money receipt
  moneyAccountId: z.uuid(errorCode('storefront_gateway_money_account_invalid')),
  // SSLCommerz keeps its fee from each payment (store_amount is what it pays out). The fee is
  // posted to this expense account (decision 6: Dr fee, Cr the money account), so the money
  // account's balance is what SSLCommerz really owes
  feeAccountId: z.uuid(errorCode('storefront_gateway_fee_account_invalid')),
});

// The first save needs a password; a later one keeps the saved password when the box is empty.
// Two schemas, as for the shop's settings: the first save has no version, a later one must
export const createStorefrontPaymentGatewayInputSchema = gatewayFieldsSchema.extend({
  password: passwordSchema.min(1, errorCode('storefront_gateway_password_required')),
});
export const updateStorefrontPaymentGatewayInputSchema = gatewayFieldsSchema.extend({
  password: passwordSchema,
  version: versionSchema,
});

export type CreateStorefrontPaymentGatewayInput = z.infer<
  typeof createStorefrontPaymentGatewayInputSchema
>;
export type UpdateStorefrontPaymentGatewayInput = z.infer<
  typeof updateStorefrontPaymentGatewayInputSchema
>;
export type StorefrontPaymentGatewayFormValues = z.input<
  typeof updateStorefrontPaymentGatewayInputSchema
>;

export const storefrontPaymentGatewaySchema = z.object({
  provider: z.enum(PAYMENT_GATEWAY_PROVIDERS),
  storeId: z.string(),
  mode: z.enum(PAYMENT_GATEWAY_MODES),
  moneyAccountId: z.uuid(),
  feeAccountId: z.uuid(),
  // Both accounts still fit: the money account is active and holds money, the fee account is an
  // active expense account. Archiving one later makes this false, and then "Pay online" cannot be
  // ticked (storefront_online_not_ready) and the checkout stops offering it
  ready: z.boolean(),
  // The last "Test connection": when, and what went wrong (null: it worked). null: never tested.
  // Saving new values clears it, because it said something about the old ones
  lastTest: z
    .object({
      at: z.iso.datetime(),
      problem: z.enum(PAYMENT_GATEWAY_TEST_PROBLEMS).nullable(),
    })
    .nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontPaymentGateway = z.infer<typeof storefrontPaymentGatewaySchema>;

// An account the selects offer, "1150 · SSLCommerz merchant balance"
const accountChoiceSchema = z.object({ id: z.uuid(), code: z.string(), name: z.string() });
export type StorefrontAccountChoice = z.infer<typeof accountChoiceSchema>;

// The Payment card's one read: the saved account (null before the first save) and what the two
// selects offer. The choices come here, not from the accounts list, because storefront.manage does
// not read the chart of accounts (the same reason as 27b's deliveryChoices)
export const storefrontPaymentSetupSchema = z.object({
  gateway: storefrontPaymentGatewaySchema.nullable(),
  moneyAccounts: z.array(accountChoiceSchema),
  feeAccounts: z.array(accountChoiceSchema),
});
export type StorefrontPaymentSetup = z.infer<typeof storefrontPaymentSetupSchema>;

// All four need storefront.manage: whoever sets up the shop sets up where its money goes. There is
// no delete: unticking "Pay online" in the shop's settings stops new online payments, and the saved
// account is what settles the payments that are already on their way
export const storefrontPaymentRoutes = {
  getPaymentGateway: defineRoute({
    method: 'GET',
    path: '/storefront/payment-gateway',
    summary: "The shop's payment gateway account (never its password) and the account choices",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    response: storefrontPaymentSetupSchema,
  }),
  createPaymentGateway: defineRoute({
    method: 'POST',
    path: '/storefront/payment-gateway',
    summary: "Save the shop's payment gateway account the first time",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createStorefrontPaymentGatewayInputSchema,
    response: storefrontPaymentGatewaySchema,
  }),
  updatePaymentGateway: defineRoute({
    method: 'PUT',
    path: '/storefront/payment-gateway',
    summary: "Change the shop's payment gateway account; an empty password keeps the saved one",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    body: updateStorefrontPaymentGatewayInputSchema,
    response: storefrontPaymentGatewaySchema,
  }),
  // No body: it tests what is saved, so the password never travels for a test. The answer is the
  // account with its new lastTest, a 200 whether the test worked or not (a refusal by the gateway
  // is an answer to show, not an error of this call)
  testPaymentGateway: defineRoute({
    method: 'POST',
    path: '/storefront/payment-gateway/test',
    summary: 'Ask the gateway whether it accepts the saved store id and password',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    response: storefrontPaymentGatewaySchema,
  }),
};
