import { formatMoney } from '@omnivo/i18n/format';

import type { Language } from '@omnivo/i18n';

// A shop price is a unit price: whole taka when it is whole ("৳1,199"), paisa only when it has
// them ("৳49.50"). CLAUDE.md → Money keeps decimals for unit prices only; this keeps a shelf of
// whole prices from showing ".00" on every card.
// Step 26b: out of locale.ts, so the cart drawer's script can use it in the browser. It imports
// '@omnivo/i18n/format', never '@omnivo/i18n': the package's main entry starts i18next with its
// English words (about 150 KB gz), and the drawer only formats numbers.
export function shopMoney(value: string, language: Language): string {
  const hasPaisa = /\.\d*[1-9]/.test(value);
  return formatMoney(value, language, { decimals: hasPaisa ? 2 : 0 });
}
