import { documentTotals, lineAmounts, sumMoney } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { lineDiscounts } from './sales-order-maker.js';
import { challanDiscounts } from './storefront-orders.service.js';

// Step 27c: a coupon's discount on the ERP's documents (decision 4)
describe('lineDiscounts (sales order)', () => {
  it('gives every line ৳0 when the order has no discount', () => {
    expect(lineDiscounts('0.0000', ['458.0000', '120.0000'])).toEqual(['0', '0']);
  });

  it('spreads the discount by line total, to the paisa, and the totals still agree', () => {
    // 2 × ৳229 and 1 × ৳120, WELCOME10 takes ৳57.80 off ৳578
    const lines = [
      { quantity: '2', unitPrice: '229.0000', lineTotal: '458.0000' },
      { quantity: '1', unitPrice: '120.0000', lineTotal: '120.0000' },
    ];
    const discounts = lineDiscounts(
      '57.8000',
      lines.map((line) => line.lineTotal),
    );
    expect(discounts).toEqual(['45.8000', '12.0000']);
    // The sales order prices include VAT (createForShop), so its total is the shop's ৳520.20
    const amounts = lines.map((line, index) =>
      lineAmounts(
        {
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountType: 'amount',
          discount: discounts[index] ?? '0',
          rate: '15.00',
        },
        true,
      ),
    );
    expect(documentTotals(amounts)).toMatchObject({ discount: '57.8000', total: '520.2000' });
  });

  it('gives the left-over paisa to the line that lost the most', () => {
    // ৳10 over three lines of ৳50: 3.33 each, and the paisa left goes to the first (a tie)
    expect(lineDiscounts('10.0000', ['50.0000', '50.0000', '50.0000'])).toEqual([
      '3.3400',
      '3.3300',
      '3.3300',
    ]);
  });
});

describe('challanDiscounts (invoice)', () => {
  const orderLines = new Map([
    ['so-1', { discountType: 'amount', discount: '45.8000', unitPrice: '229.0000' }],
    ['so-2', { discountType: 'amount', discount: '0.0000', unitPrice: '120.0000' }],
  ]);

  it("gives a challan line its order line's discount, and none to a line without one", () => {
    const shares = challanDiscounts(
      [
        { id: 'dl-1', orderLineId: 'so-1', quantity: '2.0000' },
        { id: 'dl-2', orderLineId: 'so-2', quantity: '1.0000' },
      ],
      orderLines,
    );
    expect(shares.get('dl-1')).toBe('45.8000');
    expect(shares.has('dl-2')).toBe(false);
  });

  it('spreads it over the batches one order line was packed from, adding up exactly', () => {
    const shares = challanDiscounts(
      [
        { id: 'dl-1', orderLineId: 'so-1', quantity: '1.0000' },
        { id: 'dl-2', orderLineId: 'so-1', quantity: '1.0000' },
      ],
      new Map([['so-1', { discountType: 'amount', discount: '45.8100', unitPrice: '229.0000' }]]),
    );
    expect([shares.get('dl-1'), shares.get('dl-2')]).toEqual(['22.9100', '22.9000']);
    expect(sumMoney([...shares.values()])).toBe('45.8100');
  });
});
