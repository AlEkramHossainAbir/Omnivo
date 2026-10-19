import { CheckmarkBadge01Icon } from '@hugeicons/core-free-icons';
import { DEFAULT_SETTINGS, isApprovalDocument, type WaitingApproval } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DataTable, dataTableColumns, EmptyState, PageHeader } from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import { useIsoDate, useTenantId } from '../components/stock-parts';
import { settingsQuery, waitingApprovalsQuery } from '../lib/queries';

const column = dataTableColumns<WaitingApproval>();

// "Waiting for me" (step 17a, decision 17): the documents whose waiting step the signed-in person
// may decide, oldest first, so nothing is left at the bottom. A row opens the document: a person
// approves what they have read, on its own page (decision 16), never from a list.
export function ApprovalsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const isoDate = useIsoDate();
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    waitingApprovalsQuery(tenantId),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // One navigate() per kind: each path has its own parameter name, and TanStack checks each pair
  // against the router. Step 17b: the purchase order.
  const open = useCallback(
    (row: WaitingApproval) => {
      if (row.document === 'requisition') {
        void navigate({ to: '/requisitions/$requisitionId', params: { requisitionId: row.id } });
      } else if (row.document === 'purchase_order') {
        void navigate({ to: '/purchase-orders/$orderId', params: { orderId: row.id } });
      }
    },
    [navigate],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('approvals.columns.document'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => {
            const { document, number } = row.original;
            return (
              <span className="grid">
                <span className="font-mono font-medium tabular-nums">{number}</span>
                {/* A kind a newer server knows and this app does not keeps its key */}
                <span className="text-caption text-ink-3">
                  {isApprovalDocument(document) ? t(`approvals.kinds.${document}`) : document}
                </span>
              </span>
            );
          },
        }),
        column.accessor('date', {
          header: t('approvals.columns.date'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="tabular-nums">{isoDate(getValue())}</span>,
        }),
        column.accessor('subject', {
          header: t('approvals.columns.subject'),
          enableSorting: false,
          meta: { card: 'subtitle' },
        }),
        column.accessor((row) => row.submittedBy.name, {
          id: 'submittedBy',
          header: t('approvals.columns.submittedBy'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="grid">
              <span>{row.original.submittedBy.name}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {format.dateTime(new Date(row.original.submittedAt), timeZone)}
              </span>
            </span>
          ),
        }),
        column.accessor('amount', {
          header: t('approvals.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => <span className="font-medium">{format.money(getValue())}</span>,
        }),
        column.accessor('position', {
          header: t('approvals.columns.step'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) => (
            <span className="tabular-nums">
              {t('approvals.stepOf', {
                position: row.original.position,
                count: row.original.stepCount,
              })}
            </span>
          ),
        }),
      ]),
    [t, format, isoDate, timeZone],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('approvals.title')} description={t('approvals.description')} />
      {isError && <p className="text-body-sm text-crit">{t('approvals.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('approvals.title')}
          data={rows}
          columns={columns}
          // A round waits once per document: the round is the row
          getRowId={(row) => row.roundId}
          onRowClick={open}
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={CheckmarkBadge01Icon}
              title={t('approvals.emptyTitle')}
              description={t('approvals.emptyBody')}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
