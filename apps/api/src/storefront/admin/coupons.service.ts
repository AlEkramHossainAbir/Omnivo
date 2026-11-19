import { Inject, Injectable } from '@nestjs/common';
import {
  addMoney,
  type CreateStorefrontCouponInput,
  DEFAULT_SETTINGS,
  SHOP_ORDER_HOLD_MINUTES,
  type ShopDiscount,
  type StorefrontCoupon,
  type StorefrontCouponPage,
  type storefrontCouponQuerySchema,
  storefrontCouponStatus,
  todayIn,
  type UpdateStorefrontCouponInput,
} from '@omnivo/contracts';
import { storefrontCoupons, tenantSettings } from '@omnivo/db';
import { and, desc, eq, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../../common/audit/audit.js';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from '../../common/db/pg-errors.js';
import { containsPattern } from '../../common/db/search.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { isoText } from '../listing-sql.js';

type CouponRow = typeof storefrontCoupons.$inferSelect;
type CouponQuery = z.output<typeof storefrontCouponQuerySchema>;
// What the form saves: the same boxes for a new coupon and a change (less the version)
type CouponFields = Omit<UpdateStorefrontCouponInput, 'version'>;

// [created_at as text, id]: newest first. The time as Postgres's own text to the microsecond
// (isoText): a JavaScript Date keeps milliseconds only, and a cursor cut to the millisecond would
// show a coupon made in the same millisecond on two pages, or on none
const cursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);

// The orders that hold a use now, counted by the database function the shop uses (0074), so the
// list's "12 of 100 used" is the number the quote judges by. A pending order counts only inside
// its hold, measured from the database's clock here (the ERP has no ShopDb clock)
const used =
  sql<number>`storefront_coupon_uses(${storefrontCoupons.id}, now() - make_interval(mins => ${SHOP_ORDER_HOLD_MINUTES}))`.mapWith(
    Number,
  );

function codeTaken(): AppError {
  return new AppError(409, 'storefront_coupon_code_taken', 'Another coupon has this code.', {
    fieldErrors: { code: ['storefront_coupon_code_taken'] },
  });
}

function codeLocked(): AppError {
  return new AppError(
    409,
    'storefront_coupon_code_locked',
    'An order has had this code, so it can no longer change.',
    { fieldErrors: { code: ['storefront_coupon_code_locked'] } },
  );
}

// The database's answers in the form's words. The code's unique key covers archived coupons too.
// A new code after an order had the old one is refused twice over: by 0074's guard (any order
// ever placed, first_ordered_at) and by the orders' foreign key, which names the code (an order
// that still exists). The check below in TypeScript gives the same answer first; these catch the
// race in which the first order lands while the form is being saved
function mapped(error: unknown): unknown {
  if (isUniqueViolation(error, 'storefront_coupons_code_key')) return codeTaken();
  if (
    isCheckViolation(error, 'storefront_coupons_code_locked') ||
    isForeignKeyViolation(error, 'storefront_orders_coupon_fk')
  ) {
    return codeLocked();
  }
  return error;
}

// The discount for the audit log as one short value, "percent 10" or "amount 50.0000", like a
// listing's sale, so a change reads "percent 10 → percent 15"
function discountText(discount: ShopDiscount): string {
  return discount.kind === 'percent'
    ? `percent ${String(discount.value)}`
    : `amount ${addMoney(discount.value, '0')}`;
}

function discountOf(row: CouponRow): ShopDiscount {
  // A percent is a whole number in a numeric(19,4) column ("10.0000")
  return row.discountKind === 'percent'
    ? { kind: 'percent', value: Number(row.discountValue) }
    : { kind: 'amount', value: row.discountValue };
}

// Plain values only (auditValueSchema). The amounts through addMoney, so "50" typed and "50.0000"
// read back are one value and an unchanged box is no change
function snapshot(coupon: CouponFields) {
  return {
    code: coupon.code,
    discount: discountText(coupon.discount),
    upTo: coupon.upTo === null ? null : addMoney(coupon.upTo, '0'),
    minimum: coupon.minimum === null ? null : addMoney(coupon.minimum, '0'),
    startsOn: coupon.startsOn,
    lastDay: coupon.lastDay,
    usageLimit: coupon.usageLimit,
    onePerPhone: coupon.onePerPhone,
  };
}

function fieldsOf(row: CouponRow): CouponFields {
  return {
    code: row.code,
    discount: discountOf(row),
    upTo: row.upTo,
    minimum: row.minimum,
    startsOn: row.startsOn,
    lastDay: row.lastDay,
    usageLimit: row.usageLimit,
    onePerPhone: row.onePerPhone,
  };
}

// The columns the form writes, from the checked input
function columnsOf(input: CouponFields) {
  return {
    code: input.code,
    discountKind: input.discount.kind,
    discountValue: String(input.discount.value),
    upTo: input.upTo,
    minimum: input.minimum,
    startsOn: input.startsOn,
    lastDay: input.lastDay,
    usageLimit: input.usageLimit,
    onePerPhone: input.onePerPhone,
  };
}

