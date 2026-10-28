import {
  Archive02Icon,
  CashierIcon,
  CheckmarkCircle02Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  formatPosNumber,
  moneyAccountIds,
  POS_PAPER_WIDTHS,
  POS_PAYMENT_METHODS,
  POS_REGISTER_STATUSES,
  type PosRegisterListItem,
  posRegisterInputSchema,
  type PosRegisterStatus,
  routes,
  updatePosRegisterInputSchema,
  type Warehouse,
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
  Field,
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
import { type Path, useForm } from 'react-hook-form';
import type { z } from 'zod';

import { failureOf } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { posRegistersQuery } from '../lib/pos-queries';
import { accountsQuery, warehousesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// Step 20a: Settings → POS registers (decision 3). A register is one counter: its code (on every
// receipt number), its warehouse, an account per way of paying, the most discount a cashier may
// give, and its receipt. Like the warehouses page: a data table, and one form dialog for a new
// register and a change. Everyone may read it; pos.register.manage changes it.

const column = dataTableColumns<PosRegisterListItem>();

// One form for both, like the warehouse form: the create schema plus the version. A change sends
// everything but the code, which never changes (20a.1); a new register sends everything but the
// version (1, which the create route never reads).
const formSchema = posRegisterInputSchema.extend({
  version: updatePosRegisterInputSchema.shape.version,
});
type FormValues = z.input<typeof formSchema>;

// The paths the server may name in fieldErrors, typed against the form (accounts.card and so on)
const FIELD_NAMES = [
  'code',
  'name',
  'warehouseId',
  'accounts.cash',
  'accounts.card',
  'accounts.bkash',
  'accounts.nagad',
  'maxDiscountPercent',
  'paperWidth',
  'receiptFooter',
] as const satisfies readonly Path<FormValues>[];

function RegisterForm({
  register: current,
  warehouses,
  onDone,
}: {
  register: PosRegisterListItem | null;
  warehouses: readonly Warehouse[];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const accounts = useQuery(accountsQuery(tenantId)).data;
  // The accounts money goes into: the contracts' own list, the one the API checks against
  // (moneyAccountIds), by code
  const moneyAccounts = useMemo(() => {
    const all = accounts ?? [];
    const ids = moneyAccountIds(all);
    return all
      .filter((account) => ids.has(account.id))
      .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [accounts]);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(formSchema, { error: contractErrorMap }),
    defaultValues: {
      code: current?.code ?? '',
      name: current?.name ?? '',
      // The select starts empty: the warehouse decides the branch, so it is picked on purpose
      warehouseId: current?.warehouseId ?? '',
      accounts: {
        cash: current?.accounts.cash ?? '',
        card: current?.accounts.card ?? '',
        bkash: current?.accounts.bkash ?? '',
        nagad: current?.accounts.nagad ?? '',
      },
      maxDiscountPercent: current?.maxDiscountPercent ?? '',
      paperWidth: current?.paperWidth ?? '80',
      receiptFooter: current?.receiptFooter ?? '',
      version: current?.version ?? 1,
    } satisfies FormValues,
  });

  // The registers page, the POS chooser and the POS sales filter all read ['pos', tenant]
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pos', tenantId] });

  const toggle = useMutation({
    mutationFn: (item: PosRegisterListItem) =>
      call(item.archivedAt === null ? routes.pos.archiveRegister : routes.pos.restoreRegister, {
        params: { id: item.id },
        body: { version: item.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'registers.restoredToast' : 'registers.archivedToast', {
          name: saved.name,
        }),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ code, version, ...fields }) => {
    try {
      const saved = current
        ? await call(routes.pos.updateRegister, {
            params: { id: current.id },
            body: { ...fields, version },
          })
        : await call(routes.pos.createRegister, { body: { ...fields, code } });
      await refresh();
      toast(t(current ? 'registers.updated' : 'registers.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // archive/restore's errors (pos_register_in_use, version_conflict) belong to no field
  const failure = errors.root?.server?.message ?? failureOf(toggle.error);
  const accountOptions = moneyAccounts.map((account) => ({
    value: account.id,
    label: `${account.code} · ${account.name}`,
  }));

  return (
    <DialogContent
      title={current ? t('registers.editTitle', { code: current.code }) : t('registers.newTitle')}
      footer={
        <>
          {current && (
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(current);
              }}
            >
              {current.archivedAt === null ? t('registers.archive') : t('registers.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="register-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : current ? t('common.save') : t('registers.add')}
          </Button>
        </>
      }
    >
      <form
        id="register-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          {current ? (
            // Decision 16: the code is on every receipt the register printed, so it is shown,
            // not offered as a box
            <Field id="register-code" label={t('registers.code')} hint={t('registers.codeLocked')}>
              <p id="register-code" className="py-2.5 font-mono text-body">
                {current.code}
              </p>
            </Field>
          ) : (
            <TextField
              label={t('registers.code')}
              hint={t('registers.codeHint')}
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="POS1"
              {...register('code')}
              error={errors.code?.message}
            />
          )}
          <TextField
            label={t('registers.name')}
            icon={CashierIcon}
            placeholder={t('registers.namePlaceholder')}
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <SelectField
          label={t('registers.warehouse')}
          hint={t('registers.warehouseHint')}
          options={[
            { value: '', label: t('registers.warehousePlaceholder') },
            ...warehouses.map((warehouse) => ({
              value: warehouse.id,
              label: `${warehouse.code} · ${warehouse.name}`,
            })),
          ]}
          {...register('warehouseId')}
          error={errors.warehouseId?.message}
        />
        <fieldset className="grid gap-4">
          <legend className="text-label font-medium">{t('registers.accountsTitle')}</legend>
          <p className="-mt-2 text-label text-ink-3">
            {moneyAccounts.length === 0 && accounts
              ? t('registers.noMoneyAccounts')
              : t('registers.accountsHint')}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {POS_PAYMENT_METHODS.map((method) => (
              <SelectField
                key={method}
                label={t(`registers.accounts.${method}`)}
                // Cash is always there (change is given in cash); an empty box = not taken here
                hint={method === 'cash' ? t('registers.cashHint') : undefined}
                options={[
                  {
                    value: '',
                    label:
                      method === 'cash'
                        ? t('registers.accountPlaceholder')
                        : t('registers.notTaken'),
                  },
                  ...accountOptions,
                ]}
                {...register(`accounts.${method}`)}
                error={errors.accounts?.[method]?.message}
              />
            ))}
          </div>
        </fieldset>
        <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
          <TextField
            label={t('registers.maxDiscount')}
            hint={t('registers.maxDiscountHint')}
            inputMode="decimal"
            suffix="%"
            align="end"
            placeholder="10"
            {...register('maxDiscountPercent')}
            error={errors.maxDiscountPercent?.message}
          />
          <SelectField
            label={t('registers.paperWidth')}
            hint={t('registers.paperWidthHint')}
            options={POS_PAPER_WIDTHS.map((width) => ({
              value: width,
              label: t(`registers.paperWidths.${width}`),
            }))}
            {...register('paperWidth')}
            error={errors.paperWidth?.message}
          />
        </div>
        <TextAreaField
          label={t('registers.receiptFooter')}
          optional
          placeholder={t('registers.receiptFooterPlaceholder')}
          {...register('receiptFooter')}
          error={errors.receiptFooter?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | PosRegisterListItem;

export function PosRegistersPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = useCan()('pos.register.manage');
  const [status, setStatus] = useState<PosRegisterStatus>('active');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery({
    ...posRegistersQuery(tenantId, status),
    enabled: me !== null,
  });
  const warehouses = useQuery(warehousesQuery(tenantId, 'active')).data;
  const archivedWarehouses = useQuery(warehousesQuery(tenantId, 'archived')).data;
  const warehouseName = useMemo(
    () =>
      new Map(
        [...(warehouses ?? []), ...(archivedWarehouses ?? [])].map((warehouse) => [
          warehouse.id,
          `${warehouse.code} · ${warehouse.name}`,
        ]),
      ),
    [warehouses, archivedWarehouses],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('registers.columns.register'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <span className="grid h-[30px] min-w-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft px-1 text-[11px] font-semibold text-brand">
                {row.original.code}
              </span>
              <span className="block min-w-0 truncate font-medium">{row.original.name}</span>
            </span>
          ),
        }),
        column.accessor('warehouseId', {
          header: t('registers.columns.warehouse'),
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => warehouseName.get(getValue()) ?? '—',
        }),
        // Decision 14: who holds it, by the device's name and its person, or free
        column.accessor('holder', {
          header: t('registers.columns.holder'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const holder = getValue();
            return holder ? (
              t('registers.holder', { device: holder.deviceName, person: holder.userName })
            ) : (
              <span className="text-ink-3">{t('registers.free')}</span>
            );
          },
        }),
        column.accessor('lastNumber', {
          header: t('registers.columns.lastNumber'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row, getValue }) =>
            getValue() === 0 ? (
              <span className="text-ink-3">{t('registers.noSaleYet')}</span>
            ) : (
              <span className="font-mono tabular-nums">
                {formatPosNumber(row.original.code, getValue())}
              </span>
            ),
        }),
        column.accessor('archivedAt', {
          header: t('registers.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) =>
            getValue() === null ? (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('registers.statuses.active')}
              </Pill>
            ) : (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('registers.statuses.archived')}
              </Pill>
            ),
        }),
      ]),
    [t, warehouseName],
  );

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader
        title={t('registers.title')}
        description={t('registers.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('registers.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label={t('registers.show')}
          value={status}
          options={POS_REGISTER_STATUSES.map((value) => ({
            value,
            label: t(`registers.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
        {!canManage && <p className="text-body-sm text-ink-3">{t('registers.readOnly')}</p>}
      </div>
      {isError && <p className="text-body-sm text-crit">{t('registers.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('registers.title')}
          data={data}
          columns={columns}
          getRowId={(item) => item.id}
          onRowClick={canManage ? setEditing : undefined}
          empty={
            status === 'archived' ? (
              <EmptyState
                icon={Archive02Icon}
                title={t('registers.emptyArchivedTitle')}
                description={t('registers.emptyArchivedBody')}
              />
            ) : (
              <EmptyState
                icon={CashierIcon}
                title={t('registers.emptyTitle')}
                description={t('registers.emptyBody')}
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
        {/* The form opens with the warehouses loaded: its select lists them */}
        {editing !== null && warehouses && (
          <RegisterForm
            key={editing === 'new' ? 'new' : editing.id}
            register={editing === 'new' ? null : editing}
            warehouses={warehouses}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
