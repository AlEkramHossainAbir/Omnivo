import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  DEFAULT_SETTINGS,
  formatDocumentNumber,
  type NumberSeries,
  periodOf,
  routes,
  todayIn,
  updateNumberSeriesInputSchema,
  YEAR_STYLES,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { settingsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<NumberSeries>();
const FIELD_NAMES = updateNumberSeriesInputSchema.keyof().options;
const PADDINGS = [3, 4, 5, 6, 7, 8].map((digits) => ({
  value: String(digits),
  label: String(digits),
}));

function numberSeriesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['number-series', tenantId],
    queryFn: async () => (await call(routes.numberSeries.list)).items,
  });
}

// ফর্ম খোলা অবস্থায় টাইপ করতে করতেই উদাহরণ বদলায়। সার্ভারের নম্বর বানানোর ঠিক একই ফাংশন
// (contracts-এর formatDocumentNumber, periodOf) — তাই প্রিভিউ আর আসল নম্বর কখনো আলাদা হয় না
function SeriesForm({ series, onDone }: { series: NumberSeries; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const settings = useQuery(settingsQuery(tenantId)).data;
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateNumberSeriesInputSchema, { error: contractErrorMap }),
    defaultValues: {
      prefix: series.prefix,
      yearStyle: series.yearStyle,
      padding: series.padding,
      version: series.version,
    },
  });
  const [prefix, yearStyle, padding] = useWatch({
    control,
    name: ['prefix', 'yearStyle', 'padding'],
  });
  const document = t(`numbering.documents.${series.documentType}`);

  // settings এখনো না এলে বাংলাদেশের ডিফল্ট দিয়ে উদাহরণ — ফাঁকা জায়গার চেয়ে ভালো
  const example = formatDocumentNumber(
    { prefix: prefix.trim().toUpperCase(), yearStyle, padding },
    periodOf(
      todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone),
      yearStyle,
      settings?.fiscalYearStartMonth ?? DEFAULT_SETTINGS.fiscalYearStartMonth,
    ),
    1,
  );

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.numberSeries.update, {
        params: { documentType: series.documentType },
        body: values,
      });
      // পুরো তালিকা আবার না এনে শুধু এই রো বদলানো
      queryClient.setQueryData(numberSeriesQuery(tenantId).queryKey, (items) =>
        items?.map((item) => (item.documentType === saved.documentType ? saved : item)),
      );
      toast(t('numbering.saved', { document }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <DialogContent
      title={t('numbering.editTitle', { document })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="series-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="series-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('numbering.prefix')}
          hint={t('numbering.prefixHint')}
          autoCapitalize="characters"
          spellCheck={false}
          {...register('prefix')}
          error={errors.prefix?.message}
        />
        <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
          <SelectField
            label={t('numbering.yearStyle')}
            hint={t('numbering.yearStyleHint')}
            options={YEAR_STYLES.map((style) => ({
              value: style,
              label: t(`numbering.yearStyles.${style}`),
            }))}
            {...register('yearStyle')}
            error={errors.yearStyle?.message}
          />
          <SelectField
            label={t('numbering.padding')}
            options={PADDINGS}
            {...register('padding', { valueAsNumber: true })}
            error={errors.padding?.message}
          />
        </div>
        <p className="rounded-control bg-subtle px-3 py-2.5 text-body-sm text-ink-2">
          {t('numbering.preview')}:{' '}
          <span className="font-mono font-medium text-ink tabular-nums">{example}</span>
        </p>
      </form>
    </DialogContent>
  );
}

export function NumberingPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = useCan()('core.settings.manage');
  const { data, isError } = useQuery({ ...numberSeriesQuery(tenantId), enabled: canManage });
  const [editing, setEditing] = useState<NumberSeries | null>(null);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('documentType', {
          header: t('numbering.columns.document'),
          meta: { card: 'title' },
          cell: ({ getValue }) => (
            <span className="font-medium">{t(`numbering.documents.${getValue()}`)}</span>
          ),
        }),
        column.accessor('yearStyle', {
          header: t('numbering.columns.format'),
          meta: { card: 'subtitle' },
          cell: ({ row }) =>
            `${row.original.prefix} · ${t(`numbering.yearStyles.${row.original.yearStyle}`)}`,
        }),
        column.accessor('nextNumber', {
          header: t('numbering.columns.next'),
          meta: { card: 'trailing', align: 'end' },
          cell: ({ getValue }) => <span className="font-mono tabular-nums">{getValue()}</span>,
        }),
      ]),
    [t],
  );

  return (
    <div className="grid max-w-4xl gap-5">
      <PageHeader title={t('numbering.title')} description={t('numbering.description')} />
      {!canManage && <p className="text-body-sm text-ink-3">{t('settings.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('numbering.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('numbering.title')}
          data={data}
          columns={columns}
          getRowId={(series) => series.documentType}
          onRowClick={setEditing}
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing && (
          <SeriesForm
            key={editing.documentType}
            series={editing}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
