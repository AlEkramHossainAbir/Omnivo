import {
  CheckmarkCircle02Icon,
  Clock01Icon,
  MinusSignCircleIcon,
} from '@hugeicons/core-free-icons';
import type { PosShiftStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';

import { differenceKind } from '../lib/pos-shift';
import { hasPaisa } from './pos-parts';

// Step 20b: a shift's words and pill, for the POS screen, the managers' pages and the bell. Small
// on purpose: the bell is in the first load.

type Locale = ReturnType<typeof useLocale>;

// Whole taka unless the amount has paisa, like the counter (CLAUDE.md → Money at the counter): a
// count of ৳2,502.50 is shown as it was counted, and ৳5,000 without ".00"
export function counterMoney(format: Locale['format'], value: string): string {
  return format.money(value, { decimals: hasPaisa(value) ? 2 : 0 });
}

// "৳50 short", "৳120 over", "No difference" (decision 66). The sign becomes the word, so one
// sentence reads right both ways.
export function differenceWords(t: Locale['t'], format: Locale['format'], difference: string) {
  const kind = differenceKind(difference);
  if (kind === 'even') return t('posShifts.even');
  const amount = counterMoney(format, difference.replace(/^-/, ''));
  return kind === 'over' ? t('posShifts.over', { amount }) : t('posShifts.short', { amount });
}

// Open is work in progress (brand). Closed is done (good). Not counted is neutral: nothing is
// wrong yet, and the next shift's opening count finds any money that is missing (decision 11).
const PILLS = {
  open: { tone: 'brand', icon: Clock01Icon },
  closed: { tone: 'good', icon: CheckmarkCircle02Icon },
  closed_without_count: { tone: 'neutral', icon: MinusSignCircleIcon },
} as const satisfies Record<PosShiftStatus, { tone: string; icon: unknown }>;

export function PosShiftPill({ status }: { status: PosShiftStatus }) {
  const { t } = useLocale();
  const pill = PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`posShifts.statuses.${status}`)}
    </Pill>
  );
}
