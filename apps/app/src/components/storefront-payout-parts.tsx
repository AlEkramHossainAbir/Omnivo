import {
  ArrowLeft01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { PayoutAccount, PayoutStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';

// Step 28c: what the payout pages share. Small on purpose: the list, the new payout and the payout's
// page each load it.

// Like a money receipt's: posted is good, a voided one is neutral (it stays in the list, P2)
export function PayoutStatusPill({ status }: { status: PayoutStatus }) {
  const { t } = useLocale();
  return status === 'voided' ? (
    <Pill tone="neutral" icon={CancelCircleIcon}>
      {t('storefront.payouts.statuses.voided')}
    </Pill>
  ) : (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('storefront.payouts.statuses.posted')}
    </Pill>
  );
}

// An account's name, with "(archived)" on an archived one: it keeps its payouts and can still pay
// out (decision 4), so the selects list it, and the words say why it is not on Shop couriers' tab
export function usePayoutAccountName(): (
  account: Pick<PayoutAccount, 'name' | 'archived'>,
) => string {
  const { t } = useLocale();
  return useCallback(
    (account) =>
      account.archived
        ? t('storefront.payouts.archivedAccount', { name: account.name })
        : account.name,
    [t],
  );
}

// Back to the list, from a new payout and from a payout's page
export function PayoutBackLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/storefront/payouts"
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {t('storefront.payout.back')}
    </Link>
  );
}
