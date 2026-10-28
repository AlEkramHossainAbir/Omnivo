import {
  ADDRESS_KINDS,
  type AddressKind,
  type AuditEntry,
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
// Step 20a: a POS sale (pos-data.ts's createSale) is posted when it arrives.

type PushInput = z.output<typeof syncPushInputSchema>;
type PushedCommand = PushInput['commands'][number];

function isSyncCommandType(type: string): type is SyncCommandType {
  return SYNC_COMMAND_TYPES.some((known) => known === type);
}

export function push(data: WorkspaceData, userId: string, input: PushInput): SyncPush {
  // The protocol first, like the pull: an old app is told to reload before anything else
  if (input.protocol !== SYNC_PROTOCOL) throw new MockProblem(409, 'sync_protocol_mismatch');
  const device = deviceFor(data, userId, input.deviceId);
  const from = { id: device.id, name: device.name };
  return {
    results: input.commands.map((pushed) => run(data, from, pushed)),
    serverTime: new Date().toISOString(),
  };
}

function run(
  data: WorkspaceData,
  device: NonNullable<AuditEntry['device']>,
  pushed: PushedCommand,
): SyncResult {
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
  if (stored) return answerOf(data, command.id, stored);

  const key = { type: command.type, entityId: entityOf(command) };
  try {
    // transaction() puts the documents, the stock and the audit log back if the command throws,
    // like the API's savepoint. A customer is checked in full before it is written.
    const notices = transaction(data, () => apply(data, device, command));
    const answer: MockAnswer = { ...key, status: 'accepted', notices };
    data.sync.answers.set(command.id, answer);
    return answerOf(data, command.id, answer);
  } catch (error) {
    // A rule of the mock refused it: kept as refused. Anything else is a bug in the mock.
    if (!(error instanceof MockProblem)) throw error;
    // Step 20a (decision 37): the refused sale's receipt was printed, so its number stays used.
    // After transaction() put everything back, like the API's keepNumber() after the savepoint.
    if (command.type === 'pos_sale.create') keepNumber(data, command.input);
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
    case 'sales_order.create_draft':
      return command.orderId;
    case 'pos_sale.create':
      return command.saleId;
    default:
      return command.customerId;
  }
}

function refused(id: string, error: SyncCommandError): SyncResult {
  return { id, status: 'rejected', error };
}

// An accepted answer brings the customer as it is now, also when it is sent again (decision 18):
// an old answer never puts an older row back on the device. Archived since: a delete, like in a
// delta pull. An order and a POS sale bring nothing: they are not on the device.
function answerOf(data: WorkspaceData, id: string, answer: MockAnswer): SyncResult {
  if (answer.status === 'rejected') return refused(id, answer.error);
  return { id, status: 'accepted', notices: answer.notices, changes: changesOf(data, answer) };
}

function changesOf(data: WorkspaceData, answer: MockAnswer): SyncChange[] {
  if (answer.type === 'sales_order.create_draft' || answer.type === 'pos_sale.create') return [];
  const found = data.sales.customers.find((item) => item.id === answer.entityId);
  // Not found (undefined), or archived
  if (found?.archivedAt !== null) {
    return [{ op: 'delete', entity: 'customer', key: answer.entityId }];
  }
  return [{ op: 'upsert', entity: 'customer', key: found.id, data: found }];
}

// --- The commands -------------------------------------------------------------------------------

function apply(
  data: WorkspaceData,
  device: NonNullable<AuditEntry['device']>,
  command: SyncCommand,
): SyncNotice[] {
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
