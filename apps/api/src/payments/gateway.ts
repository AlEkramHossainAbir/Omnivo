import {
  multiplyMoney,
  type PaymentGatewayMode,
  type PaymentGatewayProvider,
  type PaymentGatewayTestProblem,
} from '@omnivo/contracts';

// Step 27d: what the API needs from a payment gateway, with nothing about shops in it (decision
// 10): step 24's subscription billing opens pages and asks about payments the same way. The shop's
// code (storefront/orders/shop-payments.service.ts) decides what an answer means for an order;
// this layer only talks to the gateway and says what it answered.

// The account a call is made with: the tenant's own store, opened from its sealed row
// (storefront/gateway-accounts.ts). The password lives in memory only for the call
export interface GatewayAccount {
  provider: PaymentGatewayProvider;
  mode: PaymentGatewayMode;
  storeId: string;
  password: string;
}

// One payment page. The amount is in taka (BDT), a decimal string; the addresses are where the
// gateway sends the shopper's browser back (success, fail and cancel all go to returnUrl) and where
// its own server posts the outcome (noticeUrl, SSLCommerz's IPN)
export interface PaymentPageRequest {
  tranId: string;
  amount: string;
  returnUrl: string;
  noticeUrl: string;
  customer: { name: string; phone: string; address: string; area: string };
  // What the payment is for, in the gateway's own report: "Order from Nirvor Pharmacy"
  description: string;
  items: number;
}

// rejected: the gateway answered and refused (the store id or password is wrong, the store is
// inactive). unreachable: no answer in time, or one that is not the gateway's
export type GatewayProblem = PaymentGatewayTestProblem;

export type PaymentPage = { ok: true; url: string } | { ok: false; problem: GatewayProblem };

// What the gateway says about one payment, asked by its validation id or by our transaction id:
// - paid: the money arrived. Every field from the gateway's own answer; the caller still checks
//   the transaction id, the amount and the currency against the try (decision 2)
// - failed / cancelled: the bank refused it, or the shopper pressed Cancel
// - pending: the gateway is still processing it; ask again later
// - none: the gateway knows no payment for it (never paid, expired, or never opened)
// - problem: the gateway could not be asked (GatewayProblem)
export type GatewayAnswer =
  | {
      kind: 'paid';
      tranId: string;
      valId: string;
      amount: string;
      currency: string;
      storeAmount: string;
      cardType: string | null;
      bankTranId: string | null;
    }
  | { kind: 'failed' | 'cancelled' | 'pending' | 'none' }
  | { kind: 'problem'; problem: GatewayProblem };

export interface PaymentGateway {
  openPage(account: GatewayAccount, request: PaymentPageRequest): Promise<PaymentPage>;
  // By the val_id the gateway gave the shopper's browser (and its IPN): the paid case
  validate(account: GatewayAccount, valId: string): Promise<GatewayAnswer>;
  // By our own transaction id: a failed or cancelled try (no val_id), a shopper who came back
  // with the Back button, and the sweep's last look before it deletes an order
  find(account: GatewayAccount, tranId: string): Promise<GatewayAnswer>;
  // "Test connection": null when the gateway accepts the account
  test(account: GatewayAccount): Promise<GatewayProblem | null>;
}

// A gateway's amount as our money string, to the paisa. Gateways send "578.00", 578 or "563.5500";
// a value with more than 4 decimals is cut to 4 first (anything under a paisa is noise), then
// rounded to the paisa like every amount the books post (27d.2's storefront_payments_amounts_check).
// null for anything that is not a plain positive amount
export function paisaOf(value: string | number): string | null {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(text);
  if (match?.[1] === undefined) return null;
  const fraction = (match[2] ?? '').slice(0, 4);
  return multiplyMoney('1', fraction === '' ? match[1] : `${match[1]}.${fraction}`);
}

// A gateway's word for a column of ours: trimmed, null when empty, and cut to the column's 100
// characters (storefront_payments_text_check), so a long card name never leaves a payment
// unrecorded
export function gatewayText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text === '' ? null : text.slice(0, 100);
}
