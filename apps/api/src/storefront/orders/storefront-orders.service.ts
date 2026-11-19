import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  compareQuantity,
  type DocumentRef,
  type ErrorCode,
  isErrorCode,
  multiplyMoney,
  type PackStorefrontOrderInput,
  type StorefrontOrder,
  type StorefrontOrderCounts,
  type StorefrontOrderPage,
  type storefrontOrderQuerySchema,
  STOREFRONT_ORDER_SORTS,
  type StorefrontOrderSort,
  type StorefrontOrderStatus,
  type StorefrontOrderSummary,
  type StorefrontPackPlan,
  storefrontImageSchema,
  spreadMoney,
  sumQuantity,
  subtractQuantity,
  todayIn,
} from '@omnivo/contracts';
import {
  batches,
  deliveries,
  deliveryLines,
  invoices,
  parties,
  products,
  productVariants,
  salesOrderLines,
  salesOrders,
  salesReturns,
  stockBalances,
  storefrontImages,
  storefrontOrderLines,
  storefrontOrders,
  storefrontSettings,
  storefrontStockHolds,
  tenantSettings,
  units,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, gt, inArray, ne, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, diff } from '../../common/audit/audit.js';
import { containsPattern } from '../../common/db/search.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { DeliveriesService } from '../../sales/deliveries.service.js';
import { InvoicesService } from '../../sales/invoices.service.js';
import { SalesOrdersService } from '../../sales/sales-orders.service.js';
import { SalesReturnsService } from '../../sales/sales-returns.service.js';
import { cancelledSms } from '../../sms/shop-sms.js';
import { SmsQueue } from '../../sms/sms-queue.js';
import { isoText } from '../listing-sql.js';
import { shopImage } from '../media.js';
import { historyOf, type OrderLineRow, type OrderRow } from './order-view.js';
import { ShopSalesOrderMaker } from './sales-order-maker.js';

type Query = z.output<typeof storefrontOrderQuerySchema>;

// The pieces in an order, for "3 items" on a phone's card. By the table's name: inside the
// subquery a bare "id" would be the line's
const itemCount = sql<number>`(
  SELECT coalesce(sum(l.quantity), 0)::int FROM storefront_order_lines l
   WHERE l.tenant_id = storefront_orders.tenant_id AND l.order_id = storefront_orders.id
)`;

// Each sort's key, like the catalog's (listings.service.ts): the key's text goes into the cursor,
// ties go by id so the order is total. "confirmed" uses the microseconds (isoText): two orders
// confirmed in one millisecond are not skipped by a cursor. A Record, so a new sort without its
// line here does not compile
const SORTS: Record<
  StorefrontOrderSort,
  { key: SQL; text: SQL; desc: boolean; valid: (key: string) => boolean }
> = {
  '-confirmed': {
    key: sql`${storefrontOrders.confirmedAt}`,
    text: isoText(sql`${storefrontOrders.confirmedAt}`),
    desc: true,
    valid: (key) => !Number.isNaN(Date.parse(key)),
  },
  confirmed: {
    key: sql`${storefrontOrders.confirmedAt}`,
    text: isoText(sql`${storefrontOrders.confirmedAt}`),
    desc: false,
    valid: (key) => !Number.isNaN(Date.parse(key)),
  },
  '-total': {
    key: sql`${storefrontOrders.total}`,
    text: sql`${storefrontOrders.total}::text`,
    desc: true,
    valid: (key) => /^\d{1,15}(?:\.\d{1,4})?$/.test(key),
  },
  total: {
    key: sql`${storefrontOrders.total}`,
    text: sql`${storefrontOrders.total}::text`,
    desc: false,
    valid: (key) => /^\d{1,15}(?:\.\d{1,4})?$/.test(key),
  },
};

// [sort, key, id]: the sort is in it, so a cursor of one order sent with another is refused
const cursorSchema = z.tuple([z.enum(STOREFRONT_ORDER_SORTS), z.string().max(40), z.uuid()]);

function invalidCursor(): AppError {
  return new AppError(400, 'invalid_cursor', 'The cursor is not valid for this list.');
}

function stepInvalid(): AppError {
  return new AppError(
    409,
    'storefront_order_step_invalid',
    'This order has moved on since it was loaded. Reload it.',
  );
}

// The statuses the ERP shows (decision 13). The routes never read a pending order (their WHERE
// says status <> 'pending'), so one here is a bug, and a loud one
function erpStatus(order: OrderRow): StorefrontOrderStatus {
  const { status } = order;
  if (status === 'pending') throw new Error(`Order ${order.id} is still pending`);
  return status;
}

