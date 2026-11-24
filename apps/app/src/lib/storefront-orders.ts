import {
  compareQuantity,
  type CourierExportRow,
  isOpenShipment,
  isQuantity,
  type PackStorefrontOrderFormValues,
  routes,
  type StorefrontOrder,
  type StorefrontOrderSort,
  type StorefrontOrderView,
  type StorefrontPackPlan,
  type StorefrontShipment,
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

// Step 28a.6: the accounts the Packed dialog and Book courier offer (courierChoices). Asked each
// time one of them opens, like the pack plan: an account archived a minute ago must not be offered
export function storefrontCourierChoicesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'orders', 'courier-choices'],
    queryFn: () => call(routes.storefrontOrders.courierChoices),
    staleTime: 0,
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

// ---------------------------------------------------------------------------------------------
// Step 28a: the order's parcels

// The order's parcels come oldest first (storefrontOrderSchema). The page shows the newest first:
// the one that matters now is on top, and an earlier failed one sits under it
export function parcelsNewestFirst(order: StorefrontOrder): StorefrontShipment[] {
  return [...order.shipments].reverse();
}

// The parcel on its way, if any. The database keeps at most one per order (28a.2's open_idx)
export function openParcel(order: StorefrontOrder): StorefrontShipment | null {
  return order.shipments.find((parcel) => isOpenShipment(parcel.status)) ?? null;
}

// "Needs attention" on the order's page, by the API's own rule for the list (parcelNeedsAttention):
// a packed order whose last parcel failed to book. "Book again" made a new parcel, so a failed one
// under a newer one no longer counts
export function parcelFailed(order: StorefrontOrder): StorefrontShipment | null {
  const last = order.shipments.at(-1);
  return order.status === 'packed' && last?.status === 'booking_failed' ? last : null;
}

// "Book courier": a packed order with no parcel on its way (none yet, or the last one failed or
// was cancelled). The API refuses the rest with storefront_order_not_bookable
export function canBook(order: StorefrontOrder): boolean {
  return order.status === 'packed' && openParcel(order) === null;
}

// ---------------------------------------------------------------------------------------------
// Step 28a: the export for a courier's bulk upload (decision 19)

// The columns of Steadfast's bulk upload, in its own words, which the other couriers' panels take
// too. They stay English in a Bangla app: the courier's panel reads them, not a person
export const COURIER_CSV_COLUMNS = [
  'Invoice',
  'Name',
  'Address',
  'Phone',
  'Amount',
  'Note',
] as const;

// One CSV cell. Quoted when it holds a comma, a quote or a line break (an address often has all
// three), with its quotes doubled. A shopper typed the name and the address: one that starts with
// = + - or @ would run as a formula when the file is opened in Excel, so it gets a ' in front
// (OWASP's CSV injection advice). Only those two: a phone or an amount never starts that way, and
// a ' there would reach the courier's panel
function csvCell(value: string, typed = false): string {
  const safe = typed && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// Found in 28a.7: the API answers money with 4 decimals ("538.0000"), and a courier's panel wants
// taka and paisa ("538.00"). Every shop amount is whole paisa (its prices, and a percent off rounds
// to the paisa), so the last two digits are always 0 and cutting them loses nothing
function paisaOf(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

// The whole file. note(count) is the rider's line ("3 items", in the reader's words). CRLF, as
// RFC 4180 says, and a byte order mark first, so Excel reads a Bangla name as UTF-8, not as
// question marks. The amount with paisa and a dot (paisaOf): the courier's panel reads it
export function courierCsv(
  rows: readonly CourierExportRow[],
  note: (count: number) => string,
): string {
  const lines = [
    COURIER_CSV_COLUMNS.join(','),
    ...rows.map((row) =>
      [
        csvCell(row.invoice),
        csvCell(row.name, true),
        csvCell(row.address, true),
        csvCell(row.phone),
        csvCell(paisaOf(row.amount)),
        csvCell(note(row.itemCount), true),
      ].join(','),
    ),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
