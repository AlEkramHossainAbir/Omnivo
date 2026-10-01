import { Undo02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  type Branch,
  contractErrorMap,
  isJournalSource,
  type JournalEntry,
  reverseJournalEntryInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  DatePicker,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  FormField,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { totalsOf } from '../lib/journal';
import { useCan } from '../lib/permissions';
import {
  BackLink,
  failureOf,
  JournalStatusPill,
  useIsoDate,
  useJournalRefresh,
} from './journal-parts';

// A posted entry, read only, with Reverse — or a draft for someone who may post but not edit.
// A chunk of its own, like the form (routes/journal-entry.tsx).

function ReverseForm({
  entry,
  today,
  onDone,
}: {
  entry: JournalEntry;
  today: string;
  onDone: (reversal: JournalEntry) => void;
}) {
  const { t } = useLocale();
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(reverseJournalEntryInputSchema, { error: contractErrorMap }),
    // Today, unless the entry is dated later (a reversal is never dated before its entry)
    defaultValues: { date: today < entry.date ? entry.date : today, version: entry.version },
  });
  const onSubmit = handleSubmit(async (values) => {
    try {
      onDone(await call(routes.journal.reverse, { params: { id: entry.id }, body: values }));
    } catch (error) {
      applyApiError(error, ['date'], setError);
    }
  });
  return (
    <DialogContent
      title={t('journal.reverseTitle', { number: entry.number ?? '' })}
      description={t('journal.reverseBody')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="reverse-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('journal.confirmReverse')}
          </Button>
        </>
      }
    >
      <form
        id="reverse-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <FormField control={control} name="date" label={t('journal.reverseDate')}>
          {(field) => <DatePicker {...field} />}
        </FormField>
      </form>
    </DialogContent>
  );
}

// A posted entry (read only, with Reverse), or a draft for someone who may post but not edit
export function EntryView({
  entry,
  accounts,
  branches,
  today,
}: {
  entry: JournalEntry;
  accounts: Account[];
  branches: Branch[];
  today: string;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const refresh = useJournalRefresh();
  const showDate = useIsoDate();
  const canPost = useCan()('accounting.journal.post');
  const [reversing, setReversing] = useState(false);
  const accountOf = useMemo(() => new Map(accounts.map((item) => [item.id, item])), [accounts]);
  const branchOf = useMemo(() => new Map(branches.map((item) => [item.id, item])), [branches]);
  const totals = totalsOf(entry.lines);

  const post = useMutation({
    mutationFn: () =>
      call(routes.journal.post, { params: { id: entry.id }, body: { version: entry.version } }),
    onSuccess: async (saved) => {
      await refresh(saved);
      toast(t('journal.posted', { number: saved.number ?? '' }));
    },
  });

  // A closing entry is undone by reopening its year (the Year-end close page), not from here
  const canReverse =
    canPost &&
    entry.status === 'posted' &&
    entry.reversedBy === null &&
    entry.source !== 'reversal' &&
    entry.source !== 'year_close';
  const failure = failureOf(post.error);
  const amount = (value: string) =>
    value === '0.0000' ? '' : format.money(value, { decimals: 2 });

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <BackLink />
      <PageHeader
        title={entry.number ?? t('journal.draftTitle')}
        description={showDate(entry.date)}
        actions={
          <>
            {entry.status === 'draft' && canPost && (
              <Button
                disabled={post.isPending || !totals.balanced}
                onClick={() => {
                  post.mutate();
                }}
              >
                {post.isPending ? t('journal.posting') : t('journal.post')}
              </Button>
            )}
            {canReverse && (
              <Button
                variant="secondary"
                onClick={() => {
                  setReversing(true);
                }}
              >
                <HugeiconsIcon icon={Undo02Icon} size={17} strokeWidth={1.5} />
                {t('journal.reverse')}
              </Button>
            )}
          </>
        }
      />
      {failure && <FormAlert message={failure} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-body-sm text-ink-2">
        <JournalStatusPill entry={entry} />
        <span>
          {isJournalSource(entry.source) ? t(`journal.sources.${entry.source}`) : entry.source}
        </span>
        {entry.reversalOf && (
          <Link
            to="/journal/$entryId"
            params={{ entryId: entry.reversalOf.id }}
            className="font-medium text-brand underline-offset-3 hover:underline"
          >
            {t('journal.reverses', { number: entry.reversalOf.number })}
          </Link>
        )}
        {entry.reversedBy && (
          <Link
            to="/journal/$entryId"
            params={{ entryId: entry.reversedBy.id }}
            className="font-medium text-brand underline-offset-3 hover:underline"
          >
            {t('journal.reversedBy', { number: entry.reversedBy.number })}
          </Link>
        )}
      </div>
      {entry.narration && <p className="text-body text-ink">{entry.narration}</p>}
      {/* A plain table in its own scroll box: four columns, a handful of rows, a totals row */}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-body-sm">
          <thead className="bg-subtle text-left text-caption font-medium text-ink-3">
            <tr>
              <th scope="col" className="px-5 py-2.5 font-medium">
                {t('journal.account')}
              </th>
              <th scope="col" className="px-5 py-2.5 font-medium">
                {t('journal.branch')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">
                {t('journal.debit')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">
                {t('journal.credit')}
              </th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line) => {
              const account = accountOf.get(line.accountId);
              const branch = line.branchId === null ? undefined : branchOf.get(line.branchId);
              return (
                <tr key={line.id} className="border-t border-line">
                  <td className="px-5 py-3">
                    {account ? (
                      <Link
                        to="/ledger"
                        search={{ account: account.id }}
                        className="font-medium text-ink underline-offset-3 hover:underline"
                      >
                        <span className="font-mono text-ink-3 tabular-nums">{account.code}</span>{' '}
                        {account.name}
                      </Link>
                    ) : (
                      '—'
                    )}
                    {line.description && (
                      <span className="block text-caption text-ink-3">{line.description}</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-ink-2">{branch?.name ?? '—'}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{amount(line.debit)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{amount(line.credit)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-line bg-subtle font-medium">
            <tr>
              <th scope="row" colSpan={2} className="px-5 py-3 text-left font-medium">
                {t('journal.total')}
              </th>
              <td className="px-5 py-3 text-right tabular-nums">
                {format.money(totals.debit, { decimals: 2 })}
              </td>
              <td className="px-5 py-3 text-right tabular-nums">
                {format.money(totals.credit, { decimals: 2 })}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>
      <Dialog open={reversing} onOpenChange={setReversing}>
        {reversing && (
          <ReverseForm
            entry={entry}
            today={today}
            onDone={(reversal) => {
              setReversing(false);
              void refresh(reversal).then(() => {
                toast(
                  t('journal.reversed', {
                    number: reversal.number ?? '',
                    original: entry.number ?? '',
                  }),
                );
                void navigate({ to: '/journal/$entryId', params: { entryId: reversal.id } });
              });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
