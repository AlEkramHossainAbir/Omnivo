import {
  absMoney,
  compareMoney,
  isMoneyAmount,
  type PayoutFormValues,
  type PayoutMatchOutcome,
  type PayoutMatchRow,
  type PayoutParcel,
  type PayoutStatus,
  plainQuantity,
  routes,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 28c: Shop payouts' reads and the new payout's sums. Its own file, like storefront-orders.ts:
// only the payout pages load it. Every key starts with ['storefront', tenantId], so a payout saved
// or voided refreshes the couriers' Holds and the order page's parcel card too. No React here, so
// the spec runs without a DOM.

// ---------------------------------------------------------------------------------------------
// Reads

// The account select's choices (with what each holds) and the bank accounts
export function storefrontPayoutSetupQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'payouts', 'setup'],
    queryFn: () => call(routes.storefrontPayouts.setup),
  });
}

export interface PayoutFilter {
  // '' = both
  status: PayoutStatus | '';
  // '' = every courier account
  accountId: string;
}

export function storefrontPayoutsQuery(tenantId: string, filter: PayoutFilter) {
  return infiniteQueryOptions({
    queryKey: ['storefront', tenantId, 'payouts', 'list', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.storefrontPayouts.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.accountId !== '' && { accountId: filter.accountId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    // A filter change keeps the old rows until the first page comes: no flash of an empty table
    placeholderData: keepPreviousData,
  });
}

export function storefrontPayoutQuery(tenantId: string, payoutId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'payouts', 'one', payoutId],
    queryFn: () => call(routes.storefrontPayouts.get, { params: { id: payoutId } }),
    retry: false,
  });
}

// The parcels a new payout may take. Asked each time the page opens (staleTime 0, gcTime 0), like
// the pack plan: a parcel another member paid out a minute ago must not be offered again
export function storefrontPayoutParcelsQuery(tenantId: string, accountId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'payouts', 'parcels', accountId],
    queryFn: () => call(routes.storefrontPayouts.parcels, { params: { id: accountId } }),
    staleTime: 0,
    gcTime: 0,
  });
}

// ---------------------------------------------------------------------------------------------
// The new payout's lines

export type PayoutLineValue = PayoutFormValues['lines'][number];
// What each charge box holds, ticked or not, by shipment id. An unticked parcel keeps its box, so
// ticking it again brings back what was typed
export type ChargeDrafts = Readonly<Record<string, string>>;

// The API answers money with 4 decimals ("60.0000"); the charge's schema takes 2 at most. The
// plain form ("60", "60.5") is the same amount and passes it
export function startDrafts(parcels: readonly PayoutParcel[]): ChargeDrafts {
  return Object.fromEntries(
    parcels.map((parcel) => [
      parcel.shipmentId,
      parcel.courierCharge === null ? '' : plainQuantity(parcel.courierCharge),
    ]),
  );
}

// The ticked lines in the parcels' order, so the server's "lines.3.charge" points at the row the
// page shows fourth among the ticked ones, the same order every time
export function orderLines(
  parcels: readonly PayoutParcel[],
  lines: readonly PayoutLineValue[],
): PayoutLineValue[] {
  const order = new Map(parcels.map((parcel, index) => [parcel.shipmentId, index]));
  return lines.toSorted((a, b) => (order.get(a.shipmentId) ?? 0) - (order.get(b.shipmentId) ?? 0));
}

export interface PayoutTotals {
  collected: string;
  charges: string;
  net: string;
}

// The sums under the table, of the ticked lines only. A charge box that is empty or not a number
// yet counts as nothing: the sums follow the typing, and the save says what is wrong with the box
export function payoutTotals(
  parcels: readonly PayoutParcel[],
  lines: readonly PayoutLineValue[],
): PayoutTotals {
  const ticked = new Set(lines.map((line) => line.shipmentId));
  const collected = sumMoney(
    parcels.filter((parcel) => ticked.has(parcel.shipmentId)).map((parcel) => parcel.collected),
  );
  const charges = sumMoney(
    lines.map((line) => line.charge.trim()).filter((charge) => isMoneyAmount(charge)),
  );
  return { collected, charges, net: subtractMoney(collected, charges) };
}

// The file's bank figure against the ticked lines' (P4): null when they agree, else how far apart,
// without its sign (the pill says "Out by ৳9.00" either way)
export function fileDifference(net: string, fileNet: string): string | null {
  return compareMoney(net, fileNet) === 0 ? null : absMoney(subtractMoney(fileNet, net));
}

// ---------------------------------------------------------------------------------------------
// The payout file

// P5: the rows that need a look first, then the ones that only say why nothing was ticked, then the
// ones found. A `satisfies` keeps it every outcome, each once: an outcome added to the contract
// fails the type check here
const OUTCOME_RANK = {
  different: 0,
  unknown: 1,
  invalid: 2,
  twice: 3,
  already_paid: 4,
  not_ready: 5,
  matched: 6,
} as const satisfies Record<PayoutMatchOutcome, number>;

// Stable: inside one outcome, the file's own order (the row numbers go up)
export function sortMatchRows(rows: readonly PayoutMatchRow[]): PayoutMatchRow[] {
  return rows.toSorted(
    (a, b) => OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome] || a.row - b.row,
  );
}

// The count pills above the rows, in the same order, only the outcomes the file has
export function outcomeCounts(
  rows: readonly PayoutMatchRow[],
): { outcome: PayoutMatchOutcome; count: number }[] {
  const counts = new Map<PayoutMatchOutcome, number>();
  for (const row of rows) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  return [...counts]
    .map(([outcome, count]) => ({ outcome, count }))
    .toSorted((a, b) => OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome]);
}

// A row whose parcel this payout can take: found, or found with another amount (the member decides,
// decision 12). Only a parcel the page lists: the list and the match apply the same rule, but the
// list may be a minute older than the match
function tickable(
  row: PayoutMatchRow,
  listed: ReadonlySet<string>,
): row is PayoutMatchRow & {
  shipmentId: string;
} {
  return (
    (row.outcome === 'matched' || row.outcome === 'different') &&
    row.shipmentId !== null &&
    listed.has(row.shipmentId)
  );
}

export function tickableCount(
  parcels: readonly PayoutParcel[],
  rows: readonly PayoutMatchRow[],
): number {
  const listed = new Set(parcels.map((parcel) => parcel.shipmentId));
  return rows.filter((row) => tickable(row, listed)).length;
}

// "Tick 4 parcels": the file's parcels ticked with the file's charges. A file with no charge
// column keeps each box as it is. Parcels ticked before stay ticked (the hint says so), so two
// files of one transfer can be matched one after the other
export function applyMatch(
  parcels: readonly PayoutParcel[],
  lines: readonly PayoutLineValue[],
  drafts: ChargeDrafts,
  rows: readonly PayoutMatchRow[],
): { lines: PayoutLineValue[]; drafts: ChargeDrafts; ticked: number } {
  const listed = new Set(parcels.map((parcel) => parcel.shipmentId));
  const next: Record<string, string> = { ...drafts };
  const ticked = new Set(lines.map((line) => line.shipmentId));
  let count = 0;
  for (const row of rows) {
    if (!tickable(row, listed)) continue;
    if (row.fileCharge !== null) next[row.shipmentId] = plainQuantity(row.fileCharge);
    ticked.add(row.shipmentId);
    count += 1;
  }
  return {
    lines: orderLines(
      parcels,
      [...ticked].map((shipmentId) => ({ shipmentId, charge: next[shipmentId] ?? '' })),
    ),
    drafts: next,
    ticked: count,
  };
}
