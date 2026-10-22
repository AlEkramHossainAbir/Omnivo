import { Inject, Injectable } from '@nestjs/common';
import {
  contractErrorMap,
  type ErrorCode,
  isErrorCode,
  type PermissionKey,
  routes,
  SYNC_COMMAND_TYPES,
  SYNC_PROTOCOL,
  type SyncChange,
  type SyncCommand,
  type SyncCommandError,
  type SyncCommandType,
  type SyncNotice,
  type SyncPush,
  type syncPushInputSchema,
  type SyncResult,
  syncCommandSchema,
} from '@omnivo/contracts';
import { syncCommands } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError } from '../common/http/app-error.js';
import { getTenantId, runFromDevice } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type Access, PermissionService } from '../rbac/permission.service.js';
import { CustomersService } from '../sales/customers.service.js';
import { SalesOrdersService } from '../sales/sales-orders.service.js';
import { type DeviceRow, DevicesService } from './devices.service.js';
import { LOADERS } from './sync-rows.js';

type PushedCommand = z.output<typeof syncPushInputSchema>['commands'][number];
type StoredAnswer = typeof syncCommands.$inferSelect;

// The permission each command needs: its API route's own (decision 17), read from the contract,
// so a route that changes its permission changes the command's too
const PERMISSION_OF = {
  'customer.create': routes.customers.create.permission,
  'customer.update': routes.customers.update.permission,
  'sales_order.create_draft': routes.salesOrders.create.permission,
} satisfies Record<SyncCommandType, PermissionKey>;

// The ids a device makes (decision 12). One already used — in this workspace or another, the
// primary keys are global — fails the insert on its primary key, and the command is refused.
const DEVICE_ID_KEYS = ['parties_pkey', 'party_addresses_pkey', 'sales_orders_pkey'] as const;

function isSyncCommandType(type: string): type is SyncCommandType {
  return SYNC_COMMAND_TYPES.some((known) => known === type);
}

// The customer or the order a command is about: the answer's entity_id
function entityOf(command: SyncCommand): string {
  return command.type === 'sales_order.create_draft' ? command.orderId : command.customerId;
}

