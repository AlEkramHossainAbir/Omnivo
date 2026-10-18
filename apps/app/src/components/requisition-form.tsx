import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Requisition,
  type RequisitionFormValues,
  routes,
  updateRequisitionInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  DatePicker,
  FormAlert,
  FormField,
  PageHeader,
  SelectField,
  TextAreaField,
  toast,
} from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import {
  type PurchaseLineMeta,
  REQUISITION_LINE_FIELDS,
  savedRequisitionLines,
} from '../lib/purchase';
import { requisitionQuery } from '../lib/queries';
import { PurchaseBackLink, usePurchaseRefresh } from './purchase-parts';
import { useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The requisition form (step 17a): its own chunk (loaded by routes/requisition.tsx), because the
// form library and the date picker are only needed to write.

// The line editor as a chunk of its own, loaded as the form opens: it brings decimal.js with its
// money box, and the product picker
const PurchaseLinesEditor = lazy(async () => ({
  default: (await import('./purchase-lines-editor')).PurchaseLinesEditor,
}));

// The server's field names for the errors it can send: one set per line
function fieldNames(lineCount: number): Path<RequisitionFormValues>[] {
  return [
    'date',
    'warehouseId',
    'neededBy',
    'note',
    'lines',
    ...Array.from({ length: lineCount }, (_, index) =>
      REQUISITION_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
    ).flat(),
  ];
}

// Writing a new requisition, or changing a draft. It gets its number on the first save
// (decision 19), and is submitted for approval from its page.
export function RequisitionForm({
  requisition,
  today,
  onClose,
}: {
  requisition: Requisition | null;
  today: string;
  // Back to the requisition's page (an edit); a new requisition goes to its page instead
  onClose?: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = usePurchaseRefresh();
  const { active, byId } = useWarehouses();
  const [start] = useState(() =>
    requisition
      ? savedRequisitionLines(requisition.lines)
      : { values: [], meta: [] as PurchaseLineMeta[] },
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateRequisitionInputSchema, { error: contractErrorMap }),
    defaultValues: {
      date: requisition?.date ?? today,
      warehouseId: requisition?.warehouseId ?? '',
      neededBy: requisition?.neededBy ?? '',
      note: requisition?.note ?? '',
      lines: start.values,
      // A new requisition has no version; 1 passes the schema, and the create route never reads it
      version: requisition?.version ?? 1,
    },
  });

  // The active warehouses, and the requisition's own if it was archived since: the server keeps
  // it on a save (17a.4), so the select must not drop it
  const own = requisition ? byId.get(requisition.warehouseId) : undefined;
  const warehouses = [...(active ?? []), ...(own && own.archivedAt !== null ? [own] : [])];

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = requisition
        ? await call(routes.requisitions.update, {
            params: { id: requisition.id },
            body: { ...values, version },
          })
        : await call(routes.requisitions.create, { body: values });
      queryClient.setQueryData(requisitionQuery(tenantId, saved.id).queryKey, saved);
      await refresh();
      toast(t('requisitions.saved', { number: saved.number }));
      if (requisition) onClose?.();
      else {
        void navigate({
          to: '/requisitions/$requisitionId',
          params: { requisitionId: saved.id },
          replace: true,
        });
      }
    } catch (error) {
      applyApiError(error, fieldNames(getValues('lines').length), setError);
    }
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PurchaseBackLink to="/requisitions" label={t('requisitions.back')} />
      <PageHeader
        title={requisition ? requisition.number : t('requisitions.newTitle')}
        description={t('requisitions.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-[13rem_minmax(0,1fr)_13rem]">
          <FormField control={control} name="date" label={t('requisitions.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <SelectField
            label={t('requisitions.warehouse')}
            hint={t('requisitions.warehouseHint')}
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...warehouses.map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <FormField
            control={control}
            name="neededBy"
            label={t('requisitions.neededBy')}
            optional
            hint={t('requisitions.neededByHint')}
          >
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
          </FormField>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextAreaField
              label={t('requisitions.note')}
              optional
              placeholder={t('requisitions.notePlaceholder')}
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
              <PurchaseLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={start.meta}
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
            {isSubmitting ? t('common.saving') : t('requisitions.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
