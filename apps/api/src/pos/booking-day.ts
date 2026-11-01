import { todayIn } from '@omnivo/contracts';
import { tenantSettings } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { firstOpenDay } from '../journal/period-lock.service.js';

// Step 20a, decision 26, for every POS command (a sale; since 20b a shift's open, its pay ins and
// outs and its close): the books take it on the device's day, unless the device's clock is ahead
// of the server's today, or the books are closed for that day: then on the first day they take.
export async function bookingDay(tx: Transaction, deviceDate: string): Promise<string> {
  const tenantId = getTenantId();
  const [settings] = await tx
    .select({ timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
  const today = todayIn(settings.timezone);
  return firstOpenDay(tx, deviceDate > today ? today : deviceDate);
}
