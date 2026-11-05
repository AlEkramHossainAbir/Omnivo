import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SupplierNotFound, useTenantId } from '../components/supplier-parts';
import { useCan } from '../lib/permissions';
import { supplierGroupsQuery, supplierQuery } from '../lib/queries';

// The new and edit pages, apart from the supplier's page (routes/supplier.tsx): that page's
// statement brings the data table and the date pickers, which the form never uses (the customer
// pages are split the same way, for the same reason).

// The page loads the data; the form is a lazy chunk of its own
const SupplierForm = lazy(async () => ({
  default: (await import('../components/supplier-form')).SupplierForm,
}));

export function NewSupplierPage() {
  const canManage = useCan()('purchase.supplier.manage');
  const groups = useQuery(supplierGroupsQuery(useTenantId())).data;
  if (!groups) return null;
  return (
    <Suspense fallback={null}>
      <SupplierForm supplier={null} groups={groups} canManage={canManage} />
    </Suspense>
  );
}

export function EditSupplierPage() {
  const { supplierId = '' } = useParams({ strict: false });
  const tenantId = useTenantId();
  const canManage = useCan()('purchase.supplier.manage');
  const groups = useQuery(supplierGroupsQuery(tenantId)).data;
  const { data: supplier, isError } = useQuery({
    ...supplierQuery(tenantId, supplierId),
    enabled: supplierId !== '',
  });
  if (isError) return <SupplierNotFound />;
  if (!supplier || !groups) return null;
  return (
    <Suspense fallback={null}>
      {/* key: a supplier saved elsewhere comes back with a new version; start from it again */}
      <SupplierForm
        key={`${supplier.id}-${String(supplier.version)}`}
        supplier={supplier}
        groups={groups}
        canManage={canManage}
      />
    </Suspense>
  );
}
