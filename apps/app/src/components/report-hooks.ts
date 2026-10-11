import { DEFAULT_SETTINGS, todayIn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { useQuery } from '@tanstack/react-query';

import { settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// Two hooks of the report pages without any of their components (step 15c). The year-end page uses
// only these; importing them from report-parts.tsx brought that file's date picker and export menu
// into its chunk, and the 15c contracts took the chunk over its 100 KB budget.

// Today and the fiscal year's first month, on the company's clock (not the browser's): the
// presets are worked out from them
export function useReportCalendar(): { today: string; startMonth: number } {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const settings = useQuery(settingsQuery(tenantId)).data;
  return {
    today: todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone),
    startMonth: settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
  };
}

// "৳18,42,600.50": 2 decimals, so a statement's totals visibly add up (CLAUDE.md → Money)
export function useAmount(): (value: string) => string {
  const { format } = useLocale();
  return (value: string) => format.money(value, { decimals: 2 });
}
