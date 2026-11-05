import { AlertCircleIcon, ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';

import { useSession } from '../lib/session-store';

// Shared by the customer's page and its form pages. Here, not in a route file: a route file is its
// own lazy chunk, and importing from one would pull that whole page into the others.

export function useTenantId(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

export function BackLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/customers"
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {t('customers.back')}
    </Link>
  );
}

export function CustomerNotFound() {
  const { t } = useLocale();
  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <BackLink />
      <EmptyState
        icon={AlertCircleIcon}
        title={t('customers.title')}
        description={t('customers.notFound')}
      />
    </div>
  );
}
