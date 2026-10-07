import {
  Archive02Icon,
  Location01Icon,
  Notebook02Icon,
  PencilEdit02Icon,
  TruckDeliveryIcon,
  UserSwitchIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type Customer,
  DEFAULT_SETTINGS,
  type LedgerLine,
  routes,
  todayIn,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  Field,
  FormAlert,
  KpiStrip,
  PageHeader,
  Pill,
  SectionHeader,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { BackLink, CustomerNotFound, useTenantId } from '../components/customer-parts';
import { failureOf, useBalanceText, useIsoDate } from '../components/journal-parts';
import { call } from '../lib/api';
import { useCustomerText } from '../lib/customers';
import { fiscalYearStart } from '../lib/journal';
import { useCan } from '../lib/permissions';
import {
  customerGroupsQuery,
  customerQuery,
  customerStatementQuery,
  priceListsQuery,
  settingsQuery,
} from '../lib/queries';

// One label and its value in the details card; an empty value is a dash, so the rows line up
function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-1 gap-0.5">
      <dt className="text-label text-ink-3">{label}</dt>
      <dd className="text-body-sm break-words text-ink">{value ?? '—'}</dd>
    </div>
  );
}

const column = dataTableColumns<LedgerLine>();

// The customer's receivable lines with a running balance: the ledger of one account, cut down
// to one customer. Dates as on the ledger: this fiscal year to today until the person picks.
function Statement({ customerId }: { customerId: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const canReadJournal = useCan()('accounting.journal.read');
  const showDate = useIsoDate();
  const balanceText = useBalanceText();
  const settings = useQuery(settingsQuery(tenantId)).data;
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const today = todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone);
  const { from, to } = range ?? {
    from: fiscalYearStart(
      today,
      settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
    ),
    to: today,
  };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    customerStatementQuery(tenantId, customerId, from, to),
  );
  const lines = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const first = data?.pages[0];

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(() => {
    const amount = (value: string) =>
      value === '0.0000' ? '' : format.money(value, { decimals: 2 });
    return column.columns([
      column.accessor('number', {
        header: t('ledger.columns.entry'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
            <span className="text-caption text-ink-3 tabular-nums">
              {showDate(row.original.date)}
            </span>
          </span>
        ),
      }),
      column.accessor((line) => line.description ?? line.narration ?? '', {
        id: 'narration',
        header: t('journal.columns.narration'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => <span className="block truncate">{getValue() || '—'}</span>,
      }),
      column.accessor('debit', {
        header: t('ledger.columns.debit'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => amount(getValue()),
      }),
      column.accessor('credit', {
        header: t('ledger.columns.credit'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => amount(getValue()),
      }),
      column.accessor('balance', {
        header: t('ledger.columns.balance'),
        enableSorting: false,
        meta: { align: 'end', card: 'trailing' },
        cell: ({ getValue }) => <span className="font-medium">{balanceText(getValue())}</span>,
      }),
    ]);
  }, [t, format, showDate, balanceText]);

  return (
    <section className="grid grid-cols-1 gap-4" aria-label={t('customers.statementTitle')}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeader
          title={t('customers.statementTitle')}
          subtitle={t('customers.statementSubtitle')}
        />
        <div className="grid w-full grid-cols-2 gap-4 sm:w-auto sm:grid-cols-[12rem_12rem]">
          <Field id="statement-from" label={t('ledger.from')}>
            <DatePicker
              id="statement-from"
              value={from}
              onChange={(value) => {
                setRange({ from: value, to });
              }}
            />
          </Field>
          <Field id="statement-to" label={t('ledger.to')}>
            <DatePicker
              id="statement-to"
              value={to}
              onChange={(value) => {
                setRange({ from, to: value });
              }}
            />
          </Field>
        </div>
      </div>
      {/* One card split by a rule, like the ledger's */}
      <Card className="grid grid-cols-2 divide-x divide-line">
        {[
          { label: t('ledger.opening'), value: first?.openingBalance },
          { label: t('ledger.closing'), value: first?.closingBalance },
        ].map((cell) => (
          <div key={cell.label} className="grid gap-1 px-5 py-4">
            <span className="text-caption text-ink-3">{cell.label}</span>
            <span className="text-h3 tabular-nums">
              {cell.value === undefined ? '—' : balanceText(cell.value)}
            </span>
          </div>
        ))}
      </Card>
      {isError && <p className="text-body-sm text-crit">{t('customers.statementLoadFailed')}</p>}
      {lines && (
        <DataTable
          label={t('customers.statementTitle')}
          data={lines}
          columns={columns}
          getRowId={(line) => line.lineId}
          // The entry behind a line, for those who may read the journal
          onRowClick={
            canReadJournal
              ? (line) =>
                  void navigate({ to: '/journal/$entryId', params: { entryId: line.entryId } })
              : undefined
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={Notebook02Icon}
              title={t('customers.statementEmptyTitle')}
              description={t('customers.statementEmptyBody')}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </section>
  );
}

function CustomerView({ customer }: { customer: Customer }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const can = useCan();
  const canManage = can('sales.customer.manage');
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
      toast(t('customers.deleted', { name: customer.name }));
    },
  });
  // customer_in_use, version_conflict: they belong to no field
  const failure = failureOf(toggle.error) ?? failureOf(remove.error);
  const busy = toggle.isPending || remove.isPending;

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <BackLink />
      <PageHeader
        title={customer.name}
        description={<span className="font-mono tabular-nums">{customer.code}</span>}
        actions={
          canManage && (
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
          )
        }
      />
      {confirming && <p className="text-body-sm text-ink-2">{t('customers.deleteWarning')}</p>}
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
            <Pill tone="brand" icon={UserSwitchIcon}>
              {t('customers.alsoSupplier')}
            </Pill>
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
      {can('sales.customer.balance') && <Statement customerId={customer.id} />}
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
