import { zodResolver } from '@hookform/resolvers/zod';
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  contractErrorMap,
  EXPORT_FORMATS,
  isExportFormat,
  MAX_REPORT_SCHEDULE_RECIPIENTS,
  type ReportExportInput,
  type ReportKind,
  type ReportSchedule,
  reportScheduleFiltersOf,
  REPORT_SCHEDULE_FREQUENCIES,
  reportScheduleUpdateSchema,
  type ReportScheduleWhen,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  CheckboxGroup,
  type CheckboxOption,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  SelectField,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import {
  reportScheduleCandidatesQuery,
  SCHEDULE_HOURS,
  useScheduleWords,
  WEEKDAY_KEYS,
} from '../lib/report-schedules';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 21c: the dialog that makes a scheduled report email (from a report's Export menu) or changes
// one (from the scheduled emails page). A lazy chunk: the report pages load it only when someone
// picks "Email on a schedule".

// The names of the page's filters, for the lines the dialog shows. The page knows them from its own
// selects; a saved schedule has them from the API (filterNames). Absent = not set.
export interface ScheduleFilterNames {
  branch?: string | undefined;
  warehouse?: string | undefined;
  group?: string | undefined;
  category?: string | undefined;
}

export type ReportScheduleTarget =
  // A new schedule: the export the page would ask for, with the page's filters and dates. The API
  // keeps only the filters (reportScheduleFiltersOf); the report's own schema checks them.
  | { kind: 'new'; request: ReportExportInput; names: ScheduleFilterNames }
  // A saved one: its report and filters stay (decision 10), so only these fields change
  | { kind: 'edit'; schedule: ReportSchedule; report: ReportKind };

// The aging and the balance sheet show one day: the last of the period (decision 8). satisfies: a
// new report does not compile until someone says which it is.
const SHOWS_ONE_DAY = {
  trial_balance: false,
  profit_and_loss: false,
  balance_sheet: true,
  sales_report: false,
  purchase_report: false,
  ar_aging: true,
  ap_aging: true,
  vat_report: false,
  stock_movement: false,
} as const satisfies Record<ReportKind, boolean>;

const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, index) => index + 1);

// The form is flat: one box per field, whatever the frequency. The contract's `when` is a union
// (a weekly schedule cannot lack its day), so whenOf() builds it from the boxes that frequency
// uses. The numbers come from the selects with valueAsNumber, so they are numbers here.
const scheduleFormSchema = z.object({
  format: z.enum(EXPORT_FORMATS),
  frequency: z.enum(REPORT_SCHEDULE_FREQUENCIES),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6),
  dayOfMonth: z.number().int().min(1).max(28),
  // The contract's own rule: 1 to 10 people, no one twice
  recipientIds: reportScheduleUpdateSchema.shape.recipientIds,
});
type ScheduleForm = z.infer<typeof scheduleFormSchema>;

const FORM_FIELDS = scheduleFormSchema.keyof().options;

function whenOf(values: ScheduleForm): ReportScheduleWhen {
  switch (values.frequency) {
    case 'daily':
      return { frequency: 'daily', hour: values.hour };
    case 'weekly':
      return { frequency: 'weekly', hour: values.hour, weekday: values.weekday };
    case 'monthly':
      return { frequency: 'monthly', hour: values.hour, dayOfMonth: values.dayOfMonth };
  }
}

// What the form opens with. A new schedule: weekly on Sunday at 08:00 (decision 8's defaults),
// Excel, nobody yet. A saved one: its own values; the boxes its frequency does not use keep the
// defaults, so switching to them shows a sensible day. Someone who may not read the report any
// more starts unticked: the API would refuse them (decision 55).
function defaultsOf(target: ReportScheduleTarget): ScheduleForm {
  const blank = {
    format: 'xlsx',
    frequency: 'weekly',
    hour: 8,
    weekday: 0,
    dayOfMonth: 1,
    recipientIds: [],
  } as const satisfies ScheduleForm;
  if (target.kind === 'new') return { ...blank, recipientIds: [] };
  const { schedule } = target;
  const { when } = schedule;
  return {
    format: isExportFormat(schedule.format) ? schedule.format : blank.format,
    frequency: when.frequency,
    hour: when.hour,
    weekday: when.frequency === 'weekly' ? when.weekday : blank.weekday,
    dayOfMonth: when.frequency === 'monthly' ? when.dayOfMonth : blank.dayOfMonth,
    recipientIds: schedule.recipients.filter((item) => item.canReceive).map((item) => item.userId),
  };
}

