import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { CustomerNotFound, useTenantId } from '../components/customer-parts';
import { useCan } from '../lib/permissions';
import { customerGroupsQuery, customerQuery, priceListsQuery } from '../lib/queries';

// The new and edit pages, apart from the customer's page (routes/customer.tsx): that page's
// statement brings the data table and the date pickers, which the form never uses. In one file,
// the form's route went over its 100 KB budget (121.5 KB).

// The page loads the data; the form is a lazy chunk of its own (the form library and the money
// input are only needed to write), like the product form
const CustomerForm = lazy(async () => ({
  default: (await import('../components/customer-form')).CustomerForm,
}));

// What the form needs besides the customer: the groups and the price lists to pick from
function useFormData() {
  const tenantId = useTenantId();
  const groups = useQuery(customerGroupsQuery(tenantId)).data;
  const priceLists = useQuery(priceListsQuery(tenantId)).data;
  return { groups, priceLists };
}

export function NewCustomerPage() {
  const canManage = useCan()('sales.customer.manage');
  const { groups, priceLists } = useFormData();
  if (!groups || !priceLists) return null;
  return (
    <Suspense fallback={null}>
      <CustomerForm customer={null} groups={groups} priceLists={priceLists} canManage={canManage} />
    </Suspense>
  );
}

export function EditCustomerPage() {
  const { customerId = '' } = useParams({ strict: false });
  const canManage = useCan()('sales.customer.manage');
  const { groups, priceLists } = useFormData();
  const { data: customer, isError } = useQuery({
    ...customerQuery(useTenantId(), customerId),
    enabled: customerId !== '',
  });
  if (isError) return <CustomerNotFound />;
  if (!customer || !groups || !priceLists) return null;
  return (
    <Suspense fallback={null}>
      {/* key: a customer saved elsewhere comes back with a new version; start from it again */}
      <CustomerForm
        key={`${customer.id}-${String(customer.version)}`}
        customer={customer}
        groups={groups}
        priceLists={priceLists}
        canManage={canManage}
      />
    </Suspense>
  );
}
