import {
  type Delivery,
  type InvoiceLineFormValues,
  type PriceLookupItem,
  routes,
  type SalesOrder,
} from '@omnivo/contracts';
import type { QueryClient } from '@tanstack/react-query';

import { call } from './api';
import {
  challanBilledQuantity,
  challanLinesLeft,
  challanLineToInvoice,
  chargesLeft,
  itemOfDeliveryLine,
  type LineOrigin,
  orderChargeToInvoice,
} from './invoices';
import { salesOrderQuery } from './queries';
import { type LineMeta, salesItemOf } from './sales';

// The lines an invoice gets from a challan or an order (step 15c), with what the editor and the
// form keep beside each: its meta, and where it came from. Shared by the invoice form's pickers
// and by "Make invoice" on a challan, which starts the form with them.

export interface SourcedLine {
  line: InvoiceLineFormValues;
  meta: LineMeta;
  // The challan line's or order line's id, and what the form says about it
  origin: readonly [string, LineOrigin];
}

let lastKey = 0;
function sourceKey(): string {
  lastKey += 1;
  return `source-${String(lastKey)}`;
}

// The challan's lines not billed yet and not on the form (`onForm`). With an order, the order's
// prices (read through the query cache: a second challan of the same order asks nothing again);
// without one, the price lookup for this customer, like a new order line. Step 15d: the lookup asks
// for the unit the line will bill in (challanBilledQuantity), the base unit when what came back
// leaves part of the challan's unit.
export async function challanLines(
  queryClient: QueryClient,
  tenantId: string,
  delivery: Delivery,
  onForm: ReadonlySet<string>,
): Promise<{ lines: SourcedLine[]; order: SalesOrder | null }> {
  const left = challanLinesLeft(delivery.lines, onForm);
  const order =
    delivery.order === null
      ? null
      : await queryClient.query(salesOrderQuery(tenantId, delivery.order.id));
  const orderLines = new Map(order?.lines.map((line) => [line.id, line]));
  const unpriced = left.filter(
    (line) => line.orderLineId === null || !orderLines.has(line.orderLineId),
  );
  const prices = new Map<string, PriceLookupItem>();
  if (unpriced.length > 0) {
    const answer = await call(routes.salesPrices.lookup, {
      body: {
        customerId: delivery.customer.id,
        items: unpriced.map((line) => ({
          variantId: line.variantId,
          unitId: challanBilledQuantity(line).unitId,
        })),
      },
    });
    for (const item of answer.items) prices.set(`${item.variantId}:${item.unitId}`, item);
  }
  return {
    order,
    lines: left.map((line) => {
      const orderLine = line.orderLineId === null ? undefined : orderLines.get(line.orderLineId);
      const price = orderLine
        ? undefined
        : prices.get(`${line.variantId}:${challanBilledQuantity(line).unitId}`);
      return {
        line: challanLineToInvoice(line, orderLine, price),
        meta: {
          key: sourceKey(),
          item: itemOfDeliveryLine(line),
          // The order's price says nothing new; a looked-up one says where it came from
          source: orderLine ? undefined : (price?.source ?? null),
          pricedFor: delivery.customer.id,
        },
        origin: [
          line.id,
          {
            deliveryNumber: delivery.number,
            orderNumber: order?.number ?? null,
            pricesIncludeVat: order?.pricesIncludeVat ?? null,
            returnedQuantity: line.returnedQuantity,
          },
        ],
      };
    }),
  };
}

// An order's service lines not billed yet and not on the form, at the order's prices
export function orderCharges(order: SalesOrder, onForm: ReadonlySet<string>): SourcedLine[] {
  return chargesLeft(order.lines, onForm).map((line) => ({
    line: orderChargeToInvoice(line),
    meta: {
      key: sourceKey(),
      item: salesItemOf(line),
      source: undefined,
      pricedFor: order.customer.id,
    },
    origin: [
      line.id,
      {
        deliveryNumber: null,
        orderNumber: order.number,
        pricesIncludeVat: order.pricesIncludeVat,
        returnedQuantity: '0',
      },
    ],
  }));
}
