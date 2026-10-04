import {
  Archive02Icon,
  PlusSignIcon,
  TextIcon,
  CheckmarkCircle02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createCustomFieldInputSchema,
  CUSTOM_FIELD_COLUMN_PREFIX,
  CUSTOM_FIELD_TYPES,
  type CustomFieldDefinition,
  errorCode,
  isCustomFieldType,
  routes,
  updateCustomFieldInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  PageHeader,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { productFieldsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<CustomFieldDefinition>();

// The choices are typed one per line in a text area; the API takes a list. Blank lines are
// dropped here, so a trailing Enter never becomes an empty choice.
function choicesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// "Generic name" → "generic_name": a key suggested from the label while the key was not typed
// by hand. Letters outside a–z (a Bangla label) leave nothing to suggest; the person types it.
function keyOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40);
}

// The form's own shape: the choices as one text. Built from the contract's shape (not .extend():
// the contract's rule "a select needs a choice" is a refinement, and is checked again below).
const newFieldSchema = z
  .object({ ...createCustomFieldInputSchema.shape, options: z.string() })
  .superRefine((values, ctx) => {
    if (values.type === 'select' && choicesOf(values.options).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: errorCode('custom_field_options_required'),
      });
    }
  });
// Typed by the schema, so 'product' and 'text' stay the literals the schema wants
const NEW_FIELD: z.input<typeof newFieldSchema> = {
  entity: 'product',
  key: '',
  label: '',
  type: 'text',
  options: '',
  required: false,
};
const editFieldSchema = updateCustomFieldInputSchema.extend({ options: z.string() });
const NEW_FIELDS = ['key', 'label', 'type', 'options', 'required'] as const;
const EDIT_FIELDS = ['label', 'options', 'required'] as const;

function useRefresh() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['products', tenantId] });
}

