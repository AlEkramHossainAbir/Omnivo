import { fakeGatewayParamsSchema, fakeValId, type FakeGatewayOutcome } from '@omnivo/contracts';

import type { PlacedOrder, ShopSource } from '../types';

// Step 27d: for the tests. What a press on the fake gateway's page does (pages/checkout/
// fake-gateway.astro): the page's address names the try and its amount, and the button posts its
// val_id to the return path, which settles the try. The tests of the mock, of the routes and of
// tracking pay this way, so each one says only what it checks.

// The try and the amount on a payment page's address
export function fakePageOf(paymentUrl: string | null): { tranId: string; amount: string } {
  if (paymentUrl === null) throw new Error('No payment page opened');
  const url = new URL(paymentUrl);
  return fakeGatewayParamsSchema.parse({
    tranId: url.searchParams.get('tranId'),
    amount: url.searchParams.get('amount'),
  });
}

// Presses one of the page's buttons for the order's newest try. `amount` changes what "Pay" says
// was paid, as a tester can by editing the address
export async function pressOnFakePage(
  source: ShopSource,
  paymentUrl: string | null,
  outcome: FakeGatewayOutcome = 'paid',
  amount?: string,
) {
  const page = fakePageOf(paymentUrl);
  const valId =
    outcome === 'paid'
      ? fakeValId(page.tranId, { outcome, amount: amount ?? page.amount })
      : fakeValId(page.tranId, { outcome });
  return source.settlePayment({ tranId: page.tranId, valId });
}

// Places nothing: pays an order placed with Pay online, and gives back its number
export async function payPlaced(source: ShopSource, placed: PlacedOrder): Promise<string> {
  if (placed.answer.next !== 'pay') throw new Error(`The order answered ${placed.answer.next}`);
  await pressOnFakePage(source, placed.answer.paymentUrl);
  const wait = await source.paymentWait(placed.token);
  if (wait?.state !== 'paid') throw new Error('The payment did not confirm the order');
  return wait.orderNo;
}
