import {
  Archive02Icon,
  CheckmarkCircle02Icon,
  MoneyAdd01Icon,
  MoneyExchange03Icon,
  MoneyRemove01Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  contractErrorMap,
  isPartyAccountPurpose,
  POS_CASH_DIRECTIONS,
  POS_CASH_REASON_STATUSES,
  type PosCashDirection,
  type PosCashReason,
  posCashReasonInputSchema,
  routes,
  type StockAccounts,
  updatePosCashReasonInputSchema,
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
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { type Path, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { failureOf } from '../components/journal-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { posCashReasonsQuery } from '../lib/pos-queries';
import { accountsQuery, stockAccountsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

// Step 20b: Settings → POS cash reasons (decisions 4 and 67). Why a cashier puts money into the
// drawer or takes it out, and the account on the other side. The device copies the active ones
// (the pull's pos_cash_reason rows), so the cashier picks a reason offline and never an account.
// Like the registers page: a data table and one form dialog. Everyone may read it;
// pos.register.manage changes it.

type ReasonStatus = (typeof POS_CASH_REASON_STATUSES)[number];

const column = dataTableColumns<PosCashReason>();

// One form for both: the create schema plus the version. A change sends the name and the account
// (a reason's direction never changes, decision 20); a new reason sends everything but the version.
const formSchema = posCashReasonInputSchema.extend({
  version: updatePosCashReasonInputSchema.shape.version,
});
type FormValues = z.input<typeof formSchema>;

const FIELD_NAMES = [
  'name',
  'direction',
  'accountId',
] as const satisfies readonly Path<FormValues>[];

// A pay in and a pay out look alike at a glance in a list of names; the pill tells them apart. Not
// a status, so neutral, with the shift menu's icons.
const DIRECTION_ICONS = {
  in: MoneyAdd01Icon,
  out: MoneyRemove01Icon,
} as const satisfies Record<PosCashDirection, unknown>;

function DirectionPill({ direction }: { direction: PosCashDirection }) {
  const { t } = useLocale();
  return (
    <Pill tone="neutral" icon={DIRECTION_ICONS[direction]}>
      {t(`posCashReasons.pills.${direction}`)}
    </Pill>
  );
}

// The accounts a reason may name, the API's own rule (pos-cash-reasons.service.ts → checkAccount):
// active, not a group, not the receivable or the payable (a pay out names no customer), and not a
// stock account (the inventory, goods in transit, goods received not billed: cash buys no stock
// here). `keep` stays in the list even when it no longer fits (its account archived since), so the
// select shows it instead of moving to another. By code, like every account select.
function reasonAccounts(
  accounts: readonly Account[],
  stock: StockAccounts | undefined,
  keep: string,
): Account[] {
  const stockIds = new Set([stock?.in_transit, stock?.received_not_billed]);
  return accounts
    .filter(
      (account) =>
        account.id === keep ||
        (!account.isGroup &&
          account.archivedAt === null &&
          !isPartyAccountPurpose(account.purpose) &&
          account.purpose !== 'inventory' &&
          !stockIds.has(account.id)),
    )
    .toSorted((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

function ReasonForm({
  reason: current,
  accounts,
  onDone,
}: {
  reason: PosCashReason | null;
  accounts: readonly Account[];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const stock = useQuery(stockAccountsQuery(tenantId)).data;
  const options = useMemo(
    () => reasonAccounts(accounts, stock, current?.accountId ?? ''),
    [accounts, stock, current],
  );
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(formSchema, { error: contractErrorMap }),
    defaultValues: {
      name: current?.name ?? '',
      // A new workspace's first reason is the float (decision 12): "in" first
      direction: current?.direction ?? 'in',
      // Picked on purpose: a pay out to the wrong account is a wrong expense
      accountId: current?.accountId ?? '',
      version: current?.version ?? 1,
    } satisfies FormValues,
  });
  // The account's hint says where the money comes from or goes to, by the direction picked
  const direction = useWatch({ control, name: 'direction' });

  // The page's list and the reason's own row read ['pos', tenant]
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['pos', tenantId] });

  const toggle = useMutation({
    mutationFn: (item: PosCashReason) =>
      call(
        item.archivedAt === null
          ? routes.posShifts.archiveCashReason
          : routes.posShifts.restoreCashReason,
        { params: { id: item.id }, body: { version: item.version } },
      ),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(
          saved.archivedAt === null
            ? 'posCashReasons.restoredToast'
            : 'posCashReasons.archivedToast',
          {
            name: saved.name,
          },
        ),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, direction: picked, ...fields }) => {
    try {
      const saved = current
        ? await call(routes.posShifts.updateCashReason, {
            params: { id: current.id },
            body: { ...fields, version },
          })
        : await call(routes.posShifts.createCashReason, {
            body: { ...fields, direction: picked },
          });
      await refresh();
      toast(t(current ? 'posCashReasons.updated' : 'posCashReasons.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  // archive/restore's errors (version_conflict; a restore whose account no longer fits,
  // pos_reason_account_invalid) belong to no box of the form
  const failure = errors.root?.server?.message ?? failureOf(toggle.error);

  return (
    <DialogContent
      title={
        current
          ? t('posCashReasons.editTitle', { name: current.name })
          : t('posCashReasons.newTitle')
      }
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
              {current.archivedAt === null
                ? t('posCashReasons.archive')
                : t('posCashReasons.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="cash-reason-form" disabled={isSubmitting}>
            {isSubmitting
              ? t('common.saving')
              : current
                ? t('common.save')
                : t('posCashReasons.add')}
          </Button>
        </>
      }
    >
      <form
        id="cash-reason-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <TextField
          label={t('posCashReasons.name')}
          placeholder={t('posCashReasons.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
        {current ? (
          // Decision 20: shown, not offered. The money it moved keeps its meaning.
          <Field
            id="cash-reason-direction"
            label={t('posCashReasons.direction')}
            hint={t('posCashReasons.directionLocked')}
          >
            <p id="cash-reason-direction" className="py-2.5 text-body">
              {t(`posCashReasons.directions.${current.direction}`)}
            </p>
          </Field>
        ) : (
          <SelectField
            label={t('posCashReasons.direction')}
            options={POS_CASH_DIRECTIONS.map((value) => ({
              value,
              label: t(`posCashReasons.directions.${value}`),
            }))}
            {...register('direction')}
            error={errors.direction?.message}
          />
        )}
        <SelectField
          label={t('posCashReasons.account')}
          hint={t(`posCashReasons.accountHints.${direction}`)}
          options={[
            { value: '', label: t('posCashReasons.accountPlaceholder') },
            ...options.map((account) => ({
              value: account.id,
              label: `${account.code} · ${account.name}`,
            })),
          ]}
          {...register('accountId')}
          error={errors.accountId?.message}
        />
      </form>
    </DialogContent>
  );
}

type Editing = null | 'new' | PosCashReason;

export function PosCashReasonsPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = useCan()('pos.register.manage');
  const [status, setStatus] = useState<ReasonStatus>('active');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery({
    ...posCashReasonsQuery(tenantId, status),
    enabled: me !== null,
  });
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const accountName = useMemo(
    () =>
      new Map((accounts ?? []).map((account) => [account.id, `${account.code} · ${account.name}`])),
    [accounts],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('posCashReasons.columns.reason'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
        }),
        column.accessor('direction', {
          header: t('posCashReasons.columns.direction'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <DirectionPill direction={getValue()} />,
        }),
        column.accessor('accountId', {
          header: t('posCashReasons.columns.account'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => accountName.get(getValue()) ?? '—',
        }),
        column.accessor('archivedAt', {
          header: t('posCashReasons.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) =>
            getValue() === null ? (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('posCashReasons.statuses.active')}
              </Pill>
            ) : (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('posCashReasons.statuses.archived')}
              </Pill>
            ),
        }),
      ]),
    [t, accountName],
  );

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader
        title={t('posCashReasons.title')}
        description={t('posCashReasons.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('posCashReasons.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label={t('posCashReasons.show')}
          value={status}
          options={POS_CASH_REASON_STATUSES.map((value) => ({
            value,
            label: t(`posCashReasons.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
        {!canManage && <p className="text-body-sm text-ink-3">{t('posCashReasons.readOnly')}</p>}
      </div>
      {isError && <p className="text-body-sm text-crit">{t('posCashReasons.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('posCashReasons.title')}
          data={data}
          columns={columns}
          getRowId={(item) => item.id}
          onRowClick={canManage ? setEditing : undefined}
          empty={
            status === 'archived' ? (
              <EmptyState
                icon={Archive02Icon}
                title={t('posCashReasons.emptyArchivedTitle')}
                description={t('posCashReasons.emptyArchivedBody')}
              />
            ) : (
              <EmptyState
                icon={MoneyExchange03Icon}
                title={t('posCashReasons.emptyTitle')}
                description={t('posCashReasons.emptyBody')}
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
        {/* The form opens with the chart loaded: its select lists the accounts */}
        {editing !== null && accounts && (
          <ReasonForm
            key={editing === 'new' ? 'new' : editing.id}
            reason={editing === 'new' ? null : editing}
            accounts={accounts}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
