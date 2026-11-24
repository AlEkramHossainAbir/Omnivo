import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PaymentGatewayMode } from '@omnivo/contracts';
import { storefrontPaymentGateways } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { PaymentsConfig } from '../config.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { PAYMENTS_CONFIG, WITH_TENANT } from '../infra/tokens.js';
import { openSecret } from '../payments/credentials.js';
import type { GatewayAccount } from '../payments/gateway.js';

// A workspace's gateway account, opened for one call, with the two accounts its money goes to
export interface OpenGatewayAccount extends GatewayAccount {
  moneyAccountId: string;
  feeAccountId: string;
}

// Step 27d (decision 4): the one place that reads a shop's gateway account and opens its password.
// As omnivo_app, inside the shop's workspace: the shop's own roles (omnivo_public, omnivo_shop)
// have no grant on the table (27d.2), so the order routes, which run as omnivo_shop, come here for
// it in a transaction of their own. The API's routes and the worker's sweep both use it.
@Injectable()
export class GatewayAccounts {
  private readonly logger = new Logger(GatewayAccounts.name);

  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
  ) {}

  // The account, or null: none saved, or its password cannot be opened (no CREDENTIALS_KEY on this
  // server, or one other than the key that sealed it). A payment then waits, it is never refused
  // with a 500. `mode` is a try's own: its answer is asked where it was started (27d.2's mine 20)
  async open(tenantId: string, mode?: PaymentGatewayMode): Promise<OpenGatewayAccount | null> {
    const row = await runWithTenant(tenantId, () =>
      this.withTenant(async (tx) => {
        const [found] = await tx
          .select()
          .from(storefrontPaymentGateways)
          .where(eq(storefrontPaymentGateways.tenantId, tenantId));
        return found;
      }),
    );
    if (row === undefined) return null;
    const key = this.config.credentialsKey;
    const password =
      key === null ? null : openSecret(key, tenantId, row.passwordSealed, row.keyVersion);
    if (password === null) {
      // The workspace and why, never the value
      this.logger.error(
        `The gateway password of tenant ${tenantId} cannot be opened (${key === null ? 'no CREDENTIALS_KEY' : `key version ${String(row.keyVersion)}`})`,
      );
      return null;
    }
    return {
      provider: row.provider,
      mode: mode ?? row.mode,
      storeId: row.storeId,
      password,
      moneyAccountId: row.moneyAccountId,
      feeAccountId: row.feeAccountId,
    };
  }
}
