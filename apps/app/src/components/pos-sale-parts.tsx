import { Alert02Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';

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
