import type { Dashboard } from '@omnivo/contracts';

import type { LocalCopy } from './copy.js';
import type { KeptDashboard } from './database.js';

// Step 21a (decision 7): the Overview's last answer, kept on the device so the page still shows
// numbers offline, with "As of 10:42". One row: the answer the page showed last, whatever branch it
// was for. Sealed like every row (the sealed-copy rule): cash, dues and sales are the business's
// most private numbers. Type imports only, like carts.ts: the Overview's chunk loads no Dexie.

const KEY = 'dashboard';

// branchName: the branch the answer is for, as the select named it ("MIR · Mirpur store"). Offline
// the page cannot ask the server for the branches, and the select must still say whose numbers
// these are. null = every branch.
export async function keepDashboard(
  copy: LocalCopy,
  dashboard: Dashboard,
  branchName: string | null,
): Promise<void> {
  const kept: KeptDashboard = { dashboard, branchName };
  await copy.db.dashboard.put({ key: KEY, box: await copy.seal('dashboard', KEY, kept) });
}

// null = nothing kept yet (a device that was never online on the Overview), or a row that does not
// open. A row that does not open was changed on the disk (crypto.ts): the next answer online
// replaces it, and until then the page says it has nothing, which is true.
export async function keptDashboard(copy: LocalCopy): Promise<KeptDashboard | null> {
  const row = await copy.db.dashboard.get(KEY);
  if (!row) return null;
  try {
    return await copy.open('dashboard', KEY, row.box);
  } catch {
    return null;
  }
}
