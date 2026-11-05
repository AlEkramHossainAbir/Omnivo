import {
  Alert02Icon,
  Analytics01Icon,
  Building03Icon,
  ChartLineData01Icon,
  PackageOutOfStockIcon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  absMoney,
  type Dashboard,
  type DashboardCard,
  type DashboardDues,
  type DashboardQuery,
  dashboardCardsFor,
  dashboardPeriods,
  isNegativeMoney,
  marginPercent,
  subtractMoney,
  todayIn,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { keepDashboard, keptDashboard } from '@omnivo/sync';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  type KpiCell,
  KpiStrip,
  LineChart,
  PageHeader,
  parseIsoDate,
  Pill,
  SelectField,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import { DocumentNotice } from '../components/document-notice';
import {
  BRANCH_CARDS,
  barWidth,
  cashChange,
  madeToday,
  nothingSold,
  salesChange,
} from '../lib/dashboard';
import { useLocalCopy, useLocalQuery } from '../lib/local-data';
import { branchesQuery, dashboardQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 21a: the Overview. One answer from GET /dashboard (decision 13), asked again every minute
// while the page is open; offline, the last answer this device kept (decision 7). A card shows
// when the answer has it and the person's permissions allow it now: a kept answer may be from
// before a role change. Amounts are whole taka (CLAUDE.md → Money: dashboards stay without
// decimals), so format.money() is called without decimals everywhere here.

// "Paracetamol 500 mg · Strip of 10": the product and its option values (lib/stock.ts has the same
// rule, but importing it would bring the stock pages' helpers into this chunk)
function itemName(item: { productName: string; optionValues: readonly string[] }): string {
  return item.optionValues.length === 0
    ? item.productName
    : `${item.productName} · ${item.optionValues.join(' / ')}`;
}

function isoDate(iso: string): Date {
  return parseIsoDate(iso) ?? new Date();
}

export function DashboardPage() {
  const { t, format } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const online = useOnline();
  const copy = useLocalCopy();

  const cards = useMemo(() => dashboardCardsFor(me?.permissions ?? []), [me]);
  const byBranch = cards.some((card) => BRANCH_CARDS.includes(card));

  // '' = every branch; the select's own empty value
  const [branchId, setBranchId] = useState('');
  const branches = useQuery({
    ...branchesQuery(tenantId, 'active'),
    enabled: online && byBranch,
  }).data;
  // An absent key, not `undefined` (exactOptionalPropertyTypes), and a short query key
  const query: DashboardQuery = branchId === '' ? {} : { branchId };
  const live = useQuery({
    ...dashboardQuery(tenantId, query),
    // A person with no card asks for nothing: the answer would be all nulls (decision 14)
    enabled: online && cards.length > 0,
    // Every minute while the page is open and its tab is seen: TanStack does not poll a hidden tab
    refetchInterval: 60_000,
  });
  // undefined while it is read, null = nothing kept on this device
  const kept = useLocalQuery(copy ? keptDashboard : null);

  // The branch of an answer as the select names it ("MIR · Mirpur store"), kept with the answer:
  // offline the branches cannot be asked for, and the select must still say whose numbers they are
  const answerBranch = live.data?.branchId ?? null;
  const keptName = useMemo(() => {
    const branch = branches?.find((candidate) => candidate.id === answerBranch);
    return branch ? `${branch.code} · ${branch.name}` : null;
  }, [branches, answerBranch]);

  // Each new answer replaces the kept one; the last branch's numbers, shown while another branch's
  // load (placeholder data), never do. A write that fails (the storage is full) leaves the older
  // copy: the page online does not need it, and the Sync page's storage card says what is wrong.
  const fresh = live.isPlaceholderData ? undefined : live.data;
  useEffect(() => {
    if (!copy || !fresh) return;
    keepDashboard(copy, fresh, keptName).catch(() => undefined);
  }, [copy, fresh, keptName]);

  // Online: the live answer, null when it failed. Offline: the kept one, or the live one still in
  // memory on a device that keeps nothing (its copy is not set up). undefined = still reading.
  const answer: Dashboard | null | undefined = online
    ? (live.data ?? (live.isError ? null : undefined))
    : copy && kept === undefined
      ? undefined
      : (kept?.dashboard ?? live.data ?? null);
  const offlineBranch = !online && kept && kept.dashboard === answer ? kept.branchName : null;

  const asOf =
    !online && answer
      ? t('dashboard.asOf', {
          time: madeToday(answer.generatedAt, timeZone)
            ? format.time(new Date(answer.generatedAt), timeZone)
            : format.dateTime(new Date(answer.generatedAt), timeZone),
        })
      : null;
  // The workspace's today: the answer's, else the device's clock in the workspace's time zone
  const description = [
    me?.tenant.name,
    format.date(isoDate(answer?.today ?? todayIn(timeZone))),
    asOf,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(' · ');

  // Online with more than one branch. Offline only for a kept answer of one branch, to say so: the
  // select cannot change while offline (decision 7 keeps one answer).
  const showBranch = byBranch && (online ? (branches?.length ?? 0) > 1 : offlineBranch !== null);

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('dashboard.title')}
        description={description}
        actions={
          showBranch && (
            <div className="w-full sm:w-72">
              <SelectField
                label={t('dashboard.branch')}
                icon={Building03Icon}
                hint={online ? t('dashboard.branchHint') : t('dashboard.branchOffline')}
                disabled={!online}
                value={online ? branchId : (answer?.branchId ?? '')}
                options={
                  online
                    ? [
                        { value: '', label: t('dashboard.allBranches') },
                        ...(branches ?? []).map((branch) => ({
                          value: branch.id,
                          label: `${branch.code} · ${branch.name}`,
                        })),
                      ]
                    : [{ value: answer?.branchId ?? '', label: offlineBranch ?? '' }]
                }
                onChange={(event) => {
                  setBranchId(event.target.value);
                }}
              />
            </div>
          )
        }
      />

      {cards.length === 0 ? (
        <Card>
          <EmptyState
            icon={Analytics01Icon}
            title={t('dashboard.noCardsTitle')}
            description={t('dashboard.noCardsBody')}
          />
        </Card>
      ) : answer === null ? (
        <Card>
          {online ? (
            <EmptyState
              tone="crit"
              icon={Alert02Icon}
              title={t('dashboard.loadFailedTitle')}
              description={t('dashboard.loadFailed')}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void live.refetch();
                  }}
                >
                  {t('common.retry')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={WifiDisconnected02Icon}
              title={t('sync.needsConnectionTitle')}
              description={t('dashboard.noCopyBody')}
            />
          )}
        </Card>
      ) : (
        answer && (
          <>
            {!online && (
              <DocumentNotice tone="neutral">{t('dashboard.offlineNotice')}</DocumentNotice>
            )}
            <Cards answer={answer} cards={cards} />
          </>
        )
      )}
    </div>
  );
}

