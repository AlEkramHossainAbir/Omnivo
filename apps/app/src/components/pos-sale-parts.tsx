import {
  Alert02Icon,
  ArrowLeftRightIcon,
  CheckmarkCircle02Icon,
  HourglassIcon,
} from '@hugeicons/core-free-icons';
import type { PosReturnSummary, PosSale } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';

import { useCan } from '../lib/permissions';

// Step 20a: a POS sale's pills, for its list and its page. A sale reaches the server already paid
// and is posted when it arrives, so it is always Posted (good). A second, warn pill when a line went
// below zero: someone must count the shelf and put the stock right (decision 30), and warn is for
// what a person must act on.
export function PosSalePills({ soldShort }: { soldShort: boolean }) {
  const { t } = useLocale();
  return (
    <span className="flex flex-wrap gap-1.5">
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('posSales.posted')}
      </Pill>
      {soldShort && (
        <Pill tone="warn" icon={Alert02Icon}>
          {t('posSales.soldShort')}
        </Pill>
      )}
    </span>
  );
}

// Step 20c: a POS return's pills (decision 32). Posted, like a sale: it is posted when it arrives.
// After the window is warn with the Hourglass, like a credit note long after its invoice (15d): the
// counter took back more than the register allows, and a manager may want to ask why. An exchange
// is a fact, not a problem: neutral, with the exchange's icon from the counter.
export function PosReturnPills({
  item,
}: {
  item: Pick<PosReturnSummary, 'outsideWindow' | 'exchangeSale'>;
}) {
  const { t } = useLocale();
  return (
    <span className="flex flex-wrap gap-1.5">
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('posReturns.posted')}
      </Pill>
      {item.outsideWindow && (
        <Pill tone="warn" icon={HourglassIcon}>
          {t('posReturns.outsideWindow')}
        </Pill>
      )}
      {item.exchangeSale && (
        <Pill tone="neutral" icon={ArrowLeftRightIcon}>
          {t('posReturns.exchangeFor', { number: item.exchangeSale.number })}
        </Pill>
      )}
    </span>
  );
}

// Step 20b: the shift a sale was made in (step 20c: or a return), a link for the people who read
// the shifts (pos.shift.manage, decision 26). A sale made before step 20b has none. Moved here from
// the sale's page in 20c, for the return's page.
export function ShiftFact({ label, shift }: { label: string; shift: PosSale['shift'] }) {
  const canRead = useCan()('pos.shift.manage');
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-caption font-medium text-ink-3">{label}</span>
      {shift === null ? (
        <span className="text-body-sm text-ink-3">—</span>
      ) : canRead ? (
        <Link
          to="/pos/shifts/$shiftId"
          params={{ shiftId: shift.id }}
          className="w-fit font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
        >
          {shift.number}
        </Link>
      ) : (
        <span className="font-mono text-body-sm tabular-nums">{shift.number}</span>
      )}
    </div>
  );
}
