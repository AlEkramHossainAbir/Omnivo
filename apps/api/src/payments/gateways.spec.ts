import { fakeValId, SHOP_FAKE_GATEWAY_PATH } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { FakeGateway } from './fake-gateway.js';
import { type GatewayAccount, paisaOf, type PaymentPageRequest } from './gateway.js';
import { SslcommerzGateway } from './sslcommerz-gateway.js';

const TRAN = 'K7Q2M4X9B1C3D5E6F8G0';
const ACCOUNT: GatewayAccount = {
  provider: 'sslcommerz',
  mode: 'sandbox',
  storeId: 'nirvo67412bc0d9f1e',
  password: 'nirvo67412bc0d9f1e@ssl',
};
const REQUEST: PaymentPageRequest = {
  tranId: TRAN,
  amount: '578.0000',
  returnUrl: 'http://nirvor.localhost:4321/checkout/pay/return',
  noticeUrl: 'http://nirvor.localhost:4321/api/payments/notice',
  customer: {
    name: 'Sadia Rahman',
    phone: '01786120356',
    address: 'House 12\nRoad 4',
    area: 'Inside Dhaka',
  },
  description: 'Order from Nirvor Pharmacy',
  items: 3,
};

// A fetch that answers one JSON body and remembers what it was asked
function answering(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    // The gateway passes a plain string address; the other two forms are fetch's own type
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetchFn };
}

describe('gateway amounts (step 27d.3)', () => {
  it('reads a gateway amount to the paisa, and nothing that is not one', () => {
    expect(paisaOf('578.00')).toBe('578.0000');
    expect(paisaOf(578)).toBe('578.0000');
    expect(paisaOf('563.555')).toBe('563.5600');
    expect(paisaOf('563.554999')).toBe('563.5500');
    expect(paisaOf('-1')).toBeNull();
    expect(paisaOf('1,000')).toBeNull();
    expect(paisaOf('')).toBeNull();
  });
});

