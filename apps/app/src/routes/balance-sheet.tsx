import { PieChartIcon } from '@hugeicons/core-free-icons';
import { addMoney, type BalanceSheetQuery, fiscalYearOf, subtractMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { DatePicker, EmptyState, Field, PageHeader, SelectField } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useIsoDate } from '../components/journal-parts';
import {
  BalancePill,
  ExportMenu,
  KpiStrip,
  sectionRows,
  type StatementRow,
  StatementTable,
  useAmount,
  useReportCalendar,
} from '../components/report-parts';
import { useCan } from '../lib/permissions';
import { balanceSheetQuery } from '../lib/queries';
import { COMPARE_AS_OF_MODES, type CompareAsOfMode, compareAsOf } from '../lib/reports';
import { useSession } from '../lib/session-store';

export function BalanceSheetPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.report.read');
  const showDate = useIsoDate();
  const amount = useAmount();
  const { today, startMonth } = useReportCalendar();
  // null = today, which follows the company's clock once the settings arrive
  const [picked, setPicked] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareAsOfMode>('none');
  const asOf = picked ?? today;
  const second = compareAsOf(asOf, compare, startMonth);
  const query: BalanceSheetQuery = { asOf, ...(second !== null && { compareAsOf: second }) };
  const { data, isError } = useQuery({
    ...balanceSheetQuery(tenantId, query),
    enabled: canRead && asOf !== '',
  });
  const asAt = (date: string) => t('reports.asAt', { date: showDate(date) });
  const withCompare = second !== null;
  const cells = (value: string, other: string | null) =>
    withCompare ? [amount(value), amount(other ?? '0')] : [amount(value)];
  const versus = (value: string | null) =>
    value === null ? undefined : t('reports.vs', { amount: amount(value) });
  // Equity ends with the profit no year-end close has moved in yet, and its total includes it
  const equityTotal = data ? addMoney(data.equity.total, data.profitNotClosed) : '0';
  const equityCompare = data?.equity.compareTotal ?? null;
  const profitCompare = data?.compareProfitNotClosed ?? null;
  const compareEquityTotal =
    equityCompare === null || profitCompare === null
      ? null
      : addMoney(equityCompare, profitCompare);

  const rows = (): StatementRow[] => {
    if (!data) return [];
    const equity = sectionRows(
      data.equity,
      { heading: t('reports.sections.equity'), total: t('reports.totalOf.equity') },
      amount,
      withCompare,
    );
    return [
      ...sectionRows(
        data.asset,
        { heading: t('reports.sections.asset'), total: t('reports.totalOf.asset') },
        amount,
        withCompare,
      ),
      ...sectionRows(
        data.liability,
        { heading: t('reports.sections.liability'), total: t('reports.totalOf.liability') },
        amount,
        withCompare,
      ),
      ...equity.slice(0, -1),
      {
        key: 'profit-not-closed',
        name: t('reports.balanceSheet.profitNotClosed'),
        hint: t('reports.balanceSheet.profitNotClosedHint'),
        depth: 1,
        style: 'normal',
        cells: cells(data.profitNotClosed, data.compareProfitNotClosed),
      },
      {
        key: 'equity-total',
        name: t('reports.totalOf.equity'),
        depth: 0,
        style: 'total',
        cells: cells(equityTotal, compareEquityTotal),
      },
      {
        key: 'liabilities-and-equity',
        name: t('reports.balanceSheet.liabilitiesAndEquity'),
        depth: 0,
        style: 'grand',
        cells: cells(data.liabilitiesAndEquity, data.compareLiabilitiesAndEquity),
      },
    ];
  };

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('reports.balanceSheet.title')}
        description={t('reports.balanceSheet.description')}
        actions={
          canRead && (
            <ExportMenu request={(format) => ({ report: 'balance_sheet', format, query })} />
          )
        }
      />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.report.read' })}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field id="report-as-of" label={t('reports.asOf')}>
              <DatePicker id="report-as-of" value={asOf} onChange={setPicked} />
            </Field>
            <SelectField
              label={t('reports.compare')}
              value={compare}
              options={COMPARE_AS_OF_MODES.map((value) => ({
                value,
                label: t(`reports.compareAsOfModes.${value}`),
              }))}
              onChange={(event) => {
                const next = COMPARE_AS_OF_MODES.find((value) => value === event.target.value);
                if (next) setCompare(next);
              }}
            />
          </div>
          {isError && <p className="text-body-sm text-crit">{t('reports.loadFailed')}</p>}
          {data && (
            <>
              <KpiStrip
                cells={[
                  {
                    label: t('reports.totalOf.asset'),
                    value: amount(data.asset.total),
                    sub: versus(data.asset.compareTotal),
                  },
                  {
                    label: t('reports.totalOf.liability'),
                    value: amount(data.liability.total),
                    sub: versus(data.liability.compareTotal),
                  },
                  {
                    label: t('reports.totalOf.equity'),
                    value: amount(equityTotal),
                    sub: versus(compareEquityTotal),
                  },
                ]}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-label text-ink-3 tabular-nums">{asAt(asOf)}</p>
                <BalancePill
                  difference={subtractMoney(data.asset.total, data.liabilitiesAndEquity)}
                />
              </div>
              <StatementTable
                label={t('reports.balanceSheet.title')}
                columns={[asAt(asOf), ...(second === null ? [] : [asAt(second)])]}
                rows={rows()}
                // An account's ledger from the start of the fiscal year up to the day
                ledgerRange={{ from: fiscalYearOf(asOf, startMonth).start, to: asOf }}
                empty={
                  <EmptyState
                    icon={PieChartIcon}
                    title={t('reports.balanceSheet.emptyTitle')}
                    description={t('reports.balanceSheet.emptyBody')}
                  />
                }
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
