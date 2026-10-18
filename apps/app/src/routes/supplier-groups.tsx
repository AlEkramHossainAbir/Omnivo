import { PlusSignIcon, UserGroup02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  type SupplierGroup,
  supplierGroupInputSchema,
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
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { failureOf } from '../components/journal-parts';
import { useTenantId } from '../components/supplier-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { supplierGroupsQuery } from '../lib/queries';

const column = dataTableColumns<SupplierGroup>();
const FIELD_NAMES = supplierGroupInputSchema.keyof().options;

// Step 17a: the supplier's twin of the customer groups page (routes/customer-groups.tsx), for
// groups like Yarn and fabric, Accessories and Packaging. One form for both: a new group (none
// given) and a rename. A rename sends the version the dialog opened with; the name is all a group
// has.
function GroupForm({ group, onDone }: { group: SupplierGroup | null; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(supplierGroupInputSchema, { error: contractErrorMap }),
    defaultValues: { name: group?.name ?? '' },
  });

  // ['suppliers', tenantId]: the list's group column and filter read the groups too
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['suppliers', tenantId] });

  const remove = useMutation({
    mutationFn: (target: SupplierGroup) =>
      call(routes.supplierGroups.remove, {
        params: { id: target.id },
        query: { version: target.version },
      }),
    onSuccess: async (_, target) => {
      await refresh();
      toast(t('supplierGroups.deleted', { name: target.name }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = group
        ? await call(routes.supplierGroups.update, {
            params: { id: group.id },
            body: { ...values, version: group.version },
          })
        : await call(routes.supplierGroups.create, { body: values });
      await refresh();
      toast(t(group ? 'supplierGroups.updated' : 'supplierGroups.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // supplier_group_in_use, version_conflict: they belong to no field
  const failure = errors.root?.server?.message ?? failureOf(remove.error);

  return (
    <DialogContent
      title={
        group ? t('supplierGroups.editTitle', { name: group.name }) : t('supplierGroups.newTitle')
      }
      footer={
        <>
          {group && (
            // Left, away from Save. Two clicks: a deleted group cannot come back.
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={remove.isPending}
              onClick={() => {
                if (confirming) remove.mutate(group);
                else setConfirming(true);
              }}
            >
              {confirming
                ? t('supplierGroups.confirmDelete', { name: group.name })
                : t('supplierGroups.delete')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="supplier-group-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : group ? t('common.save') : t('supplierGroups.add')}
          </Button>
        </>
      }
    >
      <form
        id="supplier-group-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && (
          <p className="text-body-sm text-ink-2">{t('supplierGroups.deleteWarning')}</p>
        )}
        <TextField
          label={t('supplierGroups.name')}
          icon={UserGroup02Icon}
          placeholder={t('supplierGroups.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | SupplierGroup;

export function SupplierGroupsPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const canManage = useCan()('purchase.supplier.manage');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery(supplierGroupsQuery(tenantId));

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('supplierGroups.columns.name'),
          meta: { card: 'title' },
          cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
        }),
        column.accessor('supplierCount', {
          header: t('supplierGroups.columns.suppliers'),
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) =>
            t('supplierGroups.supplierCount', {
              count: getValue(),
              formatted: format.number(getValue()),
            }),
        }),
      ]),
    [t, format],
  );

  return (
    <div className="grid max-w-3xl gap-5">
      <PageHeader
        title={t('supplierGroups.title')}
        description={t('supplierGroups.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('supplierGroups.add')}
            </Button>
          )
        }
      />
      {!canManage && <p className="text-body-sm text-ink-3">{t('supplierGroups.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('supplierGroups.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('supplierGroups.title')}
          data={data}
          columns={columns}
          getRowId={(group) => group.id}
          onRowClick={canManage ? setEditing : undefined}
          empty={
            <EmptyState
              icon={UserGroup02Icon}
              title={t('supplierGroups.emptyTitle')}
              description={t('supplierGroups.emptyBody')}
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
        {editing !== null && (
          <GroupForm
            key={editing === 'new' ? 'new' : editing.id}
            group={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
