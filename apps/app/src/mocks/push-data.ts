import {
  ADDRESS_KINDS,
  type AddressKind,
  type AuditEntry,
  compareMoney,
  contractErrorMap,
  type CustomerAddressChanges,
  type CustomerChanges,
  type CustomerField,
  type CustomerInput,
  type ErrorCode,
  isErrorCode,
  MAX_CUSTOMER_ADDRESSES,
  SERVER_WINS_CUSTOMER_FIELDS,
  SYNC_COMMAND_TYPES,
  SYNC_PROTOCOL,
  type SyncChange,
  type SyncCommand,
  type SyncCommandError,
  syncCommandSchema,
  type SyncCommandType,
  type SyncNotice,
  type syncPushInputSchema,
  type SyncPush,
  type SyncResult,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { MockProblem } from './mock';
import { createSale, keepNumber, overrideText } from './pos-data';
import { createPosReturn, keepReturnNumber, keptSalesOf, toReturnable } from './pos-return-data';
import { closeShift, moveCash, openShift } from './pos-shift-data';
import { type MockCustomer, refreshPartyRefs, saveCustomer } from './sales-data';
import { createOrder } from './sales-document-data';
import { copyToSupplier } from './supplier-data';
import { deviceFor, type MockAnswer } from './sync-data';
import { diff, record, transaction, type WorkspaceData } from './workspace-data';

// The mock's step 18b: the push. The API's sync-push.service.ts and customer-merge.ts on plain
// arrays, shortened: the commands run in the order sent, each on its own, and one refused command
// does not stop the ones after it. Each answer is kept by the command's id (MockSync.answers), so
// a batch sent again after a lost answer changes nothing twice. The mock's person is the owner,
// who has every permission, so the per-command permission check (decision 17) is left out.
// Step 20a: a POS sale (pos-data.ts's createSale) is posted when it arrives. Step 20b: so are a
// shift's open, its pay ins and outs, and its close (pos-shift-data.ts). Step 20c: and a return
// (pos-return-data.ts).

type PushInput = z.output<typeof syncPushInputSchema>;
type PushedCommand = PushInput['commands'][number];

function isSyncCommandType(type: string): type is SyncCommandType {
  return SYNC_COMMAND_TYPES.some((known) => known === type);
}

export function push(data: WorkspaceData, userId: string, input: PushInput): SyncPush {
  // The protocol first, like the pull: an old app is told to reload before anything else
  if (input.protocol !== SYNC_PROTOCOL) throw new MockProblem(409, 'sync_protocol_mismatch');
  const device = deviceFor(data, userId, input.deviceId);
  const from = { id: device.id, name: device.name, userId };
  return {
    results: input.commands.map((pushed) => run(data, from, pushed)),
    serverTime: new Date().toISOString(),
  };
}

// The device the commands came from, as the audit rows name it, and its person (a shift's cashier)
type From = NonNullable<AuditEntry['device']> & { userId: string };

function run(data: WorkspaceData, device: From, pushed: PushedCommand): SyncResult {
  // A command the mock cannot read is refused alone and keeps no answer (decision 24). The app's
  // forms check the same schemas, so only a bug gets here: the paths are the command's own, not
  // the form's (the API's decision 22 is not repeated here).
  if (!isSyncCommandType(pushed.type)) return refused(pushed.id, { code: 'sync_command_invalid' });
  const parsed = syncCommandSchema.safeParse(pushed, { error: contractErrorMap });
  if (!parsed.success) {
    const fieldErrors: Record<string, ErrorCode[]> = {};
    for (const issue of parsed.error.issues) {
      const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
      (fieldErrors[issue.path.map(String).join('.') || 'command'] ??= []).push(code);
    }
    return refused(pushed.id, { code: 'invalid_input', fieldErrors });
  }
  const command = parsed.data;

  // Sent before: answered from what was kept, accepted or refused
  const stored = data.sync.answers.get(command.id);
  if (stored) return answerOf(data, device.id, command.id, stored);

  const key = { type: command.type, entityId: entityOf(command) };
  try {
    // transaction() puts the documents, the stock and the audit log back if the command throws,
    // like the API's savepoint. A customer is checked in full before it is written.
    const notices = transaction(data, () => apply(data, device, command));
    const answer: MockAnswer = { ...key, status: 'accepted', notices };
    data.sync.answers.set(command.id, answer);
    return answerOf(data, device.id, command.id, answer);
  } catch (error) {
    // A rule of the mock refused it: kept as refused. Anything else is a bug in the mock.
    if (!(error instanceof MockProblem)) throw error;
    // Step 20a (decision 37): the refused sale's receipt was printed, so its number stays used.
    // After transaction() put everything back, like the API's keepNumber() after the savepoint.
    if (command.type === 'pos_sale.create') keepNumber(data, command.input);
    // Step 20c (decision 43): a refused return's slip too
    if (command.type === 'pos_return.create') keepReturnNumber(data, command.input);
    const refusal: SyncCommandError = {
      code: error.code,
      ...(error.fieldErrors && { fieldErrors: error.fieldErrors }),
      ...(error.params && { params: error.params }),
    };
    data.sync.answers.set(command.id, { ...key, status: 'rejected', error: refusal });
    return refused(command.id, refusal);
  }
}

function entityOf(command: SyncCommand): string {
  switch (command.type) {
    case 'customer.create':
    case 'customer.update':
      return command.customerId;
    case 'sales_order.create_draft':
      return command.orderId;
    case 'pos_sale.create':
      return command.saleId;
    case 'pos_shift.open':
    case 'pos_shift.close':
      return command.shiftId;
    case 'pos_cash_movement.create':
      return command.movementId;
    case 'pos_return.create':
      return command.returnId;
  }
}

function refused(id: string, error: SyncCommandError): SyncResult {
  return { id, status: 'rejected', error };
}

// An accepted answer brings the customer as it is now, also when it is sent again (decision 18):
// an old answer never puts an older row back on the device. Archived since: a delete, like in a
// delta pull. An order and a shift's command bring nothing: they are not on the device as rows
// (the register's latest shift comes with the next pull). Step 20c (decision 23): a POS sale or
// return brings the sale's pos_sale row, so the return screen knows at once what is left of it; a
// sale the device does not keep (another register's, or older than its days) is a delete, which
// it ignores.
function answerOf(
  data: WorkspaceData,
  deviceId: string,
  id: string,
  answer: MockAnswer,
): SyncResult {
  if (answer.status === 'rejected') return refused(id, answer.error);
  return {
    id,
    status: 'accepted',
    notices: answer.notices,
    changes: changesOf(data, deviceId, answer),
  };
}

function changesOf(data: WorkspaceData, deviceId: string, answer: MockAnswer): SyncChange[] {
  if (answer.type === 'pos_sale.create' || answer.type === 'pos_return.create') {
    const saleId =
      answer.type === 'pos_sale.create'
        ? answer.entityId
        : data.pos.returns.find((item) => item.id === answer.entityId)?.saleId;
    if (saleId === undefined) return [];
    const kept = keptSalesOf(data, deviceId).find((sale) => sale.id === saleId);
    if (!kept) return [{ op: 'delete', entity: 'pos_sale', key: saleId }];
    return [{ op: 'upsert', entity: 'pos_sale', key: kept.id, data: toReturnable(data, kept) }];
  }
  if (answer.type !== 'customer.create' && answer.type !== 'customer.update') return [];
  const found = data.sales.customers.find((item) => item.id === answer.entityId);
  // Not found (undefined), or archived
  if (found?.archivedAt !== null) {
    return [{ op: 'delete', entity: 'customer', key: answer.entityId }];
  }
  return [{ op: 'upsert', entity: 'customer', key: found.id, data: found }];
}

// --- The commands -------------------------------------------------------------------------------

function apply(data: WorkspaceData, from: From, command: SyncCommand): SyncNotice[] {
  const device = { id: from.id, name: from.name };
  switch (command.type) {
    case 'customer.create': {
      assertIdsFree(data, [command.customerId], command.input.addresses);
      const saved = saveCustomer(data, command.input, undefined, {
        customerId: command.customerId,
      });
      data.sales.customers.push(saved);
      record(
        data,
        'customer.created',
        'customer',
        saved.id,
        diff({}, { code: saved.code, name: saved.name }),
        device,
      );
      return [];
    }
    case 'customer.update': {
      const target = data.sales.customers.find((item) => item.id === command.customerId);
      // Deleted since the device read it, or no longer a customer
      if (!target) throw new MockProblem(409, 'sync_customer_gone');
      const { input, kept } = mergeCustomer(data, target, command);
      const saved = saveCustomer(data, input, target, { customerId: target.id });
      data.sales.customers = data.sales.customers.map((item) =>
        item.id === target.id ? saved : item,
      );
      refreshPartyRefs(data, saved);
      copyToSupplier(data, saved);
      record(
        data,
        'customer.updated',
        'customer',
        target.id,
        diff(
          { code: target.code, name: target.name, paymentTermsDays: target.paymentTermsDays },
          { code: saved.code, name: saved.name, paymentTermsDays: saved.paymentTermsDays },
        ),
        device,
      );
      return kept.length === 0 ? [] : [{ code: 'kept_server_value', fields: kept }];
    }
    case 'sales_order.create_draft': {
      if (data.salesDocuments.orders.some((item) => item.id === command.orderId)) {
        throw new MockProblem(409, 'sync_id_taken');
      }
      // A draft only (decision 15): confirming it is done online, with the credit check
      const created = createOrder(data, command.input, null, command.orderId);
      record(data, 'sales_order.created', 'sales_order', created.id, {}, device);
      return [];
    }
    case 'pos_sale.create': {
      if (data.pos.sales.some((sale) => sale.id === command.saleId)) {
        throw new MockProblem(409, 'sync_id_taken');
      }
      const { sale, overrides, shortLines } = createSale(
        data,
        device.id,
        command.saleId,
        command.input,
      );
      record(
        data,
        'pos_sale.created',
        'pos_sale',
        sale.id,
        diff(
          {},
          {
            number: sale.number,
            date: sale.date,
            soldOn: command.input.date,
            register: sale.register.code,
            customer: sale.customer?.code ?? null,
            total: sale.total,
            paid: sale.paid,
            entry: sale.entry?.number ?? null,
            soldShort: shortLines,
          },
        ),
        device,
      );
      // Decision 25: written, never a refusal. The mock's owner has pos.price.override.
      if (overrides.length > 0) {
        const register = data.pos.registers.find((item) => item.id === sale.register.id);
        record(
          data,
          'pos_sale.overridden',
          'pos_sale',
          sale.id,
          diff(
            {},
            {
              overrides: overrideText(overrides),
              maxDiscountPercent: register?.maxDiscountPercent ?? null,
              allowed: true,
            },
          ),
          device,
        );
      }
      return [];
    }
    // Step 20b: the audit rows are the API's. The mock's person is the owner, who has
    // pos.sale.create, so pos_shift.without_permission is never written.
    case 'pos_shift.open': {
      const { shift, floatReason } = openShift(data, from, command.shiftId, command.input);
      record(
        data,
        'pos_shift.opened',
        'pos_shift',
        shift.id,
        diff(
          {},
          {
            number: shift.number,
            date: shift.opening.date,
            openedOn: command.input.date,
            opening: command.input.opening.total,
            comparedWith: shift.opening.comparedWith,
            floatReason,
            entry: shift.opening.entry?.number ?? null,
          },
        ),
        device,
      );
      return [];
    }
    case 'pos_cash_movement.create': {
      const { shift, movement, reason } = moveCash(
        data,
        device.id,
        command.movementId,
        command.input,
      );
      record(
        data,
        'pos_shift.cash_moved',
        'pos_shift',
        shift.id,
        diff(
          {},
          {
            reason: reason.name,
            direction: movement.direction,
            amount: command.input.amount,
            note: movement.note,
            date: movement.date,
            entry: movement.entry.number,
            shiftStatus: shift.status,
          },
        ),
        device,
      );
      return [];
    }
    case 'pos_shift.close': {
      const { input } = command;
      const closed = closeShift(data, device.id, command.shiftId, input);
      const { shift } = closed;
      if (!closed.kept) {
        // Decision 38: never a refusal, the cashier did count
        record(
          data,
          'pos_shift.closed',
          'pos_shift',
          shift.id,
          diff(
            {},
            {
              number: shift.number,
              counted: input.counted.total,
              deviceExpected: input.deviceExpected,
              closedOn: input.date,
              kept: false,
              statusBefore: closed.statusBefore,
            },
          ),
          device,
        );
        return [];
      }
      record(
        data,
        'pos_shift.closed',
        'pos_shift',
        shift.id,
        diff(
          {},
          {
            number: shift.number,
            date: closed.date,
            closedOn: input.date,
            counted: input.counted.total,
            expected: closed.expected,
            difference: closed.difference,
            heldDropped: input.heldDropped,
            entry: closed.entry?.number ?? null,
          },
        ),
        device,
      );
      // Decision 22: the books keep the server's number
      if (compareMoney(input.deviceExpected, closed.expected) !== 0) {
        record(
          data,
          'pos_shift.expected_differs',
          'pos_shift',
          shift.id,
          diff({}, { device: input.deviceExpected, server: closed.expected }),
          device,
        );
      }
      return [];
    }
    // Step 20c: the API's audit rows (decision 20). The mock's person is the owner, who has
    // pos.return.create, so pos_return.without_permission is never written.
    case 'pos_return.create': {
      if (data.pos.returns.some((item) => item.id === command.returnId)) {
        throw new MockProblem(409, 'sync_id_taken');
      }
      const { input } = command;
      const done = createPosReturn(data, from, command.returnId, input);
      const { stored } = done;
      record(
        data,
        'pos_return.created',
        'pos_return',
        stored.id,
        diff(
          {},
          {
            number: stored.number,
            date: stored.date,
            returnedOn: input.date,
            register: done.registerCode,
            sale: done.sale.number,
            total: stored.total,
            refunds: input.refunds.map((refund) => `${refund.method} ${refund.amount}`).join(', '),
            entry: stored.entry?.number ?? null,
          },
        ),
        device,
      );
      if (stored.outsideWindow) {
        record(
          data,
          'pos_return.outside_window',
          'pos_return',
          stored.id,
          diff(
            {},
            {
              sale: done.sale.number,
              soldOn: done.sale.date,
              returnedOn: input.date,
              returnDays: String(done.returnDays),
            },
          ),
          device,
        );
      }
      if (done.over.length > 0) {
        record(
          data,
          'pos_return.over_returned',
          'pos_return',
          stored.id,
          diff({}, { lines: done.over.join('; ') }),
          device,
        );
      }
      if (done.differ.length > 0) {
        record(
          data,
          'pos_return.amounts_differ',
          'pos_return',
          stored.id,
          diff({}, { lines: done.differ.join('; ') }),
          device,
        );
      }
      return [];
    }
  }
}

// The ids a device made must still be free (decision 20): a new party's (a customer, or a
// supplier: one party table in the API) and its new addresses'. In the API the tables' primary
// keys say so, with sync_id_taken and no field.
function assertIdsFree(
  data: WorkspaceData,
  partyIds: readonly string[],
  addresses: readonly { id: string }[],
): void {
  const parties = new Set(
    [...data.sales.customers, ...data.suppliers.suppliers].map((party) => party.id),
  );
  const addressIds = new Set(
    data.sales.customers.flatMap((item) => item.addresses.map((address) => address.id)),
  );
  if (
    partyIds.some((id) => parties.has(id)) ||
    addresses.some((address) => addressIds.has(address.id))
  ) {
    throw new MockProblem(409, 'sync_id_taken');
  }
}

// --- The merge (the API's customer-merge.ts) ----------------------------------------------------

// A customer's address kind is a string in the contract, like the API's; the mock saved one of
// ADDRESS_KINDS, so anything else is a bug
function kindOf(kind: string): AddressKind {
  const known = ADDRESS_KINDS.find((candidate) => candidate === kind);
  if (!known) throw new Error(`Unknown address kind ${kind}`);
  return known;
}

const SERVER_WINS: ReadonlySet<CustomerField> = new Set(SERVER_WINS_CUSTOMER_FIELDS);

// Only the fields the person changed. A head-office field the server changed since the device read
// it (its value is no longer `from`) keeps the server's value, and the answer names it; any other
// field takes the device's value, whatever the server had: the later arrival wins (decision 6).
function mergeCustomer(
  data: WorkspaceData,
  now: MockCustomer,
  command: { changes: CustomerChanges; addresses: CustomerAddressChanges },
): { input: CustomerInput; kept: CustomerField[] } {
  const { changes } = command;
  const kept: CustomerField[] = [];
  function take<From extends To, To>(
    field: CustomerField,
    change: { from: From; to: To } | undefined,
    current: From,
  ): To {
    if (change === undefined) return current;
    if (SERVER_WINS.has(field) && change.from !== current) {
      kept.push(field);
      return current;
    }
    return change.to;
  }
  // Field by field, in the form's order: the notice lists the kept fields in that order
  const input: CustomerInput = {
    code: take('code', changes.code, now.code),
    name: take('name', changes.name, now.name),
    groupId: take('groupId', changes.groupId, now.groupId),
    contactPerson: take('contactPerson', changes.contactPerson, now.contactPerson),
    phone: take('phone', changes.phone, now.phone),
    email: take('email', changes.email, now.email),
    documentLanguage: take('documentLanguage', changes.documentLanguage, now.documentLanguage),
    bin: take('bin', changes.bin, now.bin),
    paymentTermsDays: take('paymentTermsDays', changes.paymentTermsDays, now.paymentTermsDays),
    creditLimit: take('creditLimit', changes.creditLimit, now.creditLimit),
    priceListId: take('priceListId', changes.priceListId, now.priceListId),
    notes: take('notes', changes.notes, now.notes),
    addresses: mergeAddresses(data, now, command.addresses),
  };
  return { input, kept };
}

// The addresses one by one, by id (decision 4): removed ones go, changed ones take the fields
// sent (an address the server removed meanwhile stays removed), added ones go at the end with the
// device's ids. Then the form's two rules again, on the merged list.
function mergeAddresses(
  data: WorkspaceData,
  now: MockCustomer,
  changes: CustomerAddressChanges,
): CustomerInput['addresses'] {
  const removed = new Set(changes.remove);
  const changed = new Map(changes.change.map((change) => [change.id, change]));
  assertIdsFree(data, [], changes.add);
  const merged = [
    ...now.addresses
      .filter((address) => !removed.has(address.id))
      .map((address) => {
        const change = changed.get(address.id);
        return {
          id: address.id,
          kind: change?.kind ?? kindOf(address.kind),
          label: change?.label === undefined ? address.label : change.label,
          address: change?.address ?? address.address,
          phone: change?.phone === undefined ? address.phone : change.phone,
        };
      }),
    ...changes.add,
  ];
  if (merged.length > MAX_CUSTOMER_ADDRESSES) {
    throw new MockProblem(409, 'too_long', { addresses: ['too_long'] });
  }
  const billing = merged.filter((address) => address.kind === 'billing');
  const second = billing[1];
  if (second !== undefined) {
    // On a billing address this change made: the one the person can fix in the outbox
    const touched = new Set([
      ...changes.add.map((address) => address.id),
      ...changes.change.flatMap((change) => (change.kind === undefined ? [] : [change.id])),
    ]);
    const { id } = billing.find((address) => touched.has(address.id)) ?? second;
    throw new MockProblem(409, 'customer_billing_twice', {
      [`addresses.${id}.kind`]: ['customer_billing_twice'],
    });
  }
  return merged;
}