function ScheduleForm({ target, onDone }: { target: ReportScheduleTarget; onDone: () => void }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const queryClient = useQueryClient();
  const words = useScheduleWords();
  const report = target.kind === 'new' ? target.request.report : target.report;
  const candidates = useQuery(reportScheduleCandidatesQuery(tenantId, report));

  const {
    register,
    control,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(scheduleFormSchema, { error: contractErrorMap }),
    defaultValues: defaultsOf(target),
  });
  const frequency = watch('frequency');

  // The filter lines: a new schedule's from the page (its query and its selects' names), a saved
  // one's from the API. The same function as the list, so the two always say the same thing.
  const filterLines =
    target.kind === 'new'
      ? words.filterLines({
          report,
          filters: reportScheduleFiltersOf(target.request.query),
          filterNames: {
            branch: target.names.branch ?? null,
            warehouse: target.names.warehouse ?? null,
            group: target.names.group ?? null,
            category: target.names.category ?? null,
          },
        })
      : words.filterLines(target.schedule);

  // The people to pick from. On a saved schedule, someone on it who may not read the report now
  // is still listed, disabled and unticked, with why: so the editor sees who stops getting it.
  const recipientOptions: CheckboxOption[] = [
    ...(candidates.data?.items ?? []).map((person) => ({
      value: person.userId,
      label: (
        <span className="grid">
          <span className="font-medium text-ink">{person.name}</span>
          <span className="text-caption text-ink-3">{person.email}</span>
        </span>
      ),
    })),
    ...(target.kind === 'edit'
      ? target.schedule.recipients
          .filter((person) => !person.canReceive)
          .map((person) => ({
            value: person.userId,
            disabled: true,
            label: (
              <span className="grid">
                <span className="font-medium text-ink-2">{person.name}</span>
                <span className="text-caption text-ink-3">{person.email}</span>
                <span className="mt-0.5 flex items-center gap-1 text-caption font-medium text-warn">
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    size={13}
                    strokeWidth={1.5}
                    className="shrink-0"
                  />
                  {t('reportSchedules.cannotReceive')}
                </span>
              </span>
            ),
          }))
      : []),
  ];
  // Nobody may read the report: the form says where to fix that, and has nothing to save
  const nobody = candidates.isSuccess && candidates.data.items.length === 0;

  const onSubmit = handleSubmit(async (values) => {
    const when = whenOf(values);
    try {
      const saved =
        target.kind === 'new'
          ? await call(routes.reportSchedules.create, {
              body: {
                ...target.request,
                format: values.format,
                when,
                recipientIds: values.recipientIds,
              },
            })
          : await call(routes.reportSchedules.update, {
              params: { id: target.schedule.id },
              body: {
                format: values.format,
                when,
                recipientIds: values.recipientIds,
                version: target.schedule.version,
              },
            });
      await queryClient.invalidateQueries({ queryKey: ['report-schedules', tenantId] });
      const name = words.report(report);
      toast(
        target.kind === 'new'
          ? t('reportSchedules.created', {
              report: name,
              // A new schedule is active, so it has its first run
              date:
                saved.nextRunAt === null
                  ? ''
                  : format.dateTime(new Date(saved.nextRunAt), timeZone),
            })
          : t('reportSchedules.updated', { report: name }),
      );
      onDone();
    } catch (error) {
      applyApiError(error, FORM_FIELDS, setError);
    }
  });

  const name = words.report(report);
  const periodHint = [
    t(`reportSchedules.periods.${frequency}`),
    SHOWS_ONE_DAY[report] && t('reportSchedules.asOfHint'),
    t('reportSchedules.hourHint', { timeZone }),
  ]
    .filter((line) => line !== false)
    .join(' ');

  return (
    <DialogContent
      title={
        target.kind === 'new'
          ? t('reportSchedules.newTitle', { report: name })
          : t('reportSchedules.editTitle', { report: name })
      }
      description={t('reportSchedules.newDescription')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          {!nobody && (
            <Button type="submit" form="report-schedule-form" disabled={isSubmitting}>
              {isSubmitting
                ? t('common.saving')
                : target.kind === 'new'
                  ? t('reportSchedules.create')
                  : t('reportSchedules.save')}
            </Button>
          )}
        </>
      }
    >
      <form
        id="report-schedule-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {/* The filters are shown, never edited (decision 10) */}
        <div className="grid gap-1.5">
          <span className="text-label font-medium text-ink">{t('reportSchedules.filters')}</span>
          <ul className="grid gap-0.5 rounded-control bg-subtle px-3.5 py-3 text-body-sm text-ink-2">
            {filterLines.length === 0 ? (
              <li>{t('reportSchedules.noFilters')}</li>
            ) : (
              filterLines.map((line) => <li key={line}>{line}</li>)
            )}
          </ul>
          <p className="text-label text-ink-3">
            {target.kind === 'new'
              ? t('reportSchedules.filtersHint')
              : t('reportSchedules.fixedHint')}
          </p>
        </div>
        <SelectField
          label={t('reportSchedules.format')}
          options={EXPORT_FORMATS.map((value) => ({
            value,
            label: t(`reports.export.${value}`),
          }))}
          {...register('format')}
          error={errors.format?.message}
        />
        <div className="grid gap-1.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.2fr_1fr_0.8fr]">
            <SelectField
              label={t('reportSchedules.frequency')}
              options={REPORT_SCHEDULE_FREQUENCIES.map((value) => ({
                value,
                label: t(`reportSchedules.frequencies.${value}`),
              }))}
              {...register('frequency')}
            />
            {/* Only the box the frequency uses: daily needs no day */}
            {frequency === 'weekly' && (
              <SelectField
                label={t('reportSchedules.weekday')}
                options={WEEKDAY_KEYS.map((key, index) => ({
                  value: String(index),
                  label: t(`reportSchedules.weekdays.${key}`),
                }))}
                {...register('weekday', { valueAsNumber: true })}
              />
            )}
            {frequency === 'monthly' && (
              <SelectField
                label={t('reportSchedules.dayOfMonth')}
                options={DAYS_OF_MONTH.map((day) => ({
                  value: String(day),
                  label: format.number(day),
                }))}
                {...register('dayOfMonth', { valueAsNumber: true })}
              />
            )}
            <SelectField
              label={t('reportSchedules.hour')}
              options={SCHEDULE_HOURS.map((hour) => ({
                value: String(hour),
                label: words.hour(hour),
              }))}
              {...register('hour', { valueAsNumber: true })}
            />
          </div>
          <p className="text-label text-ink-3">
            {periodHint}
            {frequency === 'monthly' && ` ${t('reportSchedules.dayOfMonthHint')}`}
          </p>
        </div>
        {nobody ? (
          <p className="text-body-sm text-ink-2">{t('reportSchedules.noCandidates')}</p>
        ) : (
          candidates.isSuccess && (
            <Controller
              control={control}
              name="recipientIds"
              render={({ field }) => (
                <CheckboxGroup
                  legend={t('reportSchedules.recipients')}
                  options={recipientOptions}
                  value={field.value}
                  onChange={field.onChange}
                  hint={t('reportSchedules.recipientsHint', {
                    count: MAX_REPORT_SCHEDULE_RECIPIENTS,
                  })}
                  error={errors.recipientIds?.message}
                />
              )}
            />
          )
        )}
        {candidates.isError && <FormAlert message="unknown_error" />}
      </form>
    </DialogContent>
  );
}

// The dialog itself. Closing it any way drops what was typed: the next open starts again.
export function ReportScheduleDialog({
  target,
  onClose,
}: {
  target: ReportScheduleTarget;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ScheduleForm target={target} onDone={onClose} />
    </Dialog>
  );
}
