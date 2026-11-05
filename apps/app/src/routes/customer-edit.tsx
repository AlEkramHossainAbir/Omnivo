import { allRows, customerCommands, type LocalCopy } from '@omnivo/sync';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense, useCallback } from 'react';

import { CustomerNotFound, useTenantId } from '../components/customer-parts';
import { LocalState, type WaitingView } from '../components/local-state';
import { useLocalCopy, useLocalData, useLocalQuery, useSaveMode } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import { customerGroupsQuery, customerQuery, priceListsQuery } from '../lib/queries';
import { useOnline } from '../lib/use-online';

// The new and edit pages, apart from the customer's page (routes/customer.tsx): that page's
// statement brings the data table and the date pickers, which the form never uses. In one file,
// the form's route went over its 100 KB budget (121.5 KB).

// The page loads the data; the form is a lazy chunk of its own (the form library and the money
// input are only needed to write), like the product form
const CustomerForm = lazy(async () => ({
  default: (await import('../components/customer-form')).CustomerForm,
}));

// Reads of the device's copy: stable functions, so useLocalQuery subscribes once
const readGroups = (copy: LocalCopy) => allRows(copy, copy.db.customerGroups);
const readPriceLists = (copy: LocalCopy) => allRows(copy, copy.db.priceLists);

// What the form needs besides the customer: the groups and the price lists to pick from. Step
// 18b: offline, the device's copy has them.
function useFormData() {
  const tenantId = useTenantId();
  const online = useOnline();
  const groups = useQuery({ ...customerGroupsQuery(tenantId), enabled: online }).data;
  const priceLists = useQuery({ ...priceListsQuery(tenantId), enabled: online }).data;
  const localGroups = useLocalQuery(online ? null : readGroups);
  const localPriceLists = useLocalQuery(online ? null : readPriceLists);
  return online ? { groups, priceLists } : { groups: localGroups, priceLists: localPriceLists };
}

// Offline without a complete copy of the data, there is nothing to pick from: the device's state
// says what to do instead
function NoCopy({ view }: { view: WaitingView }) {
  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <LocalState view={view} />
    </div>
  );
}

export function NewCustomerPage() {
  const canManage = useCan()('sales.customer.manage');
  const { groups, priceLists } = useFormData();
  // A new customer has no commands: online it is the API, offline the device
  const mode = useSaveMode('');
  const { view } = useLocalData();
  if (mode === 'device' && view.kind !== 'ready') return <NoCopy view={view} />;
  if (!groups || !priceLists || mode === undefined) return null;
  return (
    <Suspense fallback={null}>
      <CustomerForm
        customer={null}
        groups={groups}
        priceLists={priceLists}
        canManage={canManage}
        mode={mode}
        failed={null}
      />
    </Suspense>
  );
}

export function EditCustomerPage() {
  const { customerId = '' } = useParams({ strict: false });
  const canManage = useCan()('sales.customer.manage');
  const { groups, priceLists } = useFormData();
  const mode = useSaveMode(customerId);
  const copy = useLocalCopy();
  // The customer's refused command, if any: the form shows its errors under the boxes
  const readCommands = useCallback(
    (open: LocalCopy) => customerCommands(open, customerId),
    [customerId],
  );
  const commands = useLocalQuery(copy ? readCommands : null);
  const failed = commands?.find((command) => command.status === 'failed')?.error ?? null;
  // In device mode the query reads the device (queries.ts): the customer with its changes on it
  const { data: customer, isError } = useQuery({
    ...customerQuery(useTenantId(), customerId),
    enabled: customerId !== '',
  });
  const { view } = useLocalData();
  if (mode === 'device' && view.kind !== 'ready') return <NoCopy view={view} />;
  if (isError) return <CustomerNotFound />;
  if (!customer || !groups || !priceLists || mode === undefined) return null;
  return (
    <Suspense fallback={null}>
      {/* key: a customer saved elsewhere comes back with a new version, and a customer whose
          commands synced goes back to the API: start from it again */}
      <CustomerForm
        key={`${customer.id}-${String(customer.version)}-${mode}`}
        customer={customer}
        groups={groups}
        priceLists={priceLists}
        canManage={canManage}
        mode={mode}
        failed={failed}
      />
    </Suspense>
  );
}
