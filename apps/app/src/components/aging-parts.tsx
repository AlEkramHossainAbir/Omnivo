import {
  absMoney,
  type AgingAmounts,
  type AgingShow,
  isNegativeMoney,
  isZeroMoney,
  subtractMoney,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import type { KpiCell } from '@omnivo/ui';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import { useReportCalendar } from './report-hooks';

// Step 21b: what the two aging pages and the two party pages share. Here, not in a route file, for
// the same reason as report-parts.tsx.

export type AgingNamespace = 'arAging' | 'apAging';

interface AgingSearch {
  asOf?: string;
  groupId?: string;
  show?: 'overdue';
}

// Only what differs from the defaults goes in the address, so a plain link stays plain: an empty day
// means "today", which keeps following the company's clock
function searchOf(asOf: string | undefined, groupId: string, show: AgingShow): AgingSearch {
  return {
    ...(asOf !== undefined && asOf !== '' && { asOf }),
    ...(groupId !== '' && { groupId }),
    ...(show === 'overdue' && { show }),
  };
}

// The day and the filters are in the address (router.tsx, agingSearch), so going to a party's page
// and back lands on the same report, and the address can be sent to someone.
export function useAgingFilters() {
  const navigate = useNavigate();
  const { today } = useReportCalendar();
  const { asOf: asOfParam, groupId = '', show: showParam } = useSearch({ strict: false });
  // Not strict, so this field is every route's `show` together; only these two mean anything here
  const show: AgingShow = showParam === 'overdue' ? 'overdue' : 'all';
  // Memoized: the table's columns link with it, and new columns on every render would remount
  // every cell (a keyboard user's focus on a link would be lost)
  const search = useMemo(() => searchOf(asOfParam, groupId, show), [asOfParam, groupId, show]);
  // '.' is the page's own address, so the party page changes its day without leaving it. replace:
  // a changed filter is not a place to come back to with the browser's Back button.
  const update = (next: AgingSearch) => {
    void navigate({ to: '.', search: next, replace: true });
  };
  return {
    today,
    // Empty until the settings say what day it is in the company's time zone
    asOf: asOfParam ?? today,
    groupId,
    show,
    search,
    chooseDay: (asOf: string) => {
      update(searchOf(asOf, groupId, show));
    },
    chooseGroup: (id: string) => {
      update(searchOf(asOfParam, id, show));
    },
    chooseShow: (value: AgingShow) => {
      update(searchOf(asOfParam, groupId, value));
    },
  };
}

// A balance below zero means the party is ahead: "৳50,000 in advance" for a customer, "They owe you
// ৳50,000" for a supplier. It reads the words, not a minus sign, like a customer's balance elsewhere.
export function useBalanceWords(namespace: AgingNamespace): (balance: string) => string {
  const { t, format } = useLocale();
  return useCallback(
    (balance) =>
      isNegativeMoney(balance)
        ? t(`reports.${namespace}.inAdvance`, { amount: format.money(absMoney(balance)) })
        : format.money(balance),
    [t, format, namespace],
  );
}

// The KPI strip of a report and of a party's page: the same four cells. `dueSub` is the line under
// the total, which only a party's page has (how many documents are open).
export function useAgingKpis(namespace: AgingNamespace) {
  const { t, format } = useLocale();
  const balanceWords = useBalanceWords(namespace);
  return (totals: AgingAmounts, dueSub?: string): KpiCell[] => [
    { label: t('reports.aging.columns.due'), value: format.money(totals.due), sub: dueSub },
    {
      label: t('reports.aging.overdue'),
      // The buckets after Current together
      value: format.money(subtractMoney(totals.due, totals.current)),
      sub: isZeroMoney(totals.over90)
        ? undefined
        : t('reports.aging.over90', { amount: format.money(totals.over90) }),
    },
    {
      label: t('reports.aging.columns.advances'),
      value: format.money(totals.advances),
      sub: t(`reports.${namespace}.advancesHint`),
    },
    {
      label: t('reports.aging.columns.balance'),
      value: balanceWords(totals.balance),
      sub: t('reports.aging.balanceHint'),
    },
  ];
}
