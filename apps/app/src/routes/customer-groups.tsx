import { PlusSignIcon, UserGroup03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type CustomerGroup,
  customerGroupInputSchema,
  routes,
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
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { customerGroupsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<CustomerGroup>();
const FIELD_NAMES = customerGroupInputSchema.keyof().options;

// One form for both: a new group (none given) and a rename. A rename sends the version the dialog
// opened with; the name is all a group has.
function GroupForm({ group, onDone }: { group: CustomerGroup | null; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(customerGroupInputSchema, { error: contractErrorMap }),
    defaultValues: { name: group?.name ?? '' },
  });

  // ['customers', tenantId]: the list's group column and filter read the groups too
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['customers', tenantId] });

  const remove = useMutation({
    mutationFn: (target: CustomerGroup) =>
      call(routes.customerGroups.remove, {
        params: { id: target.id },
        query: { version: target.version },
      }),
    onSuccess: async (_, target) => {
      await refresh();
      toast(t('customerGroups.deleted', { name: target.name }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = group
        ? await call(routes.customerGroups.update, {
            params: { id: group.id },
            body: { ...values, version: group.version },
          })
        : await call(routes.customerGroups.create, { body: values });
      await refresh();
      toast(t(group ? 'customerGroups.updated' : 'customerGroups.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // customer_group_in_use, version_conflict: they belong to no field
  const failure = errors.root?.server?.message ?? failureOf(remove.error);

  return (
    <DialogContent
      title={
        group ? t('customerGroups.editTitle', { name: group.name }) : t('customerGroups.newTitle')
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
                ? t('customerGroups.confirmDelete', { name: group.name })
                : t('customerGroups.delete')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="customer-group-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : group ? t('common.save') : t('customerGroups.add')}
          </Button>
        </>
      }
    >
      <form
        id="customer-group-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && (
          <p className="text-body-sm text-ink-2">{t('customerGroups.deleteWarning')}</p>
        )}
        <TextField
          label={t('customerGroups.name')}
          icon={UserGroup03Icon}
          placeholder={t('customerGroups.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | CustomerGroup;

export function CustomerGroupsPage() {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const canManage = useCan()('sales.customer.manage');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery(customerGroupsQuery(tenantId));

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('customerGroups.columns.name'),
          meta: { card: 'title' },
          cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
        }),
        column.accessor('customerCount', {
          header: t('customerGroups.columns.customers'),
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) =>
            t('customerGroups.customerCount', {
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
        title={t('customerGroups.title')}
        description={t('customerGroups.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('customerGroups.add')}
            </Button>
          )
        }
      />
      {!canManage && <p className="text-body-sm text-ink-3">{t('customerGroups.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('customerGroups.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('customerGroups.title')}
          data={data}
          columns={columns}
          getRowId={(group) => group.id}
          onRowClick={canManage ? setEditing : undefined}
          empty={
            <EmptyState
              icon={UserGroup03Icon}
              title={t('customerGroups.emptyTitle')}
              description={t('customerGroups.emptyBody')}
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
