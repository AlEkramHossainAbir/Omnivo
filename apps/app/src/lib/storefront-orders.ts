import {
  compareQuantity,
  isQuantity,
  type PackStorefrontOrderFormValues,
  routes,
  type StorefrontOrder,
  type StorefrontOrderSort,
  type StorefrontOrderView,
  type StorefrontPackPlan,
  sumQuantity,
} from '@omnivo/contracts';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 27b: the Shop orders pages' reads and the Packed dialog's form. Its own file, not
// lib/storefront.ts: a packer with only storefront.order.read opens these two pages and nothing
// else of the menu, so their chunk does not carry the catalog's and the appearance's code. Every
// key starts with ['storefront', tenantId, 'orders'], so the menu's refresh reaches them too, and
// one invalidate of that prefix after a move refreshes the list, the order and the sidebar's count.

// ---------------------------------------------------------------------------------------------
// Reads

export interface OrderFilter {
  view: StorefrontOrderView;
  search: string;
  sort: StorefrontOrderSort;
}

export function storefrontOrdersQuery(tenantId: string, filter: OrderFilter) {
  return infiniteQueryOptions({
    queryKey: ['storefront', tenantId, 'orders', 'list', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.storefrontOrders.listOrders, {
        query: {
          limit: 50,
          view: filter.view,
          sort: filter.sort,
          ...(filter.search !== '' && { search: filter.search }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    // Another tab keeps the old rows until its first page comes: no flash of an empty table
    placeholderData: keepPreviousData,
  });
}

export function storefrontOrderQuery(tenantId: string, orderId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'orders', 'one', orderId],
    queryFn: () => call(routes.storefrontOrders.getOrder, { params: { id: orderId } }),
  });
}

// What the Packed dialog opens with. Asked each time the dialog opens (staleTime 0, gcTime 0): the
// batches' stock changes with every sale, and a plan from an hour ago would suggest a batch that
// is empty now
export function storefrontPackPlanQuery(tenantId: string, orderId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'orders', 'pack-plan', orderId],
    queryFn: () => call(routes.storefrontOrders.getPackPlan, { params: { id: orderId } }),
    staleTime: 0,
    gcTime: 0,
  });
}

// ---------------------------------------------------------------------------------------------
// One order

// The step a member can take next, by status (decisions 5–8, 28). A confirmed order with no sales
// order cannot be packed: the challan is written from the sales order, so the page offers to make
// it first (decisions 1 and 29)
export type OrderStep = 'makeSalesOrder' | 'pack' | 'ship' | 'deliver';

export function nextStep(order: StorefrontOrder): OrderStep | null {
  switch (order.status) {
    case 'confirmed':
      return order.salesOrder === null ? 'makeSalesOrder' : 'pack';
    case 'packed':
      return 'ship';
    case 'shipped':
      return 'deliver';
    default:
      return null;
  }
}

// Decision 8: a new or packed order can be cancelled. A shipped one is with the courier, and its
// coming back is step 28's "returned"
export function canCancel(order: StorefrontOrder): boolean {
  return order.status === 'confirmed' || order.status === 'packed';
}

// ---------------------------------------------------------------------------------------------
// The Packed dialog's form

// What the dialog edits for one line. Not the contract's input: a serial line is one box of serial
// numbers (SerialNumbersInput keeps the list), and a batch line's picks keep the box's text as typed
// until the send
export interface PackLineValues {
  position: number;
  picks: { batchId: string; quantity: string }[];
  serials: string[];
}

// The API writes stock quantities with four decimals ("3.0000") and the order's own quantities as
// whole numbers ("2"), decision 32. A box shows what a person would type: only the zeros at the
// end go, never a digit that counts
export function plainQuantity(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

// How many decimals a quantity has once its zeros at the end are gone ("2.50" → 1), so the dialog
// formats it with the user's digits without rounding it
export function decimalsOf(value: string): number {
  return plainQuantity(value).split('.')[1]?.length ?? 0;
}

// The dialog's start: the API's suggestion (FEFO for a batch line, one pick for an untracked one),
// and an empty box for a serial line. A batch line with no suggestion (no batch has stock) starts
// with one empty pick, so the packer sees the select and the noBatches line together
export function packFormValues(plan: StorefrontPackPlan): PackLineValues[] {
  return plan.lines.map((line) => {
    if (line.tracking === 'serial') {
      return { position: line.position, picks: [], serials: [] };
    }
    const picks = line.picks.map((pick) => ({
      batchId: pick.batchId ?? '',
      quantity: plainQuantity(pick.quantity),
    }));
    return {
      position: line.position,
      picks: picks.length > 0 ? picks : [{ batchId: '', quantity: plainQuantity(line.quantity) }],
      serials: [],
    };
  });
}

// What "Mark packed" sends. A serial line is one pick of the whole quantity with the serial
// numbers typed; the challan checks that their count matches. A box that is not a quantity is
// sent as it is: the contract's schema refuses it on that box, with the same path as the API's
export function toPackInput(
  plan: StorefrontPackPlan,
  lines: readonly PackLineValues[],
  version: number,
): PackStorefrontOrderFormValues {
  return {
    version,
    lines: lines.map((values, index) => {
      const planned = plan.lines[index];
      if (planned?.tracking === 'serial') {
        return {
          position: values.position,
          picks: [
            {
              batchId: '',
              quantity: plainQuantity(planned.quantity),
              serialNumbers: [...values.serials],
            },
          ],
        };
      }
      return {
        position: values.position,
        picks: values.picks.map((pick) => ({
          batchId: pick.batchId,
          quantity: pick.quantity.trim(),
          serialNumbers: [],
        })),
      };
    }),
  };
}

// The line's count under its picks: what was picked so far, and whether it is exactly the line.
// A box that is not a quantity yet counts as nothing, so the count never shows NaN while typing
export function pickedOf(
  values: PackLineValues,
  quantity: string,
): { picked: string; complete: boolean } {
  const picked = sumQuantity(
    values.picks.map((pick) => pick.quantity.trim()).filter((value) => isQuantity(value)),
  );
  // sumQuantity writes four decimals; the count shows what a person would write
  return { picked: plainQuantity(picked), complete: compareQuantity(picked, quantity) === 0 };
}
