import { ArrowLeft01Icon, TimeQuarterPassIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type {
  AgingDocument,
  ApAgingAdvance,
  ApAgingDocument,
  ArAgingAdvance,
  ArAgingParty,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  dataTableColumns,
  DatePicker,
  EmptyState,
  Field,
  KpiStrip,
  PageHeader,
  SectionHeader,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { type ReactNode, useCallback, useMemo } from 'react';

import { type AgingNamespace, useAgingFilters, useAgingKpis } from '../components/aging-parts';
import { useIsoDate } from '../components/journal-parts';
import {
  BooksLine,
  Footnotes,
  LoadFailed,
  NeedsConnection,
} from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { useSession } from '../lib/session-store';
import { apAgingPartyQuery, arAgingPartyQuery } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';

// Step 21b: the documents behind one row of an aging, at the same day (decision 6). A number links
// to its document, so the person can go from "this much is 60 days late" to the invoice itself.

// What a party's page gets from the API, for either side. The documents and advances are generic
// so a bill keeps the supplier's own number and each advance its own kinds.
interface PartyData<TDocument, TAdvance> extends Pick<ArAgingParty, 'party' | 'totals' | 'ledger'> {
  documents: TDocument[];
  advances: TAdvance[];
}

// Outside the components: the columns are memoized on these, and a function made in a render would
// rebuild the columns (and remount every cell) on each one
function invoiceLink(row: AgingDocument, children: ReactNode) {
  return (
    <Link to="/invoices/$invoiceId" params={{ invoiceId: row.id }}>
      {children}
    </Link>
  );
}

function billLink(row: ApAgingDocument, children: ReactNode) {
  return (
    <Link to="/bills/$billId" params={{ billId: row.id }}>
      {children}
    </Link>
  );
}

function arAdvanceLink(row: ArAgingAdvance, children: ReactNode) {
  return row.kind === 'receipt' ? (
    <Link to="/receipts/$receiptId" params={{ receiptId: row.id }}>
      {children}
    </Link>
  ) : (
    <Link to="/credit-notes/$creditNoteId" params={{ creditNoteId: row.id }}>
      {children}
    </Link>
  );
}

function apAdvanceLink(row: ApAgingAdvance, children: ReactNode) {
  return row.kind === 'payment' ? (
    <Link to="/supplier-payments/$paymentId" params={{ paymentId: row.id }}>
      {children}
    </Link>
  ) : (
    <Link to="/debit-notes/$debitNoteId" params={{ debitNoteId: row.id }}>
      {children}
    </Link>
  );
}

export function ArAgingPartyPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('sales.report.read');
  const online = useOnline();
  const filters = useAgingFilters();
  const { customerId = '' } = useParams({ strict: false });
  const query = useQuery({
    ...arAgingPartyQuery(tenantId, customerId, { asOf: filters.asOf }),
    enabled: canRead && online && filters.asOf !== '',
  });
  const documents = useDocumentColumns<AgingDocument>(invoiceLink);
  const kindName = useCallback(
    (kind: ArAgingAdvance['kind']) => t(`reports.arAging.advanceKinds.${kind}`),
    [t],
  );
  const advances = useAdvanceColumns<ArAgingAdvance>(kindName, arAdvanceLink);
  return (
    <PartyView<AgingDocument, ArAgingAdvance>
      namespace="arAging"
      permission="sales.report.read"
      canRead={canRead}
      online={online}
      filters={filters}
      data={query.data}
      isError={query.isError}
      onRetry={() => void query.refetch()}
      documentColumns={documents}
      advanceColumns={advances}
      back={
        <Link
          to="/reports/ar-aging"
          search={filters.search}
          className="inline-flex items-center gap-1.5 justify-self-start text-body-sm font-medium text-brand hover:underline hover:underline-offset-[3px]"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('reports.arAging.title')}
        </Link>
      }
    />
  );
}

