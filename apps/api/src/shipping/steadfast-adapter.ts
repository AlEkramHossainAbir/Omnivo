import { Logger } from '@nestjs/common';
import { type ShopShipmentStatus, steadfastWebhookSchema } from '@omnivo/contracts';
import { z } from 'zod';

import {
  type BookAnswer,
  type CourierAdapter,
  courierId,
  type CourierKeys,
  type CourierNotice,
  type CourierProblem,
  courierText,
  type FindAnswer,
  type ParcelRequest,
  type StatusAnswer,
} from './courier.js';

// Step 28a: Steadfast's merchant API (portal.packzy.com/api/v1). Written from Steadfast's own
// documentation of its requests and answers only: there was no Steadfast account to try it on (the
// guide says so, and 28a.8's "Try it" books one real parcel first). Four calls: create_order (a
// booking), status_by_invoice (after a lost answer), status_by_cid (the poll) and get_balance
// ("Test connection"). Steadfast has no cancel call: a booking is cancelled on its panel.

const BASE_URL = 'https://portal.packzy.com/api/v1';

// Long enough for Steadfast on a slow day. A booking runs in the worker, so nobody waits on it;
// "Test connection" waits this long at most
const TIMEOUT_MS = 15_000;

// Steadfast's tracking page for a code. Not in its API answer, so it is made here
function trackingUrlOf(trackingCode: string): string {
  return `https://steadfast.com.bd/t/${encodeURIComponent(trackingCode)}`;
}

// Steadfast's words for where a parcel is, and ours (SHOP_SHIPMENT_STATUSES). The one place they
// meet: when Steadfast adds or renames one, only this table changes. A word that is not here is
// kept with the event as it came (decision 22) and moves nothing.
//  - in_review: booked, waiting for Steadfast to approve it; pending: approved and with Steadfast,
//    not delivered or cancelled yet. Steadfast has no word for "picked up" on its own: pending is
//    the first one after the booking, so it is read as on the way
//  - *_approval_pending: the rider says delivered (or partly, or cancelled), and Steadfast's hub
//    has not approved it yet. Read as still out for delivery (or coming back): the order is
//    Delivered, and its invoice posted, only once Steadfast says delivered for good
//  - cancelled: Steadfast cancelled the consignment. Before anyone picked it up that is a cancelled
//    booking; after, the goods come back. The shop's code tells the two apart by where the parcel
//    was (storefront/shipping/shipment-news.ts), so the adapter says only "cancelled"
//  - hold: the rider will try again; unknown: Steadfast does not know (read as on hold)
const STEADFAST_WORDS = {
  in_review: 'booked',
  pending: 'in_transit',
  hold: 'on_hold',
  delivered_approval_pending: 'out_for_delivery',
  partial_delivered_approval_pending: 'out_for_delivery',
  cancelled_approval_pending: 'returning',
  unknown_approval_pending: 'on_hold',
  delivered: 'delivered',
  partial_delivered: 'partly_delivered',
  cancelled: 'cancelled',
  unknown: 'on_hold',
} as const satisfies Record<string, ShopShipmentStatus>;

// A Map, so a word from Steadfast ("constructor", "__proto__") can never reach an object's own
// properties, and no cast is needed to look one up
const STATUS_OF: ReadonlyMap<string, ShopShipmentStatus> = new Map(Object.entries(STEADFAST_WORDS));

function statusOf(word: string | null | undefined): ShopShipmentStatus | null {
  return STATUS_OF.get(word?.trim().toLowerCase() ?? '') ?? null;
}

// Only what is read from each answer; zod objects drop the rest. Steadfast puts its own status in
// the body too (200, 400, 401), not only in the HTTP status
const codeSchema = z.union([z.number(), z.string()]).optional();

const createSchema = z.object({
  status: codeSchema,
  message: z.string().nullish(),
  // A refused booking: { field: ["The recipient phone must be 11 digits."] }
  errors: z.record(z.string(), z.union([z.array(z.string()), z.string()])).nullish(),
  consignment: z
    .object({
      consignment_id: z.union([z.number(), z.string()]),
      tracking_code: z.string(),
      status: z.string().nullish(),
    })
    .nullish(),
});

