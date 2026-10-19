import { ArrowLeft01Icon, UserIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { PartyRef } from '@omnivo/contracts';
import { Input } from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useCallback } from 'react';

import { partyLabel } from '../lib/customers';
import type { PartyPickerProps } from './party-picker';
import { useTenantId } from './stock-parts';

// Shared by the purchase documents' pages (step 17a). Here, not in a route file: a route file is
// its own lazy chunk, and importing from one would pull that whole page into the others.

// After a save or a decision: everything under ['purchase', tenant] — the requisitions, their
// list, the "waiting for me" list and the navigation's count. An approval moves all of them at
// once. One hook for every purchase document, so none forgets one. Step 17b: the stock and the
// books too, like useSalesRefresh: an approved order changes what is coming on the stock page
// (decision 23), and a posted goods receipt brings stock in and writes a journal entry.
export function usePurchaseRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['purchase', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['stock', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
    ]);
  }, [queryClient, tenantId]);
}

export function PurchaseBackLink({
  to,
  label,
}: {
  to:
    | '/requisitions'
    | '/approvals'
    | '/purchase-orders'
    | '/goods-receipts'
    | '/bills'
    | '/supplier-payments';
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

// "S-00012 · Meghna Spinning Mills", linking to the supplier's page (everyone may read suppliers),
// like the sales pages' CustomerLink
export function SupplierLink({ supplier }: { supplier: PartyRef }) {
  return (
    <Link
      to="/suppliers/$supplierId"
      params={{ supplierId: supplier.id }}
      className="font-medium text-brand underline-offset-3 hover:underline"
    >
      {partyLabel(supplier)}
    </Link>
  );
}

// Step 17b: the supplier filter of the purchase order and goods receipt lists, loaded after the
// page like the sales lists' customer filter (customer-filter.tsx says why: the box brings the
// popover). A disabled box of the same size holds its place.
const PartyPicker = lazy(async () => ({
  default: (await import('./party-picker')).PartyPicker,
}));

export function SupplierFilter(props: PartyPickerProps) {
  return (
    <Suspense
      fallback={
        <Input
          id={props.id}
          icon={UserIcon}
          disabled
          aria-label={props['aria-label']}
          placeholder={props.allLabel}
        />
      }
    >
      <PartyPicker {...props} role="supplier" />
    </Suspense>
  );
}