// Step 18b: the push. Every command of a batch in the order sent, each in its own transaction:
//   1. a lock on the command's id, so a second push of the same command waits for this one;
//   2. the answer kept from before, if there is one: the command is answered from it, not run;
//   3. the command's work behind a savepoint, with the person's roles of now;
//   4. the answer inserted, accepted or refused, and the transaction committed.
// A refusal rolls back to the savepoint, so its half-done work goes and its answer stays. Any
// other error (a bug, the database gone) fails the whole push with a 500: the commands before it
// are committed with their answers, and the device sends the batch again (decision 23).
@Injectable()
export class SyncPushService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly devices: DevicesService,
    private readonly permissions: PermissionService,
    private readonly customers: CustomersService,
    private readonly orders: SalesOrdersService,
  ) {}

  async push(input: z.output<typeof syncPushInputSchema>): Promise<SyncPush> {
    // As in the pull: an app built for another protocol reloads first (decision 21)
    if (input.protocol !== SYNC_PROTOCOL) {
      throw new AppError(409, 'sync_protocol_mismatch', 'Reload the app to sync again.');
    }
    const device = await this.withTenant((tx) => this.devices.forSync(tx, input.deviceId));
    // The person's roles of now (decision 17), read once for the batch: one request is one moment
    const access = await this.permissions.ofCurrentUser();
    const results: SyncResult[] = [];
    for (const pushed of input.commands) {
      // One after the other, never in parallel: an order may need the customer before it
      results.push(await runFromDevice(device.id, () => this.run(device, access, pushed)));
    }
    return { results, serverTime: new Date().toISOString() };
  }

  private async run(device: DeviceRow, access: Access, pushed: PushedCommand): Promise<SyncResult> {
    // A command the server cannot read is refused alone, and keeps no answer (decision 24): the
    // same bytes always get the same refusal
    if (!isSyncCommandType(pushed.type)) {
      return refused(pushed.id, { code: 'sync_command_invalid' });
    }
    const parsed = syncCommandSchema.safeParse(pushed, { error: contractErrorMap });
    if (!parsed.success) {
      return refused(pushed.id, {
        code: 'invalid_input',
        fieldErrors: fieldErrorsOf(pushed, parsed.error.issues),
      });
    }
    const command = parsed.data;

    return this.withTenant(async (tx) => {
      // Released by the commit or the rollback; a different command never waits for this one
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.id}::text, 0))`);
      const [stored] = await tx
        .select()
        .from(syncCommands)
        .where(and(eq(syncCommands.tenantId, getTenantId()), eq(syncCommands.id, command.id)));
      // Sent before: answered from what was kept. Even from another device of the workspace (its
      // ids are its own, so only a bug sends one): the answer is still the true one.
      if (stored) return this.answerFrom(tx, device, stored);

      let notices: SyncNotice[];
      try {
        // A nested transaction is a savepoint: a refusal undoes this command's work only
        notices = await tx.transaction((work) => this.apply(work, access, command));
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === null) throw error;
        await tx.insert(syncCommands).values({
          ...this.answerKey(device, command),
          status: 'rejected',
          error: refusal,
        });
        return refused(command.id, refusal);
      }
      await tx.insert(syncCommands).values({
        ...this.answerKey(device, command),
        status: 'accepted',
        notices,
      });
      return {
        id: command.id,
        status: 'accepted',
        notices,
        changes: await this.changesOf(tx, device, command.type, entityOf(command)),
      };
    });
  }

  // The command's work, with the same service methods as the API's routes
  private async apply(
    tx: Transaction,
    access: Access,
    command: SyncCommand,
  ): Promise<SyncNotice[]> {
    const permission = PERMISSION_OF[command.type];
    if (!access.permissions.includes(permission)) {
      throw new AppError(403, 'permission_missing', `Missing permission: ${permission}.`, {
        params: { permissions: permission },
      });
    }
    switch (command.type) {
      case 'customer.create':
        await this.customers.createFromDevice(tx, command.customerId, command.input);
        return [];
      case 'customer.update':
        return this.customers.updateFromDevice(tx, command);
      case 'sales_order.create_draft':
        await this.orders.createDraftFromDevice(tx, command.orderId, command.input);
        return [];
    }
  }

  private answerKey(device: DeviceRow, command: SyncCommand) {
    return {
      id: command.id,
      tenantId: getTenantId(),
      deviceId: device.id,
      type: command.type,
      entityId: entityOf(command),
    };
  }

  private async answerFrom(
    tx: Transaction,
    device: DeviceRow,
    stored: StoredAnswer,
  ): Promise<SyncResult> {
    if (stored.status === 'rejected') {
      // sync_commands_error_check: a refused answer always has its error
      if (stored.error === null) throw new Error(`Refused answer ${stored.id} has no error`);
      return refused(stored.id, stored.error);
    }
    return {
      id: stored.id,
      status: 'accepted',
      notices: stored.notices,
      // The rows as they are now, not as they were then (decision 18)
      changes: await this.changesOf(tx, device, stored.type, stored.entityId),
    };
  }

  // The customer a command made or changed, in the pull's shape: the device writes it at once. A
  // customer the device may not keep (archived since) goes as a delete, like in a delta pull. An
  // order sends nothing: orders are not on the device.
  private async changesOf(
    tx: Transaction,
    device: DeviceRow,
    type: SyncCommandType,
    entityId: string,
  ): Promise<SyncChange[]> {
    if (type === 'sales_order.create_draft') return [];
    // The customer loader reads only the tenant; the branch's warehouses do not matter to it
    const scope = { tenantId: getTenantId(), branchId: device.branchId, warehouseIds: [] };
    const rows = await LOADERS.customer(tx, scope, { by: 'keys', keys: [entityId] });
    if (rows.length === 0) return [{ op: 'delete', entity: 'customer', key: entityId }];
    return rows.map((row) => row.change);
  }
}

function refused(id: string, error: SyncCommandError): SyncResult {
  return { id, status: 'rejected', error };
}

// A refusal the person can act on: a rule of the API (AppError, with its code and field errors),
// or an id the device made that is already used. null: anything else, which fails the push.
function refusalOf(error: unknown): SyncCommandError | null {
  if (error instanceof AppError) return { code: error.code, ...error.options };
  if (DEVICE_ID_KEYS.some((key) => isUniqueViolation(error, key))) {
    return { code: 'sync_id_taken' };
  }
  return null;
}

// A command's field errors, with the paths of the form it came from (decision 22): inside `input`
// for a new customer or an order, the field's name for a change ("creditLimit", not
// "changes.creditLimit.to"), and an address of a change by its id, not its place in the command
function fieldErrorsOf(pushed: PushedCommand, issues: z.core.$ZodIssue[]) {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const issue of issues) {
    const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
    (fieldErrors[formPath(pushed, issue.path)] ??= []).push(code);
  }
  return fieldErrors;
}

function formPath(pushed: PushedCommand, path: PropertyKey[]): string {
  const [head, field, index, ...rest] = path;
  if (head === 'input' && field !== undefined) return path.slice(1).map(String).join('.');
  if (head === 'changes' && field !== undefined) return String(field);
  if (
    head === 'addresses' &&
    (field === 'add' || field === 'change') &&
    typeof index === 'number'
  ) {
    const id = addressIdAt(pushed, field, index);
    if (id !== null) return ['addresses', id, ...rest].map(String).join('.');
  }
  return path.map(String).join('.') || 'command';
}

// The id of the address at this place of the command, when it is a real id: only then may it
// stand in a path
const pushedAddressesSchema = z.object({
  addresses: z.object({ add: z.array(z.unknown()), change: z.array(z.unknown()) }),
});
const addressIdSchema = z.object({ id: z.uuid() });

function addressIdAt(pushed: PushedCommand, list: 'add' | 'change', index: number): string | null {
  const lists = pushedAddressesSchema.safeParse(pushed);
  if (!lists.success) return null;
  const address = addressIdSchema.safeParse(lists.data.addresses[list][index]);
  return address.success ? address.data.id : null;
}
