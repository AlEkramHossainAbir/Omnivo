import {
  compareMoney,
  COURIER_EXPORT_MAX_ROWS,
  COURIER_OF_PROVIDER,
  type CourierAccount,
  type CourierAccountSaved,
  type CourierChoices,
  type CourierExport,
  type CourierSetup,
  type CourierTestProblem,
  type CreateCourierAccountInput,
  type ErrorCode,
  isOpenShipment,
  routes,
  type ShopShipmentStatus,
  type StorefrontShipment,
  subtractMoney,
  sumMoney,
  type UpdateCourierAccountInput,
} from '@omnivo/contracts';

import { API_URL } from '../lib/api';
import { MockProblem } from './mock';
import type { MockCourierAccount, MockShipment, MockShopOrder } from './storefront-seed';
import type { WorkspaceData } from './workspace-data';

// Step 28a: the shop's couriers in the ERP, with the API's rules: Shop couriers
// (apps/api/src/storefront/shipping/courier-accounts.service.ts) and an order's parcels
// (shipments.ts). The mock has no worker and no courier. A parcel booked by API waits in `booking`
// for MOCK_BOOK_MS and is then answered the way the API's FakeCourier answers (settleBookings),
// the first time anything reads the shop's orders after that: the order page asks again every 3
// seconds while a parcel books, so it sees the answer as it would see the worker's.
//
// This file imports no other storefront mock file but the seed's types, like
// storefront-payment-data.ts: storefront-order-data.ts imports it. The audit rows are the
// handlers' (handlers.ts).

// How long the pretend worker takes to book. The API's first try runs within a second or two
export const MOCK_BOOK_MS = 2000;

// The API's FakeCourier: this phone makes the courier refuse the parcel, and these two API keys
// make it answer like Steadfast on a bad day (apps/api/src/shipping/fake-courier.ts)
const FAKE_REFUSED_PHONE = '01700000000';

function fakeProblem(keys: { apiKey: string } | null): CourierTestProblem | null {
  if (keys?.apiKey === 'fake_rejected') return 'rejected';
  if (keys?.apiKey === 'fake_unreachable') return 'unreachable';
  return null;
}

function now(): string {
  return new Date().toISOString();
}

