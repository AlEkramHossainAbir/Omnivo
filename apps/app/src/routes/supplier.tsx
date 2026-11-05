import {
  Archive02Icon,
  BankIcon,
  PencilEdit02Icon,
  UserMultiple02Icon,
  UserSwitchIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { routes, type Supplier } from '@omnivo/contracts';
import { LANGUAGES, useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, FormAlert, KpiStrip, PageHeader, Pill, toast } from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { failureOf } from '../components/journal-parts';
import {
  SupplierBackLink,
  SupplierNotFound,
  usePartyRefresh,
  useTenantId,
} from '../components/supplier-parts';
import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { customerQuery, supplierGroupsQuery, supplierQuery } from '../lib/queries';
import { useSupplierText } from '../lib/suppliers';

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
      {/* pre-line: an address keeps the lines it was typed in */}
      <dd className="text-body-sm break-words whitespace-pre-line text-ink">{value ?? '—'}</dd>
    </div>
  );
}

// The supplier's page (step 17a), built like the customer's: what the company owes it, its
// details, where it is paid, and its statement.
function SupplierView({ supplier }: { supplier: Supplier }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const refresh = usePartyRefresh();
  const can = useCan();
  const canManage = can('purchase.supplier.manage');
  // The same business may buy from the company too (decision 10); not once it is archived
  const canMakeCustomer =
    can('sales.customer.manage') && !supplier.isCustomer && supplier.archivedAt === null;
  const text = useSupplierText();
  const [confirming, setConfirming] = useState(false);
  const groups = useQuery(supplierGroupsQuery(tenantId)).data;
  const group = groups?.find((item) => item.id === supplier.groupId);

  const toggle = useMutation({
    mutationFn: () =>
      call(supplier.archivedAt === null ? routes.suppliers.archive : routes.suppliers.restore, {
        params: { id: supplier.id },
        body: { version: supplier.version },
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(supplierQuery(tenantId, saved.id).queryKey, saved);
      // Both sides: archiving hides the party from both (decision 10)
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'suppliers.restoredToast' : 'suppliers.archivedToast', {
          name: saved.name,
        }),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.suppliers.remove, {
        params: { id: supplier.id },
        query: { version: supplier.version },
      }),
    onSuccess: async () => {
      // To the list first: the deleted supplier's own query would otherwise refetch into a 404
      await navigate({ to: '/suppliers' });
      queryClient.removeQueries({ queryKey: supplierQuery(tenantId, supplier.id).queryKey });
      await refresh();
      // A party that is also a customer stays one: the delete took only the supplier side
      toast(
        t(supplier.isCustomer ? 'suppliers.sideDeleted' : 'suppliers.deleted', {
          name: supplier.name,
        }),
      );
    },
  });
  // "Make customer too": the customer side starts with its defaults, so the person goes to the
  // customer's page to set its terms, credit limit and price list
  const makeCustomer = useMutation({
    mutationFn: () =>
      call(routes.customers.fromSupplier, {
        params: { id: supplier.id },
        body: { version: supplier.version },
      }),
    onSuccess: async (customer) => {
      queryClient.setQueryData(customerQuery(tenantId, customer.id).queryKey, customer);
      await refresh();
      toast(t('suppliers.madeCustomer', { name: customer.name }));
      void navigate({ to: '/customers/$customerId', params: { customerId: customer.id } });
    },
  });
  // supplier_in_use, party_role_exists, version_conflict: they belong to no field
  const failure =
    failureOf(toggle.error) ?? failureOf(remove.error) ?? failureOf(makeCustomer.error);
  const busy = toggle.isPending || remove.isPending || makeCustomer.isPending;

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <SupplierBackLink />
      <PageHeader
        title={supplier.name}
        description={<span className="font-mono tabular-nums">{supplier.code}</span>}
        actions={
          <>
            {canMakeCustomer && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  makeCustomer.mutate();
                }}
              >
                <HugeiconsIcon icon={UserMultiple02Icon} size={17} strokeWidth={1.5} />
                {t('suppliers.makeCustomer')}
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
                    ? t('suppliers.confirmDelete', { code: supplier.code })
                    : t('suppliers.delete')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    toggle.mutate();
                  }}
                >
                  {supplier.archivedAt === null ? t('suppliers.archive') : t('suppliers.restore')}
                </Button>
                <Button
                  onClick={() =>
                    void navigate({
                      to: '/suppliers/$supplierId/edit',
                      params: { supplierId: supplier.id },
                    })
                  }
                >
                  <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
                  {t('suppliers.edit')}
                </Button>
              </>
            )}
          </>
        }
      />
      {confirming && (
        <p className="text-body-sm text-ink-2">
          {supplier.isCustomer
            ? t('suppliers.deleteSideWarning', { name: supplier.name })
            : t('suppliers.deleteWarning')}
        </p>
      )}
      {failure && <FormAlert message={failure} />}
      {(supplier.archivedAt !== null || supplier.isCustomer) && (
        <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
          {supplier.archivedAt !== null && (
            <>
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('suppliers.statuses.archived')}
              </Pill>
              <span>{t('suppliers.archivedNotice')}</span>
            </>
          )}
          {supplier.isCustomer && (
            <>
              <Pill tone="brand" icon={UserSwitchIcon}>
                {t('suppliers.alsoCustomer')}
              </Pill>
              <Link
                to="/customers/$customerId"
                params={{ customerId: supplier.id }}
                className="font-medium text-brand underline-offset-3 hover:underline"
              >
                {t('suppliers.customerPage')}
              </Link>
            </>
          )}
        </div>
      )}
      <KpiStrip
        cells={[
          // Without purchase.supplier.balance the server sends null: the group takes the place
          supplier.balance === null
            ? { label: t('suppliers.fields.group'), value: group?.name ?? '—' }
            : { label: t('suppliers.kpis.balance'), value: text.balance(supplier.balance) },
          { label: t('suppliers.kpis.terms'), value: text.terms(supplier.paymentTermsDays) },
          {
            label: t('suppliers.kpis.bankAccounts'),
            value: format.number(supplier.bankAccounts.length),
          },
        ]}
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('suppliers.details')} />
          <dl className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
            <Detail label={t('suppliers.fields.contactPerson')} value={supplier.contactPerson} />
            <Detail label={t('suppliers.fields.phone')} value={supplier.phone} />
            <Detail label={t('suppliers.fields.email')} value={supplier.email} />
            <Detail
              label={t('suppliers.fields.documentLanguage')}
              value={
                LANGUAGES.find((language) => language.code === supplier.documentLanguage)?.label ??
                null
              }
            />
            <Detail label={t('suppliers.fields.bin')} value={supplier.bin} />
            <Detail label={t('suppliers.fields.group')} value={group?.name ?? null} />
            <div className="sm:col-span-2">
              <Detail
                label={t('suppliers.fields.address')}
                value={supplier.address ?? t('suppliers.noAddress')}
              />
            </div>
            {supplier.notes && (
              <div className="sm:col-span-2">
                <Detail label={t('suppliers.fields.notes')} value={supplier.notes} />
              </div>
            )}
          </dl>
        </Card>
        <Card>
          <CardHeader title={t('suppliers.sections.bankAccounts')} />
          <ul className="grid grid-cols-1 gap-4 p-5">
            {supplier.bankAccounts.length === 0 ? (
              <li className="text-body-sm text-ink-3">{t('suppliers.noBankAccounts')}</li>
            ) : (
              supplier.bankAccounts.map((account) => (
                <li key={account.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                  <HugeiconsIcon
                    icon={BankIcon}
                    size={18}
                    strokeWidth={1.5}
                    className="mt-0.5 text-ink-3"
                  />
                  <span className="grid gap-0.5">
                    <span className="text-body-sm font-medium">
                      {account.branchName === null
                        ? account.bankName
                        : t('suppliers.bankAccounts.bankAndBranch', {
                            bank: account.bankName,
                            branch: account.branchName,
                          })}
                    </span>
                    <span className="text-body-sm text-ink-2">{account.accountName}</span>
                    {/* The number in Geist Mono: it is read out and typed into a bank's app digit
                        by digit (CLAUDE.md → Typography) */}
                    <span className="font-mono text-body-sm text-ink tabular-nums">
                      {account.accountNumber}
                    </span>
                    {account.routingNumber && (
                      <span className="text-caption text-ink-3 tabular-nums">
                        {t('suppliers.bankAccounts.routing', { number: account.routingNumber })}
                      </span>
                    )}
                  </span>
                </li>
              ))
            )}
          </ul>
        </Card>
      </div>
      {/* The same rule as the balance: what the company owes is not every store keeper's business */}
      {can('purchase.supplier.balance') && (
        <Suspense fallback={null}>
          <PartyStatement role="supplier" partyId={supplier.id} />
        </Suspense>
      )}
    </div>
  );
}

export function SupplierPage() {
  const { supplierId = '' } = useParams({ strict: false });
  const { data: supplier, isError } = useQuery({
    ...supplierQuery(useTenantId(), supplierId),
    enabled: supplierId !== '',
  });
  if (isError) return <SupplierNotFound />;
  if (!supplier) return null;
  return <SupplierView supplier={supplier} />;
}
