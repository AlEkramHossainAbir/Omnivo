import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  COURIER_OF_PROVIDER,
  type CourierAccount,
  type CourierAccountSaved,
  type CourierSetup,
  type CourierTestProblem,
  type CreateCourierAccountInput,
  routes,
  type UpdateCourierAccountInput,
} from '@omnivo/contracts';
import { courierAccounts } from '@omnivo/db';
import { and, asc, eq, or, sql } from 'drizzle-orm';

import { audit, created, diff } from '../../common/audit/audit.js';
import { isCheckViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config, ShippingConfig } from '../../config.js';
import { CONFIG, COURIERS, SHIPPING_CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import type { CredentialsKey } from '../../payments/credentials.js';
import {
  type ApiCourierProvider,
  type CourierAdapters,
  isApiProvider,
} from '../../shipping/courier.js';
import { newToken, tokenHash } from '../orders/order-secrets.js';
import { openKeys, sealKeys } from './courier-keys.js';

type AccountRow = typeof courierAccounts.$inferSelect;

// Each API provider's webhook path, from the contract, so the address the page shows is the one
// the controller serves. A Record over the providers: 28c's Pathao needs its route here to compile
const WEBHOOK_PATH = {
  steadfast: routes.shipping.steadfastWebhook.path,
} satisfies Record<ApiCourierProvider, string>;

function archived(): AppError {
  return new AppError(
    409,
    'courier_account_archived',
    'This courier account is archived. Restore it first.',
  );
}

function notBookable(field: string): AppError {
  return new AppError(
    422,
    'courier_account_not_bookable',
    'Only an active account that books by API can do this.',
    { fieldErrors: { [field]: ['courier_account_not_bookable'] } },
  );
}

// The audit's view: plain values, never a key or a token. A change of keys or token is written as
// the word "changed" under its own field, like the gateway's password (27d)
function snapshot(row: AccountRow) {
  return {
    name: row.name,
    provider: row.provider,
    courier: row.courier,
    status: row.archivedAt === null ? 'active' : 'archived',
  };
}

// Step 28a: Storefront → Shop couriers (decisions 7, 8, 13 and 14). storefront.manage on every
// route (the contract says so and the guard checks it). An API account's keys are sealed here and
// never answered; its webhook token is made here, answered once, and only its hash is kept. A
// manual account is a name and a courier: nothing is called for it.
@Injectable()
export class CourierAccountsService {
  private readonly logger = new Logger(CourierAccountsService.name);

  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(SHIPPING_CONFIG) private readonly shipping: ShippingConfig,
    @Inject(COURIERS) private readonly couriers: CourierAdapters,
  ) {}

  setup(): Promise<CourierSetup> {
    return this.withTenant((tx) => this.read(tx));
  }

  create(input: CreateCourierAccountInput): Promise<CourierAccountSaved> {
    // Before the transaction: a server that cannot seal keys says so without touching anything
    if (input.provider !== 'manual') this.key();
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const userId = currentPrincipal().userId;
      // The token is made with the account (28a.2's secrets check wants its hash at once)
      const token = input.provider === 'manual' ? null : newToken();
      const values =
        input.provider === 'manual'
          ? { provider: input.provider, name: input.name, courier: input.courier }
          : {
              provider: input.provider,
              name: input.name,
              courier: COURIER_OF_PROVIDER[input.provider],
              ...this.sealed(this.key(), tenantId, input),
              webhookTokenHash: token === null ? null : tokenHash(token),
            };
      const [row] = await tx
        .insert(courierAccounts)
        .values({ tenantId, ...values, createdBy: userId, updatedBy: userId })
        .returning();
      if (row === undefined) throw new Error('Courier account insert returned no row');
      await audit(tx, {
        action: 'courier_account.created',
        entityType: 'courier_account',
        entityId: row.id,
        changes: created({
          ...snapshot(row),
          ...(row.provider === 'manual' ? {} : { keys: 'changed', webhookToken: 'changed' }),
        }),
      });
      return { account: this.toAccount(row), webhookToken: token };
    });
  }

  update(id: string, input: UpdateCourierAccountInput): Promise<CourierAccount> {
    // An empty box keeps the saved key, so only a new key needs CREDENTIALS_KEY
    const typed = input.provider !== 'manual' && (input.apiKey !== '' || input.secretKey !== '');
    const key = typed ? this.key() : null;
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, input.version);
      if (before.archivedAt !== null) throw archived();
      // The provider never changes (28a.1): the form says which one it is, and must say the saved one
      if (input.provider !== before.provider) {
        throw new AppError(
          409,
          'courier_provider_fixed',
          'A courier account keeps its provider. Add a new account for another one.',
        );
      }
      let keys: { keysSealed: Buffer; keyVersion: number } | null = null;
      if (input.provider !== 'manual' && key !== null) {
        // One box for both keys: a box with one new key needs the other one from the saved box
        const saved = openKeys(key, before);
        const apiKey = input.apiKey !== '' ? input.apiKey : saved?.apiKey;
        const secretKey = input.secretKey !== '' ? input.secretKey : saved?.secretKey;
        if (apiKey === undefined || secretKey === undefined) {
          // The saved box does not open with this server's key: both keys must be typed again
          const field = apiKey === undefined ? 'apiKey' : 'secretKey';
          throw new AppError(422, 'courier_key_required', 'Type both keys again.', {
            fieldErrors: { [field]: ['courier_key_required'] },
          });
        }
        // The same keys typed again are no change (the audit and the last test agree)
        if (saved?.apiKey !== apiKey || saved.secretKey !== secretKey) {
          keys = this.sealed(key, getTenantId(), { apiKey, secretKey });
        }
      }
      const [after] = await tx
        .update(courierAccounts)
        .set({
          name: input.name,
          ...(input.provider === 'manual' ? { courier: input.courier } : {}),
          // The last test said something about the old keys only
          ...(keys === null ? {} : { ...keys, lastTestedAt: null, lastTestProblem: null }),
          version: sql`${courierAccounts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)))
        .returning();
      if (after === undefined) throw notFound('Courier account');
      await audit(tx, {
        action: 'courier_account.updated',
        entityType: 'courier_account',
        entityId: id,
        changes: {
          ...diff(snapshot(before), snapshot(after)),
          ...(keys === null ? {} : { keys: { from: null, to: 'changed' } }),
        },
      });
      return this.toAccount(after);
    });
  }

  // "Test connection" (decision 7): the saved keys, asked outside the transaction, as 27d's test,
  // so no row stays locked while the courier thinks. A refusal is an answer, not an error
  async test(id: string): Promise<CourierAccount> {
    const saved = await this.withTenant((tx) => this.find(tx, id, false));
    if (!isApiProvider(saved.provider)) throw notBookable('id');
    const keys = openKeys(this.shipping.credentialsKey, saved);
    if (keys === null) this.cannotOpen(saved);
    // Keys this server cannot open cannot reach the courier either: refused, and typing them again
    // seals them with this server's key
    const problem: CourierTestProblem | null =
      keys === null ? 'rejected' : await this.couriers[saved.provider].test(keys);
    return this.withTenant(async (tx) => {
      await this.find(tx, id, true);
      const [after] = await tx
        .update(courierAccounts)
        // No version bump: a test changes no value the form holds
        .set({ lastTestedAt: new Date(), lastTestProblem: problem })
        .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)))
        .returning();
      if (after === undefined) throw notFound('Courier account');
      await audit(tx, {
        action: 'courier_account.tested',
        entityType: 'courier_account',
        entityId: id,
        changes: created({ testResult: problem ?? 'ok' }),
      });
      return this.toAccount(after);
    });
  }

  // A new token replaces the old one at once (28a.1): the courier's panel needs the new one too
  renewToken(id: string, version: number): Promise<CourierAccountSaved> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, version);
      if (before.provider === 'manual') throw notBookable('id');
      if (before.archivedAt !== null) throw archived();
      const token = newToken();
      const [after] = await tx
        .update(courierAccounts)
        .set({
          webhookTokenHash: tokenHash(token),
          version: sql`${courierAccounts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)))
        .returning();
      if (after === undefined) throw notFound('Courier account');
      await audit(tx, {
        action: 'courier_account.token_renewed',
        entityType: 'courier_account',
        entityId: id,
        changes: { webhookToken: { from: null, to: 'changed' } },
      });
      return { account: this.toAccount(after), webhookToken: token };
    });
  }

  // Not offered for new parcels and no longer the default, in one UPDATE: 28a.2's default check
  // refuses an archived default, so the flag goes with it. Its parcels on their way still get the
  // courier's news
  archive(id: string, version: number): Promise<CourierAccount> {
    return this.setArchived(id, version, true);
  }

  restore(id: string, version: number): Promise<CourierAccount> {
    return this.setArchived(id, version, false);
  }

  // The Packed dialog's first choice (decision 13), or none. One UPDATE sets the new default and
  // clears the old one (28a.2's partial unique index would refuse two at any moment in between).
  // It reads only the rows that change: the old default and the new one
  setDefault(accountId: string | null): Promise<CourierSetup> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const [before] = await tx
        .select({ id: courierAccounts.id, name: courierAccounts.name })
        .from(courierAccounts)
        .where(and(eq(courierAccounts.tenantId, tenantId), eq(courierAccounts.isDefault, true)));
      let name: string | null = null;
      if (accountId !== null) {
        const account = await this.find(tx, accountId, true);
        if (account.provider === 'manual' || account.archivedAt !== null) {
          throw notBookable('accountId');
        }
        name = account.name;
      }
      if ((before?.id ?? null) !== accountId) {
        try {
          await tx
            .update(courierAccounts)
            .set({
              isDefault:
                accountId === null ? false : sql`${courierAccounts.id} = ${accountId}::uuid`,
            })
            .where(
              and(
                eq(courierAccounts.tenantId, tenantId),
                accountId === null
                  ? eq(courierAccounts.isDefault, true)
                  : or(eq(courierAccounts.isDefault, true), eq(courierAccounts.id, accountId)),
              ),
            );
        } catch (error) {
          // Archived or made manual since the read above, by another request: the check's answer
          if (isCheckViolation(error, 'courier_accounts_default_check')) {
            throw notBookable('accountId');
          }
          throw error;
        }
        await audit(tx, {
          action: 'storefront.default_courier_set',
          entityType: 'storefront',
          entityId: tenantId,
          changes: { defaultCourier: { from: before?.name ?? null, to: name } },
        });
      }
      return this.read(tx);
    });
  }

  private setArchived(id: string, version: number, archive: boolean): Promise<CourierAccount> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, version);
      // Already as asked: no change, no audit row (a second tab's click)
      if ((before.archivedAt !== null) === archive) return this.toAccount(before);
      const [after] = await tx
        .update(courierAccounts)
        .set({
          archivedAt: archive ? new Date() : null,
          ...(archive ? { isDefault: false } : {}),
          version: sql`${courierAccounts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)))
        .returning();
      if (after === undefined) throw notFound('Courier account');
      await audit(tx, {
        action: archive ? 'courier_account.archived' : 'courier_account.restored',
        entityType: 'courier_account',
        entityId: id,
        changes: diff(snapshot(before), snapshot(after)),
      });
      return this.toAccount(after);
    });
  }

  // Active ones first, then by name: the page's two tabs read one list
  private async read(tx: Transaction): Promise<CourierSetup> {
    const rows = await tx
      .select()
      .from(courierAccounts)
      .where(eq(courierAccounts.tenantId, getTenantId()))
      .orderBy(
        sql`${courierAccounts.archivedAt} IS NOT NULL`,
        asc(courierAccounts.name),
        asc(courierAccounts.id),
      );
    return {
      accounts: rows.map((row) => this.toAccount(row)),
      defaultAccountId: rows.find((row) => row.isDefault)?.id ?? null,
    };
  }

  private sealed(
    key: CredentialsKey,
    tenantId: string,
    keys: { apiKey: string; secretKey: string },
  ) {
    const { sealed, keyVersion } = sealKeys(key, tenantId, keys);
    return { keysSealed: sealed, keyVersion };
  }

  private key(): CredentialsKey {
    const key = this.shipping.credentialsKey;
    if (key === null) {
      throw new AppError(
        422,
        'courier_key_missing',
        "This server has no CREDENTIALS_KEY, so it cannot keep a courier's keys.",
      );
    }
    return key;
  }

  private cannotOpen(row: AccountRow): void {
    // The workspace, the account and why, never a value
    this.logger.error(
      `The keys of courier account ${row.id} (tenant ${row.tenantId}) cannot be opened (${this.shipping.credentialsKey === null ? 'no CREDENTIALS_KEY' : `key version ${String(row.keyVersion)}`})`,
    );
  }

  private async lock(tx: Transaction, id: string, version: number): Promise<AccountRow> {
    const row = await this.find(tx, id, true);
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async find(tx: Transaction, id: string, lock: boolean): Promise<AccountRow> {
    const query = tx
      .select()
      .from(courierAccounts)
      .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)));
    const [row] = lock ? await query.for('update') : await query;
    if (row === undefined) throw notFound('Courier account');
    return row;
  }

  private toAccount(row: AccountRow): CourierAccount {
    const base = this.config.apiBaseUrl.replace(/\/+$/, '');
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      courier: row.courier,
      status: row.archivedAt === null ? 'active' : 'archived',
      webhookUrl: isApiProvider(row.provider)
        ? `${base}${WEBHOOK_PATH[row.provider].replace(':id', row.id)}`
        : null,
      hasWebhookToken: row.webhookTokenHash !== null,
      lastWebhookAt: row.lastWebhookAt?.toISOString() ?? null,
      lastTest:
        row.lastTestedAt === null
          ? null
          : { at: row.lastTestedAt.toISOString(), problem: row.lastTestProblem },
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
