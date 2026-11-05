import {
  Calendar03Icon,
  Notebook02Icon,
  PlusSignIcon,
  SquareLock02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type JournalEntrySummary,
  type JournalStatus,
  type PeriodLock,
  periodLockInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  SegmentedControl,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { JournalStatusPill, useIsoDate } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { journalListQuery, periodLockQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// The lock date's picker, loaded when the lock dialog opens (date-input.tsx says why). With the
// popover inside, this page went over its 100 KB budget once the sales documents of step 15b grew
// the contracts every page shares.
const DatePicker = lazy(async () => ({
  default: (await import('../components/date-input')).DatePicker,
}));

const column = dataTableColumns<JournalEntrySummary>();
const LOCK_FIELDS = periodLockInputSchema.keyof().options;
const FILTERS = ['all', 'draft', 'posted'] as const;
type Filter = (typeof FILTERS)[number];

function LockDateForm({ lock, onDone }: { lock: PeriodLock; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const showDate = useIsoDate();
  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(periodLockInputSchema, { error: contractErrorMap }),
    defaultValues: { lockDate: lock.lockDate ?? '', version: lock.version },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.periodLock.update, { body: values });
      queryClient.setQueryData(periodLockQuery(tenantId).queryKey, saved);
      toast(
        saved.lockDate === null
          ? t('journal.lock.cleared')
          : t('journal.lock.saved', { date: showDate(saved.lockDate) }),
      );
      onDone();
    } catch (error) {
      applyApiError(error, LOCK_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('journal.lock.title')}
      description={t('journal.lock.description')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="lock-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('journal.lock.save')}
          </Button>
        </>
      }
    >
      <form
        id="lock-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
          <FormField
            control={control}
            name="lockDate"
            label={t('journal.lock.field')}
            hint={t('journal.lock.hint')}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} value={field.value ?? ''} />
              </Suspense>
            )}
          </FormField>
          {/* Clearing the date opens every period again; it is saved like any other date */}
          <Button
            variant="secondary"
            className="mb-[26px]"
            onClick={() => {
              setValue('lockDate', '', { shouldDirty: true });
            }}
          >
            {t('journal.lock.clear')}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function JournalPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const can = useCan();
  const canRead = can('accounting.journal.read');
  const showDate = useIsoDate();
  const [filter, setFilter] = useState<Filter>('all');
  const [locking, setLocking] = useState(false);
  const status: JournalStatus | undefined = filter === 'all' ? undefined : filter;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...journalListQuery(tenantId, status),
    enabled: canRead,
  });
  const lock = useQuery({ ...periodLockQuery(tenantId), enabled: canRead }).data;
  const entries = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor((entry) => entry.number ?? '', {
          id: 'number',
          header: t('journal.columns.number'),
          // A paged list sorts on the server; the server always sends the newest date first
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* A draft has no number yet: its word, not a fake number in the number font */}
              {row.original.number === null ? (
                <span className="text-body-sm font-medium text-ink-2">
                  {t('journal.statuses.draft')}
                </span>
              ) : (
                <span className="font-mono text-body-sm font-medium tabular-nums">
                  {row.original.number}
                </span>
              )}
              <span className="text-caption text-ink-3 tabular-nums">
                {showDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((entry) => entry.narration ?? '', {
          id: 'narration',
          header: t('journal.columns.narration'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <span className="block truncate">{getValue() || '—'}</span>,
        }),
        column.accessor('status', {
          header: t('journal.columns.status'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => <JournalStatusPill entry={row.original} />,
        }),
        column.accessor('total', {
          header: t('journal.columns.amount'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => format.money(getValue(), { decimals: 2 }),
        }),
      ]),
    [t, format, showDate],
  );

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader
        title={t('journal.title')}
        description={
          lock?.lockDate
            ? `${t('journal.description')} · ${t('journal.lockedUntil', { date: showDate(lock.lockDate) })}`
            : t('journal.description')
        }
        actions={
          <>
            {can('accounting.period.close') && (
              <Button
                variant="secondary"
                disabled={!lock}
                onClick={() => {
                  setLocking(true);
                }}
              >
                <HugeiconsIcon icon={SquareLock02Icon} size={17} strokeWidth={1.5} />
                {t('journal.lockDate')}
              </Button>
            )}
            {can('accounting.journal.create') && (
              <Button onClick={() => void navigate({ to: '/journal/new' })}>
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('journal.newEntry')}
              </Button>
            )}
          </>
        }
      />
      {!canRead ? (
        <p className="text-body-sm text-ink-3">
          {t('errors.permission_missing', { permissions: 'accounting.journal.read' })}
        </p>
      ) : (
        <>
          <div>
            <SegmentedControl
              label={t('journal.show')}
              value={filter}
              options={FILTERS.map((value) => ({ value, label: t(`journal.filters.${value}`) }))}
              onChange={setFilter}
            />
          </div>
          {isError && <p className="text-body-sm text-crit">{t('journal.loadFailed')}</p>}
          {entries && (
            <DataTable
              label={t('journal.title')}
              data={entries}
              columns={columns}
              getRowId={(entry) => entry.id}
              onRowClick={(entry) =>
                void navigate({ to: '/journal/$entryId', params: { entryId: entry.id } })
              }
              onEndReached={loadMore}
              empty={
                <EmptyState
                  icon={Notebook02Icon}
                  title={t('journal.emptyTitle')}
                  description={t('journal.emptyBody')}
                />
              }
              footer={
                isFetchingNextPage && (
                  <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                )
              }
            />
          )}
        </>
      )}
      <Dialog open={locking} onOpenChange={setLocking}>
        {lock && locking && (
          <LockDateForm
            lock={lock}
            onDone={() => {
              setLocking(false);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
