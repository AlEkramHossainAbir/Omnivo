import { Archive02Icon, PlusSignIcon, Tag01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { PriceList } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  Dialog,
  EmptyState,
  PageHeader,
  SegmentedControl,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { PriceListForm } from '../components/price-list-form';
import { useCan } from '../lib/permissions';
import { priceListsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<PriceList>();

// The API sends every list at once (a workspace has a few): active and archived are split here
const STATUSES = ['active', 'archived'] as const;
type Status = (typeof STATUSES)[number];

export function PriceListsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('sales.price_list.manage');
  const [status, setStatus] = useState<Status>('active');
  const [adding, setAdding] = useState(false);
  const { data, isError } = useQuery(priceListsQuery(tenantId));
  const visible = useMemo(
    () => data?.filter((list) => (list.archivedAt === null) === (status === 'active')),
    [data, status],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('priceLists.columns.name'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[28rem]">
              <span className="truncate font-medium">{row.original.name}</span>
              {row.original.description && (
                <span className="truncate text-caption text-ink-3">{row.original.description}</span>
              )}
            </span>
          ),
        }),
        column.accessor('itemCount', {
          header: t('priceLists.columns.prices'),
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => format.number(getValue()),
        }),
        column.accessor('customerCount', {
          header: t('priceLists.columns.customers'),
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => format.number(getValue()),
        }),
      ]),
    [t, format],
  );

  return (
    <div className="grid max-w-4xl gap-5">
      <PageHeader
        title={t('priceLists.title')}
        description={t('priceLists.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setAdding(true);
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('priceLists.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label={t('priceLists.show')}
          value={status}
          options={STATUSES.map((value) => ({
            value,
            label: t(`priceLists.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
        {!canManage && <p className="text-body-sm text-ink-3">{t('priceLists.readOnly')}</p>}
      </div>
      {isError && <p className="text-body-sm text-crit">{t('priceLists.loadFailed')}</p>}
      {visible && (
        <DataTable
          label={t('priceLists.title')}
          data={visible}
          columns={columns}
          getRowId={(list) => list.id}
          // Everyone opens a list: a salesperson looks up the dealer price there
          onRowClick={(list) =>
            void navigate({ to: '/price-lists/$priceListId', params: { priceListId: list.id } })
          }
          empty={
            status === 'archived' ? (
              <EmptyState
                icon={Archive02Icon}
                title={t('priceLists.archivedEmptyTitle')}
                description={t('priceLists.archivedEmptyBody')}
              />
            ) : (
              <EmptyState
                icon={Tag01Icon}
                title={t('priceLists.emptyTitle')}
                description={t('priceLists.emptyBody')}
              />
            )
          }
        />
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <PriceListForm
            priceList={null}
            // A new list is empty: straight to its page to add the prices
            onDone={(saved) => {
              setAdding(false);
              void navigate({ to: '/price-lists/$priceListId', params: { priceListId: saved.id } });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
