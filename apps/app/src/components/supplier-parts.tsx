import { AlertCircleIcon, ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';

import { useSession } from '../lib/session-store';

// Shared by the supplier's page, its form pages and the groups page (customer-parts.tsx is the
// customer's twin). Here, not in a route file: a route file is its own lazy chunk, and importing
// from one would pull that whole page into the others.

export function useTenantId(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

// After a supplier is saved: everything about suppliers, and the customers too. A party that is
// both is one row (decision 9): its name and phone changed on the supplier page are the customer's
// name and phone, and its archive hides both sides.
export function usePartyRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['suppliers', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['customers', tenantId] }),
    ]);
  }, [queryClient, tenantId]);
}

export function SupplierBackLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/suppliers"
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {t('suppliers.back')}
    </Link>
  );
}

export function SupplierNotFound() {
  const { t } = useLocale();
  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <SupplierBackLink />
      <EmptyState
        icon={AlertCircleIcon}
        title={t('suppliers.title')}
        description={t('suppliers.notFound')}
      />
    </div>
  );
}
