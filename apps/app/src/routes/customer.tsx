import {
  Archive02Icon,
  Factory01Icon,
  Invoice03Icon,
  Location01Icon,
  MoneyReceive02Icon,
  PencilEdit02Icon,
  TruckDeliveryIcon,
  UserSwitchIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type Customer, routes } from '@omnivo/contracts';
import { LANGUAGES, useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, FormAlert, KpiStrip, PageHeader, Pill, toast } from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { BackLink, CustomerNotFound, useTenantId } from '../components/customer-parts';
import { failureOf } from '../components/journal-parts';
import { call } from '../lib/api';
import { useCustomerText } from '../lib/customers';
import { useCan } from '../lib/permissions';
import {
  customerCreditQuery,
  customerGroupsQuery,
  customerQuery,
  priceListsQuery,
  supplierQuery,
} from '../lib/queries';

// The statement as a chunk of its own (step 17a): it brings the data table and the two date
// pickers, and sits at the bottom of the page for the people with the balance permission only.
// Inside, this page went over its 100 KB budget.
const PartyStatement = lazy(async () => ({
  default: (await import('../components/party-statement')).PartyStatement,
}));

// One label and its value in the details card; an empty value is a dash, so the rows line up
function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-1 gap-0.5">
      <dt className="text-label text-ink-3">{label}</dt>
      <dd className="text-body-sm break-words text-ink">{value ?? '—'}</dd>
    </div>
  );
}

