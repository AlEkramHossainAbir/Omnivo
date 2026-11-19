import {
  addMoney,
  type CreateStorefrontCouponInput,
  type ShopDiscount,
  type StorefrontCoupon,
  type storefrontCouponQuerySchema,
  storefrontCouponStatus,
  todayIn,
  type UpdateStorefrontCouponInput,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { MockProblem } from './mock';
import { pageOf } from './sales-document-data';
import type { MockCoupon } from './storefront-seed';
import type { WorkspaceData } from './workspace-data';

// Step 27c: Storefront → Coupons with the API's rules (apps/api/src/storefront/admin/
// coupons.service.ts). Like storefront-order-data.ts, this file imports workspace-data.ts's type
// only, because workspace-data.ts imports the seed below; the audit rows are written by the
// handlers (handlers.ts), with the snapshots made here.
//
// The garments workspace has the mockup's coupons (27c.6): four in play (WELCOME10 and
// DIABETIC-CARE once per mobile number, FLAT50 until a day 6 weeks away, WINTER15 starting in 12
// days), two ended (PUJA20 by its last day, FIRST100 by its 100 uses) and two archived. Their days
// are counted from today, so the statuses stay the same on any day the tests run. The pharma
// workspace has none.

type CouponQuery = z.output<typeof storefrontCouponQuerySchema>;
// What the form saves: the same boxes for a new coupon and a change (less the version)
type CouponFields = Omit<UpdateStorefrontCouponInput, 'version'>;

function now(): string {
  return new Date().toISOString();
}

// Amounts as Postgres keeps them ("50.0000"), so the page reads what the API would send
function money(value: string): string {
  return addMoney(value, '0');
}

// An ISO day a number of days from another, counted on the calendar (UTC noon, so no clock change
// moves it a day)
function dayFrom(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The pill's today: the workspace's, like the coupon's days (decision 2)
function todayOf(data: WorkspaceData): string {
  return todayIn(data.settings.timezone);
}

function notFound(): MockProblem {
  return new MockProblem(404, 'not_found');
}

// The two refusals that belong to the code box (the API's codeTaken() and codeLocked())
function codeProblem(code: 'storefront_coupon_code_taken' | 'storefront_coupon_code_locked') {
  return new MockProblem(409, code, { code: [code] });
}

function findCoupon(data: WorkspaceData, id: string): MockCoupon {
  const coupon = data.storefront.coupons.find((candidate) => candidate.id === id);
  if (!coupon) throw notFound();
  return coupon;
}

// The code's unique key covers archived coupons too: restoring one must not meet its own code
// on another coupon
function assertCodeFree(data: WorkspaceData, code: string, except?: string): void {
  if (data.storefront.coupons.some((coupon) => coupon.code === code && coupon.id !== except)) {
    throw codeProblem('storefront_coupon_code_taken');
  }
}

export function toCoupon(data: WorkspaceData, coupon: MockCoupon): StorefrontCoupon {
  return {
    id: coupon.id,
    code: coupon.code,
    discount: coupon.discount,
    upTo: coupon.upTo,
    minimum: coupon.minimum,
    startsOn: coupon.startsOn,
    lastDay: coupon.lastDay,
    usageLimit: coupon.usageLimit,
    onePerPhone: coupon.onePerPhone,
    used: coupon.used,
    codeLocked: coupon.codeLocked,
    status: storefrontCouponStatus(coupon, todayOf(data)),
    version: coupon.version,
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// The audit's view (the API's snapshot()): plain values, the discount as one short text

function discountText(discount: ShopDiscount): string {
  return discount.kind === 'percent'
    ? `percent ${String(discount.value)}`
    : `amount ${money(discount.value)}`;
}

export function couponSnapshot(coupon: CouponFields) {
  return {
    code: coupon.code,
    discount: discountText(coupon.discount),
    upTo: coupon.upTo === null ? null : money(coupon.upTo),
    minimum: coupon.minimum === null ? null : money(coupon.minimum),
    startsOn: coupon.startsOn,
    lastDay: coupon.lastDay,
    usageLimit: coupon.usageLimit,
    onePerPhone: coupon.onePerPhone,
  };
}

// The form's fields as the table keeps them: the amounts to 4 decimals, as Postgres does
function fieldsOf(input: CouponFields): CouponFields {
  return {
    code: input.code,
    discount:
      input.discount.kind === 'amount'
        ? { kind: 'amount', value: money(input.discount.value) }
        : input.discount,
    upTo: input.upTo === null ? null : money(input.upTo),
    minimum: input.minimum === null ? null : money(input.minimum),
    startsOn: input.startsOn,
    lastDay: input.lastDay,
    usageLimit: input.usageLimit,
    onePerPhone: input.onePerPhone,
  };
}

// ---------------------------------------------------------------------------------------------
// The routes

// Newest first, one tab at a time, by part of the code. The schema upper-cased the search, like
// the codes, so `includes` finds "WEL" in WELCOME10 and reads % and _ as themselves
export function couponPage(
  data: WorkspaceData,
  query: CouponQuery,
): { items: StorefrontCoupon[]; nextCursor: string | null } {
  const archived = query.view === 'archived';
  const search = query.search ?? '';
  const found = data.storefront.coupons
    .filter((coupon) => (coupon.archivedAt !== null) === archived)
    .filter((coupon) => search === '' || coupon.code.includes(search))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const page = pageOf(found, query);
  return { items: page.items.map((coupon) => toCoupon(data, coupon)), nextCursor: page.nextCursor };
}

export function couponOf(data: WorkspaceData, id: string): StorefrontCoupon {
  return toCoupon(data, findCoupon(data, id));
}

// A coupon needs no shop (decision 23): it can be made before the shop is set up, and waits
export function createCoupon(data: WorkspaceData, input: CreateStorefrontCouponInput): MockCoupon {
  assertCodeFree(data, input.code);
  const at = now();
  const coupon: MockCoupon = {
    id: crypto.randomUUID(),
    ...fieldsOf(input),
    used: 0,
    codeLocked: false,
    archivedAt: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  data.storefront.coupons.push(coupon);
  return coupon;
}

// The version first, then the locked code (decision 16), then the code's owner: the API's order
export function updateCoupon(
  data: WorkspaceData,
  id: string,
  input: UpdateStorefrontCouponInput,
): { coupon: MockCoupon; before: CouponFields } {
  const coupon = findCoupon(data, id);
  if (coupon.version !== input.version) throw new MockProblem(409, 'version_conflict');
  if (coupon.codeLocked && input.code !== coupon.code) {
    throw codeProblem('storefront_coupon_code_locked');
  }
  assertCodeFree(data, input.code, id);
  const before = fieldsOf(coupon);
  Object.assign(coupon, fieldsOf(input), { version: coupon.version + 1, updatedAt: now() });
  return { coupon, before };
}

// Archive and restore. Asking for the state it is in already answers the coupon as it is, with no
// new version and no audit row (`changed`), like the API
export function setCouponArchived(
  data: WorkspaceData,
  id: string,
  version: number,
  archived: boolean,
): { coupon: MockCoupon; changed: boolean } {
  const coupon = findCoupon(data, id);
  if (coupon.version !== version) throw new MockProblem(409, 'version_conflict');
  if ((coupon.archivedAt !== null) === archived) return { coupon, changed: false };
  coupon.archivedAt = archived ? now() : null;
  coupon.version += 1;
  coupon.updatedAt = now();
  return { coupon, changed: true };
}

// ---------------------------------------------------------------------------------------------
// The seed

interface SeedCoupon {
  fields: CouponFields;
  used: number;
  // Days ago it was made, and archived (null: in play)
  madeDaysAgo: number;
  archivedDaysAgo: number | null;
}

export function seedCoupons(data: WorkspaceData): void {
  const today = todayOf(data);
  const day = (days: number) => dayFrom(today, days);
  const coupon = (fields: Partial<CouponFields> & Pick<CouponFields, 'code' | 'discount'>) => ({
    upTo: null,
    minimum: null,
    startsOn: null,
    lastDay: null,
    usageLimit: null,
    onePerPhone: false,
    ...fields,
  });
  const seeds: SeedCoupon[] = [
    {
      fields: coupon({
        code: 'WELCOME10',
        discount: { kind: 'percent', value: 10 },
        upTo: '200',
        usageLimit: 500,
        onePerPhone: true,
      }),
      used: 37,
      madeDaysAgo: 1,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'FLAT50',
        discount: { kind: 'amount', value: '50' },
        minimum: '500',
        lastDay: day(42),
      }),
      used: 112,
      madeDaysAgo: 9,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'WINTER15',
        discount: { kind: 'percent', value: 15 },
        upTo: '300',
        minimum: '1000',
        startsOn: day(12),
        lastDay: day(73),
      }),
      used: 0,
      madeDaysAgo: 14,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'DIABETIC-CARE',
        discount: { kind: 'amount', value: '100' },
        minimum: '1500',
        startsOn: day(-18),
        usageLimit: 100,
        onePerPhone: true,
      }),
      used: 18,
      madeDaysAgo: 20,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'PUJA20',
        discount: { kind: 'percent', value: 20 },
        minimum: '800',
        startsOn: day(-41),
        lastDay: day(-35),
      }),
      used: 64,
      madeDaysAgo: 60,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'FIRST100',
        discount: { kind: 'amount', value: '100' },
        minimum: '700',
        usageLimit: 100,
        onePerPhone: true,
      }),
      used: 100,
      madeDaysAgo: 120,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'BOISHAKH25',
        discount: { kind: 'percent', value: 25 },
        upTo: '500',
        minimum: '1200',
        startsOn: day(-219),
        lastDay: day(-213),
      }),
      used: 41,
      madeDaysAgo: 230,
      archivedDaysAgo: 200,
    },
    {
      fields: coupon({ code: 'TEST5', discount: { kind: 'percent', value: 5 } }),
      used: 0,
      madeDaysAgo: 240,
      archivedDaysAgo: 235,
    },
  ];
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  data.storefront.coupons = seeds.map((seed) => ({
    id: crypto.randomUUID(),
    ...fieldsOf(seed.fields),
    used: seed.used,
    // A coupon with a use has had an order; one without (WINTER15, TEST5) may still change its code
    codeLocked: seed.used > 0,
    archivedAt: seed.archivedDaysAgo === null ? null : daysAgo(seed.archivedDaysAgo),
    version: 1,
    createdAt: daysAgo(seed.madeDaysAgo),
    updatedAt: daysAgo(seed.archivedDaysAgo ?? seed.madeDaysAgo),
  }));
}