// The cards the answer has and the person may see, in the mockup's three rows
function Cards({ answer, cards }: { answer: Dashboard; cards: readonly DashboardCard[] }) {
  const { t, format } = useLocale();
  const allowed = <T,>(card: DashboardCard, value: T | null): T | null =>
    cards.includes(card) ? value : null;
  const sales = allowed('sales', answer.sales);
  const margin = allowed('margin', answer.margin);
  const cash = allowed('cash', answer.cash);
  const topProducts = allowed('topProducts', answer.topProducts);
  const receivables = allowed('receivables', answer.receivables);
  const payables = allowed('payables', answer.payables);
  const lowStock = allowed('lowStock', answer.lowStock);

  // The days compared with: "1 – 4 Oct 2026", or one day on the 1st of the month (decision 17)
  const periods = dashboardPeriods(answer.today);
  const showDate = (iso: string) => format.date(isoDate(iso));
  const range =
    periods.lastMonthStart === periods.lastMonthEnd
      ? showDate(periods.lastMonthStart)
      : t('reports.range', {
          from: showDate(periods.lastMonthStart),
          to: showDate(periods.lastMonthEnd),
        });

  const cells: KpiCell[] = [];
  if (sales) {
    const day = salesChange(sales.today, sales.yesterday);
    const month = salesChange(sales.monthToDate, sales.lastMonthToDate);
    cells.push(
      {
        label: t('dashboard.sales.today'),
        value: format.money(sales.today),
        change:
          day.kind === 'none'
            ? { trend: 'flat', text: t('dashboard.sales.noYesterday') }
            : day.kind === 'same'
              ? { trend: 'flat', text: t('dashboard.sales.sameAsYesterday') }
              : {
                  trend: day.kind === 'more' ? 'up' : 'down',
                  text: t(
                    day.kind === 'more'
                      ? 'dashboard.sales.moreThanYesterday'
                      : 'dashboard.sales.lessThanYesterday',
                    { percent: format.number(day.percent, 1) },
                  ),
                },
      },
      {
        label: t('dashboard.sales.month'),
        value: format.money(sales.monthToDate),
        change:
          month.kind === 'none'
            ? { trend: 'flat', text: t('dashboard.sales.noLastMonth', { range }) }
            : month.kind === 'same'
              ? { trend: 'flat', text: t('dashboard.sales.sameAsLastMonth', { range }) }
              : {
                  trend: month.kind === 'more' ? 'up' : 'down',
                  text: t(
                    month.kind === 'more'
                      ? 'dashboard.sales.moreThanLastMonth'
                      : 'dashboard.sales.lessThanLastMonth',
                    { percent: format.number(month.percent, 1), range },
                  ),
                },
      },
    );
  }
  if (margin) {
    const now = marginPercent(margin.monthToDate);
    const before = marginPercent(margin.lastMonthToDate);
    cells.push({
      label: t('dashboard.margin.title'),
      value: now === null ? '—' : `${format.number(now, 1)}%`,
      sub:
        now === null
          ? t('dashboard.margin.noSales')
          : t('dashboard.margin.ofSales', {
              profit: format.money(
                subtractMoney(margin.monthToDate.sales, margin.monthToDate.cost),
              ),
              sales: format.money(margin.monthToDate.sales),
            }),
      // Only to compare with, so no arrow and no color: the words say no "more" or "less"
      change:
        before === null
          ? undefined
          : {
              trend: 'flat',
              text: t('dashboard.margin.lastMonth', { percent: format.number(before, 1), range }),
            },
    });
  }
  if (cash) {
    const change = cashChange(cash);
    cells.push({
      label: t('dashboard.cash.title'),
      value: format.money(cash.total),
      change:
        change.kind === 'same'
          ? { trend: 'flat', text: t('dashboard.cash.sameToday') }
          : {
              trend: change.kind,
              text: t(
                change.kind === 'up' ? 'dashboard.cash.upToday' : 'dashboard.cash.downToday',
                {
                  amount: format.money(change.amount),
                },
              ),
            },
    });
  }

  const dues = receivables !== null || payables !== null;

  return (
    <>
      {cells.length > 0 && <KpiStrip cells={cells} />}

      {/* Both need sales.report.read, so they come together */}
      {sales && topProducts && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <SalesTrend days={sales.days} />
          <TopProducts items={topProducts} />
        </div>
      )}

      {(cash !== null || lowStock !== null || dues) && (
        // auto-fit: a card alone takes the whole row (a store keeper sees only the low stock)
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-5">
          {cash && <CashCard cash={cash} />}
          {dues && (
            <Card className="grid content-start divide-y divide-line">
              {receivables && <DuesBlock kind="receivables" dues={receivables} />}
              {payables && <DuesBlock kind="payables" dues={payables} />}
            </Card>
          )}
          {lowStock && <LowStockCard lowStock={lowStock} />}
        </div>
      )}
    </>
  );
}