function confirmedAtOf(order: OrderRow): Date {
  if (order.confirmedAt === null) throw new Error(`Order ${order.id} has no confirmed_at`);
  return order.confirmedAt;
}

function numberOf(order: OrderRow): string {
  if (order.orderNo === null) throw new Error(`Order ${order.id} has no number`);
  return order.orderNo;
}

function summaryOf(order: OrderRow, items: number): StorefrontOrderSummary {
  return {
    id: order.id,
    orderNo: numberOf(order),
    status: erpStatus(order),
    placedAt: order.createdAt.toISOString(),
    confirmedAt: confirmedAtOf(order).toISOString(),
    customerName: order.customerName,
    phone: order.phone,
    zoneName: order.zoneName,
    paymentMethod: order.paymentMethod,
    itemCount: items,
    total: order.total,
    needsAttention: order.documentError !== null,
  };
}

// The challan's own errors name its lines (lines.0, lines.1 …); Packed's dialog has the order's
// lines, each split into picks. `at` maps each challan line to its line and pick, so a stock
// error ("only 2 left in this batch") shows under the pick that asked for too much. Like
// onInvoiceLines in invoices.service.ts
function onPicks(error: unknown, at: readonly { line: number; pick: number }[]): never {
  if (!(error instanceof AppError) || error.options.fieldErrors === undefined) throw error;
  const fieldErrors = Object.fromEntries(
    Object.entries(error.options.fieldErrors).map(([path, codes]) => {
      const match = /^lines\.(\d+)\.(.+)$/.exec(path);
      const where = match === null ? undefined : at[Number(match[1])];
      const field = match?.[2];
      return [
        where === undefined || field === undefined
          ? path
          : `lines.${String(where.line)}.picks.${String(where.pick)}.${field}`,
        codes,
      ];
    }),
  );
  throw new AppError(error.status, error.code, error.message, { ...error.options, fieldErrors });
}

function linesError(code: ErrorCode, fieldErrors: Record<string, ErrorCode[]>): AppError {
  return new AppError(409, code, 'Some lines cannot be packed. Check the highlighted fields.', {
    fieldErrors,
  });
}

