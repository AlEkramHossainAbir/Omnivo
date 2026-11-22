import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Transaction } from '../common/tenant/with-tenant.js';

const readySchema = z.object({ ready: z.boolean() });

// Step 27d: whether the shop of this transaction's workspace can take online payment now (mine
// 22): its gateway is saved and both of its accounts still fit. The database's own function
// (0076), because the shop's pages run as omnivo_public, which may read neither the gateway nor
// the chart of accounts. The checkout (offeredMethods), the Payment card's `ready` and the
// settings' save all ask here, so they never disagree
export async function onlineReady(tx: Transaction): Promise<boolean> {
  const [row] = z
    .array(readySchema)
    .parse(await tx.execute(sql`SELECT storefront_online_ready() AS ready`));
  return row?.ready ?? false;
}
