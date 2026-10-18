import { ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';

import { useTenantId } from './stock-parts';

// Shared by the purchase documents' pages (step 17a). Here, not in a route file: a route file is
// its own lazy chunk, and importing from one would pull that whole page into the others.

// After a save or a decision: everything under ['purchase', tenant] — the requisitions, their
// list, the "waiting for me" list and the navigation's count. An approval moves all of them at
// once. One hook for every purchase document, so none forgets one.
export function usePurchaseRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['purchase', tenantId] });
  }, [queryClient, tenantId]);
}

export function PurchaseBackLink({
  to,
  label,
}: {
  to: '/requisitions' | '/approvals';
  label: string;
}) {
  return (
    <Link
      to={to}
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {label}
    </Link>
  );
}
