import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { shopPaymentUrlSchema } from '@omnivo/contracts';
import { z } from 'zod';

import {
  type GatewayAccount,
  type GatewayAnswer,
  gatewayText,
  type GatewayProblem,
  paisaOf,
  type PaymentGateway,
  type PaymentPage,
  type PaymentPageRequest,
} from './gateway.js';

// Step 27d: SSLCommerz's API v4 (developer.sslcommerz.com/doc/v4). Checked against its documented
// requests and answers only: there was no sandbox store to try it on (the guide says so). Three
// calls: the session (a payment page), the validation by val_id, and the transaction query by
// tran_id, which "Test connection" uses too.

const ADDRESSES = {
  sandbox: 'https://sandbox.sslcommerz.com',
  live: 'https://securepay.sslcommerz.com',
} as const;

// Long enough for SSLCommerz on a slow day, short enough that the shopper's Confirm Order does not
// hang: after this the page did not open, and the shop offers "Try again"
const TIMEOUT_MS = 10_000;

// SSLCommerz's answers carry many more fields; only these are read, and everything else is left
// alone (zod objects drop unknown keys). Amounts come as strings, sometimes as numbers
const amountSchema = z.union([z.string(), z.number()]);
const textSchema = z.string().nullish();

const sessionSchema = z.object({
  status: z.string(),
  failedreason: textSchema,
  GatewayPageURL: textSchema,
});

const paymentSchema = z.object({
  status: z.string(),
  tran_id: textSchema,
  val_id: textSchema,
  amount: amountSchema.nullish(),
  currency: textSchema,
  store_amount: amountSchema.nullish(),
  card_type: textSchema,
  bank_tran_id: textSchema,
});
type SslPayment = z.infer<typeof paymentSchema>;

const querySchema = z.object({
  APIConnect: z.string(),
  element: z.array(paymentSchema).nullish(),
});

