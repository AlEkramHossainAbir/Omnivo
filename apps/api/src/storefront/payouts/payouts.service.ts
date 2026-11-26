import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  type CourierProvider,
  type ErrorCode,
  isNegativeMoney,
  type Payout,
  type PayoutAccount,
  type PayoutCsvMap,
  payoutCsvMapSchema,
  type PayoutCsvKey,
  type PayoutInput,
  type PayoutLine,
  type PayoutLineKind,
  type PayoutMatch,
  type PayoutMatchInput,
  type PayoutParcel,
  type PayoutParcels,
  type PayoutSetup,
  type PayoutStatus,
  type PayoutSummary,
  STEADFAST_PAYOUT_CSV_PRESET,
  type StorefrontAccountChoice,
  subtractMoney,
  sumMoney,
  type VoidPayoutInput,
} from '@omnivo/contracts';
import {
  courierAccounts,
  ledgerAccounts,
  receipts,
  storefrontOrders,
  storefrontPayoutLines,
  storefrontPayouts,
  storefrontSettings,
  storefrontShipments,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created } from '../../common/audit/audit.js';
import { isCheckViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { NumberingService } from '../../numbering/numbering.service.js';
import { chartOf } from '../admin/payment-gateway.service.js';
import { holdsOf } from '../shipping/courier-accounts.service.js';
import { PayoutBooks } from './payout-books.js';
import {
  KEY_COLUMN,
  keysOf,
  type MatchParcel,
  matchPayoutCsv,
  missingColumns,
  payoutKindOf,
  readPayoutCsv,
} from './payout-match.js';

type PayoutRow = typeof storefrontPayouts.$inferSelect;
type AccountRow = typeof courierAccounts.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// The map a file is read with when the member gave none and the account has none saved (mine 18).
// A manual account's courier is any of five, so there is nothing to guess: its first file always
// shows the mapping step
const PRESET = {
  steadfast: STEADFAST_PAYOUT_CSV_PRESET,
  manual: null,
} as const satisfies Record<CourierProvider, PayoutCsvMap | null>;

// The saved map, read with today's schema: a map an older shape saved reads as none, so the
// mapping step shows instead of the match failing (28c.2)
function savedMapOf(row: AccountRow): PayoutCsvMap | null {
  const parsed = payoutCsvMapSchema.safeParse(row.payoutCsvMap);
  return parsed.success ? parsed.data : null;
}

function sameMap(a: PayoutCsvMap, b: PayoutCsvMap | null): boolean {
  return (
    b !== null &&
    a.key === b.key &&
    a.keyColumn === b.keyColumn &&
    a.collectedColumn === b.collectedColumn &&
    a.chargeColumn === b.chargeColumn
  );
}

// An error the form shows under one box, or under several lines' boxes (lines.2.shipmentId)
function boxError(code: ErrorCode, fields: readonly string[], message: string): AppError {
  return new AppError(422, code, message, {
    fieldErrors: Object.fromEntries(fields.map((field) => [field, [code]])),
  });
}

function unavailable(indexes: readonly number[]): AppError {
  return new AppError(
    409,
    'payout_parcel_unavailable',
    'A parcel cannot be paid out any more. Reload the parcels.',
    {
      fieldErrors: Object.fromEntries(
        indexes.map((index) => [
          `lines.${String(index)}.shipmentId`,
          ['payout_parcel_unavailable'],
        ]),
      ),
    },
  );
}

// The database's last word when two payouts took the same parcel at once, or its receipt was
// voided a moment ago (0083): the second one's UPDATE found the parcel taken and COMMIT refused
// the payout, or the line's guard found the receipt voided. The form knows one answer for both:
// reload the parcels
function parcelRace(error: unknown): unknown {
  if (
    isCheckViolation(error, 'storefront_payouts_lines_check') ||
    isCheckViolation(error, 'storefront_payout_lines_parcel_check') ||
    isCheckViolation(error, 'storefront_shipments_payout_check')
  ) {
    return unavailable([]);
  }
  return error;
}

// A parcel as the three reads need it: its keys, its state and its receipt
const parcelColumns = {
  id: storefrontShipments.id,
  orderId: storefrontShipments.orderId,
  orderNo: storefrontOrders.orderNo,
  invoice: storefrontShipments.invoice,
  trackingCode: storefrontShipments.trackingCode,
  consignmentId: storefrontShipments.consignmentId,
  status: storefrontShipments.status,
  collectedAmount: storefrontShipments.collectedAmount,
  courierCharge: storefrontShipments.courierCharge,
  lastSyncedAt: storefrontShipments.lastSyncedAt,
  payoutId: storefrontShipments.payoutId,
  receiptId: storefrontShipments.receiptId,
  receiptNumber: receipts.number,
  receiptStatus: receipts.status,
  receiptAccountId: receipts.accountId,
  receiptAmount: receipts.amount,
  receiptDate: receipts.date,
};

// Step 28c (decisions 2–12): Storefront → Shop payouts. Every route needs
// storefront.payout.manage (the contract says so and the guard checks it). A payout is posted when
// it is saved and voided on its own page, like a money receipt; its parcels are locked while it is
// made, and 0083's rules are the last word on every one of them.
@Injectable()
export class PayoutsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly books: PayoutBooks,
  ) {}

  // The pages' one read of choices (mine 16): every courier account, archived ones last (an
  // archived account's parcels can still be paid out), and the bank accounts a payout may go into
  setup(): Promise<PayoutSetup> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(courierAccounts)
        .where(eq(courierAccounts.tenantId, getTenantId()))
        .orderBy(
          sql`${courierAccounts.archivedAt} IS NOT NULL`,
          asc(courierAccounts.name),
          asc(courierAccounts.id),
        );
      const chart = await chartOf(tx);
      return {
        accounts: await this.toAccounts(tx, rows),
        bankAccounts: chart.moneyAccounts,
      };
    });
  }

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: PayoutStatus | undefined;
    accountId?: string | undefined;
  }): Promise<{ items: PayoutSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(storefrontPayouts.status, query.status),
          query.accountId === undefined
            ? undefined
            : eq(storefrontPayouts.courierAccountId, query.accountId),
          after === undefined
            ? undefined
            : sql`(${storefrontPayouts.date}, ${storefrontPayouts.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.payout.date, last.payout.id]);
      return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<Payout> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  // The new payout page's list: the account's parcels a payout can take now, oldest receipt first
  // (the courier pays the oldest first), the charge lines after them
  parcels(accountId: string): Promise<PayoutParcels> {
    return this.withTenant(async (tx) => {
      const row = await this.findAccount(tx, accountId, null);
      if (row === null) throw notFound('Courier account');
      const [account] = await this.toAccounts(tx, [row]);
      if (account === undefined) throw notFound('Courier account');
      // storefront_shipments_payable_idx's own condition, so the read stays on that index however
      // many parcels the shop has sent; payoutKindOf() then keeps the ones a payout takes now
      const candidates = await this.parcelRows(
        tx,
        and(
          eq(storefrontShipments.courierAccountId, row.id),
          isNull(storefrontShipments.payoutId),
          or(
            sql`${storefrontShipments.receiptId} IS NOT NULL`,
            sql`${storefrontShipments.courierCharge} IS NOT NULL`,
          ),
        ),
      );
      const parcels = candidates.flatMap((parcel): PayoutParcel[] => {
        const kind = payoutKindOf(parcel, row.codAccountId);
        return kind === null ? [] : [toParcel(parcel, kind)];
      });
      parcels.sort(
        (a, b) =>
          (a.receiptDate ?? '9999-12-31').localeCompare(b.receiptDate ?? '9999-12-31') ||
          a.invoice.localeCompare(b.invoice),
      );
      return { account, parcels, csvMap: savedMapOf(row) };
    });
  }

  // The courier's file against the account's parcels (decisions 10–12, mine 18 and 19). Nothing is
  // written but the map, and only a map the member gave, once the file had all its columns: a map
  // that found nothing should not replace one that works
  match(accountId: string, input: PayoutMatchInput): Promise<PayoutMatch> {
    const csv = readPayoutCsv(input.csv);
    if (typeof csv === 'string') {
      throw boxError(csv, ['csv'], 'This file cannot be read as a payout CSV.');
    }
    return this.withTenant(async (tx) => {
      const row = await this.findAccount(tx, accountId, null);
      if (row === null) throw notFound('Courier account');
      const saved = savedMapOf(row);
      const map = input.map ?? saved ?? PRESET[row.provider];
      // The mapping step's choices: the header's names, without the empty ones
      const columns = csv.header.filter((name) => name !== '');
      if (map === null) return { columns, map: null, missing: [], rows: [], fileNet: null };
      const missing = missingColumns(csv.header, map);
      if (missing.length > 0) return { columns, map, missing, rows: [], fileNet: null };
      if (input.map !== null && !sameMap(input.map, saved)) {
        // No version bump and no audit (mine 21): a map moves no money, and a member editing the
        // account at the same time must not get a conflict for it
        await tx
          .update(courierAccounts)
          .set({ payoutCsvMap: input.map })
          .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, row.id)));
      }
      const parcels = await this.parcelsByKey(tx, row, map.key, keysOf(csv, map));
      const { rows, fileNet } = matchPayoutCsv(csv, map, parcels);
      return { columns, map, missing: [], rows, fileNet };
    });
  }

  // Saving posts it (decision 6). In this order: the courier account (FOR SHARE, so its COD
  // account cannot change under us), the parcels (FOR UPDATE, in id order, so two payouts of
  // overlapping parcels queue up instead of deadlocking), every check, the number, the payout,
  // its lines, the parcels' payout_id, then the entry. 0083's deferred check runs at COMMIT
  async create(input: PayoutInput): Promise<Payout> {
    try {
      return await this.withTenant(async (tx) => {
        const tenantId = getTenantId();
        const account = await this.findAccount(tx, input.accountId, 'share');
        if (account === null) {
          throw boxError('payout_pick_account', ['accountId'], 'Pick a courier account.');
        }
        if (account.codAccountId === null) {
          throw boxError(
            'payout_account_no_cod',
            ['accountId'],
            'This courier account has no COD account.',
          );
        }
        const codAccountId = account.codAccountId;
        // An active account that holds money, and not the COD account itself: a payout into it
        // would move nothing (decision 7; 0082's accounts check is the last word)
        const chart = await chartOf(tx);
        if (
          input.bankAccountId === codAccountId ||
          !chart.moneyAccounts.some((choice) => choice.id === input.bankAccountId)
        ) {
          throw boxError(
            'payout_bank_account_invalid',
            ['bankAccountId'],
            'Pick the bank or cash account the money went into.',
          );
        }

        const ids = input.lines.map((line) => line.shipmentId);
        const locked = await this.lockParcels(tx, account.id, ids);
        const byId = new Map(locked.map((parcel) => [parcel.id, parcel]));
        const taken: number[] = [];
        const zero: number[] = [];
        const lines = input.lines.flatMap((line, index) => {
          const parcel = byId.get(line.shipmentId);
          // Not found (another account's, another workspace's) or in a posted payout already
          const kind = parcel?.payoutId === null ? payoutKindOf(parcel, codAccountId) : null;
          if (parcel === undefined || kind === null) {
            taken.push(index);
            return [];
          }
          // A charge line is there only for its charge (mine 20)
          if (kind === 'charge' && compareMoney(line.charge, '0') === 0) zero.push(index);
          return [
            {
              parcel,
              kind,
              collected: kind === 'cod' ? (parcel.receiptAmount ?? '0') : '0',
              charge: line.charge,
            },
          ];
        });
        // Every line at once, so the form marks each one: another workspace's parcel, another
        // account's and one taken a moment ago all get the same answer
        if (taken.length > 0) throw unavailable(taken);
        if (zero.length > 0) {
          throw boxError(
            'payout_charge_line_zero',
            zero.map((index) => `lines.${String(index)}.charge`),
            'A parcel that brought no cash needs its charge.',
          );
        }

        const collected = sumMoney(lines.map((line) => line.collected));
        const charges = sumMoney(lines.map((line) => line.charge));
        const net = subtractMoney(collected, charges);
        if (isNegativeMoney(net)) {
          throw new AppError(
            422,
            'payout_below_zero',
            'The charges are more than the cash on these parcels.',
          );
        }
        if (compareMoney(charges, '0') > 0 && account.chargeAccountId === null) {
          throw boxError(
            'payout_account_no_charges',
            ['accountId'],
            'This courier account has no charges account.',
          );
        }
        // Never before the newest COD receipt it pays out (decision 7): the money was not with
        // the courier before. ISO dates compare as text
        const newest = lines.reduce<string | null>((latest, line) => {
          const day = line.parcel.receiptDate;
          return day !== null && (latest === null || day > latest) ? day : latest;
        }, null);
        if (newest !== null && input.date < newest) {
          throw new AppError(
            422,
            'payout_date_before_receipt',
            'A payout cannot be dated before the COD receipts it pays out.',
            { params: { date: newest }, fieldErrors: { date: ['payout_date_before_receipt'] } },
          );
        }
        const branchId = await this.shopBranch(tx);

        const number = await this.numbering.next(tx, 'storefront.payout', input.date);
        const userId = currentPrincipal().userId;
        const [row] = await tx
          .insert(storefrontPayouts)
          .values({
            tenantId,
            number,
            date: input.date,
            courierAccountId: account.id,
            bankAccountId: input.bankAccountId,
            codAccountId,
            chargeAccountId: account.chargeAccountId,
            branchId,
            reference: input.reference,
            note: input.note,
            collected,
            charges,
            net,
            createdBy: userId,
            updatedBy: userId,
          })
          .returning();
        if (row === undefined) throw new Error('Payout insert returned no row');
        await tx.insert(storefrontPayoutLines).values(
          lines.map((line) => ({
            tenantId,
            payoutId: row.id,
            courierAccountId: account.id,
            shipmentId: line.parcel.id,
            kind: line.kind,
            collected: line.collected,
            charge: line.charge,
            // The courier's own figure as it is now (mine 22)
            courierCharge: line.parcel.courierCharge,
            receiptId: line.kind === 'cod' ? line.parcel.receiptId : null,
          })),
        );
        // After the lines: 0083's parcel guard lets payout_id point only at a payout with a line
        // for the parcel. `payout_id IS NULL` again, though the rows are locked: if anything got
        // past the lock, fewer rows come back, and the payout is refused here, not at COMMIT
        const linked = await tx
          .update(storefrontShipments)
          .set({ payoutId: row.id })
          .where(
            and(
              eq(storefrontShipments.tenantId, tenantId),
              inArray(storefrontShipments.id, ids),
              isNull(storefrontShipments.payoutId),
            ),
          )
          .returning({ id: storefrontShipments.id });
        if (linked.length !== ids.length) throw unavailable([]);
        // The journal checks the date's period: a payout in a closed month is refused here
        const entry = await this.books.post(
          tx,
          { id: row.id, number, date: row.date },
          {
            branchId,
            bankAccountId: input.bankAccountId,
            codAccountId,
            chargeAccountId: row.chargeAccountId,
            collected: row.collected,
            charges: row.charges,
            net: row.net,
          },
        );
        await audit(tx, {
          action: 'storefront_payout.created',
          entityType: 'storefront_payout',
          entityId: row.id,
          changes: created({
            number,
            date: row.date,
            courierAccount: account.name,
            bankAccount: chart.codeOf.get(input.bankAccountId) ?? input.bankAccountId,
            reference: row.reference,
            parcels: lines.length,
            collected,
            charges,
            net,
            entry: entry.number,
          }),
        });
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw parcelRace(error);
    }
  }

  // A payout typed wrong, or one the bank never got (decision 6, mine 24): voided first, then its
  // parcels freed (0083's parcel guard lets payout_id go only once the payout is voided), then its
  // entry reversed on the void date. The payout stays, voided, with its lines, so its number is
  // never reused or missing
  void(id: string, input: VoidPayoutInput): Promise<Payout> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const row = await this.lock(tx, id, input.version);
      if (input.date < row.date) {
        throw new AppError(
          409,
          'receipt_void_date',
          'A payout cannot be voided before its own date.',
          { fieldErrors: { date: ['receipt_void_date'] } },
        );
      }
      const entry = await this.books.entryOf(tx, id);
      if (entry === null) throw new Error(`Payout ${id} has no entry`);
      await tx
        .update(storefrontPayouts)
        .set({
          status: 'voided',
          voidDate: input.date,
          voidReason: input.reason,
          version: sql`${storefrontPayouts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(storefrontPayouts.tenantId, tenantId), eq(storefrontPayouts.id, id)));
      await tx
        .update(storefrontShipments)
        .set({ payoutId: null })
        .where(
          and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.payoutId, id)),
        );
      const reversal = await this.books.reverse(tx, entry, {
        date: input.date,
        narration: `Courier payout ${row.number} voided: ${input.reason}`,
      });
      await audit(tx, {
        action: 'storefront_payout.voided',
        entityType: 'storefront_payout',
        entityId: id,
        changes: created({ date: input.date, reason: input.reason, reversal: reversal.number }),
      });
      return this.read(tx, id);
    });
  }

  // FOR UPDATE: two voids of one payout take turns. A voided payout is final
  private async lock(tx: Transaction, id: string, version: number): Promise<PayoutRow> {
    const [row] = await tx
      .select()
      .from(storefrontPayouts)
      .where(and(eq(storefrontPayouts.tenantId, getTenantId()), eq(storefrontPayouts.id, id)))
      .for('update');
    if (row === undefined) throw notFound('Payout');
    if (row.status === 'voided') {
      throw new AppError(409, 'payout_voided', 'This payout is voided and cannot be changed.');
    }
    if (row.version !== version) throw versionConflict();
    return row;
  }

  // Any courier account of this workspace, archived ones too: an archived account still holds the
  // money its last parcels brought in
  private async findAccount(
    tx: Transaction,
    id: string,
    lock: 'share' | null,
  ): Promise<AccountRow | null> {
    const query = tx
      .select()
      .from(courierAccounts)
      .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)));
    const [row] = lock === null ? await query : await query.for(lock);
    return row ?? null;
  }

  // The pages' view of the accounts, with the two ledger accounts by code and name (an archived
  // one too: the page must still name it) and what each holds
  private async toAccounts(tx: Transaction, rows: readonly AccountRow[]): Promise<PayoutAccount[]> {
    if (rows.length === 0) return [];
    const ledgerIds = rows.flatMap((row) =>
      [row.codAccountId, row.chargeAccountId].filter((id): id is string => id !== null),
    );
    const choices =
      ledgerIds.length === 0
        ? []
        : await tx
            .select({ id: ledgerAccounts.id, code: ledgerAccounts.code, name: ledgerAccounts.name })
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.tenantId, getTenantId()),
                inArray(ledgerAccounts.id, ledgerIds),
              ),
            );
    const choiceOf = (id: string | null): StorefrontAccountChoice | null =>
      id === null ? null : (choices.find((choice) => choice.id === id) ?? null);
    const holds = await holdsOf(
      tx,
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      courier: row.courier,
      archived: row.archivedAt !== null,
      codAccount: choiceOf(row.codAccountId),
      chargeAccount: choiceOf(row.chargeAccountId),
      holds: holds.get(row.id) ?? { amount: '0.0000', parcels: 0 },
    }));
  }

  // The parcels with their order's number and their receipt, by any condition on the parcel
  private parcelRows(tx: Transaction, where: SQL | undefined) {
    return tx
      .select(parcelColumns)
      .from(storefrontShipments)
      .innerJoin(
        storefrontOrders,
        and(
          eq(storefrontOrders.tenantId, storefrontShipments.tenantId),
          eq(storefrontOrders.id, storefrontShipments.orderId),
        ),
      )
      .leftJoin(
        receipts,
        and(
          eq(receipts.tenantId, storefrontShipments.tenantId),
          eq(receipts.id, storefrontShipments.receiptId),
        ),
      )
      .where(and(eq(storefrontShipments.tenantId, getTenantId()), where));
  }

  // The parcels a new payout names, locked in id order. Only the account's: another account's id
  // (or another workspace's) is simply not found, and create() says it is unavailable
  private lockParcels(tx: Transaction, accountId: string, ids: readonly string[]) {
    return this.parcelRows(
      tx,
      and(
        eq(storefrontShipments.courierAccountId, accountId),
        inArray(storefrontShipments.id, [...ids]),
      ),
    )
      .orderBy(asc(storefrontShipments.id))
      .for('update', { of: storefrontShipments });
  }

  // The parcels the file's keys name, each as what a payout could do with it. One read for the
  // whole file; the account's unique keys (invoice, consignment id) and the exact compare keep it
  // on the account's own rows. A tracking code has no unique index, so a second parcel with the
  // same code (a courier's typo) keeps the first one read
  private async parcelsByKey(
    tx: Transaction,
    account: AccountRow,
    key: PayoutCsvKey,
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, MatchParcel>> {
    if (keys.length === 0) return new Map();
    const column = storefrontShipments[KEY_COLUMN[key]];
    const rows = await tx
      .select({ ...parcelColumns, payoutNumber: storefrontPayouts.number })
      .from(storefrontShipments)
      .innerJoin(
        storefrontOrders,
        and(
          eq(storefrontOrders.tenantId, storefrontShipments.tenantId),
          eq(storefrontOrders.id, storefrontShipments.orderId),
        ),
      )
      .leftJoin(
        receipts,
        and(
          eq(receipts.tenantId, storefrontShipments.tenantId),
          eq(receipts.id, storefrontShipments.receiptId),
        ),
      )
      .leftJoin(
        storefrontPayouts,
        and(
          eq(storefrontPayouts.tenantId, storefrontShipments.tenantId),
          eq(storefrontPayouts.id, storefrontShipments.payoutId),
        ),
      )
      .where(
        and(
          eq(storefrontShipments.tenantId, getTenantId()),
          eq(storefrontShipments.courierAccountId, account.id),
          inArray(column, [...keys]),
        ),
      )
      .orderBy(asc(storefrontShipments.createdAt));
    const found = new Map<string, MatchParcel>();
    for (const row of rows) {
      const value = row[KEY_COLUMN[key]];
      if (value === null || found.has(value)) continue;
      found.set(
        value,
        row.payoutId !== null
          ? {
              state: 'paid',
              shipmentId: row.id,
              payout: { id: row.payoutId, number: row.payoutNumber },
            }
          : payoutKindOf(row, account.codAccountId) === null
            ? { state: 'not_ready', shipmentId: row.id }
            : {
                state: 'payable',
                shipmentId: row.id,
                collected: row.receiptId === null ? '0.0000' : (row.receiptAmount ?? '0.0000'),
              },
      );
    }
    return found;
  }

  // The shop warehouse's branch (decision 7), as the COD receipts' branch. A shop has its
  // warehouse from its launch on, and a payout needs a parcel, which needs a launched shop
  private async shopBranch(tx: Transaction): Promise<string> {
    const [row] = await tx
      .select({ branchId: warehouses.branchId })
      .from(storefrontSettings)
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, storefrontSettings.tenantId),
          eq(warehouses.id, storefrontSettings.defaultWarehouseId),
        ),
      )
      .where(eq(storefrontSettings.tenantId, getTenantId()));
    if (row === undefined) throw new Error('The shop has no warehouse, so a payout has no branch');
    return row.branchId;
  }

  // The list's rows (and the payout page's header): the account's name and courier, and the count
  // of lines. The count is written out with its tables' names, for 27b's reason (itemCount): in a
  // select's fields Drizzle writes a column without its table, and an unqualified "tenant_id" in
  // the subquery would be the line's own
  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        payout: storefrontPayouts,
        accountName: courierAccounts.name,
        courier: courierAccounts.courier,
        parcels: sql<number>`(SELECT count(*) FROM storefront_payout_lines l
          WHERE l.tenant_id = storefront_payouts.tenant_id
            AND l.payout_id = storefront_payouts.id)::int`,
      })
      .from(storefrontPayouts)
      .innerJoin(
        courierAccounts,
        and(
          eq(courierAccounts.tenantId, storefrontPayouts.tenantId),
          eq(courierAccounts.id, storefrontPayouts.courierAccountId),
        ),
      )
      .where(and(eq(storefrontPayouts.tenantId, getTenantId()), where))
      .orderBy(desc(storefrontPayouts.date), desc(storefrontPayouts.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Payout> {
    const [found] = await this.rows(tx, eq(storefrontPayouts.id, id), 1);
    if (found === undefined) throw notFound('Payout');
    const row = found.payout;
    const tenantId = getTenantId();
    const lines = await tx
      .select({
        line: storefrontPayoutLines,
        orderId: storefrontShipments.orderId,
        orderNo: storefrontOrders.orderNo,
        invoice: storefrontShipments.invoice,
        trackingCode: storefrontShipments.trackingCode,
        receiptNumber: receipts.number,
      })
      .from(storefrontPayoutLines)
      .innerJoin(
        storefrontShipments,
        and(
          eq(storefrontShipments.tenantId, storefrontPayoutLines.tenantId),
          eq(storefrontShipments.id, storefrontPayoutLines.shipmentId),
        ),
      )
      .innerJoin(
        storefrontOrders,
        and(
          eq(storefrontOrders.tenantId, storefrontShipments.tenantId),
          eq(storefrontOrders.id, storefrontShipments.orderId),
        ),
      )
      .leftJoin(
        receipts,
        and(
          eq(receipts.tenantId, storefrontPayoutLines.tenantId),
          eq(receipts.id, storefrontPayoutLines.receiptId),
        ),
      )
      .where(
        and(eq(storefrontPayoutLines.tenantId, tenantId), eq(storefrontPayoutLines.payoutId, id)),
      )
      .orderBy(asc(storefrontShipments.invoice));
    const entry = await this.books.entryOf(tx, id);
    if (entry === null) throw new Error(`Payout ${id} has no entry`);
    const voidEntry = row.status === 'voided' ? await this.books.reversalOf(tx, entry.id) : null;
    return {
      ...toSummary(found),
      note: row.note,
      codAccountId: row.codAccountId,
      chargeAccountId: row.chargeAccountId,
      branchId: row.branchId,
      lines: lines.map((each): PayoutLine => ({
        shipmentId: each.line.shipmentId,
        kind: each.line.kind,
        order: { id: each.orderId, number: each.orderNo ?? '' },
        invoice: each.invoice,
        trackingCode: each.trackingCode,
        collected: each.line.collected,
        charge: each.line.charge,
        courierCharge: each.line.courierCharge,
        receipt:
          each.line.receiptId === null
            ? null
            : { id: each.line.receiptId, number: each.receiptNumber },
      })),
      entry,
      voidEntry,
      voidDate: row.voidDate,
      voidReason: row.voidReason,
    };
  }
}

function toSummary(found: {
  payout: PayoutRow;
  accountName: string;
  courier: PayoutSummary['account']['courier'];
  parcels: number;
}): PayoutSummary {
  const { payout } = found;
  return {
    id: payout.id,
    number: payout.number,
    date: payout.date,
    account: { id: payout.courierAccountId, name: found.accountName, courier: found.courier },
    bankAccountId: payout.bankAccountId,
    reference: payout.reference,
    parcels: found.parcels,
    collected: payout.collected,
    charges: payout.charges,
    net: payout.net,
    status: payout.status,
    version: payout.version,
    updatedAt: payout.updatedAt.toISOString(),
  };
}

// A parcel row as the new payout's list sends it. A confirmed order always has its number (a
// parcel is booked only after that), so the empty string is a broken row's, never a real one's
function toParcel(
  row: {
    id: string;
    orderId: string;
    orderNo: string | null;
    invoice: string;
    trackingCode: string | null;
    consignmentId: string | null;
    status: PayoutParcel['status'];
    courierCharge: string | null;
    lastSyncedAt: Date | null;
    receiptId: string | null;
    receiptNumber: string | null;
    receiptAmount: string | null;
    receiptDate: string | null;
  },
  kind: PayoutLineKind,
): PayoutParcel {
  return {
    shipmentId: row.id,
    kind,
    order: { id: row.orderId, number: row.orderNo ?? '' },
    invoice: row.invoice,
    trackingCode: row.trackingCode,
    consignmentId: row.consignmentId,
    status: row.status,
    collected: kind === 'cod' ? (row.receiptAmount ?? '0.0000') : '0.0000',
    courierCharge: row.courierCharge,
    receipt:
      kind === 'cod' && row.receiptId !== null
        ? { id: row.receiptId, number: row.receiptNumber }
        : null,
    receiptDate: kind === 'cod' ? row.receiptDate : null,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  };
}
