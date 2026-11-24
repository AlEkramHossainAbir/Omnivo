import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateStorefrontPaymentGatewayInput,
  type ErrorCode,
  moneyAccountIds,
  type PaymentGatewayTestProblem,
  type StorefrontAccountChoice,
  type StorefrontPaymentGateway,
  type StorefrontPaymentSetup,
  type UpdateStorefrontPaymentGatewayInput,
} from '@omnivo/contracts';
import { ledgerAccounts, storefrontPaymentGateways } from '@omnivo/db';
import { asc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../../common/audit/audit.js';
import { AppError, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { PaymentsConfig } from '../../config.js';
import { PAYMENT_GATEWAY, PAYMENTS_CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { type CredentialsKey, openSecret, sealSecret } from '../../payments/credentials.js';
import type { PaymentGateway } from '../../payments/gateway.js';
import { onlineReady } from '../online-ready.js';

type GatewayRow = typeof storefrontPaymentGateways.$inferSelect;

function notSetUp(): AppError {
  return new AppError(409, 'storefront_gateway_not_set_up', 'Save the payment gateway first.');
}

function accountError(field: 'moneyAccountId' | 'feeAccountId', code: ErrorCode): AppError {
  return new AppError(422, code, 'Pick another account.', { fieldErrors: { [field]: [code] } });
}

// The chart as the two selects need it: every account, small enough to read whole (a few hundred
// at most, as for the receipt form's moneyAccountIds)
async function chartOf(tx: Transaction) {
  const rows = await tx
    .select({
      id: ledgerAccounts.id,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      type: ledgerAccounts.type,
      parentId: ledgerAccounts.parentId,
      isGroup: ledgerAccounts.isGroup,
      holdsMoney: ledgerAccounts.holdsMoney,
      archivedAt: ledgerAccounts.archivedAt,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.tenantId, getTenantId()))
    .orderBy(asc(ledgerAccounts.code));
  const money = moneyAccountIds(
    rows.map((row) => ({ ...row, archivedAt: row.archivedAt?.toISOString() ?? null })),
  );
  const choice = (row: (typeof rows)[number]): StorefrontAccountChoice => ({
    id: row.id,
    code: row.code,
    name: row.name,
  });
  return {
    // What storefront_online_ready() accepts, read the same way: a money account is a posting
    // account that holds money (itself or a group above it); a fee account an active expense one
    moneyAccounts: rows.filter((row) => money.has(row.id)).map(choice),
    feeAccounts: rows
      .filter((row) => row.type === 'expense' && !row.isGroup && row.archivedAt === null)
      .map(choice),
    codeOf: new Map(rows.map((row) => [row.id, row.code])),
  };
}

// The audit's view: plain values only, and never the password. A changed password is written as
// the word "changed" under its own field, so the log says that it changed and nothing more
function snapshot(row: GatewayRow, codes: ReadonlyMap<string, string>) {
  return {
    storeId: row.storeId,
    mode: row.mode,
    moneyAccount: codes.get(row.moneyAccountId) ?? row.moneyAccountId,
    feeAccount: codes.get(row.feeAccountId) ?? row.feeAccountId,
  };
}

// Step 27d: Shop settings → Payment (decision 4). One row per workspace: the first save makes it
// (POST), later saves change it (PUT, with the version), "Test connection" asks the gateway with
// what is saved. The password is sealed here (CREDENTIALS_KEY) and never answered.
@Injectable()
export class StorefrontPaymentGatewayService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  setup(): Promise<StorefrontPaymentSetup> {
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, false);
      const chart = await chartOf(tx);
      return {
        gateway: row === null ? null : await this.toGateway(tx, row),
        moneyAccounts: chart.moneyAccounts,
        feeAccounts: chart.feeAccounts,
      };
    });
  }

  create(input: CreateStorefrontPaymentGatewayInput): Promise<StorefrontPaymentGateway> {
    const key = this.key();
    return this.withTenant(async (tx) => {
      const chart = await this.checkAccounts(tx, input);
      const { sealed, keyVersion } = sealSecret(key, getTenantId(), input.password);
      const [row] = await tx
        .insert(storefrontPaymentGateways)
        .values({
          tenantId: getTenantId(),
          provider: 'sslcommerz',
          storeId: input.storeId,
          mode: input.mode,
          passwordSealed: sealed,
          keyVersion,
          moneyAccountId: input.moneyAccountId,
          feeAccountId: input.feeAccountId,
          updatedBy: currentPrincipal().userId,
        })
        // Two tabs, or a double click: the second first save finds the row (as the shop's own
        // settings do). Not an upsert, which would overwrite the other save without its version
        .onConflictDoNothing({ target: storefrontPaymentGateways.tenantId })
        .returning();
      if (row === undefined) {
        throw new AppError(
          409,
          'storefront_gateway_set_up_already',
          'The payment gateway is saved already.',
        );
      }
      await audit(tx, {
        action: 'storefront_payment_gateway.created',
        entityType: 'storefront_payment_gateway',
        entityId: row.tenantId,
        changes: created({ ...snapshot(row, chart.codeOf), password: 'changed' }),
      });
      return this.toGateway(tx, row);
    });
  }

  update(input: UpdateStorefrontPaymentGatewayInput): Promise<StorefrontPaymentGateway> {
    // An empty box keeps the saved password, so only a new one needs the key
    const key = input.password === '' ? null : this.key();
    return this.withTenant(async (tx) => {
      const before = await this.find(tx, true);
      if (before === null) throw notSetUp();
      if (before.version !== input.version) throw versionConflict();
      const chart = await this.checkAccounts(tx, input);
      const sealed = key === null ? null : sealSecret(key, getTenantId(), input.password);
      // A new password that is the old one is no change (the audit and the last test agree). Only
      // checkable when the saved one opens; when it does not, the new one is a change anyway
      const passwordChanged =
        sealed !== null &&
        (key === null ||
          openSecret(key, getTenantId(), before.passwordSealed, before.keyVersion) !==
            input.password);
      // The last test said something about the store id, the password and the address (mode);
      // a change to any of them makes it say nothing any more. The accounts are not tested
      const reach =
        passwordChanged || input.storeId !== before.storeId || input.mode !== before.mode;
      const [after] = await tx
        .update(storefrontPaymentGateways)
        .set({
          storeId: input.storeId,
          mode: input.mode,
          moneyAccountId: input.moneyAccountId,
          feeAccountId: input.feeAccountId,
          ...(passwordChanged
            ? { passwordSealed: sealed.sealed, keyVersion: sealed.keyVersion }
            : {}),
          ...(reach ? { lastTestedAt: null, lastTestProblem: null } : {}),
          version: sql`${storefrontPaymentGateways.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(eq(storefrontPaymentGateways.tenantId, getTenantId()))
        .returning();
      if (after === undefined) throw notSetUp();
      await audit(tx, {
        action: 'storefront_payment_gateway.updated',
        entityType: 'storefront_payment_gateway',
        entityId: after.tenantId,
        changes: {
          ...diff(snapshot(before, chart.codeOf), snapshot(after, chart.codeOf)),
          ...(passwordChanged ? { password: { from: null, to: 'changed' } } : {}),
        },
      });
      return this.toGateway(tx, after);
    });
  }

  // "Test connection" (decision 4): the saved store id and password, at the saved mode's address.
  // The answer is kept (lastTest), and a refusal is an answer, not an error of this call
  async test(): Promise<StorefrontPaymentGateway> {
    const key = this.key();
    const saved = await this.withTenant((tx) => this.find(tx, false));
    if (saved === null) throw notSetUp();
    const password = openSecret(key, saved.tenantId, saved.passwordSealed, saved.keyVersion);
    // A password this key cannot open (sealed by another key) cannot reach the gateway either:
    // it is refused, and saving it again seals it with this server's key
    const problem: PaymentGatewayTestProblem | null =
      password === null
        ? 'rejected'
        : await this.gateway.test({
            provider: saved.provider,
            mode: saved.mode,
            storeId: saved.storeId,
            password,
          });
    // The gateway is asked outside the transaction: no row stays locked while SSLCommerz thinks
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, true);
      if (row === null) throw notSetUp();
      const testedAt = new Date();
      const [after] = await tx
        .update(storefrontPaymentGateways)
        // No version bump: a test changes no value the form holds, so a form open in another tab
        // can still be saved
        .set({ lastTestedAt: testedAt, lastTestProblem: problem })
        .where(eq(storefrontPaymentGateways.tenantId, getTenantId()))
        .returning();
      if (after === undefined) throw notSetUp();
      await audit(tx, {
        action: 'storefront_payment_gateway.tested',
        entityType: 'storefront_payment_gateway',
        entityId: after.tenantId,
        changes: created({ testResult: problem ?? 'ok' }),
      });
      return this.toGateway(tx, after);
    });
  }

  // The two selects' answers, checked like the readiness function reads them
  private async checkAccounts(
    tx: Transaction,
    input: { moneyAccountId: string; feeAccountId: string },
  ) {
    const chart = await chartOf(tx);
    if (!chart.moneyAccounts.some((account) => account.id === input.moneyAccountId)) {
      throw accountError('moneyAccountId', 'storefront_gateway_money_account_invalid');
    }
    // Never the money account itself: the fee would be posted against the money it came out of
    // (27d.2's accounts check). A money account is never an expense, so the list check covers it
    if (!chart.feeAccounts.some((account) => account.id === input.feeAccountId)) {
      throw accountError('feeAccountId', 'storefront_gateway_fee_account_invalid');
    }
    return chart;
  }

  private key(): CredentialsKey {
    const key = this.config.credentialsKey;
    if (key === null) {
      throw new AppError(
        422,
        'storefront_gateway_key_missing',
        'This server has no CREDENTIALS_KEY, so it cannot keep a gateway password.',
      );
    }
    return key;
  }

  private async find(tx: Transaction, lock: boolean): Promise<GatewayRow | null> {
    const query = tx
      .select()
      .from(storefrontPaymentGateways)
      .where(eq(storefrontPaymentGateways.tenantId, getTenantId()));
    const [row] = lock ? await query.for('update') : await query;
    return row ?? null;
  }

  private async toGateway(tx: Transaction, row: GatewayRow): Promise<StorefrontPaymentGateway> {
    return {
      provider: row.provider,
      storeId: row.storeId,
      mode: row.mode,
      moneyAccountId: row.moneyAccountId,
      feeAccountId: row.feeAccountId,
      ready: await onlineReady(tx),
      lastTest:
        row.lastTestedAt === null
          ? null
          : { at: row.lastTestedAt.toISOString(), problem: row.lastTestProblem },
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