export function ApAgingPartyPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('purchase.report.read');
  const online = useOnline();
  const filters = useAgingFilters();
  const { supplierId = '' } = useParams({ strict: false });
  const query = useQuery({
    ...apAgingPartyQuery(tenantId, supplierId, { asOf: filters.asOf }),
    enabled: canRead && online && filters.asOf !== '',
  });
  // Under our number: the number on the paper the supplier sent
  const theirNumber = useCallback(
    (row: ApAgingDocument) => t('reports.apAging.supplierBill', { number: row.supplierBillNumber }),
    [t],
  );
  const documents = useDocumentColumns<ApAgingDocument>(billLink, theirNumber);
  const kindName = useCallback(
    (kind: ApAgingAdvance['kind']) => t(`reports.apAging.advanceKinds.${kind}`),
    [t],
  );
  const advances = useAdvanceColumns<ApAgingAdvance>(kindName, apAdvanceLink);
  return (
    <PartyView<ApAgingDocument, ApAgingAdvance>
      namespace="apAging"
      permission="purchase.report.read"
      canRead={canRead}
      online={online}
      filters={filters}
      data={query.data}
      isError={query.isError}
      onRetry={() => void query.refetch()}
      documentColumns={documents}
      advanceColumns={advances}
      back={
        <Link
          to="/reports/ap-aging"
          search={filters.search}
          className="inline-flex items-center gap-1.5 justify-self-start text-body-sm font-medium text-brand hover:underline hover:underline-offset-[3px]"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('reports.apAging.title')}
        </Link>
      }
    />
  );
}

function useDocumentColumns<TDocument extends AgingDocument>(
  documentLink: (row: TDocument, children: ReactNode) => ReactNode,
  subLine?: (row: TDocument) => string,
) {
  const { t, format } = useLocale();
  const showDate = useIsoDate();
  return useMemo(() => {
    const column = dataTableColumns<TDocument>();
    // The server's order is the one that means something here (the oldest due date first), and a
    // click on a header would sort amount strings as text, so no column sorts
    const money = (id: 'total' | 'open', strong = false) =>
      column.accessor((row) => row[id], {
        id,
        header: t(`reports.aging.documentColumns.${id}`),
        enableSorting: false,
        meta: { align: 'end', card: id === 'open' ? 'trailing' : 'detail' },
        cell: ({ getValue }) => (
          <span className={strong ? 'font-medium text-ink' : 'text-ink-2'}>
            {format.money(getValue())}
          </span>
        ),
      });
    const date = (id: 'date' | 'dueDate') =>
      column.accessor((row) => row[id], {
        id,
        header: t(`reports.aging.documentColumns.${id}`),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ getValue }) => <span className="text-ink-2">{showDate(getValue())}</span>,
      });
    return column.columns([
      column.accessor((row) => row.number, {
        id: 'number',
        header: t('reports.aging.documentColumns.number'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-mono font-medium text-brand tabular-nums hover:underline hover:underline-offset-[3px]">
              {documentLink(row.original, row.original.number)}
            </span>
            {subLine && <span className="text-caption text-ink-3">{subLine(row.original)}</span>}
          </span>
        ),
      }),
      date('date'),
      date('dueDate'),
      money('total'),
      money('open', true),
      column.accessor((row) => row.daysOverdue, {
        id: 'daysOverdue',
        header: t('reports.aging.documentColumns.daysOverdue'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => {
          const count = getValue();
          return count === 0 ? (
            <span className="text-ink-3">{t('reports.aging.notDue')}</span>
          ) : (
            <span className="text-ink-2">{t('reports.aging.daysOverdue', { count })}</span>
          );
        },
      }),
      column.accessor((row) => row.bucket, {
        id: 'bucket',
        header: t('reports.aging.documentColumns.bucket'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => (
          <span className="text-ink-2">{t(`reports.aging.buckets.${getValue()}`)}</span>
        ),
      }),
    ]);
  }, [t, format, showDate, documentLink, subLine]);
}

