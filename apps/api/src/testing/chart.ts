import { ACCOUNT_TYPES } from '@omnivo/contracts';

import type { AccountTemplate, ChartTemplate } from '../setup/templates.js';

function count(node: AccountTemplate): number {
  return 1 + (node.children ?? []).reduce((sum, child) => sum + count(child), 0);
}

// How many accounts seedChart() makes from a template — tests compare with this instead of a
// number typed by hand, so adding an account to a template does not break them
export function accountCount(chart: ChartTemplate): number {
  return ACCOUNT_TYPES.reduce((sum, type) => sum + count(chart[type]), 0);
}
