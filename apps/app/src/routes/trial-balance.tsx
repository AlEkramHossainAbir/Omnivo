import { TableIcon } from '@hugeicons/core-free-icons';
import { ACCOUNT_TYPES, isZeroMoney, subtractMoney, type TrialBalance } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';

import { useIsoDate } from '../components/journal-parts';
import {
  BalancePill,
  ExportMenu,
  PeriodFields,
  type StatementRow,
  StatementTable,
  useAmount,
  usePeriod,
} from '../components/report-parts';
import { balanceSide } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { trialBalanceQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// The rows of the table: one heading per account type, then its accounts in code order. The
// totals row shows both sides of the opening and closing balances, one above the other.
function useRows(): (report: TrialBalance) => StatementRow[] {
  const { t } = useLocale();
  const amount = useAmount();
  // "৳1,200.00 Cr", or empty for zero
  const balance = (value: string) => {
    const { amount: size, side } = balanceSide(value);
    if (side === null) return null;
    return t(side === 'debit' ? 'ledger.debitBalance' : 'ledger.creditBalance', {
      amount: amount(size),
    });
  };
  const moved = (value: string) => (isZeroMoney(value) ? null : amount(value));
  const pair = (debit: string, credit: string) => (
    <span className="grid">
      <span>{t('ledger.debitBalance', { amount: amount(debit) })}</span>
      <span>{t('ledger.creditBalance', { amount: amount(credit) })}</span>
    </span>
  );
  return (report) => [
    ...ACCOUNT_TYPES.flatMap((type): StatementRow[] => {
      const rows = report.rows.filter((row) => row.type === type);
      if (rows.length === 0) return [];
      return [
        {
          key: `${type}-heading`,
          name: t(`reports.sections.${type}`),
          depth: 0,
          style: 'heading',
          cells: [],
        },
        ...rows.map((row): StatementRow => ({
          key: row.accountId,
          accountId: row.accountId,
          code: row.code,
          name: row.name,
          depth: 0,
          style: 'normal',
          cells: [balance(row.opening), moved(row.debit), moved(row.credit), balance(row.closing)],
        })),
      ];
    }),
    {
      key: 'total',
      name: t('reports.total'),
      depth: 0,
      style: 'grand',
      cells: [
        pair(report.totals.openingDebit, report.totals.openingCredit),
        amount(report.totals.debit),
        amount(report.totals.credit),
        pair(report.totals.closingDebit, report.totals.closingCredit),
      ],
    },
  ];
}

export function TrialBalancePage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.report.read');
  const showDate = useIsoDate();
  const period = usePeriod();
  const query = { from: period.range.from, to: period.range.to };
  const { data, isError } = useQuery({
    ...trialBalanceQuery(tenantId, query),
    enabled: canRead && period.valid,
  });
  const rowsOf = useRows();

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('reports.trialBalance.title')}
        description={t('reports.trialBalance.description')}
        actions={
          canRead && (
            <ExportMenu request={(format) => ({ report: 'trial_balance', format, query })} />
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
            <PeriodFields
              preset={period.preset}
              range={period.range}
              onPreset={period.choosePreset}
              onRange={period.chooseRange}
            />
          </div>
          {isError && <p className="text-body-sm text-crit">{t('reports.loadFailed')}</p>}
          {data && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-label text-ink-3 tabular-nums">
                  {t('reports.range', {
                    from: showDate(query.from),
                    to: showDate(query.to),
                  })}
                </p>
                {data.rows.length > 0 && (
                  <BalancePill
                    difference={subtractMoney(data.totals.closingDebit, data.totals.closingCredit)}
                  />
                )}
              </div>
              <StatementTable
                label={t('reports.trialBalance.title')}
                columns={[
                  t('reports.trialBalance.opening'),
                  t('reports.trialBalance.debit'),
                  t('reports.trialBalance.credit'),
                  t('reports.trialBalance.closing'),
                ]}
                rows={rowsOf(data)}
                ledgerRange={query}
                empty={
                  <EmptyState
                    icon={TableIcon}
                    title={t('reports.trialBalance.emptyTitle')}
                    description={t('reports.trialBalance.emptyBody')}
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