function CustomerView({ customer }: { customer: Customer }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const can = useCan();
  const canManage = can('sales.customer.manage');
  // Step 15c: bill the customer, take their money. An archived customer is not sold to any more.
  const canBill = can('sales.invoice.manage') && customer.archivedAt === null;
  const canPay = can('sales.receipt.manage');
  // Step 17a: the same business may sell to the company too (decision 10). Not for an archived
  // one: it is hidden from new documents on both sides.
  const canMakeSupplier =
    can('purchase.supplier.manage') && !customer.isSupplier && customer.archivedAt === null;
  // What counts against the credit limit, with the numbers the order and invoice forms check
  const credit = useQuery({
    ...customerCreditQuery(tenantId, customer.id),
    enabled: customer.balance !== null,
  }).data;
  const text = useCustomerText();
  const [confirming, setConfirming] = useState(false);
  const groups = useQuery(customerGroupsQuery(tenantId)).data;
  const priceLists = useQuery(priceListsQuery(tenantId)).data;
  const group = groups?.find((item) => item.id === customer.groupId);
  const priceList = priceLists?.find((item) => item.id === customer.priceListId);

  const toggle = useMutation({
    mutationFn: () =>
      call(customer.archivedAt === null ? routes.customers.archive : routes.customers.restore, {
        params: { id: customer.id },
        body: { version: customer.version },
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(customerQuery(tenantId, saved.id).queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
      toast(
        t(saved.archivedAt === null ? 'customers.restoredToast' : 'customers.archivedToast', {
          name: saved.name,
        }),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.customers.remove, {
        params: { id: customer.id },
        query: { version: customer.version },
      }),
    onSuccess: async () => {
      // To the list first: the deleted customer's own query would otherwise refetch into a 404
      await navigate({ to: '/customers' });
      queryClient.removeQueries({ queryKey: customerQuery(tenantId, customer.id).queryKey });
      await queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });
      // Step 17a: a party that is also a supplier stays one; the delete took only this side
      if (customer.isSupplier) {
        await queryClient.invalidateQueries({ queryKey: ['suppliers', tenantId] });
        toast(t('customers.sideDeleted', { name: customer.name }));
      } else {
        toast(t('customers.deleted', { name: customer.name }));
      }
    },
  });
  // "Make supplier too": the supplier side starts with its defaults (no group, terms on receipt, no
  // bank account), so the person goes to the supplier's page to fill them in
  const makeSupplier = useMutation({
    mutationFn: () =>
      call(routes.suppliers.fromCustomer, {
        params: { id: customer.id },
        body: { version: customer.version },
      }),
    onSuccess: async (supplier) => {
      queryClient.setQueryData(supplierQuery(tenantId, supplier.id).queryKey, supplier);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['customers', tenantId] }),
        queryClient.invalidateQueries({ queryKey: ['suppliers', tenantId] }),
      ]);
      toast(t('customers.madeSupplier', { name: supplier.name }));
      void navigate({ to: '/suppliers/$supplierId', params: { supplierId: supplier.id } });
    },
  });
  // customer_in_use, party_role_exists, version_conflict: they belong to no field
  const failure =
    failureOf(toggle.error) ?? failureOf(remove.error) ?? failureOf(makeSupplier.error);
  const busy = toggle.isPending || remove.isPending || makeSupplier.isPending;

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <BackLink />
      <PageHeader
        title={customer.name}
        description={<span className="font-mono tabular-nums">{customer.code}</span>}
        actions={
          <>
            {canBill && (
              <Button
                variant="secondary"
                onClick={() =>
                  void navigate({ to: '/invoices/new', search: { customerId: customer.id } })
                }
              >
                <HugeiconsIcon icon={Invoice03Icon} size={17} strokeWidth={1.5} />
                {t('customers.newInvoice')}
              </Button>
            )}
            {canPay && (
              <Button
                variant="secondary"
                onClick={() =>
                  void navigate({ to: '/receipts/new', search: { customerId: customer.id } })
                }
              >
                <HugeiconsIcon icon={MoneyReceive02Icon} size={17} strokeWidth={1.5} />
                {t('customers.recordPayment')}
              </Button>
            )}
            {canMakeSupplier && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  makeSupplier.mutate();
                }}
              >
                <HugeiconsIcon icon={Factory01Icon} size={17} strokeWidth={1.5} />
                {t('customers.makeSupplier')}
              </Button>
            )}
            {canManage && (
              <>
                {/* Delete takes two clicks: it cannot be undone */}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (confirming) remove.mutate();
                    else setConfirming(true);
                  }}
                >
                  {confirming
                    ? t('customers.confirmDelete', { code: customer.code })
                    : t('customers.delete')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    toggle.mutate();
                  }}
                >
                  {customer.archivedAt === null ? t('customers.archive') : t('customers.restore')}
                </Button>
                <Button
                  onClick={() =>
                    void navigate({
                      to: '/customers/$customerId/edit',
                      params: { customerId: customer.id },
                    })
                  }
                >
                  <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
                  {t('customers.edit')}
                </Button>
              </>
            )}
          </>
        }
      />
      {confirming && (
        <p className="text-body-sm text-ink-2">
          {/* A party that is both loses only its customer side (step 17a, decision 10) */}
          {customer.isSupplier
            ? t('customers.deleteSideWarning', { name: customer.name })
            : t('customers.deleteWarning')}
        </p>
      )}
      {failure && <FormAlert message={failure} />}
      {(customer.archivedAt !== null || customer.isSupplier) && (
        <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
          {customer.archivedAt !== null && (
            <>
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('customers.statuses.archived')}
              </Pill>
              <span>{t('customers.archivedNotice')}</span>
            </>
          )}
          {customer.isSupplier && (
            <>
              <Pill tone="brand" icon={UserSwitchIcon}>
                {t('customers.alsoSupplier')}
              </Pill>
              {/* Step 17a: the same party's supplier page (everyone may read suppliers) */}
              <Link
                to="/suppliers/$supplierId"
                params={{ supplierId: customer.id }}
                className="font-medium text-brand underline-offset-3 hover:underline"
              >
                {t('customers.supplierPage')}
              </Link>
            </>
          )}
        </div>
      )}
      <KpiStrip
        cells={[
          // Without sales.customer.balance the server sends null: the group takes the place
          customer.balance === null
            ? { label: t('customers.fields.group'), value: group?.name ?? '—' }
            : { label: t('customers.kpis.balance'), value: text.balance(customer.balance) },
          { label: t('customers.kpis.creditLimit'), value: text.creditLimit(customer.creditLimit) },
          // Step 15c, with the balance's permission: what confirmed orders will still bill, and
          // what is left under the limit (negative once over it)
          ...(credit
            ? [
                { label: t('customers.kpis.onOrder'), value: format.money(credit.onOrder) },
                {
                  label: t('customers.kpis.creditLeft'),
                  value:
                    credit.available === null
                      ? t('customers.credit.noLimit')
                      : format.money(credit.available),
                },
              ]
            : []),
          { label: t('customers.kpis.terms'), value: text.terms(customer.paymentTermsDays) },
        ]}
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('customers.details')} />
          <dl className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
            <Detail label={t('customers.fields.contactPerson')} value={customer.contactPerson} />
            <Detail label={t('customers.fields.phone')} value={customer.phone} />
            <Detail label={t('customers.fields.email')} value={customer.email} />
            <Detail
              label={t('customers.fields.documentLanguage')}
              value={
                LANGUAGES.find((language) => language.code === customer.documentLanguage)?.label ??
                null
              }
            />
            <Detail label={t('customers.fields.bin')} value={customer.bin} />
            <Detail label={t('customers.fields.group')} value={group?.name ?? null} />
            <Detail
              label={t('customers.fields.priceList')}
              value={priceList?.name ?? t('customers.fields.noPriceList')}
            />
            {customer.notes && (
              <div className="sm:col-span-2">
                <Detail label={t('customers.fields.notes')} value={customer.notes} />
              </div>
            )}
          </dl>
        </Card>
        <Card>
          <CardHeader title={t('customers.sections.addresses')} />
          {customer.addresses.length === 0 ? (
            <p className="p-5 text-body-sm text-ink-3">{t('customers.noAddresses')}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-4 p-5">
              {customer.addresses.map((address) => {
                // The billing address comes first (the server's order), then the shipping ones;
                // the first shipping address is the default on a delivery
                const isDefault =
                  address.kind === 'shipping' &&
                  customer.addresses.find((item) => item.kind === 'shipping') === address;
                return (
                  <li key={address.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                    <HugeiconsIcon
                      icon={address.kind === 'billing' ? Location01Icon : TruckDeliveryIcon}
                      size={18}
                      strokeWidth={1.5}
                      className="mt-0.5 text-ink-3"
                    />
                    <div className="grid gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 text-body-sm font-medium">
                        {address.kind === 'billing' || address.kind === 'shipping'
                          ? t(`customers.addresses.kinds.${address.kind}`)
                          : address.kind}
                        {address.label && <span className="text-ink-3">· {address.label}</span>}
                        {isDefault && (
                          <Pill tone="brand" icon={TruckDeliveryIcon}>
                            {t('customers.addresses.defaultShipping')}
                          </Pill>
                        )}
                      </span>
                      <span className="text-body-sm whitespace-pre-line text-ink-2">
                        {address.address}
                      </span>
                      {address.phone && (
                        <span className="text-caption text-ink-3 tabular-nums">
                          {address.phone}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
      {/* The same rule as the balance: what a customer owes is not every cashier's business */}
      {can('sales.customer.balance') && (
        <Suspense fallback={null}>
          <PartyStatement role="customer" partyId={customer.id} />
        </Suspense>
      )}
    </div>
  );
}

export function CustomerPage() {
  const { customerId = '' } = useParams({ strict: false });
  const { data: customer, isError } = useQuery({
    ...customerQuery(useTenantId(), customerId),
    enabled: customerId !== '',
  });
  if (isError) return <CustomerNotFound />;
  if (!customer) return null;
  return <CustomerView customer={customer} />;
}
