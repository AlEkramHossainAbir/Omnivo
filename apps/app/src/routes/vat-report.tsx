import { Alert02Icon, TaxesIcon } from '@hugeicons/core-free-icons';
import {
  absMoney,
  isNegativeMoney,
  isVatDocumentKind,
  isZeroMoney,
  type VatDocument,
  type VatReportFilter,
  type VatReportRow,
  type VatReportTotals,
  type VatReportSide,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  cn,
  DataTable,
  dataTableColumns,
  EmptyState,
  KpiStrip,
  PageHeader,
  parseIsoDate,
  Pill,
  SectionHeader,
  SegmentedControl,
  SelectField,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { branchName, ExportMenu, PeriodFields, usePeriod } from '../components/report-parts';
import {
  BooksLine,
  Footnotes,
  LoadFailed,
  NeedsConnection,
} from '../components/trade-report-parts';
import { useCan } from '../lib/permissions';
import { branchesQuery } from '../lib/queries';
import { plainRate } from '../lib/tax-rates';
import { vatDocumentsQuery, vatReportQuery } from '../lib/trade-report-queries';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 21c: the VAT report. The VAT charged and paid in a period by rate, what the books say beside
// it, and the documents behind it. It helps fill in Mushak 9.1; it is not the return.
//
// Every amount has paisa (decision 54): the accountant copies these numbers into the return, and
// whole taka would make the rows stop adding up to the total.

const column = dataTableColumns<VatDocument>();

// The VAT report's money: always 2 decimals
function useVatMoney() {
  const { format } = useLocale();
  return useCallback((value: string) => format.money(value, { decimals: 2 }), [format]);
}

// The number of a document, as a link to its page. One Link per kind: each path has its own
// parameter name, and TanStack checks each pair against the router. A kind this app does not
// know (a newer server) is the number alone.
function DocumentLink({ document }: { document: VatDocument }) {
  const className = 'font-mono font-medium text-brand underline-offset-3 hover:underline';
  const { kind, id, number } = document;
  if (!isVatDocumentKind(kind)) return <span className="font-mono">{number}</span>;
  switch (kind) {
    case 'invoice':
      return (
        <Link to="/invoices/$invoiceId" params={{ invoiceId: id }} className={className}>
          {number}
        </Link>
      );
    case 'pos_sale':
      return (
        <Link to="/pos/sales/$saleId" params={{ saleId: id }} className={className}>
          {number}
        </Link>
      );
    case 'credit_note':
      return (
        <Link to="/credit-notes/$creditNoteId" params={{ creditNoteId: id }} className={className}>
          {number}
        </Link>
      );
    case 'pos_return':
      return (
        <Link to="/pos/returns/$returnId" params={{ returnId: id }} className={className}>
          {number}
        </Link>
      );
    case 'bill':
      return (
        <Link to="/bills/$billId" params={{ billId: id }} className={className}>
          {number}
        </Link>
      );
    case 'debit_note':
      return (
        <Link to="/debit-notes/$debitNoteId" params={{ debitNoteId: id }} className={className}>
          {number}
        </Link>
      );
  }
}

// Net VAT in the table: below zero it is VAT to carry forward, said in words, never a bare minus
// (decision 53)
function useNetVat() {
  const { t } = useLocale();
  const money = useVatMoney();
  return useCallback(
    (value: string) =>
      isNegativeMoney(value)
        ? t('reports.vat.carry', { amount: money(absMoney(value)) })
        : money(value),
    [t, money],
  );
}

// The rates: a real table in a card, like the statements (decision 56). One to eight rows, so no
// sorting and no paging; the total is the table's own <tfoot>. On a phone it scrolls sideways
// inside its card, with the rate column sticky.
// The five amounts a rate's row and the total row share
type VatAmounts = Pick<
  VatReportTotals,
  'outputNet' | 'outputVat' | 'inputNet' | 'inputVat' | 'netVat'
>;

function RatesTable({ rows, totals }: { rows: VatReportRow[]; totals: VatAmounts }) {
  const { t, format } = useLocale();
  const money = useVatMoney();
  const netVat = useNetVat();
  const sticky = 'sticky left-0 z-[1]';
  // "15.00" → "15", "7.50" → "7.5", with Bangla digits in Bangla (the tax rates' own rule)
  const percentOf = (rate: string) => {
    const plain = plainRate(rate);
    return format.number(plain, plain.split('.')[1]?.length ?? 0);
  };
  const headers = [
    t('reports.vat.columns.outputNet'),
    t('reports.vat.columns.outputVat'),
    t('reports.vat.columns.inputNet'),
    t('reports.vat.columns.inputVat'),
    t('reports.vat.columns.netVat'),
  ];
  const cells = (row: VatAmounts, strong: boolean) =>
    [row.outputNet, row.outputVat, row.inputNet, row.inputVat].map((value, index) => (
      <td
        key={index}
        className={cn(
          'min-w-[8.5rem] px-4 py-2.5 text-right text-body-sm whitespace-nowrap tabular-nums sm:px-5',
          strong ? 'font-medium text-ink' : 'text-ink-2',
        )}
      >
        {money(value)}
      </td>
    ));
  const net = (value: string) => (
    <td className="min-w-[8.5rem] px-4 py-2.5 text-right text-body-sm font-medium whitespace-nowrap text-ink tabular-nums sm:px-5">
      {netVat(value)}
    </td>
  );
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-sm">
      <table className="w-full border-collapse">
        <caption className="sr-only">{t('reports.vat.title')}</caption>
        <thead>
          <tr className="bg-subtle">
            <th
              scope="col"
              className={cn(
                sticky,
                'bg-subtle py-2.5 pr-4 pl-5 text-left text-caption font-medium text-ink-3',
              )}
            >
              {t('reports.vat.columns.rate')}
            </th>
            {headers.map((header) => (
              <th
                key={header}
                scope="col"
                className="px-5 py-2.5 text-right text-caption font-medium whitespace-nowrap text-ink-3"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-line bg-surface">
              <th
                scope="row"
                className={cn(
                  sticky,
                  'min-w-[10rem] bg-surface py-2.5 pr-4 pl-5 text-left text-body-sm font-medium whitespace-nowrap text-ink sm:min-w-[12rem]',
                )}
              >
                {/* "VAT 15% · 15%", and the kind under it: zero-rated and exempt are both 0% */}
                {t('reports.vat.rate', { name: row.name, percent: percentOf(row.rate) })}
                <span className="block text-caption font-normal text-ink-3">
                  {t(`taxRates.kinds.${row.kind}`)}
                </span>
              </th>
              {cells(row, false)}
              {net(row.netVat)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-subtle">
            <th
              scope="row"
              className={cn(
                sticky,
                'bg-subtle py-2.5 pr-4 pl-5 text-left text-body-sm font-medium text-ink',
              )}
            >
              {t('reports.total')}
            </th>
            {cells(totals, true)}
            {net(totals.netVat)}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function VatReportPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const can = useCan();
  const canRead = can('accounting.report.read');
  const online = useOnline();
  const money = useVatMoney();
  // Decision 3: last month by default, the month a return is filed for
  const period = usePeriod('last_month');
  const [branchId, setBranchId] = useState('');
  const [side, setSide] = useState<VatReportSide>('output');

  const filter: VatReportFilter = {
    from: period.range.from,
    to: period.range.to,
    ...(branchId !== '' && { branchId }),
  };
  const enabled = canRead && online && period.valid;
  const report = useQuery({ ...vatReportQuery(tenantId, filter), enabled });
  const documents = useInfiniteQuery({ ...vatDocumentsQuery(tenantId, filter, side), enabled });
  const branches = useQuery({ ...branchesQuery(tenantId, 'active'), enabled: canRead }).data;

  const rows = useMemo(() => documents.data?.pages.flatMap((page) => page.items), [documents.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = documents;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          // Not sortable (decision 18): the server sends them oldest first, and without this the
          // DataTable would sort in the browser, only the pages loaded so far
          enableSorting: false,
          header: t('reports.vat.documents.columns.number'),
          meta: { card: 'title' },
          cell: ({ row }) => {
            const { kind } = row.original;
            return (
              <span className="grid whitespace-nowrap">
                <DocumentLink document={row.original} />
                <span className="text-caption text-ink-3">
                  {isVatDocumentKind(kind) ? t(`reports.vat.documents.kinds.${kind}`) : kind}
                </span>
              </span>
            );
          },
        }),
        column.accessor('date', {
          enableSorting: false,
          header: t('reports.vat.documents.columns.date'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const date = parseIsoDate(getValue());
            return (
              <span className="whitespace-nowrap tabular-nums">
                {date ? format.date(date) : getValue()}
              </span>
            );
          },
        }),
        column.accessor('partyName', {
          enableSorting: false,
          header:
            side === 'output'
              ? t('reports.vat.documents.columns.customer')
              : t('reports.vat.documents.columns.supplier'),
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => {
            const name = getValue();
            // A POS sale or return with no customer
            return name === null ? (
              t('reports.vat.documents.walkIn')
            ) : (
              <span className="font-medium text-ink">{name}</span>
            );
          },
        }),
        column.accessor('partyBin', {
          enableSorting: false,
          header: t('reports.vat.documents.columns.bin'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const bin = getValue();
            return bin === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="font-mono whitespace-nowrap tabular-nums">{bin}</span>
            );
          },
        }),
        // The input side only: a bill's and a debit note's own VAT document. A bill without its
        // Mushak 6.3 gets a warn pill: its input VAT is the one to check (decision 2).
        ...(side === 'input'
          ? [
              column.accessor('mushakNumber', {
                enableSorting: false,
                header: t('reports.vat.documents.columns.mushak'),
                meta: { card: 'detail' },
                cell: ({ row }) => {
                  const { mushakNumber, kind } = row.original;
                  if (mushakNumber !== null) {
                    return (
                      <span className="font-mono whitespace-nowrap tabular-nums">
                        {mushakNumber}
                      </span>
                    );
                  }
                  return kind === 'bill' ? (
                    <Pill tone="warn" icon={Alert02Icon}>
                      {t('reports.vat.documents.noMushak')}
                    </Pill>
                  ) : (
                    <span className="text-ink-3">—</span>
                  );
                },
              }),
            ]
          : []),
        column.accessor('net', {
          enableSorting: false,
          header: t('reports.vat.documents.columns.net'),
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => money(getValue()),
        }),
        column.accessor('vat', {
          enableSorting: false,
          header: t('reports.vat.documents.columns.vat'),
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => <span className="font-medium text-ink">{money(getValue())}</span>,
        }),
      ]),
    [t, format, money, side],
  );

  const header = (
    <PageHeader
      title={t('reports.vat.title')}
      description={t('reports.vat.description')}
      actions={
        canRead &&
        online &&
        period.valid && (
          <ExportMenu
            request={(exportFormat) => ({
              report: 'vat_report',
              format: exportFormat,
              query: filter,
            })}
            names={{ branch: branchName(branches, branchId) }}
          />
        )
      }
    />
  );

  if (!canRead) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        {header}
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.report.read' })}
        </p>
      </div>
    );
  }

  const answer = report.data;
  const totals = answer?.totals;
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      {header}
      {!online ? (
        <NeedsConnection />
      ) : (
        <>
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3 xl:grid-cols-4">
            <PeriodFields
              preset={period.preset}
              range={period.range}
              onPreset={period.choosePreset}
              onRange={period.chooseRange}
            />
            <SelectField
              label={t('reports.branch')}
              value={branchId}
              options={[
                { value: '', label: t('reports.allBranches') },
                ...(branches ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.code} · ${item.name}`,
                })),
              ]}
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
            />
          </div>
          {report.isError ? (
            <LoadFailed icon={TaxesIcon} onRetry={() => void report.refetch()} />
          ) : (
            answer &&
            totals &&
            (answer.rows.length === 0 ? (
              <EmptyState
                icon={TaxesIcon}
                title={t('reports.vat.emptyTitle')}
                description={t('reports.vat.emptyBody')}
              />
            ) : (
              <>
                <KpiStrip
                  cells={[
                    {
                      label: t('reports.vat.kpis.output'),
                      value: money(totals.outputVat),
                      sub: t('reports.vat.kpiHints.outputReturned', {
                        amount: money(totals.outputVatReturned),
                      }),
                    },
                    {
                      label: t('reports.vat.kpis.input'),
                      value: money(totals.inputVat),
                      sub: t('reports.vat.kpiHints.inputReturned', {
                        amount: money(totals.inputVatReturned),
                      }),
                      // Decision 2: only when some bill lacks its Mushak 6.3. A flat change line:
                      // it says something to look at, not a rise or a fall.
                      change: isZeroMoney(totals.inputVatWithoutMushak)
                        ? undefined
                        : {
                            trend: 'flat',
                            text: t('reports.vat.kpiHints.withoutMushak', {
                              amount: money(totals.inputVatWithoutMushak),
                            }),
                          },
                    },
                    {
                      label: t('reports.vat.kpis.net'),
                      // Without its sign: the words under it say which way (decision 53)
                      value: money(absMoney(totals.netVat)),
                      sub: isZeroMoney(totals.netVat)
                        ? t('reports.vat.kpiHints.nothing')
                        : isNegativeMoney(totals.netVat)
                          ? t('reports.vat.kpiHints.carryForward')
                          : t('reports.vat.kpiHints.payable'),
                    },
                  ]}
                />
                {/* One line per side, each with its own pill: the two accounts can differ apart */}
                <div className="grid gap-1.5">
                  <BooksLine
                    report={totals.outputVat}
                    books={answer.books.output}
                    noBooks=""
                    inBooks={(books) => t('reports.vat.inBooksOutput', { amount: money(books) })}
                  />
                  <BooksLine
                    report={totals.inputVat}
                    books={answer.books.input}
                    noBooks=""
                    inBooks={(books) => t('reports.vat.inBooksInput', { amount: money(books) })}
                  />
                </div>
                <RatesTable rows={answer.rows} totals={totals} />
                <Footnotes notes={[t('reports.vat.notReturn'), t('reports.vat.booksHint')]} />
              </>
            ))
          )}
          {answer && answer.rows.length > 0 && (
            <>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <SectionHeader
                  title={t('reports.vat.documents.title')}
                  subtitle={t('reports.vat.documents.subtitle')}
                />
                <SegmentedControl<VatReportSide>
                  label={t('reports.vat.documents.title')}
                  value={side}
                  options={[
                    { value: 'output', label: t('reports.vat.documents.sides.output') },
                    { value: 'input', label: t('reports.vat.documents.sides.input') },
                  ]}
                  onChange={setSide}
                />
              </div>
              {documents.isError ? (
                <LoadFailed icon={TaxesIcon} onRetry={() => void documents.refetch()} />
              ) : (
                rows && (
                  <DataTable
                    label={t('reports.vat.documents.title')}
                    data={rows}
                    columns={columns}
                    getRowId={(item) => `${item.kind}:${item.id}`}
                    onEndReached={loadMore}
                    empty={
                      <EmptyState
                        icon={TaxesIcon}
                        title={t('reports.vat.documents.title')}
                        description={
                          side === 'output'
                            ? t('reports.vat.documents.emptyOutput')
                            : t('reports.vat.documents.emptyInput')
                        }
                      />
                    }
                    footer={
                      isFetchingNextPage && (
                        <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                      )
                    }
                  />
                )
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
