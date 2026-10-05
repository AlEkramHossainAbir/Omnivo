import {
  Archive02Icon,
  CheckmarkCircle02Icon,
  PlusSignIcon,
  WarehouseIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Branch,
  contractErrorMap,
  routes,
  updateWarehouseInputSchema,
  type Warehouse,
  WAREHOUSE_STATUSES,
  type WarehouseStatus,
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
  PageHeader,
  Pill,
  SegmentedControl,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { failureOf } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { branchesQuery, warehousesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<Warehouse>();
const FIELD_NAMES = updateWarehouseInputSchema.keyof().options;

// One form for both: a new warehouse (none given) and a change. Like the branch form, version 1
// for a new one passes the schema, and the create route never reads it.
function WarehouseForm({
  warehouse,
  branches,
  onDone,
}: {
  warehouse: Warehouse | null;
  branches: readonly Branch[];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateWarehouseInputSchema, { error: contractErrorMap }),
    defaultValues: {
      // A new warehouse goes to the first branch unless the person picks another
      branchId: warehouse?.branchId ?? branches[0]?.id ?? '',
      code: warehouse?.code ?? '',
      name: warehouse?.name ?? '',
      address: warehouse?.address ?? '',
      version: warehouse?.version ?? 1,
    },
  });

  // The warehouse lists and every stock page show warehouses: both prefixes refresh
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['warehouses', tenantId] });
    await queryClient.invalidateQueries({ queryKey: ['stock', tenantId] });
  };

  const toggle = useMutation({
    mutationFn: (current: Warehouse) =>
      call(current.archivedAt === null ? routes.warehouses.archive : routes.warehouses.restore, {
        params: { id: current.id },
        body: { version: current.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'warehouses.restoredToast' : 'warehouses.archivedToast', {
          name: saved.name,
        }),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = warehouse
        ? await call(routes.warehouses.update, {
            params: { id: warehouse.id },
            body: { ...fields, version },
          })
        : await call(routes.warehouses.create, { body: fields });
      await refresh();
      toast(t(warehouse ? 'warehouses.updated' : 'warehouses.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // archive/restore's errors (warehouse_has_stock, version_conflict) belong to no field
  const failure = errors.root?.server?.message ?? failureOf(toggle.error);

  return (
    <DialogContent
      title={
        warehouse ? t('warehouses.editTitle', { code: warehouse.code }) : t('warehouses.newTitle')
      }
      footer={
        <>
          {warehouse && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(warehouse);
              }}
            >
              {warehouse.archivedAt === null ? t('warehouses.archive') : t('warehouses.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="warehouse-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : warehouse ? t('common.save') : t('warehouses.add')}
          </Button>
        </>
      }
    >
      <form
        id="warehouse-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('warehouses.code')}
            hint={t('warehouses.codeHint')}
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="FG"
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField
            label={t('warehouses.name')}
            icon={WarehouseIcon}
            placeholder="Finished goods store"
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <SelectField
          label={t('warehouses.branch')}
          options={branches.map((branch) => ({
            value: branch.id,
            label: `${branch.code} · ${branch.name}`,
          }))}
          {...register('branchId')}
          error={errors.branchId?.message}
        />
        <TextAreaField
          label={t('warehouses.address')}
          optional
          placeholder="Shed 3, BSCIC Industrial Area, Konabari, Gazipur 1751"
          {...register('address')}
          error={errors.address?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | Warehouse;

export function WarehousesPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = useCan()('inventory.warehouse.manage');
  const [status, setStatus] = useState<WarehouseStatus>('active');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery({
    ...warehousesQuery(tenantId, status),
    enabled: me !== null,
  });
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const archivedBranches = useQuery(branchesQuery(tenantId, 'archived')).data;
  const branchName = useMemo(
    () =>
      new Map(
        [...(branches ?? []), ...(archivedBranches ?? [])].map((branch) => [
          branch.id,
          `${branch.code} · ${branch.name}`,
        ]),
      ),
    [branches, archivedBranches],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('warehouses.columns.warehouse'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span className="grid h-[30px] min-w-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft px-1 text-[11px] font-semibold text-brand">
                {row.original.code}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{row.original.name}</span>
                {row.original.address && (
                  <span className="block truncate text-caption text-ink-3">
                    {row.original.address}
                  </span>
                )}
              </span>
            </span>
          ),
        }),
        column.accessor('branchId', {
          header: t('warehouses.columns.branch'),
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => branchName.get(getValue()) ?? '—',
        }),
        column.accessor('archivedAt', {
          header: t('warehouses.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) =>
            getValue() === null ? (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('warehouses.statuses.active')}
              </Pill>
            ) : (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('warehouses.statuses.archived')}
              </Pill>
            ),
        }),
      ]),
    [t, branchName],
  );

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader
        title={t('warehouses.title')}
        description={t('warehouses.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('warehouses.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label={t('warehouses.show')}
          value={status}
          options={WAREHOUSE_STATUSES.map((value) => ({
            value,
            label: t(`warehouses.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
        {!canManage && <p className="text-body-sm text-ink-3">{t('warehouses.readOnly')}</p>}
      </div>
      {isError && <p className="text-body-sm text-crit">{t('warehouses.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('warehouses.title')}
          data={data}
          columns={columns}
          getRowId={(warehouse) => warehouse.id}
          onRowClick={canManage ? setEditing : undefined}
          empty={
            status === 'archived' ? (
              <EmptyState
                icon={Archive02Icon}
                title={t('warehouses.emptyArchivedTitle')}
                description={t('warehouses.emptyArchivedBody')}
              />
            ) : (
              <EmptyState
                icon={WarehouseIcon}
                title={t('warehouses.emptyTitle')}
                description={t('warehouses.emptyBody')}
              />
            )
          }
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {/* The form opens with the branches loaded: a new warehouse starts in the first one */}
        {editing !== null && branches && (
          <WarehouseForm
            key={editing === 'new' ? 'new' : editing.id}
            warehouse={editing === 'new' ? null : editing}
            branches={branches}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