function SalesTrend({ days }: { days: NonNullable<Dashboard['sales']>['days'] }) {
  const { t, format } = useLocale();
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  return (
    <Card className="grid min-w-0 content-start gap-3 pb-4 lg:col-span-2">
      <CardHeader title={t('dashboard.trend.title')} subtitle={t('dashboard.trend.subtitle')} />
      <div className="px-5">
        {nothingSold(days) || first === undefined || last === undefined ? (
          <p className="grid h-[220px] place-items-center text-body-sm text-ink-3">
            {t('dashboard.trend.empty')}
          </p>
        ) : (
          <LineChart
            label={t('dashboard.trend.label', {
              from: format.date(isoDate(first)),
              to: format.date(isoDate(last)),
            })}
            points={days.map((day) => ({
              key: day.date,
              value: day.amount,
              label: format.date(isoDate(day.date)),
              axisLabel: format.dayMonth(isoDate(day.date)),
            }))}
            formatValue={(value) => format.money(value)}
          />
        )}
      </div>
    </Card>
  );
}

function TopProducts({ items }: { items: NonNullable<Dashboard['topProducts']> }) {
  const { t, format } = useLocale();
  const largest = items[0]?.amount ?? '0';
  return (
    <Card className="grid min-w-0 content-start">
      <CardHeader
        title={t('dashboard.topProducts.title')}
        subtitle={t('dashboard.topProducts.subtitle')}
      />
      {items.length === 0 ? (
        <EmptyState
          icon={ChartLineData01Icon}
          title={t('dashboard.topProducts.emptyTitle')}
          description={t('dashboard.topProducts.emptyBody')}
        />
      ) : (
        <ol className="px-5 pt-1.5 pb-2">
          {items.map((item, index) => (
            <li
              key={item.variantId}
              className="grid gap-1.5 border-t border-line py-2.5 first:border-t-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-body-sm font-medium text-ink">{itemName(item)}</span>
                <span className="shrink-0 text-body-sm font-medium tabular-nums">
                  {format.money(item.amount)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2.5 text-caption text-ink-3">
                <span className="font-mono">{item.sku}</span>
                <span className="tabular-nums">
                  {t('dashboard.topProducts.sold', {
                    quantity: `${format.number(item.quantity, item.baseUnit.decimals)} ${item.baseUnit.code}`,
                  })}
                </span>
              </div>
              {/* A magnitude bar (CLAUDE.md → Charts): brand for the first, brand-line after it */}
              <span aria-hidden="true" className="block h-1 rounded-full bg-subtle">
                <span
                  className={
                    index === 0
                      ? 'block h-1 rounded-full bg-brand'
                      : 'block h-1 rounded-full bg-brand-line'
                  }
                  style={{ width: barWidth(item.amount, largest) }}
                />
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function CashCard({ cash }: { cash: NonNullable<Dashboard['cash']> }) {
  const { t, format } = useLocale();
  return (
    <Card className="grid min-w-0 grid-cols-1 grid-rows-[auto_1fr_auto] overflow-hidden">
      <CardHeader title={t('dashboard.cash.title')} subtitle={t('dashboard.cash.subtitle')} />
      {cash.accounts.length === 0 ? (
        <EmptyState
          icon={Building03Icon}
          title={t('dashboard.cash.emptyTitle')}
          description={t('dashboard.cash.emptyBody')}
        />
      ) : (
        <>
          <ul className="px-5 py-1.5">
            {cash.accounts.map((account) => (
              <li
                key={account.accountId}
                className="flex min-h-11 items-center gap-2.5 border-t border-line text-body-sm first:border-t-0"
              >
                <span className="font-mono text-caption text-ink-3 tabular-nums">
                  {account.code}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{account.name}</span>
                <span className="font-medium tabular-nums">{format.money(account.balance)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between border-t border-line bg-subtle px-5 py-3 text-body-sm font-medium">
            <span>{t('reports.total')}</span>
            <span className="tabular-nums">{format.money(cash.total)}</span>
          </div>
        </>
      )}
    </Card>
  );
}

function DuesBlock({ kind, dues }: { kind: 'receivables' | 'payables'; dues: DashboardDues }) {
  const { t, format } = useLocale();
  return (
    <div className="grid content-start gap-2.5 px-5 py-[18px]">
      <div>
        <h3 className="text-h3">{t(`dashboard.${kind}.title`)}</h3>
        <p className="text-label text-ink-3">{t(`dashboard.${kind}.subtitle`)}</p>
      </div>
      <span className="text-kpi tracking-[-0.03em] tabular-nums">
        {/* Below zero: the advances are larger than what is owed (decision 22) */}
        {isNegativeMoney(dues.total)
          ? t(`dashboard.${kind}.advance`, { amount: format.money(absMoney(dues.total)) })
          : format.money(dues.total)}
      </span>
      {dues.overdueCount > 0 ? (
        <span className="flex items-center gap-1.5 text-label font-medium text-crit tabular-nums">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {t(`dashboard.${kind}.overdue`, {
            count: dues.overdueCount,
            formatted: format.number(dues.overdueCount),
            amount: format.money(dues.overdue),
          })}
        </span>
      ) : (
        <span className="text-label text-ink-3">{t(`dashboard.${kind}.nothingOverdue`)}</span>
      )}
      <Link
        to={kind === 'receivables' ? '/customers' : '/suppliers'}
        className="justify-self-start text-body-sm font-medium text-brand underline-offset-[3px] hover:underline"
      >
        {t(`dashboard.${kind}.link`)}
      </Link>
    </div>
  );
}

function LowStockCard({ lowStock }: { lowStock: NonNullable<Dashboard['lowStock']> }) {
  const { t, format } = useLocale();
  return (
    <Card className="grid min-w-0 grid-cols-1 grid-rows-[auto_1fr_auto]">
      <CardHeader
        title={t('dashboard.lowStock.title')}
        subtitle={t('dashboard.lowStock.subtitle')}
        actions={
          lowStock.count > 0 && (
            <Pill tone="warn" icon={PackageOutOfStockIcon}>
              {t('dashboard.lowStock.count', {
                count: lowStock.count,
                formatted: format.number(lowStock.count),
              })}
            </Pill>
          )
        }
      />
      {lowStock.items.length === 0 ? (
        <EmptyState
          icon={PackageOutOfStockIcon}
          title={t('dashboard.lowStock.emptyTitle')}
          description={t('dashboard.lowStock.emptyBody')}
        />
      ) : (
        <>
          <ul className="px-5 py-1.5">
            {lowStock.items.map((item) => (
              <li
                key={`${item.variantId}:${item.warehouseId}`}
                className="flex min-h-12 items-center gap-3 border-t border-line first:border-t-0"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium text-ink">
                    {itemName(item)}
                  </span>
                  <span className="truncate text-caption text-ink-3">{item.warehouseName}</span>
                </span>
                <span className="shrink-0 text-body-sm text-ink-2 tabular-nums">
                  {t('dashboard.lowStock.onHandOf', {
                    onHand: format.number(item.onHand, item.baseUnit.decimals),
                    level: `${format.number(item.minQuantity, item.baseUnit.decimals)} ${item.baseUnit.code}`,
                  })}
                </span>
              </li>
            ))}
          </ul>
          <Link
            to="/stock/reorder"
            className="justify-self-start px-5 pt-3 pb-4 text-body-sm font-medium text-brand underline-offset-[3px] hover:underline"
          >
            {t('dashboard.lowStock.link')}
          </Link>
        </>
      )}
    </Card>
  );
}