// Step 27b: the shop's orders in the ERP (Storefront → Shop orders). Reading needs
// storefront.order.read, every move storefront.order.manage (the contract's routes say which;
// the guard checks it). A move makes its ERP documents with the sales services' own code, in one
// transaction with the order's new status (decisions 5, 7, 8), so the documents and the status
// never disagree. No sales.* permission is asked (decision 9): the services check none themselves,
// and the routes that would are not called. Every move locks the order first (FOR UPDATE), then the
// documents; the handler that makes the sales order takes the same lock first, so the two take
// turns instead of waiting for each other in a circle.
@Injectable()
export class StorefrontOrdersService {
  private readonly mediaUrl: string;

  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) config: Config,
    private readonly maker: ShopSalesOrderMaker,
    private readonly salesOrders: SalesOrdersService,
    private readonly deliveries: DeliveriesService,
    private readonly invoices: InvoicesService,
    private readonly salesReturns: SalesReturnsService,
    private readonly sms: SmsQueue,
  ) {
    this.mediaUrl = config.storefront.mediaUrl;
  }

  list(q: Query): Promise<StorefrontOrderPage> {
    const sort = SORTS[q.sort];
    return this.withTenant(async (tx) => {
      const filters: SQL[] = [
        eq(storefrontOrders.tenantId, getTenantId()),
        q.view === 'all'
          ? ne(storefrontOrders.status, 'pending')
          : eq(storefrontOrders.status, q.view),
      ];
      if (q.search !== undefined && q.search !== '') {
        filters.push(this.searchFilter(q.search));
      }
      const cursor = decodeCursor(q.cursor, cursorSchema);
      if (cursor !== undefined) {
        const [cursorSort, key, id] = cursor;
        // The key goes into SQL with a cast; a bad one would be Postgres's cast error, a 500
        if (cursorSort !== q.sort || !sort.valid(key)) throw invalidCursor();
        const cast = q.sort.endsWith('confirmed') ? sql`timestamptz` : sql`numeric`;
        const op = sort.desc ? sql`<` : sql`>`;
        filters.push(
          sql`(${sort.key}, ${storefrontOrders.id}) ${op} (${key}::${cast}, ${id}::uuid)`,
        );
      }
      const direction = sort.desc ? sql`DESC` : sql`ASC`;
      const rows = await tx
        .select({ order: storefrontOrders, items: itemCount, sortKey: sort.text })
        .from(storefrontOrders)
        .where(and(...filters))
        .orderBy(sql`${sort.key} ${direction}`, sql`${storefrontOrders.id} ${direction}`)
        .limit(q.limit + 1);
      const page = toPage(rows, q.limit, (last) => [q.sort, last.sortKey, last.order.id]);
      return {
        items: page.items.map((row) => summaryOf(row.order, row.items)),
        nextCursor: page.nextCursor,
      };
    });
  }

  // Decision 18: the sidebar's number, without loading a page of orders
  counts(): Promise<StorefrontOrderCounts> {
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select({ confirmed: sql<number>`count(*)::int` })
        .from(storefrontOrders)
        .where(
          and(
            eq(storefrontOrders.tenantId, getTenantId()),
            eq(storefrontOrders.status, 'confirmed'),
          ),
        );
      return { confirmed: row?.confirmed ?? 0 };
    });
  }

  get(id: string): Promise<StorefrontOrder> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  // Decision 1's retry: the handler could not make the sales order (documentError), or the order
  // was confirmed before 27b and has none. The maker's refusal is kept on the order as before, and
  // the answer is the refusal itself, so the page shows what is still wrong
  async makeSalesOrder(id: string, version: number): Promise<StorefrontOrder> {
    try {
      return await this.withTenant(async (tx) => {
        const order = await this.lock(tx, id, version);
        if (order.status !== 'confirmed' || order.salesOrderId !== null) throw stepInvalid();
        await this.maker.make(tx, order);
        return this.read(tx, id);
      });
    } catch (error) {
      if (error instanceof AppError && error.code !== 'storefront_order_step_invalid') {
        await this.keepError(id, error.code);
      }
      throw error;
    }
  }

  // Decision 14: what the Packed dialog opens with. A read, but behind storefront.order.manage:
  // only someone who may pack needs the batches
  packPlan(id: string): Promise<StorefrontPackPlan> {
    return this.withTenant(async (tx) => {
      const order = await this.find(tx, id);
      if (order.status !== 'confirmed') throw stepInvalid();
      const salesOrder = await this.salesOrderOf(tx, order);
      const [warehouse] = await tx
        .select({ id: warehouses.id, name: warehouses.name })
        .from(warehouses)
        .where(
          and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, salesOrder.warehouseId)),
        );
      if (!warehouse) throw new Error(`Warehouse ${salesOrder.warehouseId} is missing`);
      const lines = await this.linesOf(tx, id);
      const stock = await this.batchesIn(
        tx,
        warehouse.id,
        lines.filter((line) => line.tracking === 'batch').map((line) => line.line.variantId),
      );
      return {
        warehouse,
        lines: lines.map(({ line, sku, unitCode, tracking }) => {
          const quantity = String(line.quantity);
          const available = stock.get(line.variantId) ?? [];
          return {
            position: line.position,
            name: line.name,
            packSize: line.packSize,
            sku,
            unitCode,
            quantity,
            tracking,
            batches: available,
            picks:
              tracking === 'none'
                ? [{ batchId: null, quantity, serialNumbers: [] }]
                : tracking === 'batch'
                  ? fefo(quantity, available)
                  : [],
          };
        }),
      };
    });
  }

  // Decision 5: Packed = a posted challan of the sales order, from the warehouse the stock is held
  // in, and the hold ends in the same transaction (the stock has really left now)
  pack(id: string, input: PackStorefrontOrderInput): Promise<StorefrontOrder> {
    return this.withTenant(async (tx) => {
      const order = await this.lock(tx, id, input.version);
      if (order.status !== 'confirmed') throw stepInvalid();
      const salesOrder = await this.salesOrderOf(tx, order);
      const orderLines = await this.orderLinesOf(tx, id);
      const soLines = await this.salesOrderLinesOf(tx, salesOrder.id);

      // Every line of the order once, and only its lines (the contract refused a line twice).
      // The picks of a line add up to what the shopper ordered: the challan would take whatever
      // it is given, and a short box is a mistake the packer can fix now
      const byPosition = new Map(orderLines.map((line, index) => [line.position, index]));
      const fieldErrors: Record<string, ErrorCode[]> = {};
      input.lines.forEach((line, lineIndex) => {
        const index = byPosition.get(line.position);
        const ordered = index === undefined ? undefined : orderLines[index];
        if (ordered === undefined) {
          fieldErrors[`lines.${String(lineIndex)}.position`] = ['storefront_order_line_missing'];
          return;
        }
        const picked = sumQuantity(line.picks.map((pick) => pick.quantity));
        if (compareQuantity(picked, String(ordered.quantity)) !== 0) {
          fieldErrors[`lines.${String(lineIndex)}.picks`] = ['storefront_order_pick_total'];
        }
      });
      const [first] = Object.values(fieldErrors);
      if (first?.[0] !== undefined) throw linesError(first[0], fieldErrors);
      if (input.lines.length !== orderLines.length) {
        throw new AppError(409, 'storefront_order_line_missing', 'Pack every line of the order.');
      }

      // The sales order's goods lines are the order's lines in the cart's order (the maker wrote
      // them so): line i of the order is line number i + 1 of the sales order
      const challanLines = input.lines.flatMap((line, lineIndex) => {
        const index = byPosition.get(line.position) ?? -1;
        const soLine = soLines[index];
        const ordered = orderLines[index];
        if (soLine === undefined || soLine.variantId !== ordered?.variantId) {
          throw new Error(`Order ${id} line ${String(line.position)} has no sales order line`);
        }
        return line.picks.map((pick, pickIndex) => ({
          at: { line: lineIndex, pick: pickIndex },
          line: {
            variantId: soLine.variantId,
            unitId: soLine.unitId,
            quantity: pick.quantity,
            batchId: pick.batchId,
            serialNumbers: pick.serialNumbers,
            orderLineId: soLine.id,
          },
        }));
      });

      // The hold first: from here on the stock counts as gone through the challan, not the hold
      await tx
        .delete(storefrontStockHolds)
        .where(
          and(
            eq(storefrontStockHolds.tenantId, getTenantId()),
            eq(storefrontStockHolds.orderId, id),
          ),
        );
      let deliveryId: string;
      try {
        deliveryId = await this.deliveries.postForShopOrder(tx, {
          customerId: salesOrder.customerId,
          orderId: salesOrder.id,
          date: await this.today(tx),
          warehouseId: salesOrder.warehouseId,
          shippingAddress: salesOrder.shippingAddress,
          note: null,
          lines: challanLines.map((entry) => entry.line),
        });
      } catch (error) {
        onPicks(
          error,
          challanLines.map((entry) => entry.at),
        );
      }
      await this.move(tx, order, { status: 'packed', packedAt: new Date(), deliveryId });
      return this.read(tx, id);
    });
  }

  // Decision 6: a status only. The courier comes in step 28
  ship(id: string, version: number): Promise<StorefrontOrder> {
    return this.withTenant(async (tx) => {
      const order = await this.lock(tx, id, version);
      if (order.status !== 'packed') throw stepInvalid();
      await this.move(tx, order, { status: 'shipped', shippedAt: new Date() });
      return this.read(tx, id);
    });
  }

  // Decision 7: a posted invoice for what the challan took and the delivery charge, dated today
  // (decision 21) and unpaid: the cash the rider brings back is a money receipt
  deliver(id: string, version: number): Promise<StorefrontOrder> {
    return this.withTenant(async (tx) => {
      const order = await this.lock(tx, id, version);
      if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
      const salesOrder = await this.salesOrderOf(tx, order);
      const orderLines = await this.orderLinesOf(tx, id);
      const soLines = await this.salesOrderLinesOf(tx, salesOrder.id);
      const soLineById = new Map(soLines.map((line) => [line.id, line]));
      const challan = await tx
        .select()
        .from(deliveryLines)
        .where(
          and(
            eq(deliveryLines.tenantId, getTenantId()),
            eq(deliveryLines.deliveryId, order.deliveryId),
          ),
        )
        .orderBy(asc(deliveryLines.lineNo));
      const [branch] = await tx
        .select({ id: warehouses.branchId })
        .from(warehouses)
        .where(
          and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, salesOrder.warehouseId)),
        );
      if (!branch) throw new Error(`Warehouse ${salesOrder.warehouseId} is missing`);

      // Each challan line at its order line's price and VAT rate; then the delivery charge, the
      // sales order's lines after the order's own (the maker added it last). Step 27c: and with
      // its share of the order line's discount (a coupon's, spread by the maker), or the invoice
      // would bill more than the shopper pays
      const discounts = challanDiscounts(challan, soLineById);
      const goods = challan.map((line) => {
        const soLine = line.orderLineId === null ? undefined : soLineById.get(line.orderLineId);
        if (soLine === undefined) throw new Error(`Challan line ${line.id} has no order line`);
        return {
          variantId: line.variantId,
          unitId: line.unitId,
          quantity: line.quantity,
          description: soLine.description,
          unitPrice: soLine.unitPrice,
          discountType: 'amount' as const,
          discount: discounts.get(line.id) ?? '0',
          taxRateId: soLine.taxRateId,
          deliveryLineId: line.id,
          orderLineId: null,
          batchId: null,
          serialNumbers: [],
        };
      });
      const charges = soLines.slice(orderLines.length).map((soLine) => ({
        variantId: soLine.variantId,
        unitId: soLine.unitId,
        quantity: soLine.quantity,
        description: soLine.description,
        unitPrice: soLine.unitPrice,
        discountType: 'amount' as const,
        discount: '0',
        taxRateId: soLine.taxRateId,
        deliveryLineId: null,
        orderLineId: soLine.id,
        batchId: null,
        serialNumbers: [],
      }));
      const invoiceId = await this.invoices.createIn(tx, {
        customerId: salesOrder.customerId,
        date: await this.today(tx),
        note: null,
        lines: [...goods, ...charges],
        // The customer's payment terms from today: 0 days for a new shop customer
        dueDate: null,
        customerReference: order.orderNo,
        branchId: branch.id,
        warehouseId: null,
        post: true,
        // Never over the limit: the invoice bills the confirmed order at its own prices, which
        // moves the amount from "on order" to "owed" and adds nothing (CreditService.check)
        overrideCreditLimit: false,
      });
      await this.move(tx, order, { status: 'delivered', deliveredAt: new Date(), invoiceId });
      return this.read(tx, id);
    });
  }

  // Decision 8: a new order's sales order is cancelled and its hold ends; a packed one's goods
  // come back on a posted sales return of the whole challan first, and then its sales order (which
  // the return opened again, with nothing delivered) is cancelled. After shipping it is step 28's
  // "returned". The shopper gets an SMS once the transaction has committed
  async cancel(
    id: string,
    input: { version: number; reason: string | null },
  ): Promise<StorefrontOrder> {
    const { order, sms } = await this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, input.version);
      if (before.status !== 'confirmed' && before.status !== 'packed') throw stepInvalid();
      let salesReturnId: string | null = null;
      if (before.status === 'packed') {
        salesReturnId = await this.returnChallan(tx, before);
      } else {
        await tx
          .delete(storefrontStockHolds)
          .where(
            and(
              eq(storefrontStockHolds.tenantId, getTenantId()),
              eq(storefrontStockHolds.orderId, id),
            ),
          );
      }
      if (before.salesOrderId !== null) {
        await this.salesOrders.cancelIn(tx, before.salesOrderId, null);
      }
      await this.move(tx, before, {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: input.reason,
        salesReturnId,
      });
      const [shop] = await tx
        .select({
          language: storefrontSettings.language,
          name: storefrontSettings.name,
          hotline: storefrontSettings.hotline,
        })
        .from(storefrontSettings)
        .where(eq(storefrontSettings.tenantId, getTenantId()));
      return {
        order: await this.read(tx, id),
        sms:
          shop === undefined
            ? null
            : {
                to: before.phone,
                text: cancelledSms(shop.language, shop.name, numberOf(before), shop.hotline),
              },
      };
    });
    // After the commit: an SMS for a cancel that rolled back would tell the shopper a lie. Never
    // throws (SmsQueue.send): the cancel stands even when Redis is away
    if (sms !== null) await this.sms.send(sms);
    return order;
  }

  // The whole challan back, into the warehouse it left from, at what it cost (15d's rule)
  private async returnChallan(tx: Transaction, order: OrderRow): Promise<string> {
    if (order.deliveryId === null || order.salesOrderId === null) throw stepInvalid();
    const [challan] = await tx
      .select({ customerId: deliveries.customerId, warehouseId: deliveries.warehouseId })
      .from(deliveries)
      .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, order.deliveryId)));
    if (!challan) throw new Error(`Challan ${order.deliveryId} is missing`);
    const lines = await tx
      .select()
      .from(deliveryLines)
      .where(
        and(
          eq(deliveryLines.tenantId, getTenantId()),
          eq(deliveryLines.deliveryId, order.deliveryId),
        ),
      )
      .orderBy(asc(deliveryLines.lineNo));
    return this.salesReturns.createIn(tx, {
      customerId: challan.customerId,
      date: await this.today(tx),
      warehouseId: challan.warehouseId,
      // The return's own list of reasons has no "order cancelled"; the shop order's page says
      // why, and the return's audit row names the order through its challan
      reason: 'other',
      note: null,
      lines: lines.map((line) => ({
        variantId: line.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        batchId: line.batchId,
        serialNumbers: line.serialNumbers,
        deliveryLineId: line.id,
      })),
      post: true,
    });
  }

  // A failed retry's reason, in its own transaction: the one that failed has rolled back
  private async keepError(id: string, code: ErrorCode): Promise<void> {
    await this.withTenant(async (tx) => {
      await tx
        .update(storefrontOrders)
        .set({ documentError: code, version: sql`${storefrontOrders.version} + 1` })
        .where(
          and(
            eq(storefrontOrders.tenantId, getTenantId()),
            eq(storefrontOrders.id, id),
            sql`${storefrontOrders.salesOrderId} IS NULL`,
          ),
        );
    });
  }

  // The new status, its time and its documents in one UPDATE (storefront_orders_documents_check
  // reads them together), the version up, and the audit row of the move
  private async move(
    tx: Transaction,
    before: OrderRow,
    fields: Partial<
      Pick<
        OrderRow,
        | 'status'
        | 'packedAt'
        | 'shippedAt'
        | 'deliveredAt'
        | 'cancelledAt'
        | 'cancelReason'
        | 'deliveryId'
        | 'invoiceId'
        | 'salesReturnId'
      >
    > & { status: StorefrontOrderStatus },
  ): Promise<void> {
    await tx
      .update(storefrontOrders)
      .set({
        ...fields,
        version: sql`${storefrontOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(storefrontOrders.tenantId, getTenantId()), eq(storefrontOrders.id, before.id)));
    const action = {
      confirmed: null,
      packed: 'storefront_order.packed',
      shipped: 'storefront_order.shipped',
      delivered: 'storefront_order.delivered',
      cancelled: 'storefront_order.cancelled',
      returned: null,
    } as const satisfies Record<StorefrontOrderStatus, string | null>;
    const name = action[fields.status];
    if (name === null) throw new Error(`No audit action for ${fields.status}`);
    await audit(tx, {
      action: name,
      entityType: 'storefront_order',
      entityId: before.id,
      changes: diff(
        { order: before.orderNo, status: before.status },
        {
          order: before.orderNo,
          status: fields.status,
          ...(fields.cancelReason === undefined ? {} : { reason: fields.cancelReason }),
        },
      ),
    });
  }

  // FOR UPDATE, never a pending order (that one is the shopper's), and the version the page read
  private async lock(tx: Transaction, id: string, version: number): Promise<OrderRow> {
    const [order] = await tx
      .select()
      .from(storefrontOrders)
      .where(
        and(
          eq(storefrontOrders.tenantId, getTenantId()),
          eq(storefrontOrders.id, id),
          ne(storefrontOrders.status, 'pending'),
        ),
      )
      .for('update');
    if (!order) throw notFound('Shop order');
    if (order.version !== version) throw versionConflict();
    return order;
  }

  private async find(tx: Transaction, id: string): Promise<OrderRow> {
    const [order] = await tx
      .select()
      .from(storefrontOrders)
      .where(
        and(
          eq(storefrontOrders.tenantId, getTenantId()),
          eq(storefrontOrders.id, id),
          ne(storefrontOrders.status, 'pending'),
        ),
      );
    if (!order) throw notFound('Shop order');
    return order;
  }

  // The order's sales order, which Packed and Delivered build on
  private async salesOrderOf(tx: Transaction, order: OrderRow) {
    if (order.salesOrderId === null) {
      throw new AppError(
        409,
        'storefront_order_no_sales_order',
        'This order has no sales order yet. Make the sales order first.',
      );
    }
    const [row] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, order.salesOrderId)));
    if (!row) throw new Error(`Sales order ${order.salesOrderId} is missing`);
    return row;
  }

  private orderLinesOf(tx: Transaction, orderId: string): Promise<OrderLineRow[]> {
    return tx
      .select()
      .from(storefrontOrderLines)
      .where(
        and(
          eq(storefrontOrderLines.tenantId, getTenantId()),
          eq(storefrontOrderLines.orderId, orderId),
        ),
      )
      .orderBy(asc(storefrontOrderLines.position));
  }

  private salesOrderLinesOf(tx: Transaction, salesOrderId: string) {
    return tx
      .select()
      .from(salesOrderLines)
      .where(
        and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, salesOrderId)),
      )
      .orderBy(asc(salesOrderLines.lineNo));
  }

  // The order's lines with what the ERP knows of each variant now: its SKU, its base unit's code
  // and how its stock is tracked
  private async linesOf(tx: Transaction, orderId: string) {
    const tenantId = getTenantId();
    const rows = await tx
      .select({
        line: storefrontOrderLines,
        sku: productVariants.sku,
        unitCode: units.code,
        tracking: products.tracking,
      })
      .from(storefrontOrderLines)
      .innerJoin(
        productVariants,
        and(
          eq(productVariants.tenantId, storefrontOrderLines.tenantId),
          eq(productVariants.id, storefrontOrderLines.variantId),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(products.tenantId, storefrontOrderLines.tenantId),
          eq(products.id, storefrontOrderLines.productId),
        ),
      )
      .innerJoin(
        units,
        and(eq(units.tenantId, products.tenantId), eq(units.id, products.baseUnitId)),
      )
      .where(
        and(eq(storefrontOrderLines.tenantId, tenantId), eq(storefrontOrderLines.orderId, orderId)),
      )
      .orderBy(asc(storefrontOrderLines.position));
    return rows;
  }

  // The batches with stock in the warehouse, per variant: earliest expiry first (none last), then
  // the oldest batch, the order FEFO takes them in (contract: storefrontPackPlanSchema)
  private async batchesIn(tx: Transaction, warehouseId: string, variantIds: readonly string[]) {
    const byVariant = new Map<string, StorefrontPackPlan['lines'][number]['batches']>();
    if (variantIds.length === 0) return byVariant;
    const rows = await tx
      .select({
        variantId: stockBalances.variantId,
        batchId: batches.id,
        lotNumber: batches.lotNumber,
        expiresOn: batches.expiresOn,
        available: stockBalances.quantity,
      })
      .from(stockBalances)
      .innerJoin(
        batches,
        and(eq(batches.tenantId, stockBalances.tenantId), eq(batches.id, stockBalances.batchId)),
      )
      .where(
        and(
          eq(stockBalances.tenantId, getTenantId()),
          eq(stockBalances.warehouseId, warehouseId),
          inArray(stockBalances.variantId, [...variantIds]),
          gt(stockBalances.quantity, '0'),
        ),
      )
      .orderBy(sql`${batches.expiresOn} ASC NULLS LAST`, asc(batches.createdAt), asc(batches.id));
    for (const { variantId, ...batch } of rows) {
      byVariant.set(variantId, [...(byVariant.get(variantId) ?? []), batch]);
    }
    return byVariant;
  }

  private async today(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    return todayIn(settings?.timezone ?? 'Asia/Dhaka');
  }

  // Part of the number ("W-000123", "123"), of the name, or of the phone with its spaces and
  // dashes dropped ("01786 120356"). No index helps here (a LIKE is not leakproof under RLS,
  // 27b.2): the list's index narrows to the workspace and the tab first
  private searchFilter(search: string): SQL {
    const pattern = containsPattern(search.normalize('NFC'));
    const digits = search.replace(/[\s-]/g, '');
    const byPhone = /^\d+$/.test(digits)
      ? sql` OR ${storefrontOrders.phone} LIKE ${containsPattern(digits)}`
      : sql``;
    return sql`(lower(${storefrontOrders.orderNo}) LIKE ${pattern}
      OR lower(${storefrontOrders.customerName}) LIKE ${pattern}${byPhone})`;
  }

  private async read(tx: Transaction, id: string): Promise<StorefrontOrder> {
    const tenantId = getTenantId();
    const order = await this.find(tx, id);
    const lines = await this.linesOf(tx, id);
    // A photo whose file a clean-up removed since shows no picture, not a broken one
    const imageIds = lines.map(({ line }) => storefrontImageSchema.parse(line.image).id);
    const ready = new Set(
      imageIds.length === 0
        ? []
        : (
            await tx
              .select({ id: storefrontImages.id })
              .from(storefrontImages)
              .where(
                and(
                  eq(storefrontImages.tenantId, tenantId),
                  inArray(storefrontImages.id, imageIds),
                  eq(storefrontImages.status, 'ready'),
                ),
              )
          ).map((row) => row.id),
    );
    const [salesOrder] =
      order.salesOrderId === null
        ? []
        : await tx
            .select({
              id: salesOrders.id,
              number: salesOrders.number,
              customerId: parties.id,
              customerName: parties.name,
            })
            .from(salesOrders)
            .innerJoin(
              parties,
              and(
                eq(parties.tenantId, salesOrders.tenantId),
                eq(parties.id, salesOrders.customerId),
              ),
            )
            .where(and(eq(salesOrders.tenantId, tenantId), eq(salesOrders.id, order.salesOrderId)));
    const ref = async (
      table: typeof deliveries | typeof invoices | typeof salesReturns,
      docId: string | null,
    ): Promise<DocumentRef | null> => {
      if (docId === null) return null;
      const [row] = await tx
        .select({ id: table.id, number: table.number })
        .from(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.id, docId)));
      return row ?? null;
    };
    const documentError = order.documentError;
    return {
      ...summaryOf(
        order,
        lines.reduce((count, { line }) => count + line.quantity, 0),
      ),
      address: order.address,
      history: historyOf(order),
      lines: lines.map(({ line, sku, unitCode }) => {
        const image = storefrontImageSchema.parse(line.image);
        return {
          position: line.position,
          listingId: line.listingId,
          name: line.name,
          packSize: line.packSize,
          image: ready.has(image.id)
            ? { ...image, url: shopImage(this.mediaUrl, image, 'small').url }
            : null,
          productId: line.productId,
          variantId: line.variantId,
          sku,
          unitCode,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        };
      }),
      subtotal: order.subtotal,
      discount: order.discount,
      couponCode: order.couponCode,
      deliveryCharge: order.deliveryCharge,
      cancelReason: order.cancelReason,
      customer:
        salesOrder === undefined
          ? null
          : { id: salesOrder.customerId, name: salesOrder.customerName },
      salesOrder:
        salesOrder === undefined ? null : { id: salesOrder.id, number: salesOrder.number },
      delivery: await ref(deliveries, order.deliveryId),
      invoice: await ref(invoices, order.invoiceId),
      salesReturn: await ref(salesReturns, order.salesReturnId),
      // Stored only as an error code (storefront_orders_document_error_check); one this API no
      // longer knows reads as none rather than breaking the page
      documentError: isErrorCode(documentError) ? documentError : null,
      version: order.version,
      updatedAt: order.updatedAt.toISOString(),
    };
  }
}

// FEFO over the batches: take from the first until the line is full, then the next. A line the
// batches cannot fill keeps what they have: the dialog shows the shortfall, and the challan's own
// stock check has the last word
function fefo(
  quantity: string,
  available: StorefrontPackPlan['lines'][number]['batches'],
): StorefrontPackPlan['lines'][number]['picks'] {
  const picks: StorefrontPackPlan['lines'][number]['picks'] = [];
  let left = quantity;
  for (const batch of available) {
    if (compareQuantity(left, '0') <= 0) break;
    const take = compareQuantity(batch.available, left) < 0 ? batch.available : left;
    picks.push({ batchId: batch.batchId, quantity: sumQuantity([take]), serialNumbers: [] });
    left = subtractQuantity(left, take);
  }
  return picks;
}

// Step 27c: each challan line's share of its sales order line's discount, by challan line id. A
// line packed from two batches is two challan lines of one order line, so the order line's
// discount is spread over them by what each is worth at the order's price (spreadMoney: to the
// paisa, adding up to the discount exactly). One challan line per order line, the usual case,
// takes the whole discount. The maker wrote every discount of a shop's sales order as an amount
// (sales-order-maker.ts); a line without one gets none. Exported for its unit test
export function challanDiscounts(
  challan: readonly { id: string; orderLineId: string | null; quantity: string }[],
  orderLines: ReadonlyMap<string, { discountType: string; discount: string; unitPrice: string }>,
): Map<string, string> {
  const byOrderLine = new Map<string, { id: string; quantity: string }[]>();
  for (const line of challan) {
    if (line.orderLineId === null) continue;
    byOrderLine.set(line.orderLineId, [...(byOrderLine.get(line.orderLineId) ?? []), line]);
  }
  const shares = new Map<string, string>();
  for (const [orderLineId, lines] of byOrderLine) {
    const orderLine = orderLines.get(orderLineId);
    if (orderLine?.discountType !== 'amount' || compareMoney(orderLine.discount, '0') === 0) {
      continue;
    }
    const pieces = spreadMoney(
      orderLine.discount,
      lines.map((line) => multiplyMoney(line.quantity, orderLine.unitPrice)),
    );
    lines.forEach((line, index) => shares.set(line.id, pieces[index] ?? '0'));
  }
  return shares;
}
