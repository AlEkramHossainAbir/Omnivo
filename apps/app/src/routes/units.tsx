import { Archive02Icon, PlusSignIcon, RulerIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createUnitInputSchema,
  isUnitDimension,
  routes,
  type Unit,
  UNIT_DIMENSIONS,
  type UnitDimension,
  updateUnitInputSchema,
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
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { plainFactor } from '../lib/products';
import { unitsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<Unit>();
const CREATE_FIELDS = createUnitInputSchema.keyof().options;
const UPDATE_FIELDS = updateUnitInputSchema.keyof().options;
const DECIMALS = [0, 1, 2, 3, 4] as const;

function failureOf(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

function useRefresh() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  // ['products', tenantId]: the product pages show unit codes too
  return () => queryClient.invalidateQueries({ queryKey: ['products', tenantId] });
}

// "1 yard = 0.9144 m", or "Pack, size set per product"
function SizeLine({ unit }: { unit: Unit }) {
  const { t } = useLocale();
  if (unit.ratio === null || !isUnitDimension(unit.dimension)) return <>{t('units.pack')}</>;
  return (
    <span className="tabular-nums">
      {t('units.sizeLine', {
        code: unit.code,
        ratio: plainFactor(unit.ratio),
        reference: t(`units.references.${unit.dimension}`),
      })}
    </span>
  );
}

function NewUnitForm({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(createUnitInputSchema, { error: contractErrorMap }),
    defaultValues: { code: '', name: '', dimension: 'count', ratio: '', decimals: 0 },
  });
  const dimension: UnitDimension = useWatch({ control, name: 'dimension' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.units.create, { body: values });
      await refresh();
      toast(t('units.created', { code: saved.code }));
      onDone();
    } catch (error) {
      applyApiError(error, CREATE_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('units.newTitle')}
      description={t('units.fixed')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="unit-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('units.add')}
          </Button>
        </>
      }
    >
      <form
        id="unit-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('units.code')}
            hint={t('units.codeHint')}
            spellCheck={false}
            placeholder="pcs"
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField
            label={t('units.name')}
            placeholder={t('units.namePlaceholder')}
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <SelectField
          label={t('units.dimension')}
          options={UNIT_DIMENSIONS.map((value) => ({
            value,
            label: t(`units.dimensions.${value}`),
          }))}
          {...register('dimension')}
          error={errors.dimension?.message}
        />
        <TextField
          label={t('units.ratio')}
          optional
          inputMode="decimal"
          hint={t('units.ratioHint', { reference: t(`units.references.${dimension}`) })}
          suffix={t(`units.references.${dimension}`)}
          {...register('ratio')}
          error={errors.ratio?.message}
        />
        <SelectField
          label={t('units.decimals')}
          hint={t('units.decimalsHint')}
          options={DECIMALS.map((value) => ({ value: String(value), label: String(value) }))}
          {...register('decimals', { valueAsNumber: true })}
          error={errors.decimals?.message}
        />
      </form>
    </DialogContent>
  );
}

function EditUnitForm({ unit, onDone }: { unit: Unit; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateUnitInputSchema, { error: contractErrorMap }),
    defaultValues: {
      code: unit.code,
      name: unit.name,
      decimals: unit.decimals,
      version: unit.version,
    },
  });

  const toggle = useMutation({
    mutationFn: () =>
      call(unit.archivedAt === null ? routes.units.archive : routes.units.restore, {
        params: { id: unit.id },
        body: { version: unit.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'units.restoredToast' : 'units.archivedToast', {
          code: saved.code,
        }),
      );
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.units.remove, { params: { id: unit.id }, query: { version: unit.version } }),
    onSuccess: async () => {
      await refresh();
      toast(t('units.deleted', { code: unit.code }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.units.update, { params: { id: unit.id }, body: values });
      await refresh();
      toast(t('units.updated', { code: saved.code }));
      onDone();
    } catch (error) {
      applyApiError(error, UPDATE_FIELDS, setError);
    }
  });

  const failure =
    errors.root?.server?.message ?? failureOf(toggle.error) ?? failureOf(remove.error);
  const busy = toggle.isPending || remove.isPending;

  return (
    <DialogContent
      title={t('units.editTitle', { code: unit.code })}
      footer={
        <>
          <div className="mr-auto flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                toggle.mutate();
              }}
            >
              {unit.archivedAt === null ? t('units.archive') : t('units.restore')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (confirming) remove.mutate();
                else setConfirming(true);
              }}
            >
              {confirming ? t('units.confirmDelete', { code: unit.code }) : t('units.delete')}
            </Button>
          </div>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="unit-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="unit-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && <p className="text-body-sm text-ink-2">{t('units.deleteWarning')}</p>}
        <p className="text-label text-ink-3">
          {isUnitDimension(unit.dimension)
            ? t(`units.dimensions.${unit.dimension}`)
            : unit.dimension}
          {' · '}
          <SizeLine unit={unit} />
        </p>
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('units.code')}
            spellCheck={false}
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField label={t('units.name')} {...register('name')} error={errors.name?.message} />
        </div>
        <SelectField
          label={t('units.decimals')}
          hint={t('units.decimalsHint')}
          options={DECIMALS.map((value) => ({ value: String(value), label: String(value) }))}
          {...register('decimals', { valueAsNumber: true })}
          error={errors.decimals?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | { kind: 'new' } | { kind: 'edit'; unit: Unit };

export function UnitsPage() {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('inventory.product.manage');
  const { data: units, isError } = useQuery(unitsQuery(tenantId));
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const visible = useMemo(
    () => units?.filter((unit) => showArchived || unit.archivedAt === null),
    [units, showArchived],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('code', {
          header: t('units.columns.unit'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono text-body-sm font-medium">{row.original.code}</span>
              <span className="text-caption text-ink-3">{row.original.name}</span>
            </span>
          ),
        }),
        column.accessor('dimension', {
          header: t('units.columns.measures'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const dimension = getValue();
            return isUnitDimension(dimension) ? t(`units.dimensions.${dimension}`) : dimension;
          },
        }),
        column.accessor((unit) => unit.ratio ?? '', {
          id: 'size',
          header: t('units.columns.size'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => <SizeLine unit={row.original} />,
        }),
        column.accessor('decimals', {
          header: t('units.columns.decimals'),
          meta: { align: 'end', card: 'detail' },
        }),
        column.accessor((unit) => unit.archivedAt ?? '', {
          id: 'archived',
          header: '',
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) =>
            row.original.archivedAt !== null && (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('units.archived')}
              </Pill>
            ),
        }),
      ]),
    [t],
  );

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-5">
      <PageHeader
        title={t('units.title')}
        description={t('units.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing({ kind: 'new' });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('units.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!canManage ? <p className="text-body-sm text-ink-3">{t('units.readOnly')}</p> : <span />}
        <Checkbox
          id="units-show-archived"
          label={t('units.showArchived')}
          checked={showArchived}
          onCheckedChange={(checked) => {
            setShowArchived(checked === true);
          }}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('units.loadFailed')}</p>}
      {visible && (
        <DataTable
          label={t('units.title')}
          data={visible}
          columns={columns}
          getRowId={(unit) => unit.id}
          // A few dozen units: the whole list on the page, no scroll box inside it
          maxHeight={2000}
          onRowClick={
            canManage
              ? (unit) => {
                  setEditing({ kind: 'edit', unit });
                }
              : undefined
          }
          empty={
            <EmptyState
              icon={RulerIcon}
              title={t('units.emptyTitle')}
              description={t('units.emptyBody')}
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
          <NewUnitForm
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
        {editing?.kind === 'edit' && (
          <EditUnitForm
            key={editing.unit.id}
            unit={editing.unit}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
