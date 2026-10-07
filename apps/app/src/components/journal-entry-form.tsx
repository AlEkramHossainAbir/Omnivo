import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Alert02Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  type Branch,
  contractErrorMap,
  isPartyAccountPurpose,
  type JournalEntry,
  type PartyRef,
  routes,
  updateJournalEntryInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  DatePicker,
  FormAlert,
  FormField,
  IconButton,
  Input,
  MoneyInput,
  PageHeader,
  Pill,
  Select,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { balanceSide, formAmount, ledgerOptions, linePath, totalsOf } from '../lib/journal';
import { useCan } from '../lib/permissions';
import { CustomerPicker } from './customer-picker';
import { BackLink, failureOf, LineField, useJournalRefresh } from './journal-parts';

// The entry form: a chunk of its own (loaded by routes/journal-entry.tsx), because the form
// library, the date picker and the money input are only needed to write — a posted entry, the most
// common page, is read without them.

type FormValues = z.input<typeof updateJournalEntryInputSchema>;
type LineValues = FormValues['lines'][number];

// One template for the lines' header, every line and the totals row, so the columns line up.
// A container query (@3xl = the card is 48rem wide), not a screen one: the sidebar takes 244px,
// so the screen width alone does not say how much room the lines have.
const LINE_COLUMNS = {
  withBranch: '@3xl:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_9rem_9rem_2.25rem]',
  withoutBranch: '@3xl:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_9rem_9rem_2.25rem]',
} as const;

function emptyLine(): LineValues {
  return { accountId: '', branchId: '', partyId: '', description: '', debit: '', credit: '' };
}

// The server's field names for the errors it can send — one set per line
function fieldNames(lineCount: number): Path<FormValues>[] {
  return [
    'date',
    'narration',
    'lines',
    ...Array.from({ length: lineCount }, (_, index) => [
      linePath(index, 'accountId'),
      linePath(index, 'branchId'),
      linePath(index, 'partyId'),
      linePath(index, 'debit'),
      linePath(index, 'credit'),
    ]).flat(),
  ];
}

