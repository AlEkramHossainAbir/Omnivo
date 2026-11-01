import { Inject, Injectable } from '@nestjs/common';
import {
  absMoney,
  cashDifferenceOf,
  compareMoney,
  type EntryRef,
  formatShiftNumber,
  isOverVarianceAlert,
  isZeroMoney,
  POS_PAYMENT_METHODS,
  type PosCashMovementInput,
  type PosShift,
  type PosShiftCloseInput,
  type PosShiftCloseWithoutCountInput,
  type PosShiftOpenInput,
  type PosShiftStatus,
  type PosShiftSummary,
  subtractMoney,
} from '@omnivo/contracts';
import {
  devices,
  journalEntries,
  posCashMovements,
  posCashReasons,
  posRegisters,
  posSalePayments,
  posSales,
  posShifts,
  users,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { isCheckViolation, isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentDeviceId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { PostingService } from '../journal/posting.service.js';
import type { Access } from '../rbac/permission.service.js';
import { bookingDay } from './booking-day.js';
import { accountOf, type PosRegisterRow } from './pos-registers.service.js';

type ShiftRow = typeof posShifts.$inferSelect;

const cursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);

const closer = alias(users, 'closer');

// pos_shift_cash() (0054) as text: numeric comes back from a raw query as Postgres's own text
const cashRowSchema = z.object({
  opening: z.string(),
  cash_taken: z.string(),
  change_given: z.string(),
  paid_in: z.string(),
  paid_out: z.string(),
  expected: z.string(),
});
type ShiftCashRow = z.infer<typeof cashRowSchema>;

// Decision 25: the commands refused at all are bugs, never the cashier's slip. A command for a
// shift the server does not have, or one of another device or another workspace: one answer.
export function shiftUnknown(): AppError {
  return new AppError(409, 'pos_shift_unknown', 'The server does not know this shift.', {
    fieldErrors: { shiftId: ['pos_shift_unknown'] },
  });
}

function alreadyOpen(): AppError {
  return new AppError(
    409,
    'pos_shift_already_open',
    'Another shift is still open on this register. Close it first.',
  );
}

function notHeld(): AppError {
  return new AppError(
    409,
    'pos_register_not_held',
    'This device does not hold the register the shift was opened on.',
    { fieldErrors: { registerId: ['pos_register_not_held'] } },
  );
}

// A count's total is stored with 4 decimals, and came with at most 2 (cashCountSchema): the last
// two are zeros, and the count goes back as it was typed ("5000.00", not "5000.0000")
function countTotal(value: string): string {
  return value.replace(/(\.\d{2})00$/, '$1');
}

// The device's own shift, FOR SHARE: a manager's close without a count (FOR UPDATE) waits for
// the sale or the movement that is being written, so the expected cash it stores counts it.
// Not this device's, or not this register's: the same answer as unknown (a bug either way).
export async function deviceShift(
  tx: Transaction,
  shiftId: string,
  deviceId: string,
  registerId?: string,
): Promise<ShiftRow> {
  const [row] = await tx
    .select()
    .from(posShifts)
    .where(and(eq(posShifts.tenantId, getTenantId()), eq(posShifts.id, shiftId)))
    .for('share');
  if (row?.deviceId !== deviceId || (registerId !== undefined && row.registerId !== registerId)) {
    throw shiftUnknown();
  }
  return row;
}

// POS shifts (step 20b). The device runs a shift and sends what happened as three sync commands:
// pos_shift.open, pos_cash_movement.create and pos_shift.close. Each is posted when it arrives,
// in the push's savepoint for that command, and is never refused for money or for permission
// (decision 25): the drawer was counted, the money moved. Every entry is the journal source
// pos_shift and points at the shift (decision 28), with the branch of the register's warehouse.
// The managers read the shifts here, and close a stuck one without a count (decision 11).
@Injectable()
export class PosShiftsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly posting: PostingService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // From the device

  // The opening count. The difference from what the last shift left posts to over/short
  // (decision 8); a register's first shift brings its count in from the float reason's account
  // (decision 12). The entry is posted first, because the opening columns never change once the
  // shift is written (0054): its id goes in with the row.
  async openFromDevice(
    tx: Transaction,
    access: Access,
    shiftId: string,
    input: PosShiftOpenInput,
  ): Promise<void> {
    const tenantId = getTenantId();
    const deviceId = this.deviceId();
    // The device, then the register (0052's lock order, like a sale). FOR UPDATE on the register:
    // the shifts of one register open one after the other, so the last one read here is the last.
    await this.lockDevice(tx, deviceId);
    const [register] = await tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, tenantId), eq(posRegisters.id, input.registerId)))
      .for('update');
    if (register?.deviceId !== deviceId) throw notHeld();
    const number = formatShiftNumber(register.code, input.sequence);

    // The latest shift of the register. Open: the device did not know it (a bug), and the
    // database would refuse the second open anyway (pos_shifts_register_open_idx).
    const [last] = await tx
      .select()
      .from(posShifts)
      .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.registerId, register.id)))
      .orderBy(desc(posShifts.sequence))
      .limit(1);
    if (last?.status === 'open') throw alreadyOpen();
    // What should be in the drawer: the last count, or, when nobody counted, what the server
    // expects now. Now and not at that close: a device that was offline sends the last sales of
    // its shift after a manager's close (decision 63), and their cash is in the drawer and in the
    // books already. undefined = the register's first shift.
    const comparedWith =
      last === undefined
        ? null
        : last.status === 'closed_without_count'
          ? (await this.cashOf(tx, last.id)).expected
          : last.countedCash;
    if (last !== undefined && comparedWith === null) {
      throw new Error(`Closed POS shift ${last.id} has no cash left`);
    }

    const date = await bookingDay(tx, input.date);
    const opening = input.opening.total;
    const branchId = await this.branchOf(tx, register);
    const document = { id: shiftId, number, date, branchId };
    let floatReason: { id: string; name: string } | null = null;
    let entry: EntryRef | null = null;
    if (comparedWith !== null) {
      // Over: more in the drawer than was left, which comes in from over/short. Short: the other way.
      entry = await this.postDifference(
        tx,
        document,
        register,
        cashDifferenceOf(opening, comparedWith),
        `POS shift ${number}: opening count`,
      );
    } else if (input.floatReasonId !== null) {
      // Decision 12: the float comes from the "in" reason's account. A reason of the other way,
      // or one the server does not know, is a bug on the device (it shows only "in" reasons).
      const reason = await this.reason(tx, input.floatReasonId);
      if (reason?.direction !== 'in') {
        throw new AppError(409, 'pos_float_reason_required', 'Pick where the float came from.', {
          fieldErrors: { floatReasonId: ['pos_float_reason_required'] },
        });
      }
      floatReason = { id: reason.id, name: reason.name };
      if (!isZeroMoney(opening)) {
        entry = await this.postMove(
          tx,
          document,
          { debit: register.cashAccountId, credit: reason.accountId, amount: opening },
          `POS shift ${number}: float, ${reason.name}`,
        );
      }
    } else {
      // A first shift without a reason: the device always asks for one when the drawer holds
      // money, so only a bug gets here. The money is still in the drawer: over/short takes it.
      entry = await this.postDifference(
        tx,
        document,
        register,
        opening,
        `POS shift ${number}: opening count`,
      );
    }

    try {
      await tx.insert(posShifts).values({
        id: shiftId,
        tenantId,
        registerId: register.id,
        deviceId,
        sequence: input.sequence,
        number,
        openedAt: new Date(input.openedAt),
        openingDate: date,
        openingNotes: input.opening.notes,
        openingCash: opening,
        openingComparedWith: comparedWith,
        floatReasonId: floatReason?.id ?? null,
        openingEntryId: entry?.id ?? null,
        createdBy: currentPrincipal().userId,
        updatedBy: currentPrincipal().userId,
      });
    } catch (error) {
      // The register is locked, so only a bug gets here; the savepoint takes the entry back too
      if (isUniqueViolation(error, 'pos_shifts_register_open_idx')) throw alreadyOpen();
      if (isCheckViolation(error, 'pos_shifts_register_not_held')) throw notHeld();
      if (
        isUniqueViolation(error, 'pos_shifts_register_sequence_idx') ||
        isUniqueViolation(error, 'pos_shifts_tenant_number_idx')
      ) {
        throw new AppError(409, 'pos_number_taken', `Another shift already has number ${number}.`, {
          fieldErrors: { sequence: ['pos_number_taken'] },
        });
      }
      throw error;
    }

    await audit(tx, {
      action: 'pos_shift.opened',
      entityType: 'pos_shift',
      entityId: shiftId,
      changes: created({
        number,
        date,
        openedOn: input.date,
        opening,
        comparedWith,
        floatReason: floatReason?.name ?? null,
        entry: entry?.number ?? null,
      }),
    });
    await this.auditPermission(tx, access, shiftId, number, input.date);
  }

  // A pay in or a pay out (decision 4): Dr the register's cash / Cr the reason's account, or the
  // other way. Written also for a shift closed since: the money moved, like a late sale (0054
  // lets it in, decision 39).
  async moveCashFromDevice(
    tx: Transaction,
    access: Access,
    movementId: string,
    input: PosCashMovementInput,
  ): Promise<void> {
    const deviceId = this.deviceId();
    await this.lockDevice(tx, deviceId);
    const shift = await deviceShift(tx, input.shiftId, deviceId);
    // An archived reason still posts (decision 40); an unknown one is a bug on the device
    const reason = await this.reason(tx, input.reasonId);
    if (!reason) {
      throw new AppError(409, 'pos_reason_required', 'The server does not know this reason.', {
        fieldErrors: { reasonId: ['pos_reason_required'] },
      });
    }
    const register = await this.register(tx, shift.registerId);
    const date = await bookingDay(tx, input.date);
    const document = {
      id: shift.id,
      number: shift.number,
      date,
      branchId: await this.branchOf(tx, register),
    };
    const cash = register.cashAccountId;
    const entry = await this.postMove(
      tx,
      document,
      reason.direction === 'in'
        ? { debit: cash, credit: reason.accountId, amount: input.amount }
        : { debit: reason.accountId, credit: cash, amount: input.amount },
      `POS shift ${shift.number}: pay ${reason.direction}, ${reason.name}`,
    );
    if (entry === null) throw new Error('A pay in or pay out above zero posted nothing');
    await tx.insert(posCashMovements).values({
      id: movementId,
      tenantId: getTenantId(),
      shiftId: shift.id,
      reasonId: reason.id,
      direction: reason.direction,
      amount: input.amount,
      note: input.note,
      date,
      movedAt: new Date(input.movedAt),
      // The reason's account now: a later change of the reason moves no money (decision 20)
      accountId: reason.accountId,
      entryId: entry.id,
      createdBy: currentPrincipal().userId,
      updatedBy: currentPrincipal().userId,
    });
    await audit(tx, {
      action: 'pos_shift.cash_moved',
      entityType: 'pos_shift',
      entityId: shift.id,
      changes: created({
        reason: reason.name,
        direction: reason.direction,
        amount: input.amount,
        note: input.note,
        date,
        entry: entry.number,
        shiftStatus: shift.status,
      }),
    });
    await this.auditPermission(tx, access, shift.id, shift.number, input.date);
  }

  // The closing count (decisions 5, 9, 22). The server works the expected cash out again from its
  // own rows (pos_shift_cash), posts the difference to over/short, and rings the bell over the
  // register's limit. The close arrives after every sale and movement of the shift: the device's
  // outbox sends them in order.
  async closeFromDevice(
    tx: Transaction,
    access: Access,
    shiftId: string,
    input: PosShiftCloseInput,
  ): Promise<void> {
    const tenantId = getTenantId();
    const deviceId = this.deviceId();
    // The device, the shift, then the register: a revoke's order (0054), so the two never wait
    // for each other in a circle
    await this.lockDevice(tx, deviceId);
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, shiftId)))
      .for('update');
    if (shift?.deviceId !== deviceId) throw shiftUnknown();
    const counted = input.counted.total;

    // Decision 38: a manager (or a revoke) closed it without a count before this arrived. The
    // shift never changes again, so the count goes to the audit log only. Never a refusal: the
    // cashier did count. A second close of a counted shift (a bug) is kept the same way.
    if (shift.status !== 'open') {
      await audit(tx, {
        action: 'pos_shift.closed',
        entityType: 'pos_shift',
        entityId: shift.id,
        changes: created({
          number: shift.number,
          counted,
          deviceExpected: input.deviceExpected,
          closedOn: input.date,
          kept: false,
          statusBefore: shift.status,
        }),
      });
      await this.auditPermission(tx, access, shift.id, shift.number, input.date);
      return;
    }

    // FOR SHARE: the over/short account and the limit stay as read until we commit
    const register = await this.register(tx, shift.registerId, true);
    const cash = await this.cashOf(tx, shift.id);
    const difference = cashDifferenceOf(counted, cash.expected);
    const date = await bookingDay(tx, input.date);
    const entry = await this.postDifference(
      tx,
      { id: shift.id, number: shift.number, date, branchId: await this.branchOf(tx, register) },
      register,
      difference,
      `POS shift ${shift.number}: closing count`,
    );

    await tx
      .update(posShifts)
      .set({
        status: 'closed',
        closedAt: new Date(input.closedAt),
        closingDate: date,
        closingNotes: input.counted.notes,
        countedCash: counted,
        deviceExpected: input.deviceExpected,
        heldDropped: input.heldDropped,
        expectedCash: cash.expected,
        closingEntryId: entry?.id ?? null,
        version: sql`${posShifts.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, shift.id)));

    await audit(tx, {
      action: 'pos_shift.closed',
      entityType: 'pos_shift',
      entityId: shift.id,
      changes: created({
        number: shift.number,
        date,
        closedOn: input.date,
        counted,
        expected: cash.expected,
        difference,
        heldDropped: input.heldDropped,
        entry: entry?.number ?? null,
      }),
    });
    // Decision 22: the books keep the server's number; a different one on the device means a sale
    // or a movement is missing on one side
    if (compareMoney(input.deviceExpected, cash.expected) !== 0) {
      await audit(tx, {
        action: 'pos_shift.expected_differs',
        entityType: 'pos_shift',
        entityId: shift.id,
        changes: created({ device: input.deviceExpected, server: cash.expected }),
      });
    }
    await this.auditPermission(tx, access, shift.id, shift.number, input.date);
    // Decision 5: the managers hear about a big difference after the commit
    if (isOverVarianceAlert(difference, register.varianceAlert)) {
      await emit(tx, 'pos.shift_variance', { shiftId: shift.id });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // For the managers (pos.shift.manage)

  list(query: {
    limit: number;
    cursor?: string | undefined;
    registerId?: string | undefined;
    status?: PosShiftStatus | undefined;
  }): Promise<{ items: PosShiftSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.registerId === undefined ? undefined : eq(posShifts.registerId, query.registerId),
          query.status === undefined ? undefined : eq(posShifts.status, query.status),
          after === undefined
            ? undefined
            : sql`(${posShifts.openedAt}, ${posShifts.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.openedAt, last.id]);
    });
  }

  get(id: string): Promise<PosShift> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  // Decision 11: a shift nobody can close at its counter (the cashier went home, the PC is in
  // repair). Nobody counted, so nothing posts; the server's expected cash is what the next
  // shift's opening count is compared with, and finds what is missing.
  closeWithoutCount(id: string, input: PosShiftCloseWithoutCountInput): Promise<PosShift> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      // FOR UPDATE: a sale or a movement being written (FOR SHARE, deviceShift) finishes first,
      // so the expected cash counts it. A close from the device waits for this one, then finds the
      // shift closed (decision 38).
      const [shift] = await tx
        .select()
        .from(posShifts)
        .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, id)))
        .for('update');
      if (!shift) throw notFound('POS shift');
      if (shift.status !== 'open') {
        throw new AppError(409, 'pos_shift_closed', 'This shift is closed already.');
      }
      const cash = await this.cashOf(tx, id);
      await tx
        .update(posShifts)
        .set({
          status: 'closed_without_count',
          closedAt: new Date(),
          closedBy: currentPrincipal().userId,
          expectedCash: cash.expected,
          version: sql`${posShifts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, id)));
      await audit(tx, {
        action: 'pos_shift.closed_without_count',
        entityType: 'pos_shift',
        entityId: id,
        changes: created({
          number: shift.number,
          expected: cash.expected,
          note: input.note,
          by: 'manager',
        }),
      });
      return this.read(tx, id);
    });
  }

  // ---------------------------------------------------------------------------------------------

  private deviceId(): string {
    const deviceId = currentDeviceId();
    if (deviceId === null) throw new Error('A POS shift command comes only from a device');
    return deviceId;
  }

  // A revoke of this device that is running finishes first: it closes the device's open shift
  // and frees the register, and this command then sees it
  private async lockDevice(tx: Transaction, deviceId: string): Promise<void> {
    await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.tenantId, getTenantId()), eq(devices.id, deviceId)))
      .for('share');
  }

  private async register(tx: Transaction, id: string, lock = false): Promise<PosRegisterRow> {
    const query = tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, getTenantId()), eq(posRegisters.id, id)));
    const [row] = lock ? await query.for('share') : await query;
    if (!row) throw new Error(`POS register ${id} of a shift is missing`);
    return row;
  }

  private async reason(tx: Transaction, id: string) {
    const [row] = await tx
      .select()
      .from(posCashReasons)
      .where(and(eq(posCashReasons.tenantId, getTenantId()), eq(posCashReasons.id, id)));
    return row;
  }

  // The branch of the register's warehouse now, like a sale's lines
  private async branchOf(tx: Transaction, register: PosRegisterRow): Promise<string> {
    const [row] = await tx
      .select({ branchId: warehouses.branchId })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, register.warehouseId)));
    if (!row) throw new Error(`Warehouse ${register.warehouseId} of a POS register is missing`);
    return row.branchId;
  }

  // With 4 decimals, like every amount of the API: a sum of no rows is coalesce's plain 0
  private async cashOf(tx: Transaction, shiftId: string): Promise<ShiftCashRow> {
    const [row] = z.array(cashRowSchema).parse(
      await tx.execute(sql`
        SELECT opening::numeric(19, 4)::text AS opening,
               cash_taken::numeric(19, 4)::text AS cash_taken,
               change_given::numeric(19, 4)::text AS change_given,
               paid_in::numeric(19, 4)::text AS paid_in,
               paid_out::numeric(19, 4)::text AS paid_out,
               expected::numeric(19, 4)::text AS expected
          FROM pos_shift_cash(${getTenantId()}::uuid, ${shiftId}::uuid)`),
    );
    if (!row) throw new Error(`POS shift ${shiftId} has no cash`);
    return row;
  }

  // A counted difference: over (above zero) comes in from over/short to the register's cash,
  // short goes the other way. null when the count matched.
  private postDifference(
    tx: Transaction,
    document: { id: string; number: string; date: string; branchId: string },
    register: PosRegisterRow,
    difference: string,
    narration: string,
  ): Promise<EntryRef | null> {
    if (isZeroMoney(difference)) return Promise.resolve(null);
    // Required in the register's form since 20b; a register from 20a opens no shift without it
    // (decision 13), so only a device that skipped that check gets here
    const overShort = register.overShortAccountId;
    if (overShort === null) {
      throw new AppError(
        409,
        'pos_over_short_required',
        'Pick the over/short account of this register in Settings → POS.',
      );
    }
    const amount = absMoney(difference);
    return this.postMove(
      tx,
      document,
      compareMoney(difference, '0') > 0
        ? { debit: register.cashAccountId, credit: overShort, amount }
        : { debit: overShort, credit: register.cashAccountId, amount },
      narration,
    );
  }

  // One entry of two lines, both with the branch of the register's warehouse. null for nothing.
  private async postMove(
    tx: Transaction,
    document: { id: string; number: string; date: string; branchId: string },
    move: { debit: string; credit: string; amount: string },
    narration: string,
  ): Promise<EntryRef | null> {
    if (isZeroMoney(move.amount)) return null;
    const line = { branchId: document.branchId, partyId: null, description: null };
    const entry = await this.posting.postNew(tx, {
      date: document.date,
      narration,
      source: 'pos_shift',
      document: { id: document.id, number: document.number },
      lines: [
        { ...line, accountId: move.debit, debit: move.amount, credit: '0' },
        { ...line, accountId: move.credit, debit: '0', credit: move.amount },
      ],
    });
    if (entry.number === null) throw new Error('A posted entry has no number');
    return { id: entry.id, number: entry.number };
  }

  // Decision 25, like a sale's (step 20a, decision 28): the command went through without the
  // permission, which was taken away while the device was offline
  private async auditPermission(
    tx: Transaction,
    access: Access,
    shiftId: string,
    number: string,
    deviceDate: string,
  ): Promise<void> {
    if (access.permissions.includes('pos.sale.create')) return;
    await audit(tx, {
      action: 'pos_shift.without_permission',
      entityType: 'pos_shift',
      entityId: shiftId,
      changes: created({ number, on: deviceDate, missing: 'pos.sale.create' }),
    });
  }

  // The list's rows. A counted shift shows what the drawer should have held at its close; an open
  // one, and one closed without a count, what it should hold now (late sales count, decision 63).
  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<PosShiftSummary[]> {
    const rows = await tx
      .select({
        shift: posShifts,
        register: { id: posRegisters.id, code: posRegisters.code, name: posRegisters.name },
        branchId: warehouses.branchId,
        cashierName: users.fullName,
        deviceName: devices.name,
        expectedNow: sql<string>`CASE WHEN ${posShifts.status} = 'closed'
          THEN ${posShifts.expectedCash}::text
          ELSE (SELECT c.expected::text FROM pos_shift_cash(${posShifts.tenantId}, ${posShifts.id}) c)
          END`,
        saleCount: sql<number>`(SELECT count(*)::int FROM pos_sales x
          WHERE x.tenant_id = ${posShifts.tenantId} AND x.shift_id = ${posShifts.id})`,
        salesTotal: sql<string>`(SELECT coalesce(sum(x.total), 0)::numeric(19, 4)::text FROM pos_sales x
          WHERE x.tenant_id = ${posShifts.tenantId} AND x.shift_id = ${posShifts.id})`,
      })
      .from(posShifts)
      .innerJoin(
        posRegisters,
        and(
          eq(posRegisters.tenantId, posShifts.tenantId),
          eq(posRegisters.id, posShifts.registerId),
        ),
      )
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, posRegisters.tenantId),
          eq(warehouses.id, posRegisters.warehouseId),
        ),
      )
      .innerJoin(
        devices,
        and(eq(devices.tenantId, posShifts.tenantId), eq(devices.id, posShifts.deviceId)),
      )
      .leftJoin(users, eq(users.id, posShifts.createdBy))
      .where(and(eq(posShifts.tenantId, getTenantId()), where))
      .orderBy(desc(posShifts.openedAt), desc(posShifts.id))
      .limit(limit);
    return rows.map((row) => {
      const { shift } = row;
      // created_by is the device's person: never empty for a shift (openFromDevice sets it)
      if (shift.createdBy === null) throw new Error(`POS shift ${shift.id} has no cashier`);
      return {
        id: shift.id,
        number: shift.number,
        register: row.register,
        branchId: row.branchId,
        sequence: shift.sequence,
        status: shift.status,
        cashier: { id: shift.createdBy, fullName: row.cashierName ?? '' },
        device: { id: shift.deviceId, name: row.deviceName },
        openedAt: shift.openedAt.toISOString(),
        closedAt: shift.closedAt?.toISOString() ?? null,
        openingCash: countTotal(shift.openingCash),
        expectedCash: row.expectedNow,
        countedCash: shift.countedCash === null ? null : countTotal(shift.countedCash),
        difference:
          shift.countedCash === null || shift.expectedCash === null
            ? null
            : cashDifferenceOf(shift.countedCash, shift.expectedCash),
        saleCount: row.saleCount,
        salesTotal: row.salesTotal,
      };
    });
  }

  // One shift with everything its page shows
  private async read(tx: Transaction, id: string): Promise<PosShift> {
    const tenantId = getTenantId();
    const [summary] = await this.summaries(tx, eq(posShifts.id, id), 1);
    if (!summary) throw notFound('POS shift');
    const [header] = await tx
      .select({ shift: posShifts, closerName: closer.fullName })
      .from(posShifts)
      .leftJoin(closer, eq(closer.id, posShifts.closedBy))
      .where(and(eq(posShifts.tenantId, tenantId), eq(posShifts.id, id)));
    if (!header) throw notFound('POS shift');
    const { shift } = header;
    const register = await this.register(tx, shift.registerId);
    const cash = await this.cashOf(tx, id);

    const movementRows = await tx
      .select({
        movement: posCashMovements,
        reasonName: posCashReasons.name,
        entryNumber: journalEntries.number,
      })
      .from(posCashMovements)
      .innerJoin(
        posCashReasons,
        and(
          eq(posCashReasons.tenantId, posCashMovements.tenantId),
          eq(posCashReasons.id, posCashMovements.reasonId),
        ),
      )
      .innerJoin(
        journalEntries,
        and(
          eq(journalEntries.tenantId, posCashMovements.tenantId),
          eq(journalEntries.id, posCashMovements.entryId),
        ),
      )
      .where(and(eq(posCashMovements.tenantId, tenantId), eq(posCashMovements.shiftId, id)))
      .orderBy(asc(posCashMovements.movedAt), asc(posCashMovements.id));

    // What the sales took by each method: every method the register takes now, and any other one
    // a sale of the shift was paid with, in the contract's order (cash first)
    const paid = await tx
      .select({
        method: posSalePayments.method,
        amount: sql<string>`sum(${posSalePayments.amount})::text`,
      })
      .from(posSalePayments)
      .innerJoin(
        posSales,
        and(
          eq(posSales.tenantId, posSalePayments.tenantId),
          eq(posSales.id, posSalePayments.saleId),
        ),
      )
      .where(and(eq(posSalePayments.tenantId, tenantId), eq(posSales.shiftId, id)))
      .groupBy(posSalePayments.method);
    const paidBy = new Map(paid.map((row) => [row.method, row.amount]));
    const payments = POS_PAYMENT_METHODS.flatMap((method) => {
      const amount = paidBy.get(method);
      if (amount === undefined && accountOf(register, method) === null) return [];
      return [{ method, amount: amount ?? '0.0000' }];
    });

    const reasonIds = shift.floatReasonId === null ? [] : [shift.floatReasonId];
    const [floatReason] =
      reasonIds.length === 0
        ? []
        : await tx
            .select({ id: posCashReasons.id, name: posCashReasons.name })
            .from(posCashReasons)
            .where(
              and(eq(posCashReasons.tenantId, tenantId), inArray(posCashReasons.id, reasonIds)),
            );
    const entries = await this.entryRefs(
      tx,
      [shift.openingEntryId, shift.closingEntryId].flatMap((entryId) =>
        entryId === null ? [] : [entryId],
      ),
    );
    const entryOf = (entryId: string | null) =>
      entryId === null ? null : (entries.get(entryId) ?? null);

    return {
      ...summary,
      opening: {
        count: { notes: shift.openingNotes, total: countTotal(shift.openingCash) },
        date: shift.openingDate,
        comparedWith: shift.openingComparedWith,
        difference:
          shift.openingComparedWith === null
            ? null
            : subtractMoney(shift.openingCash, shift.openingComparedWith),
        floatReason: floatReason ?? null,
        entry: entryOf(shift.openingEntryId),
      },
      closing:
        shift.status === 'closed' &&
        shift.countedCash !== null &&
        shift.closingDate !== null &&
        shift.deviceExpected !== null &&
        shift.heldDropped !== null
          ? {
              count: { notes: shift.closingNotes, total: countTotal(shift.countedCash) },
              date: shift.closingDate,
              deviceExpected: shift.deviceExpected,
              heldDropped: shift.heldDropped,
              entry: entryOf(shift.closingEntryId),
            }
          : null,
      closedBy:
        shift.closedBy === null ? null : { id: shift.closedBy, fullName: header.closerName ?? '' },
      cash: {
        opening: cash.opening,
        cashTaken: cash.cash_taken,
        changeGiven: cash.change_given,
        paidIn: cash.paid_in,
        paidOut: cash.paid_out,
      },
      payments,
      movements: movementRows.map(({ movement, reasonName, entryNumber }) => {
        // A movement's entry is posted the moment it is written (openFromDevice): it has a number
        if (entryNumber === null) throw new Error(`Entry of movement ${movement.id} is a draft`);
        return {
          id: movement.id,
          reason: { id: movement.reasonId, name: reasonName },
          direction: movement.direction,
          amount: movement.amount,
          note: movement.note,
          date: movement.date,
          movedAt: movement.movedAt.toISOString(),
          accountId: movement.accountId,
          entry: { id: movement.entryId, number: entryNumber },
        };
      }),
    };
  }

  private async entryRefs(tx: Transaction, ids: readonly string[]): Promise<Map<string, EntryRef>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, getTenantId()), inArray(journalEntries.id, ids)));
    const refs = new Map<string, EntryRef>();
    for (const row of rows) {
      if (row.number !== null) refs.set(row.id, { id: row.id, number: row.number });
    }
    return refs;
  }
}