describe('SSLCommerz gateway (step 27d.3)', () => {
  it('opens a session with every return on one path and the amount with 2 decimals', async () => {
    const { calls, fetchFn } = answering({
      status: 'SUCCESS',
      GatewayPageURL: 'https://sandbox.sslcommerz.com/EasyCheckOut/testcde1',
    });
    const page = await new SslcommerzGateway(fetchFn).openPage(ACCOUNT, REQUEST);
    expect(page).toEqual({ ok: true, url: 'https://sandbox.sslcommerz.com/EasyCheckOut/testcde1' });
    expect(calls[0]?.url).toBe('https://sandbox.sslcommerz.com/gwprocess/v4/api.php');
    const form = calls[0]?.init?.body;
    expect(form).toBeInstanceOf(URLSearchParams);
    if (!(form instanceof URLSearchParams)) return;
    expect(form.get('total_amount')).toBe('578.00');
    expect(form.get('currency')).toBe('BDT');
    expect(form.get('success_url')).toBe(REQUEST.returnUrl);
    expect(form.get('fail_url')).toBe(REQUEST.returnUrl);
    expect(form.get('cancel_url')).toBe(REQUEST.returnUrl);
    expect(form.get('ipn_url')).toBe(REQUEST.noticeUrl);
    expect(form.get('cus_add1')).toBe('House 12 Road 4');
    expect(form.get('cus_email')).toMatch(/\.invalid$/);
  });

  it('says rejected when SSLCommerz refuses, and unreachable when it does not answer', async () => {
    const refused = answering({ status: 'FAILED', failedreason: 'Store Credential Error' });
    expect(await new SslcommerzGateway(refused.fetchFn).openPage(ACCOUNT, REQUEST)).toEqual({
      ok: false,
      problem: 'rejected',
    });
    // A page that is not SSLCommerz's https address is no page
    const strange = answering({ status: 'SUCCESS', GatewayPageURL: 'javascript:alert(1)' });
    expect((await new SslcommerzGateway(strange.fetchFn).openPage(ACCOUNT, REQUEST)).ok).toBe(
      false,
    );
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    expect(await new SslcommerzGateway(down).openPage(ACCOUNT, REQUEST)).toEqual({
      ok: false,
      problem: 'unreachable',
    });
    const error = answering({ message: 'Bad gateway' }, 502);
    expect(await new SslcommerzGateway(error.fetchFn).validate(ACCOUNT, 'v1')).toEqual({
      kind: 'problem',
      problem: 'unreachable',
    });
  });

  it('reads a paid validation from its own answer, and asks with the store in the address', async () => {
    const { calls, fetchFn } = answering({
      status: 'VALID',
      tran_id: TRAN,
      val_id: '2611221045371uQe8kz1lO',
      amount: '578.00',
      currency: 'BDT',
      store_amount: '563.55',
      card_type: 'BKASH-BKash',
      bank_tran_id: '2611221045371',
    });
    expect(
      await new SslcommerzGateway(fetchFn).validate(ACCOUNT, '2611221045371uQe8kz1lO'),
    ).toEqual({
      kind: 'paid',
      tranId: TRAN,
      valId: '2611221045371uQe8kz1lO',
      amount: '578.0000',
      currency: 'BDT',
      storeAmount: '563.5500',
      cardType: 'BKASH-BKash',
      bankTranId: '2611221045371',
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/validator/api/validationserverAPI.php');
    expect(url.searchParams.get('val_id')).toBe('2611221045371uQe8kz1lO');
    expect(url.searchParams.get('store_id')).toBe(ACCOUNT.storeId);
  });

  it('does not call a VALID answer without its amount paid', async () => {
    const { fetchFn } = answering({
      status: 'VALID',
      tran_id: TRAN,
      val_id: 'v1',
      currency: 'BDT',
    });
    expect((await new SslcommerzGateway(fetchFn).validate(ACCOUNT, 'v1')).kind).toBe('problem');
    const invalid = answering({ status: 'INVALID_TRANSACTION' });
    expect(await new SslcommerzGateway(invalid.fetchFn).validate(ACCOUNT, 'v1')).toEqual({
      kind: 'none',
    });
  });

  it('finds a try by tran_id: paid first, then pending, failed, cancelled, else none', async () => {
    const find = async (statuses: string[]) => {
      const { fetchFn } = answering({
        APIConnect: 'DONE',
        no_of_trans_found: statuses.length,
        element: statuses.map((status) => ({
          status,
          tran_id: TRAN,
          val_id: `v-${status}`,
          amount: '578.00',
          currency: 'BDT',
          store_amount: '563.55',
        })),
      });
      return (await new SslcommerzGateway(fetchFn).find(ACCOUNT, TRAN)).kind;
    };
    expect(await find(['FAILED', 'VALIDATED'])).toBe('paid');
    expect(await find(['FAILED', 'PENDING'])).toBe('pending');
    expect(await find(['CANCELLED', 'FAILED'])).toBe('failed');
    expect(await find(['CANCELLED'])).toBe('cancelled');
    expect(await find(['EXPIRED'])).toBe('none');
    expect(await find([])).toBe('none');
  });

  it('tests the account with a transaction query that finds nothing', async () => {
    const accepted = answering({ APIConnect: 'DONE', no_of_trans_found: 0 });
    expect(await new SslcommerzGateway(accepted.fetchFn).test(ACCOUNT)).toBeNull();
    const refused = answering({ APIConnect: 'FAILED' });
    expect(await new SslcommerzGateway(refused.fetchFn).test(ACCOUNT)).toBe('rejected');
    const inactive = answering({ APIConnect: 'INACTIVE' });
    expect(await new SslcommerzGateway(inactive.fetchFn).find(ACCOUNT, TRAN)).toEqual({
      kind: 'problem',
      problem: 'rejected',
    });
    const live = answering({ APIConnect: 'DONE' });
    await new SslcommerzGateway(live.fetchFn).test({ ...ACCOUNT, mode: 'live' });
    expect(live.calls[0]?.url.startsWith('https://securepay.sslcommerz.com/')).toBe(true);
  });
});

describe('fake gateway (step 27d.3)', () => {
  const fake = new FakeGateway();

  it("opens the shop's own fake page with the try and the amount", async () => {
    const page = await fake.openPage(ACCOUNT, REQUEST);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const url = new URL(page.url);
    expect(url.origin).toBe('http://nirvor.localhost:4321');
    expect(url.pathname).toBe(SHOP_FAKE_GATEWAY_PATH);
    expect(url.searchParams.get('tranId')).toBe(TRAN);
    expect(url.searchParams.get('amount')).toBe('578.0000');
  });

  it('pays what its val_id says, less a 2.5% fee, and knows nothing by tran_id', async () => {
    const paid = await fake.validate(
      ACCOUNT,
      fakeValId(TRAN, { outcome: 'paid', amount: '578.0000' }),
    );
    expect(paid).toMatchObject({
      kind: 'paid',
      tranId: TRAN,
      amount: '578.0000',
      storeAmount: '563.5500',
    });
    expect(await fake.validate(ACCOUNT, fakeValId(TRAN, { outcome: 'cancelled' }))).toEqual({
      kind: 'cancelled',
    });
    expect(await fake.validate(ACCOUNT, '2611221045371uQe8kz1lO')).toEqual({ kind: 'none' });
    expect(await fake.find(ACCOUNT)).toEqual({ kind: 'none' });
  });

  it('answers like a bad day for its two special store ids', async () => {
    expect(await fake.test(ACCOUNT)).toBeNull();
    expect(await fake.test({ ...ACCOUNT, storeId: 'fake_rejected' })).toBe('rejected');
    expect(await fake.openPage({ ...ACCOUNT, storeId: 'fake_unreachable' }, REQUEST)).toEqual({
      ok: false,
      problem: 'unreachable',
    });
  });
});