const statusSchema = z.object({
  status: codeSchema,
  delivery_status: z.string().nullish(),
});

const balanceSchema = z.object({
  status: codeSchema,
  current_balance: z.union([z.number(), z.string()]).nullish(),
});

// An answer is Steadfast's yes when its own status says 200
function said200(status: number | string | undefined): boolean {
  return String(status) === '200';
}

// The first sentence of Steadfast's refusal: an error under a field, or its message
function refusalOf(answer: z.infer<typeof createSchema>): string | null {
  for (const value of Object.values(answer.errors ?? {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && courierText(first) !== null) return courierText(first);
  }
  return courierText(answer.message);
}

// Steadfast writes its times as "2026-11-23 14:05:09", Bangladesh time, with no zone: read so. A
// time with a zone is read as it says. Anything else, or a time more than a day ahead (a broken
// clock), is no time: the caller uses the moment the notice came
export function steadfastTime(value: string | undefined, now: Date = new Date()): Date | null {
  const text = value?.trim() ?? '';
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(text);
  const at = new Date(local === null ? text : `${local[1] ?? ''}T${local[2] ?? ''}+06:00`);
  if (text === '' || Number.isNaN(at.getTime())) return null;
  return at.getTime() > now.getTime() + 24 * 60 * 60 * 1000 ? null : at;
}

type Call =
  | { kind: 'answer'; httpStatus: number; body: unknown }
  | { kind: 'problem'; problem: CourierProblem };

export class SteadfastAdapter implements CourierAdapter {
  private readonly logger = new Logger(SteadfastAdapter.name);

  // fetch is a parameter so the unit test can answer for Steadfast
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async book(keys: CourierKeys, parcel: ParcelRequest): Promise<BookAnswer> {
    const call = await this.call(keys, '/create_order', {
      invoice: parcel.invoice,
      // Steadfast's limits: a name of 100 characters, an address of 250, a phone of 11 digits
      // (ours always is: 01XXXXXXXXX, shopPhoneSchema). The address on one line: its label
      // printer does not break lines
      recipient_name: parcel.name.slice(0, 100),
      recipient_phone: parcel.phone,
      recipient_address: parcel.address.replace(/\s+/g, ' ').trim().slice(0, 250),
      // A number in Steadfast's API. Taka with paisa is exact as a JavaScript number for any COD
      // amount a parcel can have (far below 2^53 paisa), and the string goes in unchanged
      cod_amount: Number(parcel.codAmount),
      note: parcel.note,
    });
    if (call.kind === 'problem') return call;
    const answer = createSchema.safeParse(call.body);
    if (!answer.success) return { kind: 'problem', problem: 'unreachable' };
    const consignment = answer.data.consignment;
    const consignmentId = courierId(consignment?.consignment_id);
    const trackingCode = consignment?.tracking_code.trim().toUpperCase() ?? '';
    if (said200(answer.data.status) && consignmentId !== null && trackingCode !== '') {
      if (!/^[A-Z0-9-]{1,64}$/.test(trackingCode)) {
        // A code our column cannot keep: the parcel exists at Steadfast, but not here. Asking by
        // the invoice says the same, so it fails with Steadfast's own code in the log
        this.logger.warn(`Steadfast answered a tracking code we cannot keep: ${trackingCode}`);
        return { kind: 'problem', problem: 'unreachable' };
      }
      return {
        kind: 'booked',
        parcel: {
          consignmentId,
          trackingCode,
          trackingUrl: trackingUrlOf(trackingCode),
          status: statusOf(consignment?.status) ?? 'booked',
        },
      };
    }
    const detail = refusalOf(answer.data);
    // The invoice is unique per merchant at Steadfast: an earlier call got there first
    if (detail !== null && /invoice/i.test(detail) && /taken|exist|duplicate/i.test(detail)) {
      return { kind: 'taken' };
    }
    return { kind: 'refused', detail };
  }

  // Steadfast answers where a parcel with this invoice is, but not its id or its tracking code
  async find(keys: CourierKeys, invoice: string): Promise<FindAnswer> {
    const call = await this.call(keys, `/status_by_invoice/${encodeURIComponent(invoice)}`);
    if (call.kind === 'problem') return call;
    const answer = statusSchema.safeParse(call.body);
    if (!answer.success) return { kind: 'problem', problem: 'unreachable' };
    // A 404, or its own status saying so: no parcel has this invoice
    if (call.httpStatus === 404 || !said200(answer.data.status)) return { kind: 'none' };
    return answer.data.delivery_status == null ? { kind: 'none' } : { kind: 'exists' };
  }

  async status(keys: CourierKeys, consignmentId: string): Promise<StatusAnswer> {
    const call = await this.call(keys, `/status_by_cid/${encodeURIComponent(consignmentId)}`);
    if (call.kind === 'problem') return call;
    const answer = statusSchema.safeParse(call.body);
    const word = answer.success ? answer.data.delivery_status?.trim() : undefined;
    if (!answer.success || !said200(answer.data.status) || word === undefined || word === '') {
      return { kind: 'problem', problem: 'unreachable' };
    }
    return { kind: 'status', status: statusOf(word), word: word.slice(0, 64) };
  }

  // Steadfast's two notices (28a.1's steadfastWebhookSchema): delivery_status, with the new status
  // and tracking_message, and tracking_update, with words only
  readNotice(body: unknown): CourierNotice {
    const parsed = steadfastWebhookSchema.safeParse(body);
    const raw: Record<string, unknown> =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? Object.fromEntries(Object.entries(body))
        : { body };
    if (!parsed.success) return { consignmentId: null, invoice: null, raw, kind: 'unread' };
    const notice = parsed.data;
    const ids = {
      consignmentId: courierId(notice.consignment_id),
      invoice: courierText(notice.invoice),
      raw,
    };
    const note = courierText(notice.tracking_message);
    const at = steadfastTime(notice.updated_at);
    const type = notice.notification_type?.trim().toLowerCase();
    if (type === 'tracking_update') {
      return note === null ? { ...ids, kind: 'unread' } : { ...ids, kind: 'note', note, at };
    }
    // delivery_status, or a notice with a status and no type
    if (notice.status === undefined) return { ...ids, kind: 'unread' };
    const status = statusOf(notice.status);
    return status === null
      ? { ...ids, kind: 'unread' }
      : { ...ids, kind: 'status', status, note, at };
  }

  // Steadfast's balance: it reads, changes nothing, and needs both keys
  async test(keys: CourierKeys): Promise<CourierProblem | null> {
    const call = await this.call(keys, '/get_balance');
    if (call.kind === 'problem') return call.problem;
    const answer = balanceSchema.safeParse(call.body);
    if (!answer.success) return 'unreachable';
    return said200(answer.data.status) ? null : 'rejected';
  }

  // The answer's JSON, or a problem when there is none to read: no connection, a timeout, a server
  // error, or a body that is not JSON (a proxy's error page). 401 and 403 are the keys refused,
  // here or in the body's own status. A 4xx with a JSON body is an answer (a refused booking).
  // Never throws, and never logs the keys
  private async call(
    keys: CourierKeys,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Call> {
    try {
      const response = await this.fetchFn(`${BASE_URL}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'Api-Key': keys.apiKey,
          'Secret-Key': keys.secretKey,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 || response.status === 403) {
        return { kind: 'problem', problem: 'rejected' };
      }
      if (response.status >= 500) {
        this.logger.warn(`Steadfast answered HTTP ${String(response.status)}`);
        return { kind: 'problem', problem: 'unreachable' };
      }
      const json: unknown = await response.json();
      const own =
        typeof json === 'object' && json !== null && 'status' in json ? String(json.status) : '';
      if (own === '401' || own === '403') return { kind: 'problem', problem: 'rejected' };
      return { kind: 'answer', httpStatus: response.status, body: json };
    } catch (error) {
      this.logger.warn(
        `Steadfast did not answer: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return { kind: 'problem', problem: 'unreachable' };
    }
  }
}