// Writing a new entry, or changing a draft. "Save draft" keeps it a draft; "Post entry" saves and
// posts in one request — all or nothing, so a refused post leaves nothing half saved.
export function EntryForm({
  entry,
  accounts,
  branches,
  today,
}: {
  entry: JournalEntry | null;
  accounts: Account[];
  branches: Branch[];
  today: string;
}) {
  const { t, format, errorText } = useLocale();
  const navigate = useNavigate();
  const refresh = useJournalRefresh();
  const canPost = useCan()('accounting.journal.post');
  const [confirming, setConfirming] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateJournalEntryInputSchema, { error: contractErrorMap }),
    defaultValues: {
      date: entry?.date ?? today,
      narration: entry?.narration ?? '',
      lines: entry
        ? entry.lines.map((line) => ({
            accountId: line.accountId,
            branchId: line.branchId ?? '',
            partyId: line.party?.id ?? '',
            description: line.description ?? '',
            debit: formAmount(line.debit),
            credit: formAmount(line.credit),
          }))
        : [emptyLine(), emptyLine()],
      post: false,
      // A new entry has no version; 1 passes the schema, and the create route never reads it
      version: entry?.version ?? 1,
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const totals = totalsOf(lines);

  const used = useMemo(() => entry?.lines.map((line) => line.accountId) ?? [], [entry]);
  const accountOptions = useMemo(
    () => [{ value: '', label: t('journal.accountPlaceholder') }, ...ledgerOptions(accounts, used)],
    [accounts, used, t],
  );
  const branchOptions = useMemo(
    () => [
      { value: '', label: t('journal.noBranch') },
      ...branches.map((branch) => ({ value: branch.id, label: `${branch.code} · ${branch.name}` })),
    ],
    [branches, t],
  );
  const showBranch = branches.length > 0;
  // The receivable (step 15a): a line on it names its customer. The server checks it too.
  const partyAccounts = useMemo(
    () =>
      new Set(
        accounts
          .filter((account) => isPartyAccountPurpose(account.purpose))
          .map((account) => account.id),
      ),
    [accounts],
  );
  // The customers the draft was saved with, so each box names its customer before any search
  const savedParties = useMemo(
    () =>
      new Map<string, PartyRef>(
        entry?.lines.flatMap((line) => (line.party ? [[line.party.id, line.party]] : [])) ?? [],
      ),
    [entry],
  );
  const columns = showBranch ? LINE_COLUMNS.withBranch : LINE_COLUMNS.withoutBranch;

  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post };
        const saved = entry
          ? await call(routes.journal.update, {
              params: { id: entry.id },
              body: { ...body, version },
            })
          : await call(routes.journal.create, { body });
        await refresh(saved);
        toast(
          saved.status === 'posted'
            ? t('journal.posted', { number: saved.number ?? '' })
            : t('journal.draftSaved'),
        );
        if (!entry) {
          void navigate({ to: '/journal/$entryId', params: { entryId: saved.id }, replace: true });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines.length), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: JournalEntry) =>
      call(routes.journal.remove, { params: { id: draft.id }, query: { version: draft.version } }),
    onSuccess: async () => {
      await refresh();
      toast(t('journal.deleted'));
      void navigate({ to: '/journal' });
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  // "At least two lines" belongs to the list, not to one line. react-hook-form keeps such an
  // array-level error on `lines.root` when it comes from a field array, on `lines` from a resolver.
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;
  const out = balanceSide(totals.difference);

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <BackLink />
      <PageHeader title={entry ? t('journal.draftTitle') : t('journal.newTitle')} />
      <form
        id="entry-form"
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-x-4">
          <FormField control={control} name="date" label={t('journal.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <TextField
            label={t('journal.narration')}
            optional
            placeholder={t('journal.narrationPlaceholder')}
            {...register('narration')}
            error={errors.narration?.message}
          />
        </Card>

        <Card
          className="@container grid grid-cols-1 overflow-hidden"
          aria-label={t('journal.lines')}
        >
          <div
            aria-hidden="true"
            className={cn(
              'hidden gap-2 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
              columns,
            )}
          >
            <span>{t('journal.account')}</span>
            <span>{t('journal.lineDescription')}</span>
            {showBranch && <span>{t('journal.branch')}</span>}
            <span className="text-right">{t('journal.debit')}</span>
            <span className="text-right">{t('journal.credit')}</span>
          </div>
          {fields.map((line, index) => {
            const number = index + 1;
            const lineErrors = errors.lines?.[index];
            const removeButton = (
              <IconButton
                icon={Delete02Icon}
                label={t('journal.removeLine', { number })}
                disabled={fields.length <= 2}
                onClick={() => {
                  remove(index);
                }}
              />
            );
            return (
              <div
                key={line.id}
                role="group"
                aria-label={t('journal.line', { number })}
                className={cn(
                  'grid grid-cols-2 gap-3 border-t border-line px-5 py-4 first:border-t-0 @3xl:items-start @3xl:gap-2 @3xl:py-3 @3xl:first:border-t',
                  columns,
                )}
              >
                <div className="col-span-2 flex items-center justify-between @3xl:hidden">
                  <span className="text-label font-medium text-ink-2">
                    {t('journal.line', { number })}
                  </span>
                  {removeButton}
                </div>
                <div className="col-span-2 grid grid-cols-1 gap-2 @3xl:col-span-1">
                  <LineField
                    id={linePath(index, 'accountId')}
                    label={t('journal.account')}
                    error={lineErrors?.accountId?.message}
                  >
                    <Select
                      id={linePath(index, 'accountId')}
                      options={accountOptions}
                      invalid={lineErrors?.accountId !== undefined}
                      aria-describedby={
                        lineErrors?.accountId ? `${linePath(index, 'accountId')}-error` : undefined
                      }
                      {...register(linePath(index, 'accountId'), {
                        // Another account takes no customer: the server would refuse the line
                        // (journal_party_not_allowed), and the box is gone, so it could not be
                        // seen to clear it
                        onChange: () => {
                          if (!partyAccounts.has(getValues(linePath(index, 'accountId')))) {
                            setValue(linePath(index, 'partyId'), '');
                          }
                        },
                      })}
                    />
                  </LineField>
                  {/* Under the account, not in a column of its own: only receivable lines have
                      it, and a column empty on most lines would squeeze the others */}
                  {partyAccounts.has(lines[index]?.accountId ?? '') && (
                    <Controller
                      control={control}
                      name={linePath(index, 'partyId')}
                      render={({ field, fieldState }) => (
                        <LineField
                          id={field.name}
                          label={t('journal.customer')}
                          error={fieldState.error?.message}
                        >
                          <CustomerPicker
                            id={field.name}
                            name={field.name}
                            ref={field.ref}
                            value={field.value ?? ''}
                            saved={savedParties.get(field.value ?? '') ?? null}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            invalid={fieldState.error !== undefined}
                            aria-describedby={fieldState.error ? `${field.name}-error` : undefined}
                          />
                        </LineField>
                      )}
                    />
                  )}
                </div>
                <div className="col-span-2 @3xl:col-span-1">
                  <LineField
                    id={linePath(index, 'description')}
                    label={t('journal.lineDescription')}
                    error={lineErrors?.description?.message}
                  >
                    <Input
                      id={linePath(index, 'description')}
                      invalid={lineErrors?.description !== undefined}
                      {...register(linePath(index, 'description'))}
                    />
                  </LineField>
                </div>
                {showBranch && (
                  <div className="col-span-2 @3xl:col-span-1">
                    <LineField
                      id={linePath(index, 'branchId')}
                      label={t('journal.branch')}
                      error={lineErrors?.branchId?.message}
                    >
                      <Select
                        id={linePath(index, 'branchId')}
                        options={branchOptions}
                        invalid={lineErrors?.branchId !== undefined}
                        {...register(linePath(index, 'branchId'))}
                      />
                    </LineField>
                  </div>
                )}
                {(['debit', 'credit'] as const).map((side) => (
                  <Controller
                    key={side}
                    control={control}
                    name={linePath(index, side)}
                    render={({ field, fieldState }) => (
                      <LineField
                        id={field.name}
                        label={t(`journal.${side}`)}
                        error={fieldState.error?.message}
                      >
                        <MoneyInput
                          id={field.name}
                          name={field.name}
                          ref={field.ref}
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          invalid={fieldState.error !== undefined}
                          aria-describedby={fieldState.error ? `${field.name}-error` : undefined}
                        />
                      </LineField>
                    )}
                  />
                ))}
                <div className="hidden @3xl:block @3xl:pt-1">{removeButton}</div>
              </div>
            );
          })}
          {linesError && (
            <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
              <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
              {errorText(linesError)}
            </p>
          )}
          <div className="border-t border-line px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                append(emptyLine());
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
              {t('journal.addLine')}
            </Button>
          </div>
          <div
            className={cn(
              'grid grid-cols-2 items-center gap-3 border-t border-line bg-subtle px-5 py-3 @3xl:gap-2',
              columns,
            )}
          >
            <div
              className={cn(
                'col-span-2 flex flex-wrap items-center gap-2',
                showBranch ? '@3xl:col-span-3' : '@3xl:col-span-2',
              )}
            >
              <span className="text-body-sm font-medium text-ink">{t('journal.total')}</span>
              {totals.balanced ? (
                <Pill tone="good" icon={CheckmarkCircle02Icon}>
                  {t('journal.balanced')}
                </Pill>
              ) : (
                out.side !== null && (
                  <Pill tone="crit" icon={AlertCircleIcon}>
                    {t('journal.outBy', { amount: format.money(out.amount, { decimals: 2 }) })}
                  </Pill>
                )
              )}
            </div>
            <span className="text-right text-body-sm font-medium tabular-nums">
              <span className="text-ink-3 @3xl:sr-only">{t('journal.debit')} </span>
              {format.money(totals.debit, { decimals: 2 })}
            </span>
            <span className="text-right text-body-sm font-medium tabular-nums">
              <span className="text-ink-3 @3xl:sr-only">{t('journal.credit')} </span>
              {format.money(totals.credit, { decimals: 2 })}
            </span>
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {entry && (
            // Left, away from Post. Two clicks: a deleted draft cannot come back.
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(entry);
                  else setConfirming(true);
                }}
              >
                {confirming ? t('journal.confirmDelete') : t('journal.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('journal.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('journal.saveDraft')}
          </Button>
          <Button
            disabled={isSubmitting || !canPost || !totals.balanced}
            onClick={() => void save(true)()}
          >
            {isSubmitting ? t('journal.posting') : t('journal.post')}
          </Button>
        </div>
        {(!canPost || !totals.balanced) && (
          <p className="text-right text-label text-ink-3">
            {canPost ? t('journal.postHint') : t('journal.cantPost')}
          </p>
        )}
      </form>
    </div>
  );
}
