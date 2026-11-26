import { createHash } from 'node:crypto';

import {
  COURIER_OF_PROVIDER,
  type CourierTestProblem,
  type ShopShipmentStatus,
} from '@omnivo/contracts';

// Step 28a: what the API needs from a courier, in our own words (§14.6). Nothing about shops or
// orders is in here: a challan of the ERP books the same way later (decision 10). The shop's code
// (storefront/shipping/) decides what an answer means for a parcel; an adapter only talks to its
// courier and says what it answered. One adapter per provider that books by API; a manual account
// has none, because nothing is called.

// The providers that have an adapter: every provider but 'manual' (28a.1's COURIER_OF_PROVIDER)
export type ApiCourierProvider = keyof typeof COURIER_OF_PROVIDER;

export function isApiProvider(provider: string): provider is ApiCourierProvider {
  return Object.keys(COURIER_OF_PROVIDER).includes(provider);
}

// An account's two keys, opened from their sealed box for one call (storefront/shipping/
// courier-keys.ts). In memory only for the call
export interface CourierKeys {
  apiKey: string;
  secretKey: string;
}

// What the courier is told about one parcel. The invoice is our key at the courier (decision 3):
// the order number, or "W-000123-2" for a later parcel (28a.2's mine 25)
export interface ParcelRequest {
  invoice: string;
  name: string;
  phone: string;
  address: string;
  // What the rider collects, a decimal string to the paisa ("578.00"; "0.00" when paid online)
  codAmount: string;
  // For the rider, "3 items"; never the products
  note: string;
}

// rejected: the courier answered and refused the keys. unreachable: no answer in time, or one that
// is not the courier's. The same two as "Test connection" (28a.1)
export type CourierProblem = CourierTestProblem;

// A parcel the courier knows, with its id, its tracking code, its own tracking page and where it
// is now, already in our words
export interface CourierParcel {
  consignmentId: string;
  trackingCode: string;
  trackingUrl: string | null;
  status: ShopShipmentStatus;
}

// - booked: the courier took it
// - refused: the courier answered and said no to this parcel (a phone it does not take, an address
//   too long), with its own sentence when it gave one. Asking again would get the same answer
// - taken: the courier already has a parcel with this invoice (an earlier call reached it, and its
//   answer was lost). The caller asks by the invoice (find)
// - problem: the courier could not be asked, or refused the keys
export type BookAnswer =
  | { kind: 'booked'; parcel: CourierParcel }
  | { kind: 'refused'; detail: string | null }
  | { kind: 'taken' }
  | { kind: 'problem'; problem: CourierProblem };

// What the courier knows by our invoice, asked after a call whose answer was lost (decision 3):
// - found: the parcel, with everything a booking answers
// - exists: a parcel has this invoice, but the courier's answer does not say its tracking code
//   (Steadfast's status_by_invoice says only where it is). It cannot be recorded as booked
// - none: nothing has this invoice, so booking it now makes the only parcel
export type FindAnswer =
  | { kind: 'found'; parcel: CourierParcel }
  | { kind: 'exists' }
  | { kind: 'none' }
  | { kind: 'problem'; problem: CourierProblem };

// Where a parcel is now, asked by the 15-minute poll (decision 9). status null: the courier
// answered a word this adapter does not know; the courier's own word is in `word`, kept with the
// event so it can be read later (decision 22)
export type StatusAnswer =
  | { kind: 'status'; status: ShopShipmentStatus | null; word: string }
  | { kind: 'problem'; problem: CourierProblem };

// One webhook body, read. The courier names the parcel by its own id or by our invoice (or both);
// the caller finds it with either, only inside the account's own workspace
//  - status: the parcel moved, with the courier's note and time when it gave them. Step 28b: and
//    the money it named, as decimal strings to the paisa, or null when it named none (the poll's
//    answer never does): `collected`, what the notice says the rider collected (Steadfast's
//    cod_amount), and `charge`, the courier's charge for the parcel (its delivery_charge). The
//    adapter only reads them; the shop's code decides what they mean (shipment-news.ts: a
//    collected amount counts only on a delivered or partly delivered step)
//  - note: words about the parcel with no new status ("Received at Sylhet hub")
//  - unread: a body this adapter cannot read. Kept raw on the parcel (decision 22), never refused
export type CourierNotice = {
  consignmentId: string | null;
  invoice: string | null;
  raw: Record<string, unknown>;
} & (
  | {
      kind: 'status';
      status: ShopShipmentStatus | null;
      note: string | null;
      at: Date | null;
      collected: string | null;
      charge: string | null;
    }
  | { kind: 'note'; note: string; at: Date | null }
  | { kind: 'unread' }
);

export interface CourierAdapter {
  book(keys: CourierKeys, parcel: ParcelRequest): Promise<BookAnswer>;
  find(keys: CourierKeys, invoice: string): Promise<FindAnswer>;
  status(keys: CourierKeys, consignmentId: string): Promise<StatusAnswer>;
  // No call: the body came to us. Pure, so the unit test covers every shape
  readNotice(body: unknown): CourierNotice;
  // "Test connection": null when the courier accepts the keys. Asks something that changes nothing
  test(keys: CourierKeys): Promise<CourierProblem | null>;
}

// The adapters of this process, one per API provider (shipping/create-couriers.ts). A Record over
// the providers, so 28c's Pathao does not compile until it has its adapter
export type CourierAdapters = Record<ApiCourierProvider, CourierAdapter>;

// A courier's words for a column of ours: trimmed, null when empty, and cut to the columns' 300
// characters (storefront_shipments_text_check and the events' note), so a long sentence never
// leaves a parcel's news unrecorded
export function courierText(value: unknown): string | null {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text === '' ? null : text.slice(0, 300);
}

// A courier's id for a parcel as our text: Steadfast sends a number, others a string. null for
// anything that is not a plain id (the column takes 1 to 64 characters)
export function courierId(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(text.trim()) ? text.trim() : null;
}

// Step 28b: an amount a courier sent, as our money text: a number (Steadfast's JSON has 1500.00 as
// 1500) or a numeric string, zero or more, to the paisa at most ("578", "578.50"). null for
// anything else (a minus, a third decimal, "N/A"): a sum we cannot read is no sum, and the raw
// body still has it. A number goes through toFixed(2) first, so 0.1 + 0.2's float noise never
// reaches the books; a number with real paisa beyond two places is refused like the string
export function courierMoney(value: unknown): string | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value >= 1e13) return null;
    text = value.toFixed(2);
    if (Math.abs(Number(text) - value) > 1e-6) return null;
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return null;
  }
  return /^\d{1,13}(?:\.\d{1,2})?$/.test(text) ? text : null;
}

// The API's own key for one step of a parcel (28a.2's mine 26): the same status, time and note is
// the same step, whether the webhook said it twice or the webhook and the poll both did. The time
// is the courier's own as it sent it (null when it sent none), never one we worked out: the same
// notice sent twice must give the same key. A SHA-256 in hex, the column's form
// (storefront_shipment_events_text_check)
export function eventKeyOf(
  kind: string,
  status: ShopShipmentStatus | null,
  at: Date | null,
  note: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, status, at?.toISOString() ?? null, note]))
    .digest('hex');
}