// "578.0000" as "578.00". The try's amount is to the paisa already (27d.2's amounts check), so
// this only drops the two zeros Postgres adds; a string all the way, never a JavaScript number
function twoDecimals(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

// VALID: paid, first look. VALIDATED: paid, and asked about before (the return and the IPN both
// ask, so the second one sees this). Both are money that arrived
const PAID = new Set(['VALID', 'VALIDATED']);

// A paid payment as our answer, or a problem when a field is missing or not an amount: an answer
// that says "VALID" without its amount is not one the API can check, so it records nothing
function paidOf(payment: SslPayment): GatewayAnswer {
  const amount = payment.amount == null ? null : paisaOf(payment.amount);
  const storeAmount = payment.store_amount == null ? null : paisaOf(payment.store_amount);
  if (
    payment.tran_id == null ||
    payment.val_id == null ||
    payment.currency == null ||
    amount === null ||
    storeAmount === null
  ) {
    return { kind: 'problem', problem: 'unreachable' };
  }
  return {
    kind: 'paid',
    tranId: payment.tran_id,
    valId: payment.val_id,
    amount,
    currency: payment.currency.toUpperCase(),
    storeAmount,
    cardType: gatewayText(payment.card_type),
    bankTranId: gatewayText(payment.bank_tran_id),
  };
}

export class SslcommerzGateway implements PaymentGateway {
  private readonly logger = new Logger(SslcommerzGateway.name);

  // fetch is a parameter so the unit test can answer for SSLCommerz
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async openPage(account: GatewayAccount, request: PaymentPageRequest): Promise<PaymentPage> {
    const form = new URLSearchParams({
      store_id: account.storeId,
      store_passwd: account.password,
      total_amount: twoDecimals(request.amount),
      currency: 'BDT',
      tran_id: request.tranId,
      // Success, fail and cancel all come back to one path: what happened is asked of SSLCommerz,
      // never read from which address it posted to (27d.1's shopGatewayPostSchema)
      success_url: request.returnUrl,
      fail_url: request.returnUrl,
      cancel_url: request.returnUrl,
      ipn_url: request.noticeUrl,
      cus_name: request.customer.name.slice(0, 50),
      // SSLCommerz requires an email, and the shop asks for none (a phone is enough to deliver).
      // A reserved .invalid address (RFC 2606) can never receive mail, so no stranger gets the
      // shopper's receipt (mine)
      cus_email: 'shopper@omnivo.invalid',
      cus_phone: request.customer.phone,
      cus_add1: request.customer.address.replace(/\s+/g, ' ').slice(0, 50),
      // The delivery zone stands in for the city; the shop has no postcode, and SSLCommerz wants
      // the field, so it gets Dhaka's GPO code as a placeholder (mine)
      cus_city: request.customer.area.slice(0, 50),
      cus_postcode: '1000',
      cus_country: 'Bangladesh',
      // The shop delivers by itself (or by its courier, step 28), not through SSLCommerz, so no
      // ship_* fields are needed
      shipping_method: 'NO',
      num_of_item: String(request.items),
      product_name: request.description.slice(0, 255),
      product_category: 'General',
      product_profile: 'general',
    });
    const answer = await this.call(`${ADDRESSES[account.mode]}/gwprocess/v4/api.php`, {
      method: 'POST',
      body: form,
    });
    if (answer === null) return { ok: false, problem: 'unreachable' };
    const session = sessionSchema.safeParse(answer);
    if (!session.success) return { ok: false, problem: 'unreachable' };
    // A page only from SSLCommerz's own https address: the shop puts it in `location`
    const url = shopPaymentUrlSchema.safeParse(session.data.GatewayPageURL);
    if (session.data.status.toUpperCase() === 'SUCCESS' && url.success) {
      return { ok: true, url: url.data };
    }
    // The reason is SSLCommerz's own words ("Store Credential Error Or Store is De-active"),
    // logged for whoever reads the logs; the shop only says the page did not open
    this.logger.warn(`SSLCommerz refused a session: ${session.data.failedreason ?? 'no reason'}`);
    return { ok: false, problem: 'rejected' };
  }

  async validate(account: GatewayAccount, valId: string): Promise<GatewayAnswer> {
    const answer = await this.call(
      this.query(account, '/validator/api/validationserverAPI.php', { val_id: valId }),
    );
    if (answer === null) return { kind: 'problem', problem: 'unreachable' };
    const payment = paymentSchema.safeParse(answer);
    if (!payment.success) return { kind: 'problem', problem: 'unreachable' };
    if (PAID.has(payment.data.status.toUpperCase())) return paidOf(payment.data);
    // INVALID_TRANSACTION: no payment under this val_id. The caller asks by tran_id next, which
    // says whether the try failed, was cancelled or was never paid
    return { kind: 'none' };
  }

  async find(account: GatewayAccount, tranId: string): Promise<GatewayAnswer> {
    const answer = await this.transactions(account, tranId);
    if (answer.kind === 'problem') return answer;
    const statuses = answer.payments.map((payment) => payment.status.toUpperCase());
    // One tran_id can have several attempts on SSLCommerz's side (the shopper tried a card, then
    // bKash). Any paid one is the answer: money that arrived is never left unrecorded (decision 5)
    const paid = answer.payments.find((payment) => PAID.has(payment.status.toUpperCase()));
    if (paid !== undefined) return paidOf(paid);
    if (statuses.includes('PENDING')) return { kind: 'pending' };
    if (statuses.includes('FAILED')) return { kind: 'failed' };
    if (statuses.includes('CANCELLED')) return { kind: 'cancelled' };
    // None found, or only EXPIRED / UNATTEMPTED: the page was opened and nothing was paid
    return { kind: 'none' };
  }

  // A transaction query for an id that cannot exist: SSLCommerz answers APIConnect DONE with
  // nothing found when it accepts the store, and FAILED (or INACTIVE) when it does not. Nothing
  // is paid or changed by it
  async test(account: GatewayAccount): Promise<GatewayProblem | null> {
    const answer = await this.transactions(
      account,
      `TEST${randomBytes(8).toString('hex').toUpperCase()}`,
    );
    return answer.kind === 'problem' ? answer.problem : null;
  }

  private async transactions(
    account: GatewayAccount,
    tranId: string,
  ): Promise<
    { kind: 'found'; payments: SslPayment[] } | { kind: 'problem'; problem: GatewayProblem }
  > {
    const answer = await this.call(
      this.query(account, '/validator/api/merchantTransIDvalidationAPI.php', { tran_id: tranId }),
    );
    if (answer === null) return { kind: 'problem', problem: 'unreachable' };
    const query = querySchema.safeParse(answer);
    if (!query.success) return { kind: 'problem', problem: 'unreachable' };
    // DONE: the store was accepted. INVALID_REQUEST, FAILED (wrong store id or password) and
    // INACTIVE: refused
    if (query.data.APIConnect.toUpperCase() !== 'DONE')
      return { kind: 'problem', problem: 'rejected' };
    return { kind: 'found', payments: query.data.element ?? [] };
  }

  // SSLCommerz's two validator APIs take the store's password in the address (its own design).
  // The address is therefore never logged, here or by the error below
  private query(account: GatewayAccount, path: string, params: Record<string, string>): string {
    const search = new URLSearchParams({
      ...params,
      store_id: account.storeId,
      store_passwd: account.password,
      v: '1',
      format: 'json',
    });
    return `${ADDRESSES[account.mode]}${path}?${search.toString()}`;
  }

  // The answer's JSON, or null when there is none to read: no connection, a timeout, an HTTP
  // error, or a body that is not JSON (a proxy's error page). Never throws
  private async call(url: string, init: RequestInit = {}): Promise<unknown> {
    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        this.logger.warn(`SSLCommerz answered HTTP ${String(response.status)}`);
        return null;
      }
      const body: unknown = await response.json();
      return body;
    } catch (error) {
      this.logger.warn(
        `SSLCommerz did not answer: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return null;
    }
  }
}