function NewFieldForm({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm({
    resolver: zodResolver(newFieldSchema, { error: contractErrorMap }),
    defaultValues: NEW_FIELD,
  });
  const type = useWatch({ control, name: 'type' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.customFields.create, {
        body: { ...values, options: choicesOf(values.options) },
      });
      await refresh();
      toast(t('customFields.created', { label: saved.label }));
      onDone();
    } catch (error) {
      applyApiError(error, NEW_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('customFields.newTitle')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="field-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('customFields.add')}
          </Button>
        </>
      }
    >
      <form
        id="field-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <TextField
          label={t('customFields.label')}
          placeholder={t('customFields.labelPlaceholder')}
          {...register('label', {
            onChange: (event: ChangeEvent<HTMLInputElement>) => {
              if (!dirtyFields.key) setValue('key', keyOf(event.target.value));
            },
          })}
          error={errors.label?.message}
        />
        <TextField
          label={t('customFields.key')}
          hint={t('customFields.keyHint')}
          prefix={CUSTOM_FIELD_COLUMN_PREFIX}
          spellCheck={false}
          {...register('key')}
          error={errors.key?.message}
        />
        <SelectField
          label={t('customFields.type')}
          options={CUSTOM_FIELD_TYPES.map((value) => ({
            value,
            label: t(`customFields.types.${value}`),
          }))}
          {...register('type')}
          error={errors.type?.message}
        />
        {type === 'select' && (
          <TextAreaField
            label={t('customFields.options')}
            hint={t('customFields.optionsHint')}
            placeholder={'Tablet\nCapsule\nSyrup'}
            {...register('options')}
            error={errors.options?.message}
          />
        )}
        {type !== 'boolean' && (
          <Controller
            control={control}
            name="required"
            render={({ field }) => (
              <Checkbox
                id="field-required"
                label={t('customFields.required')}
                checked={field.value}
                onCheckedChange={(checked) => {
                  field.onChange(checked === true);
                }}
              />
            )}
          />
        )}
      </form>
    </DialogContent>
  );
}

function EditFieldForm({ field, onDone }: { field: CustomFieldDefinition; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(editFieldSchema, { error: contractErrorMap }),
    defaultValues: {
      label: field.label,
      options: field.options.join('\n'),
      required: field.required,
      version: field.version,
    },
  });
  const toggle = useMutation({
    mutationFn: () =>
      call(field.archivedAt === null ? routes.customFields.archive : routes.customFields.restore, {
        params: { id: field.id },
        body: { version: field.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'customFields.restoredToast' : 'customFields.archivedToast', {
          label: saved.label,
        }),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.customFields.update, {
        params: { id: field.id },
        body: { ...values, options: choicesOf(values.options) },
      });
      await refresh();
      toast(t('customFields.updated', { label: saved.label }));
      onDone();
    } catch (error) {
      applyApiError(error, EDIT_FIELDS, setError);
    }
  });

  const failure =
    errors.root?.server?.message ??
    (toggle.error instanceof ApiRequestError ? toggle.error.code : undefined);

  return (
    <DialogContent
      title={t('customFields.editTitle', { label: field.label })}
      description={`${CUSTOM_FIELD_COLUMN_PREFIX}${field.key} · ${
        isCustomFieldType(field.type) ? t(`customFields.types.${field.type}`) : field.type
      }`}
      footer={
        <>
          <Button
            variant="secondary"
            className="mr-auto"
            disabled={toggle.isPending}
            onClick={() => {
              toggle.mutate();
            }}
          >
            {field.archivedAt === null ? t('customFields.archive') : t('customFields.restore')}
          </Button>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="field-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="field-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <TextField
          label={t('customFields.label')}
          {...register('label')}
          error={errors.label?.message}
        />
        {field.type === 'select' && (
          <TextAreaField
            label={t('customFields.options')}
            hint={t('customFields.optionsHint')}
            {...register('options')}
            error={errors.options?.message}
          />
        )}
        {field.type !== 'boolean' && (
          <Controller
            control={control}
            name="required"
            render={({ field: required }) => (
              <Checkbox
                id="field-required"
                label={t('customFields.required')}
                checked={required.value}
                onCheckedChange={(checked) => {
                  required.onChange(checked === true);
                }}
              />
            )}
          />
        )}
      </form>
    </DialogContent>
  );
}

type Editing = null | { kind: 'new' } | { kind: 'edit'; field: CustomFieldDefinition };

export function CustomFieldsPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('core.settings.manage');
  const { data: fields, isError } = useQuery(productFieldsQuery(tenantId));
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const visible = useMemo(
    () => fields?.filter((field) => showArchived || field.archivedAt === null),
    [fields, showArchived],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('label', {
          header: t('customFields.columns.field'),
          meta: { card: 'title' },
        }),
        column.accessor('type', {
          header: t('customFields.columns.type'),
          meta: { card: 'subtitle' },
          cell: ({ row }) => {
            const { type, options } = row.original;
            const name = isCustomFieldType(type) ? t(`customFields.types.${type}`) : type;
            return type === 'select' ? `${name}: ${options.join(', ')}` : name;
          },
        }),
        column.accessor('key', {
          header: t('customFields.columns.column'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="font-mono text-caption text-ink-3">
              {CUSTOM_FIELD_COLUMN_PREFIX}
              {getValue()}
            </span>
          ),
        }),
        column.accessor((field) => (field.archivedAt === null ? '' : 'archived'), {
          id: 'state',
          header: '',
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) =>
            row.original.archivedAt !== null ? (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('customFields.archived')}
              </Pill>
            ) : (
              row.original.required && (
                <Pill tone="brand" icon={CheckmarkCircle02Icon}>
                  {t('customFields.requiredPill')}
                </Pill>
              )
            ),
        }),
      ]),
    [t],
  );

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        title={t('customFields.title')}
        description={t('customFields.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing({ kind: 'new' });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('customFields.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!canManage ? (
          <p className="text-body-sm text-ink-3">{t('customFields.readOnly')}</p>
        ) : (
          <span />
        )}
        <Checkbox
          id="fields-show-archived"
          label={t('customFields.showArchived')}
          checked={showArchived}
          onCheckedChange={(checked) => {
            setShowArchived(checked === true);
          }}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('customFields.loadFailed')}</p>}
      {visible && (
        <DataTable
          label={t('customFields.title')}
          data={visible}
          columns={columns}
          getRowId={(field) => field.id}
          onRowClick={
            canManage
              ? (field) => {
                  setEditing({ kind: 'edit', field });
                }
              : undefined
          }
          empty={
            <EmptyState
              icon={TextIcon}
              title={t('customFields.emptyTitle')}
              description={t('customFields.emptyBody')}
            />
          }
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing?.kind === 'new' && (
          <NewFieldForm
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
        {editing?.kind === 'edit' && (
          <EditFieldForm
            key={editing.field.id}
            field={editing.field}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