// Step 27c: Storefront → Coupons (decision 5, storefront.manage). A coupon may be made before the
// shop is set up or open: the shop's policies hide every coupon until it is launched, so a tenant
// can have WELCOME10 ready for the first day. Never deleted (decision 18): an order points at it.
@Injectable()
export class StorefrontCouponsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(q: CouponQuery): Promise<StorefrontCouponPage> {
    return this.withTenant(async (tx) => {
      const today = await this.today(tx);
      const filters: SQL[] = [
        eq(storefrontCoupons.tenantId, getTenantId()),
        q.view === 'archived'
          ? isNotNull(storefrontCoupons.archivedAt)
          : isNull(storefrontCoupons.archivedAt),
      ];
      // Part of the code. The schema upper-cased it like the codes, and containsPattern lower-
      // cases it again, so the column is compared lower-cased too (and LIKE's % and _ are literal)
      if (q.search !== undefined && q.search !== '') {
        filters.push(sql`lower(${storefrontCoupons.code}) LIKE ${containsPattern(q.search)}`);
      }
      const cursor = decodeCursor(q.cursor, cursorSchema);
      if (cursor !== undefined) {
        const [createdAt, id] = cursor;
        filters.push(
          sql`(${storefrontCoupons.createdAt}, ${storefrontCoupons.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
        );
      }
      const rows = await tx
        .select({
          coupon: storefrontCoupons,
          used,
          createdKey: isoText(sql`${storefrontCoupons.createdAt}`).mapWith(String),
        })
        .from(storefrontCoupons)
        .where(and(...filters))
        // storefront_coupons_list_idx
        .orderBy(desc(storefrontCoupons.createdAt), desc(storefrontCoupons.id))
        .limit(q.limit + 1);
      const page = toPage(rows, q.limit, (last) => [last.createdKey, last.coupon.id]);
      return {
        items: page.items.map((row) => couponOf(row.coupon, row.used, today)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<StorefrontCoupon> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: CreateStorefrontCouponInput): Promise<StorefrontCoupon> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(storefrontCoupons)
          .values({
            tenantId: getTenantId(),
            ...columnsOf(input),
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Coupon insert returned no row');
        await audit(tx, {
          action: 'storefront_coupon.created',
          entityType: 'storefront_coupon',
          entityId: row.id,
          changes: created(snapshot(input)),
        });
        return couponOf(row, 0, await this.today(tx));
      });
    } catch (error) {
      throw mapped(error);
    }
  }

  async update(id: string, input: UpdateStorefrontCouponInput): Promise<StorefrontCoupon> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        // Decision 2: once an order has had the code, the code stays. The rest may change: a
        // later last day, a bigger limit. An order already placed keeps what it was given
        if (before.firstOrderedAt !== null && input.code !== before.code) throw codeLocked();
        await this.write(tx, id, columnsOf(input));
        await audit(tx, {
          action: 'storefront_coupon.updated',
          entityType: 'storefront_coupon',
          entityId: id,
          changes: diff(snapshot(fieldsOf(before)), snapshot(input)),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      throw mapped(error);
    }
  }

  // Archived: the shop no longer knows the code (0074's policy), so the quote answers "unknown".
  // An order placed with it keeps its discount. Restoring gives it back with its uses as they are
  setArchived(id: string, version: number, archived: boolean): Promise<StorefrontCoupon> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) !== archived) {
        await this.write(tx, id, { archivedAt: archived ? new Date() : null });
        await audit(tx, {
          action: archived ? 'storefront_coupon.archived' : 'storefront_coupon.restored',
          entityType: 'storefront_coupon',
          entityId: id,
        });
      }
      return this.read(tx, id);
    });
  }

  // FOR UPDATE: two saves of one coupon take turns, and the version check sees the first one's.
  // Placing an order locks the same row, so a code change waits for an order that is being placed
  private async lock(tx: Transaction, id: string): Promise<CouponRow> {
    const [row] = await tx
      .select()
      .from(storefrontCoupons)
      .where(and(eq(storefrontCoupons.tenantId, getTenantId()), eq(storefrontCoupons.id, id)))
      .for('update');
    if (!row) throw notFound('Coupon');
    return row;
  }

  // Every ERP change moves the version, so a form open elsewhere reloads first. Placing an order
  // never does (markOrdered sets first_ordered_at only): the form may still save, and a new code
  // is then refused on its own (codeLocked)
  private async write(
    tx: Transaction,
    id: string,
    columns: Partial<ReturnType<typeof columnsOf>> & { archivedAt?: Date | null },
  ): Promise<void> {
    await tx
      .update(storefrontCoupons)
      .set({
        ...columns,
        version: sql`${storefrontCoupons.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(storefrontCoupons.tenantId, getTenantId()), eq(storefrontCoupons.id, id)));
  }

  private async read(tx: Transaction, id: string): Promise<StorefrontCoupon> {
    const [row] = await tx
      .select({ coupon: storefrontCoupons, used })
      .from(storefrontCoupons)
      .where(and(eq(storefrontCoupons.tenantId, getTenantId()), eq(storefrontCoupons.id, id)));
    if (!row) throw notFound('Coupon');
    return couponOf(row.coupon, row.used, await this.today(tx));
  }

  // The status pill's today: the workspace's, like the coupon's days (decision 2)
  private async today(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    return todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone);
  }
}

function couponOf(row: CouponRow, usedNow: number, today: string): StorefrontCoupon {
  const archivedAt = row.archivedAt?.toISOString() ?? null;
  return {
    id: row.id,
    ...fieldsOf(row),
    used: usedNow,
    // Decision 16: any order ever placed with the code, a cancelled or dropped one too
    codeLocked: row.firstOrderedAt !== null,
    status: storefrontCouponStatus(
      {
        archivedAt,
        startsOn: row.startsOn,
        lastDay: row.lastDay,
        usageLimit: row.usageLimit,
        used: usedNow,
      },
      today,
    ),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
