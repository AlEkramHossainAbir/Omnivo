import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { DEFAULT_SETTINGS, todayIn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { BackLink } from '../components/journal-parts';
import { useCan } from '../lib/permissions';
import { accountsQuery, branchesQuery, journalEntryQuery, settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// The page only loads the data and picks the form or the view; each is a lazy chunk of its own.
// Together they were over the 100 KB budget, and most visits read a posted entry, which needs
// neither the form library nor the money input.
const EntryForm = lazy(async () => ({
  default: (await import('../components/journal-entry-form')).EntryForm,
}));
const EntryView = lazy(async () => ({
  default: (await import('../components/journal-entry-view')).EntryView,
}));

// The data both pages need: the chart, the branches (archived ones too, for old lines) and
// "today" in the company's time zone
function useEntryData() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const active = useQuery(branchesQuery(tenantId, 'active')).data;
  const archived = useQuery(branchesQuery(tenantId, 'archived')).data;
  const timeZone = useQuery(settingsQuery(tenantId)).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  return {
    tenantId,
    accounts,
    active,
    all: active && archived ? [...active, ...archived] : undefined,
    today: todayIn(timeZone),
  };
}

export function NewJournalEntryPage() {
  const { t } = useLocale();
  const canCreate = useCan()('accounting.journal.create');
  const { accounts, active, today } = useEntryData();
  if (!canCreate) {
    return (
      <div className="grid max-w-5xl grid-cols-1 gap-5">
        <BackLink />
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.journal.create' })}
        </p>
      </div>
    );
  }
  if (!accounts || !active) return null;
  return (
    <Suspense fallback={null}>
      <EntryForm entry={null} accounts={accounts} branches={active} today={today} />
    </Suspense>
  );
}

export function JournalEntryPage() {
  const { t } = useLocale();
  const { entryId = '' } = useParams({ strict: false });
  const can = useCan();
  const { tenantId, accounts, active, all, today } = useEntryData();
  const { data: entry, isError } = useQuery({
    ...journalEntryQuery(tenantId, entryId),
    enabled: can('accounting.journal.read') && entryId !== '',
  });

  if (isError) {
    return (
      <div className="grid max-w-5xl grid-cols-1 gap-5">
        <BackLink />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('journal.draftTitle')}
          description={t('journal.notFound')}
        />
      </div>
    );
  }
  if (!entry || !accounts || !active || !all) return null;
  if (entry.status === 'draft' && can('accounting.journal.create')) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <EntryForm
          key={`${entry.id}-${String(entry.version)}`}
          entry={entry}
          accounts={accounts}
          branches={active}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <EntryView entry={entry} accounts={accounts} branches={all} today={today} />
    </Suspense>
  );
}