function useAdvanceColumns<TAdvance extends ArAgingAdvance | ApAgingAdvance>(
  kindName: (kind: TAdvance['kind']) => string,
  documentLink: (row: TAdvance, children: ReactNode) => ReactNode,
) {
  const { t, format } = useLocale();
  const showDate = useIsoDate();
  return useMemo(() => {
    const column = dataTableColumns<TAdvance>();
    return column.columns([
      column.accessor((row) => row.number, {
        id: 'number',
        header: t('reports.aging.advanceColumns.number'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-mono font-medium text-brand tabular-nums hover:underline hover:underline-offset-[3px]">
              {documentLink(row.original, row.original.number)}
            </span>
            <span className="text-caption text-ink-3">{kindName(row.original.kind)}</span>
          </span>
        ),
      }),
      column.accessor((row) => row.date, {
        id: 'date',
        header: t('reports.aging.advanceColumns.date'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ getValue }) => <span className="text-ink-2">{showDate(getValue())}</span>,
      }),
      column.accessor((row) => row.amount, {
        id: 'amount',
        header: t('reports.aging.advanceColumns.amount'),
        enableSorting: false,
        meta: { align: 'end', card: 'trailing' },
        cell: ({ getValue }) => (
          <span className="font-medium text-ink">{format.money(getValue())}</span>
        ),
      }),
    ]);
  }, [t, format, showDate, kindName, documentLink]);
}

function PartyView<
  TDocument extends AgingDocument,
  TAdvance extends ArAgingAdvance | ApAgingAdvance,
>({
  namespace,
  permission,
  canRead,
  online,
  filters,
  data,
  isError,
  onRetry,
  documentColumns,
  advanceColumns,
  back,
}: {
  namespace: AgingNamespace;
  permission: 'sales.report.read' | 'purchase.report.read';
  canRead: boolean;
  online: boolean;
  filters: ReturnType<typeof useAgingFilters>;
  data: PartyData<TDocument, TAdvance> | undefined;
  isError: boolean;
  onRetry: () => void;
  documentColumns: ReturnType<typeof useDocumentColumns<TDocument>>;
  advanceColumns: ReturnType<typeof useAdvanceColumns<TAdvance>>;
  back: ReactNode;
}) {
  const { t } = useLocale();
  const showDate = useIsoDate();
  const kpis = useAgingKpis(namespace);
  const { asOf } = filters;
  const asAtField = (
    <div className="w-full sm:w-56">
      <Field id="aging-as-of" label={t('reports.asOf')}>
        <DatePicker id="aging-as-of" value={asOf} onChange={filters.chooseDay} />
      </Field>
    </div>
  );

  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        {back}
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: permission })}
        </p>
      </div>
    );
  }

  const documents = data?.documents ?? [];
  const advances = data?.advances ?? [];
  const nothing = documents.length === 0 && advances.length === 0;
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      {back}
      {!online ? (
        <NeedsConnection />
      ) : isError ? (
        <LoadFailed icon={TimeQuarterPassIcon} onRetry={onRetry} />
      ) : (
        data && (
          <>
            <PageHeader
              title={data.party.name}
              description={t('reports.aging.partyDescription', { date: showDate(asOf) })}
              actions={asAtField}
            />
            {nothing ? (
              <EmptyState
                icon={TimeQuarterPassIcon}
                title={t('reports.aging.partyEmptyTitle')}
                description={t('reports.aging.partyEmptyBody', {
                  name: data.party.name,
                  date: showDate(asOf),
                })}
              />
            ) : (
              <>
                <KpiStrip
                  cells={kpis(
                    data.totals,
                    t(`reports.${namespace}.openCount`, { count: documents.length }),
                  )}
                />
                <BooksLine
                  report={data.totals.balance}
                  books={data.ledger}
                  noBooks={t('reports.aging.noLedger')}
                />
                {documents.length > 0 && (
                  <>
                    <SectionHeader
                      title={t(`reports.${namespace}.documentsTitle`)}
                      subtitle={t('reports.aging.documentsSubtitle')}
                    />
                    <DataTable
                      label={t(`reports.${namespace}.documentsTitle`)}
                      data={documents}
                      columns={documentColumns}
                      getRowId={(row) => row.id}
                    />
                  </>
                )}
                {advances.length > 0 && (
                  <>
                    <SectionHeader
                      title={t('reports.aging.advancesTitle')}
                      subtitle={t(`reports.${namespace}.advancesSubtitle`)}
                    />
                    <DataTable
                      label={t('reports.aging.advancesTitle')}
                      data={advances}
                      columns={advanceColumns}
                      getRowId={(row) => row.id}
                    />
                  </>
                )}
                <Footnotes
                  notes={[t('reports.aging.bucketsHint'), t(`reports.${namespace}.ledgerHint`)]}
                />
              </>
            )}
          </>
        )
      )}
    </div>
  );
}
