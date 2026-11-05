import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Quotation,
  type QuotationFormValues,
  routes,
  updateQuotationInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  FormAlert,
  DatePicker,
  FormField,
  PageHeader,
  TextField,
  toast,
} from '@omnivo/ui';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { type LineMeta, SALES_LINE_FIELDS, savedLines } from '../lib/sales';
import { CustomerPicker } from './customer-picker';
import { SalesBackLink, useSalesRefresh } from './sales-parts';

// The quotation form: its own chunk (loaded by routes/quotation.tsx), because the form library, the
// date picker and the line editor are only needed to write.

// The line editor as a chunk of its own, loaded as the form opens: it brings decimal.js with its
// money and discount boxes (cost-input.tsx says the same of the adjustment form), and inside this
// chunk it took the form over its 100 KB budget
const SalesLinesEditor = lazy(async () => ({
  default: (await import('./sales-line-editor')).SalesLinesEditor,
}));

type FormValues = QuotationFormValues;

// The server's field names for the errors it can send: one set per line
function fieldNames(lineCount: number): Path<FormValues>[] {
  return [
    'customerId',
    'date',
    'validUntil',
    'note',
    'lines',
    ...Array.from({ length: lineCount }, (_, index) =>
      SALES_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
    ).flat(),
  ];
}

// Writing a new quotation, or changing an open one. It gets its number on the first save.
export function QuotationForm({
  quotation,
  today,
  pricesIncludeVat,
  onClose,
}: {
  quotation: Quotation | null;
  today: string;
  // The quotation's own copy of the setting, or the workspace's now for a new one
  pricesIncludeVat: boolean;
  // Back to the quotation's page (an edit); a new quotation goes to its page instead
  onClose?: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const refresh = useSalesRefresh();
  const [start] = useState(() =>
    quotation
      ? savedLines(quotation.lines, quotation.customer.id)
      : { values: [], meta: [] as LineMeta[] },
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateQuotationInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: quotation?.customer.id ?? '',
      date: quotation?.date ?? today,
      validUntil: quotation?.validUntil ?? '',
      note: quotation?.note ?? '',
      lines: start.values,
      // A new quotation has no version; 1 passes the schema, and the create route never reads it
      version: quotation?.version ?? 1,
    },
  });
  const customerId = useWatch({ control, name: 'customerId' });
  const lineCount = useWatch({ control, name: 'lines' }).length;

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = quotation
        ? await call(routes.quotations.update, {
            params: { id: quotation.id },
            body: { ...values, version },
          })
        : await call(routes.quotations.create, { body: values });
      await refresh();
      toast(t('quotations.saved', { number: saved.number }));
      if (quotation) onClose?.();
      else {
        void navigate({
          to: '/quotations/$quotationId',
          params: { quotationId: saved.id },
          replace: true,
        });
      }
    } catch (error) {
      applyApiError(error, fieldNames(lineCount), setError);
    }
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/quotations" label={t('quotations.back')} />
      <PageHeader
        title={quotation ? quotation.number : t('quotations.newTitle')}
        description={t('quotations.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-[minmax(0,1.6fr)_13rem_13rem]">
          <FormField control={control} name="customerId" label={t('quotations.customer')}>
            {(field) => (
              <CustomerPicker
                {...field}
                saved={quotation?.customer ?? null}
                aria-label={t('quotations.customer')}
              />
            )}
          </FormField>
          <FormField control={control} name="date" label={t('quotations.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <FormField
            control={control}
            name="validUntil"
            label={t('quotations.validUntil')}
            optional
            hint={t('quotations.validUntilHint')}
          >
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
          </FormField>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('quotations.note')}
              optional
              placeholder={t('quotations.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Controller
          control={control}
          name="lines"
          render={({ field }) => (
            <Suspense fallback={<Card className="min-h-24" />}>
              <SalesLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={start.meta}
                customerId={customerId}
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.lines}
              />
            </Suspense>
          )}
        />

        <div className="flex flex-wrap items-center justify-end gap-2">
          {onClose && (
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('quotations.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
