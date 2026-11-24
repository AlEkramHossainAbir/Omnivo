import {
  percentOfMoney,
  readFakeValId,
  SHOP_FAKE_GATEWAY_PATH,
  subtractMoney,
} from '@omnivo/contracts';

import {
  type GatewayAccount,
  type GatewayAnswer,
  type GatewayProblem,
  type PaymentGateway,
  type PaymentPage,
  type PaymentPageRequest,
} from './gateway.js';

// What the fake gateway keeps as its fee: 2.5%, about SSLCommerz's own, so a paid fake order posts
// a fee line and the books look like the real thing's (decision 6)
const FAKE_FEE_PERCENT = '2.5';

// Step 27d (decision 8): the gateway of development, CI and the tests. It keeps nothing: its page
// is the shop's own (SHOP_FAKE_GATEWAY_PATH), and the val_id that page posts back says what
// happened (27d.1's fakeValId). Refused in production (config.ts), because a val_id anyone can
// write would pay for anything.
export class FakeGateway implements PaymentGateway {
  // On the shop's own address: the return path's origin is the shop's, so the page opens where
  // the shopper already is, in dev on http://<shop>.localhost:4321
  openPage(account: GatewayAccount, request: PaymentPageRequest): Promise<PaymentPage> {
    const problem = fakeProblem(account);
    if (problem !== null) return Promise.resolve({ ok: false, problem });
    const url = new URL(SHOP_FAKE_GATEWAY_PATH, request.returnUrl);
    url.search = new URLSearchParams({ tranId: request.tranId, amount: request.amount }).toString();
    return Promise.resolve({ ok: true, url: url.toString() });
  }

  validate(account: GatewayAccount, valId: string): Promise<GatewayAnswer> {
    const problem = fakeProblem(account);
    if (problem !== null) return Promise.resolve({ kind: 'problem', problem });
    const answer = readFakeValId(valId);
    if (answer === null) return Promise.resolve({ kind: 'none' });
    if (answer.outcome !== 'paid') return Promise.resolve({ kind: answer.outcome });
    return Promise.resolve({
      kind: 'paid',
      tranId: answer.tranId,
      valId,
      amount: answer.amount,
      currency: 'BDT',
      storeAmount: subtractMoney(answer.amount, percentOfMoney(answer.amount, FAKE_FEE_PERCENT)),
      cardType: 'BKASH-BKash',
      bankTranId: `FAKE${answer.tranId.slice(0, 12)}`,
    });
  }

  // It keeps no table, so it knows no payment by its tran_id: a try whose val_id never came back
  // (the shopper closed the fake page) is never paid
  find(account: GatewayAccount): Promise<GatewayAnswer> {
    const problem = fakeProblem(account);
    return Promise.resolve(problem === null ? { kind: 'none' } : { kind: 'problem', problem });
  }

  test(account: GatewayAccount): Promise<GatewayProblem | null> {
    return Promise.resolve(fakeProblem(account));
  }
}

// Two store ids that make the fake gateway answer like SSLCommerz on a bad day, so the Payment
// card's "Test connection" and a page that does not open can be tried by hand and in the tests
function fakeProblem(account: GatewayAccount): GatewayProblem | null {
  if (account.storeId === 'fake_rejected') return 'rejected';
  if (account.storeId === 'fake_unreachable') return 'unreachable';
  return null;
}
