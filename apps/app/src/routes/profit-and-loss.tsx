import { ChartIncreaseIcon } from '@hugeicons/core-free-icons';
import type { ProfitAndLossQuery } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState, PageHeader, SelectField } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useIsoDate } from '../components/journal-parts';
import {
  ExportMenu,
  KpiStrip,
  PeriodFields,
  sectionRows,
  StatementTable,
  useAmount,
  usePeriod,
} from '../components/report-parts';
import { useCan } from '../lib/permissions';
import { branchesQuery, profitAndLossQuery } from '../lib/queries';
import { COMPARE_MODES, type CompareMode, compareRange } from '../lib/reports';
import { useSession } from '../lib/session-store';

export function ProfitAndLossPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canRead = useCan()('accounting.report.read');
  const showDate = useIsoDate();
  const amount = useAmount();
  const period = usePeriod();
  const [compare, setCompare] = useState<CompareMode>('none');
  // '' = every branch; the select's own empty value
  const [branchId, setBranchId] = useState('');
  const branches = useQuery({ ...branchesQuery(tenantId, 'active'), enabled: canRead }).data;

  const second = compareRange(period.range, compare);
  // Only the parts that are set: an absent key, not `undefined`, is what the contract allows
  // (exactOptionalPropertyTypes), and it keeps the query key short
  const query: ProfitAndLossQuery = {
    from: period.range.from,
    to: period.range.to,
    ...(second && { compareFrom: second.from, compareTo: second.to }),
    ...(branchId !== '' && { branchId }),
  };
  const { data, isError } = useQuery({
    ...profitAndLossQuery(tenantId, query),
    enabled: canRead && period.valid,
  });
  const label = (range: { from: string; to: string }) =>
    t('reports.range', { from: showDate(range.from), to: showDate(range.to) });
  const versus = (value: string | null) =>
    value === null ? undefined : t('reports.vs', { amount: amount(value) });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('reports.profitAndLoss.title')}
        description={t('reports.profitAndLoss.description')}
        actions={
          canRead && (
            <ExportMenu request={(format) => ({ report: 'profit_and_loss', format, query })} />
          )
        }
      />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.report.read' })}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            <PeriodFields
              preset={period.preset}
              range={period.range}
              onPreset={period.choosePreset}
              onRange={period.chooseRange}
            />
            <SelectField
              label={t('reports.compare')}
              value={compare}
              options={COMPARE_MODES.map((value) => ({
                value,
                label: t(`reports.compareModes.${value}`),
              }))}
              onChange={(event) => {
                const next = COMPARE_MODES.find((value) => value === event.target.value);
                if (next) setCompare(next);
              }}
            />
            <SelectField
              label={t('reports.branch')}
              value={branchId}
              options={[
                { value: '', label: t('reports.allBranches') },
                ...(branches ?? []).map((branch) => ({
                  value: branch.id,
                  label: `${branch.code} · ${branch.name}`,
                })),
              ]}
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
            />
          </div>
          {isError && <p className="text-body-sm text-crit">{t('reports.loadFailed')}</p>}
          {data && (
            <>
              <KpiStrip
                cells={[
                  {
                    label: t('reports.totalOf.income'),
                    value: amount(data.income.total),
                    sub: versus(data.income.compareTotal),
                  },
                  {
                    label: t('reports.totalOf.expense'),
                    value: amount(data.expense.total),
                    sub: versus(data.expense.compareTotal),
                  },
                  {
                    label: t('reports.profitAndLoss.netProfit'),
                    value: amount(data.netProfit),
                    sub: versus(data.compareNetProfit),
                  },
                ]}
              />
              <StatementTable
                label={t('reports.profitAndLoss.title')}
                columns={[label(period.range), ...(second ? [label(second)] : [])]}
                rows={[
                  ...sectionRows(
                    data.income,
                    { heading: t('reports.sections.income'), total: t('reports.totalOf.income') },
                    amount,
                    second !== null,
                  ),
                  ...sectionRows(
                    data.expense,
                    {
                      heading: t('reports.sections.expense'),
                      total: t('reports.totalOf.expense'),
                    },
                    amount,
                    second !== null,
                  ),
                  {
                    key: 'net-profit',
                    name: t('reports.profitAndLoss.netProfit'),
                    depth: 0,
                    style: 'grand',
                    cells: [
                      amount(data.netProfit),
                      ...(second ? [amount(data.compareNetProfit ?? '0')] : []),
                    ],
                  },
                ]}
                ledgerRange={period.range}
                empty={
                  <EmptyState
                    icon={ChartIncreaseIcon}
                    title={t('reports.profitAndLoss.emptyTitle')}
                    description={t('reports.profitAndLoss.emptyBody')}
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
