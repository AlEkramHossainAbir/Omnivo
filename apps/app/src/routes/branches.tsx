import {
  Archive02Icon,
  Call02Icon,
  CheckmarkCircle02Icon,
  PlusSignIcon,
  Store01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Branch,
  BRANCH_STATUSES,
  type BranchStatus,
  contractErrorMap,
  routes,
  updateBranchInputSchema,
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
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { useSession } from '../lib/session-store';

const column = dataTableColumns<Branch>();
const FIELD_NAMES = updateBranchInputSchema.keyof().options;

function branchesQuery(tenantId: string, status: BranchStatus) {
  return queryOptions({
    queryKey: ['branches', tenantId, status],
    queryFn: async () => (await call(routes.branches.list, { query: { status } })).items,
  });
}

// একটা ফর্ম দুই কাজে: নতুন (branch নেই) আর বদল। নতুনের version 1 — schema-র min(1) পার হয়,
// আর তৈরির route version পড়েই না (branchInputSchema-তে ঘরটা নেই, z.object বাড়তি key ফেলে দেয়)
function BranchForm({ branch, onDone }: { branch: Branch | null; onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateBranchInputSchema, { error: contractErrorMap }),
    defaultValues: {
      code: branch?.code ?? '',
      name: branch?.name ?? '',
      phone: branch?.phone ?? '',
      address: branch?.address ?? '',
      version: branch?.version ?? 1,
    },
  });

  // সেভ, archive বা restore — যা-ই হোক, দুই তালিকাই (চালু আর আর্কাইভ) পুরনো। prefix key দিয়ে
  // দুটোকেই একসাথে: ['branches', tenantId] দিয়ে শুরু হওয়া সব query
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['branches', tenantId] });

  const toggle = useMutation({
    mutationFn: (current: Branch) =>
      call(current.archivedAt === null ? routes.branches.archive : routes.branches.restore, {
        params: { id: current.id },
        body: { version: current.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'branches.restoredToast' : 'branches.archivedToast', {
          name: saved.name,
        }),
      );
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = branch
        ? await call(routes.branches.update, {
            params: { id: branch.id },
            body: { ...fields, version },
          })
        : await call(routes.branches.create, { body: fields });
      await refresh();
      toast(t(branch ? 'branches.updated' : 'branches.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  const failure = errors.root?.server?.message ?? toggleFailure(toggle.error);

  return (
    <DialogContent
      title={branch ? t('branches.editTitle', { code: branch.code }) : t('branches.newTitle')}
      footer={
        <>
          {branch && (
            // বাঁয়ে সরানো: মূল কাজ (সেভ) থেকে দূরে, ভুল করে চাপার সম্ভাবনা কম
            <Button
              variant="secondary"
              className="mr-auto"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(branch);
              }}
            >
              {branch.archivedAt === null ? t('branches.archive') : t('branches.restore')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="branch-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : branch ? t('common.save') : t('branches.add')}
          </Button>
        </>
      }
    >
      <form
        id="branch-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('branches.code')}
            hint={t('branches.codeHint')}
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="GZP"
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField
            label={t('branches.name')}
            icon={Store01Icon}
            placeholder="Gazipur factory"
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <TextField
          label={t('branches.phone')}
          icon={Call02Icon}
          optional
          type="tel"
          placeholder="+880 1711-000000"
          {...register('phone')}
          error={errors.phone?.message}
        />
        <TextAreaField
          label={t('branches.address')}
          optional
          placeholder="Plot 12, BSCIC Industrial Area, Konabari, Gazipur 1751"
          {...register('address')}
          error={errors.address?.message}
        />
      </form>
    </DialogContent>
  );
}

// archive/restore-এর error (branch_last_active, version_conflict) ফর্মের ঘরের না — উপরে alert-এ
function toggleFailure(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

// null = dialog বন্ধ, 'new' = নতুন ব্রাঞ্চ, Branch = সেটা বদলানো
type Editing = null | 'new' | Branch;

export function BranchesPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = useCan()('core.branch.manage');
  const [status, setStatus] = useState<BranchStatus>('active');
  const [editing, setEditing] = useState<Editing>(null);
  const { data, isError } = useQuery({ ...branchesQuery(tenantId, status), enabled: me !== null });

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('branches.columns.branch'),
          meta: { card: 'title' },
          // CLAUDE.md → Table: প্রথম কলামে ৩০px tile + নাম + ink-3 সাব-লাইন। tile-এ কোড — রিপোর্টে
          // যে ছোট নামে ব্রাঞ্চ চেনা যায়
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
        column.accessor('phone', {
          header: t('branches.columns.phone'),
          meta: { card: 'detail' },
          cell: ({ getValue }) => getValue() ?? '—',
        }),
        column.accessor('archivedAt', {
          header: t('branches.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          // রং একা না — আইকন আর লেখা সহ (CLAUDE.md → Status colors)
          cell: ({ getValue }) =>
            getValue() === null ? (
              <Pill tone="good" icon={CheckmarkCircle02Icon}>
                {t('branches.statuses.active')}
              </Pill>
            ) : (
              <Pill tone="neutral" icon={Archive02Icon}>
                {t('branches.statuses.archived')}
              </Pill>
            ),
        }),
      ]),
    [t],
  );

  const statusOptions = useMemo(
    () => BRANCH_STATUSES.map((value) => ({ value, label: t(`branches.statuses.${value}`) })),
    [t],
  );

  return (
    <div className="grid max-w-5xl gap-5">
      <PageHeader
        title={t('branches.title')}
        description={t('branches.description')}
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing('new');
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('branches.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label={t('branches.show')}
          value={status}
          options={statusOptions}
          onChange={setStatus}
        />
        {!canManage && <p className="text-body-sm text-ink-3">{t('branches.readOnly')}</p>}
      </div>
      {isError && <p className="text-body-sm text-crit">{t('branches.loadFailed')}</p>}
      {data && (
        <DataTable
          label={t('branches.title')}
          data={data}
          columns={columns}
          getRowId={(branch) => branch.id}
          // বদলানোর অনুমতি না থাকলে রো ক্লিক করা যায় না — খুলে "অনুমতি নেই" দেখানোর চেয়ে ভালো
          onRowClick={canManage ? setEditing : undefined}
          // চালু তালিকা কখনো খালি হয় না (অন্তত একটা চালু ব্রাঞ্চ থাকে) — খালি শুধু আর্কাইভ
          empty={
            status === 'archived' && (
              <EmptyState
                icon={Archive02Icon}
                title={t('branches.emptyArchivedTitle')}
                description={t('branches.emptyArchivedBody')}
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
        {editing !== null && (
          <BranchForm
            key={editing === 'new' ? 'new' : editing.id}
            branch={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