function later(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

// A token like the API's newToken(): 128 random bits as 22 base64url characters
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// The fake courier's answer depends on the invoice only, so a retry gets the same id and code.
// The API hashes with SHA-256 (async in a browser); FNV-1a is enough for a stable mock value
function hashOf(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function fakeBooking(invoice: string): { consignmentId: string; trackingCode: string } {
  const a = hashOf(invoice, 2166136261);
  const b = hashOf(invoice, 3735928559);
  return {
    consignmentId: String(100_000_000 + (a % 900_000_000)),
    trackingCode: `FAKE${b.toString(16).toUpperCase().padStart(8, '0')}${(a & 0xff).toString(16).toUpperCase().padStart(2, '0')}`,
  };
}

function notFound(): MockProblem {
  return new MockProblem(404, 'not_found');
}

function archived(field?: string): MockProblem {
  return new MockProblem(
    409,
    'courier_account_archived',
    field === undefined ? undefined : { [field]: ['courier_account_archived'] },
  );
}

function notBookable(field: string): MockProblem {
  return new MockProblem(422, 'courier_account_not_bookable', {
    [field]: ['courier_account_not_bookable'],
  });
}

function hasParcel(): MockProblem {
  return new MockProblem(409, 'storefront_order_has_parcel');
}

function orderNotBookable(): MockProblem {
  return new MockProblem(409, 'storefront_order_not_bookable');
}

// ---------------------------------------------------------------------------------------------
// Courier accounts (Shop couriers)

function findAccount(data: WorkspaceData, id: string): MockCourierAccount {
  const found = data.storefront.couriers.find((account) => account.id === id);
  if (!found) throw notFound();
  return found;
}

function lockAccount(data: WorkspaceData, id: string, version: number): MockCourierAccount {
  const account = findAccount(data, id);
  if (account.version !== version) throw new MockProblem(409, 'version_conflict');
  return account;
}

// Never the keys, and never a token: only whether one is saved
export function toCourierAccount(account: MockCourierAccount): CourierAccount {
  return {
    id: account.id,
    provider: account.provider,
    name: account.name,
    courier: account.courier,
    status: account.archivedAt === null ? 'active' : 'archived',
    webhookUrl:
      account.provider === 'manual'
        ? null
        : `${API_URL}${routes.shipping.steadfastWebhook.path.replace(':id', account.id)}`,
    hasWebhookToken: account.hasWebhookToken,
    lastWebhookAt: account.lastWebhookAt,
    lastTest: account.lastTest,
    version: account.version,
    updatedAt: account.updatedAt,
  };
}

// The audit's view (the API's snapshot): plain values, never a key or a token
export function courierSnapshot(account: MockCourierAccount) {
  return {
    name: account.name,
    provider: account.provider,
    courier: account.courier,
    status: account.archivedAt === null ? 'active' : 'archived',
  };
}

// Active ones first, then by name: the page's two tabs read one list
export function courierSetup(data: WorkspaceData): CourierSetup {
  const accounts = data.storefront.couriers.toSorted(
    (a, b) =>
      Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  return {
    accounts: accounts.map(toCourierAccount),
    defaultAccountId: accounts.find((account) => account.isDefault)?.id ?? null,
  };
}

// What the Packed dialog and Book courier offer the packer: active accounts by name
export function courierChoicesOf(data: WorkspaceData): CourierChoices {
  const active = data.storefront.couriers
    .filter((account) => account.archivedAt === null)
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    accounts: active.map(({ id, provider, name, courier }) => ({ id, provider, name, courier })),
    defaultAccountId: active.find((account) => account.isDefault)?.id ?? null,
  };
}

// An API account answers its webhook token once; a manual account has none
export function createCourier(
  data: WorkspaceData,
  input: CreateCourierAccountInput,
): { account: MockCourierAccount; saved: CourierAccountSaved } {
  const at = now();
  const token = input.provider === 'manual' ? null : newToken();
  const account: MockCourierAccount = {
    id: crypto.randomUUID(),
    provider: input.provider,
    name: input.name,
    courier: input.provider === 'manual' ? input.courier : COURIER_OF_PROVIDER[input.provider],
    keys: input.provider === 'manual' ? null : { apiKey: input.apiKey, secretKey: input.secretKey },
    hasWebhookToken: token !== null,
    isDefault: false,
    archivedAt: null,
    lastWebhookAt: null,
    lastTest: null,
    version: 1,
    updatedAt: at,
  };
  data.storefront.couriers.push(account);
  return { account, saved: { account: toCourierAccount(account), webhookToken: token } };
}

// An empty key box keeps the saved key. New keys clear the last test: it was about the old ones
export function updateCourier(
  data: WorkspaceData,
  id: string,
  input: UpdateCourierAccountInput,
): { before: MockCourierAccount; after: MockCourierAccount; keysChanged: boolean } {
  const account = lockAccount(data, id, input.version);
  if (account.archivedAt !== null) throw archived();
  if (input.provider !== account.provider) throw new MockProblem(409, 'courier_provider_fixed');
  const before = { ...account };
  let keysChanged = false;
  if (input.provider !== 'manual') {
    const apiKey = input.apiKey !== '' ? input.apiKey : (account.keys?.apiKey ?? '');
    const secretKey = input.secretKey !== '' ? input.secretKey : (account.keys?.secretKey ?? '');
    keysChanged = account.keys?.apiKey !== apiKey || account.keys.secretKey !== secretKey;
    if (keysChanged) Object.assign(account, { keys: { apiKey, secretKey }, lastTest: null });
  } else {
    account.courier = input.courier;
  }
  Object.assign(account, { name: input.name, version: account.version + 1, updatedAt: now() });
  return { before, after: account, keysChanged };
}

// "Test connection": the saved keys, answered like the API's FakeCourier. No version change
export function testCourier(data: WorkspaceData, id: string): MockCourierAccount {
  const account = findAccount(data, id);
  if (account.provider === 'manual') throw notBookable('id');
  account.lastTest = { at: now(), problem: fakeProblem(account.keys) };
  return account;
}

// A new token replaces the old one at once
export function renewCourierToken(
  data: WorkspaceData,
  id: string,
  version: number,
): CourierAccountSaved {
  const account = lockAccount(data, id, version);
  if (account.provider === 'manual') throw notBookable('id');
  if (account.archivedAt !== null) throw archived();
  Object.assign(account, { hasWebhookToken: true, version: account.version + 1, updatedAt: now() });
  return { account: toCourierAccount(account), webhookToken: newToken() };
}

// Archived: not offered for new parcels, and no longer the default. changed is false when it was
// already as asked (a second tab's click): no audit row then
export function setCourierArchived(
  data: WorkspaceData,
  id: string,
  version: number,
  archive: boolean,
): { before: MockCourierAccount; after: MockCourierAccount; changed: boolean } {
  const account = lockAccount(data, id, version);
  const before = { ...account };
  if ((account.archivedAt !== null) === archive) return { before, after: account, changed: false };
  Object.assign(account, {
    archivedAt: archive ? now() : null,
    ...(archive ? { isDefault: false } : {}),
    version: account.version + 1,
    updatedAt: now(),
  });
  return { before, after: account, changed: true };
}

// The Packed dialog's first choice, or none: an active API account only. change is null when it
// was already so (no audit row then)
export function setDefaultCourier(
  data: WorkspaceData,
  accountId: string | null,
): { setup: CourierSetup; change: { from: string | null; to: string | null } | null } {
  const before = data.storefront.couriers.find((account) => account.isDefault) ?? null;
  let next: MockCourierAccount | null = null;
  if (accountId !== null) {
    next = findAccount(data, accountId);
    if (next.provider === 'manual' || next.archivedAt !== null) throw notBookable('accountId');
  }
  if (before?.id === next?.id) return { setup: courierSetup(data), change: null };
  for (const account of data.storefront.couriers) account.isDefault = account.id === next?.id;
  return {
    setup: courierSetup(data),
    change: { from: before?.name ?? null, to: next?.name ?? null },
  };
}

// ---------------------------------------------------------------------------------------------
// Parcels

// What the rider collects: the total less what the order's paid tries took, never below zero
export function codAmountOf(order: MockShopOrder): string {
  const paid = order.payments
    .filter((payment) => payment.status === 'paid')
    .map((payment) => payment.amount);
  const left = subtractMoney(order.total, sumMoney(paid));
  return compareMoney(left, '0') > 0 ? left : '0.0000';
}

// The list's "Needs attention": a packed order whose last parcel failed to book
export function parcelNeedsAttention(order: MockShopOrder): boolean {
  return order.status === 'packed' && order.shipments.at(-1)?.status === 'booking_failed';
}

export function shipmentsOf(data: WorkspaceData, order: MockShopOrder): StorefrontShipment[] {
  return order.shipments.map((parcel) => {
    const account = findAccount(data, parcel.accountId);
    return {
      id: parcel.id,
      account: { id: account.id, name: account.name, provider: account.provider },
      courier: parcel.courier,
      status: parcel.status,
      consignmentId: parcel.consignmentId,
      trackingCode: parcel.trackingCode,
      codAmount: parcel.codAmount,
      bookedAt: parcel.bookedAt,
      attempts: parcel.attempts,
      error: parcel.error,
      errorDetail: parcel.errorDetail,
      events: parcel.events.slice(-100),
      lastSyncedAt: parcel.lastSyncedAt,
    };
  });
}

function step(parcel: MockShipment, status: ShopShipmentStatus, at: string, note: string | null) {
  parcel.events.push({ status, at, note });
}

// A failed booking rings the bell (the API's onGiveUp). The mock has one member to tell
function ringFailed(data: WorkspaceData, order: MockShopOrder, account: MockCourierAccount): void {
  data.notifications.unshift({
    id: crypto.randomUUID(),
    type: 'storefront.shipment_failed',
    params: { id: order.id, number: order.orderNo, courier: account.name },
    readAt: null,
    createdAt: now(),
  });
}

// The pretend worker (the API's ShipmentBookingHandler with its FakeCourier): every parcel whose
// booking time is up gets the courier's answer. Keys the courier refuses and a phone it refuses
// fail at once (one try, as the API's PermanentJobError); a courier that does not answer fails
// after the API's five tries, which the mock counts at once
export function settleBookings(data: WorkspaceData, at: string = now()): void {
  for (const order of data.storefront.orders) {
    for (const parcel of order.shipments) {
      if (parcel.status !== 'booking' || parcel.bookUntil === null || parcel.bookUntil > at) {
        continue;
      }
      const account = findAccount(data, parcel.accountId);
      const problem = fakeProblem(account.keys);
      const failed: { error: ErrorCode; detail: string | null; tries: number } | null =
        problem === 'rejected'
          ? { error: 'courier_rejected_keys', detail: null, tries: 1 }
          : problem === 'unreachable'
            ? { error: 'courier_unreachable', detail: null, tries: 5 }
            : order.phone === FAKE_REFUSED_PHONE
              ? {
                  error: 'courier_rejected_parcel',
                  detail: 'The recipient phone must be a working mobile number.',
                  tries: 1,
                }
              : null;
      parcel.bookUntil = null;
      if (failed !== null) {
        Object.assign(parcel, {
          status: 'booking_failed',
          attempts: parcel.attempts + failed.tries,
          error: failed.error,
          errorDetail: failed.detail,
        });
        ringFailed(data, order, account);
        continue;
      }
      // Booked: the last error goes, and the booking is the parcel's first step
      Object.assign(parcel, {
        ...fakeBooking(parcel.invoice),
        status: 'booked',
        bookedAt: at,
        attempts: parcel.attempts + 1,
        error: null,
        errorDetail: null,
      });
      step(parcel, 'booked', at, null);
    }
  }
}

// Packed books with an active API account only: a manual parcel needs the courier's code
export function bookableAtPack(data: WorkspaceData, accountId: string): void {
  const account = data.storefront.couriers.find((item) => item.id === accountId);
  if (account === undefined || account.provider === 'manual' || account.archivedAt !== null) {
    throw new MockProblem(422, 'courier_account_not_bookable', {
      courierAccountId: ['courier_account_not_bookable'],
    });
  }
}

// Packed with a courier, or Book courier later. An API account's parcel books in the pretend
// worker; a manual account's parcel is booked at once with the code the member typed. The order's
// version does not change, as in the API (the parcel is its own row)
export function startShipment(
  data: WorkspaceData,
  order: MockShopOrder,
  input: { accountId: string; trackingCode: string },
  at: string = now(),
): MockCourierAccount {
  if (order.status !== 'packed') throw orderNotBookable();
  const account = findAccount(data, input.accountId);
  if (account.archivedAt !== null) throw archived('accountId');
  const manual = account.provider === 'manual';
  if (manual && input.trackingCode === '') {
    throw new MockProblem(422, 'courier_tracking_code_required', {
      trackingCode: ['courier_tracking_code_required'],
    });
  }
  if (order.shipments.some((parcel) => isOpenShipment(parcel.status))) throw hasParcel();
  if (order.shipments.length >= 5) throw orderNotBookable();
  const parcelNo = order.shipments.length + 1;
  const parcel: MockShipment = {
    id: crypto.randomUUID(),
    accountId: account.id,
    parcelNo,
    invoice: parcelNo === 1 ? order.orderNo : `${order.orderNo}-${String(parcelNo)}`,
    courier: account.courier,
    status: manual ? 'booked' : 'booking',
    consignmentId: null,
    trackingCode: manual ? input.trackingCode : null,
    codAmount: codAmountOf(order),
    bookedAt: manual ? at : null,
    attempts: 0,
    error: null,
    errorDetail: null,
    events: [],
    lastSyncedAt: null,
    bookUntil: manual ? null : later(at, MOCK_BOOK_MS),
  };
  if (manual) step(parcel, 'booked', at, null);
  order.shipments.push(parcel);
  return account;
}

// Book again: the same row, so the courier is asked with the same invoice. The last error stays
// while it books again
export function retryShipment(
  data: WorkspaceData,
  order: MockShopOrder,
  shipmentId: string,
  at: string = now(),
): { account: MockCourierAccount; parcel: MockShipment } {
  if (order.status !== 'packed') throw orderNotBookable();
  const parcel = order.shipments.find((item) => item.id === shipmentId);
  if (parcel === undefined) throw notFound();
  if (parcel.status !== 'booking_failed') {
    throw new MockProblem(409, 'storefront_shipment_not_failed');
  }
  if (
    order.shipments.some((item) => item.parcelNo > parcel.parcelNo || isOpenShipment(item.status))
  ) {
    throw hasParcel();
  }
  const account = findAccount(data, parcel.accountId);
  if (account.archivedAt !== null) throw archived();
  Object.assign(parcel, { status: 'booking', bookUntil: later(at, MOCK_BOOK_MS) });
  return { account, parcel };
}

// Cancel: a parcel only booked is cancelled with the order; one still booking, or one the courier
// has, refuses the cancel. A failed one stays as it was
export function cancelShipments(order: MockShopOrder, at: string = now()): void {
  const open = order.shipments.find((parcel) => isOpenShipment(parcel.status));
  if (open === undefined) return;
  if (open.status === 'booking') throw new MockProblem(409, 'storefront_order_parcel_booking');
  if (open.status !== 'booked') throw new MockProblem(409, 'storefront_order_parcel_on_its_way');
  open.status = 'cancelled';
  step(open, 'cancelled', at, null);
}

// Mark shipped and Mark delivered move a parcel booked by hand with them. An API parcel moves
// with its courier's news only
export function followOrder(
  data: WorkspaceData,
  order: MockShopOrder,
  status: 'picked_up' | 'delivered',
  at: string = now(),
): void {
  const open = order.shipments.find(
    (parcel) =>
      isOpenShipment(parcel.status) && findAccount(data, parcel.accountId).provider === 'manual',
  );
  if (open === undefined) return;
  open.status = status;
  step(open, status, at, null);
}

function packedAt(order: MockShopOrder): string {
  return order.history.find((entry) => entry.status === 'packed')?.at ?? order.updatedAt;
}

// The export for a courier's bulk upload: the packed orders with no parcel on its way, oldest
// packed first. The invoice is the one the order's next parcel gets
export function courierExportOf(data: WorkspaceData): CourierExport {
  const waiting = data.storefront.orders
    .filter(
      (order) =>
        order.status === 'packed' &&
        !order.shipments.some((parcel) => isOpenShipment(parcel.status)),
    )
    .toSorted((a, b) => packedAt(a).localeCompare(packedAt(b)) || a.id.localeCompare(b.id));
  const page = waiting.slice(0, COURIER_EXPORT_MAX_ROWS);
  return {
    rows: page.flatMap((order) => {
      const parcels = order.shipments.length;
      if (parcels >= 5) return [];
      return [
        {
          orderId: order.id,
          invoice: parcels === 0 ? order.orderNo : `${order.orderNo}-${String(parcels + 1)}`,
          name: order.customerName,
          address: order.address.replace(/\s+/g, ' ').trim(),
          phone: order.phone,
          amount: codAmountOf(order),
          itemCount: Math.max(
            order.lines.reduce((count, line) => count + line.quantity, 0),
            1,
          ),
        },
      ];
    }),
    more: waiting.length > COURIER_EXPORT_MAX_ROWS,
  };
}

// ---------------------------------------------------------------------------------------------
// The seed

// Rahman Fashion's couriers: Steadfast from its Dhaka pickup point (the default, its news
// arriving), a second Steadfast account for the Chattogram depot whose webhook was never pasted
// (and whose keys the fake courier does not answer, so booking with it fails and Test connection
// says so), Pathao booked by hand at the counter, and an archived RedX account
export function seedCouriers(data: WorkspaceData, at: string): MockCourierAccount[] {
  const account = (
    fields: Pick<MockCourierAccount, 'provider' | 'name' | 'courier' | 'keys'> &
      Partial<MockCourierAccount>,
  ): MockCourierAccount => {
    const item: MockCourierAccount = {
      id: crypto.randomUUID(),
      hasWebhookToken: fields.provider !== 'manual',
      isDefault: false,
      archivedAt: null,
      lastWebhookAt: null,
      lastTest: null,
      version: 1,
      updatedAt: at,
      ...fields,
    };
    data.storefront.couriers.push(item);
    return item;
  };
  return [
    account({
      provider: 'steadfast',
      name: 'Steadfast Dhaka',
      courier: 'steadfast',
      keys: { apiKey: 'sf7k2qd9xw', secretKey: 'sfs81mzp0c' },
      isDefault: true,
      lastWebhookAt: later(now(), -25 * 60_000),
      lastTest: { at: later(now(), -26 * 60 * 60_000), problem: null },
    }),
    account({
      provider: 'steadfast',
      name: 'Steadfast Chattogram',
      courier: 'steadfast',
      keys: { apiKey: 'fake_unreachable', secretKey: 'sfs40ctg7q' },
    }),
    account({ provider: 'manual', name: 'Pathao counter', courier: 'pathao', keys: null }),
    account({
      provider: 'manual',
      name: 'RedX',
      courier: 'redx',
      keys: null,
      archivedAt: later(at, 2 * 24 * 60 * 60_000),
      version: 2,
    }),
  ];
}

// A seeded parcel booked with an API account, with the courier's own id and code and the steps it
// sent since (the seed's story is the real Steadfast, not the fake courier)
export function seedParcel(
  order: MockShopOrder,
  account: MockCourierAccount,
  codes: { consignmentId: string; trackingCode: string },
  bookedAt: string,
  steps: { status: ShopShipmentStatus; at: string; note: string | null }[],
): MockShipment {
  const parcel: MockShipment = {
    id: crypto.randomUUID(),
    accountId: account.id,
    parcelNo: order.shipments.length + 1,
    invoice: order.orderNo,
    courier: account.courier,
    status: steps.at(-1)?.status ?? 'booked',
    ...codes,
    codAmount: codAmountOf(order),
    bookedAt,
    attempts: 1,
    error: null,
    errorDetail: null,
    events: [{ status: 'booked', at: bookedAt, note: null }, ...steps],
    lastSyncedAt: steps.at(-1)?.at ?? bookedAt,
    bookUntil: null,
  };
  order.shipments.push(parcel);
  return parcel;
}
