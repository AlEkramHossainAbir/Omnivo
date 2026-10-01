import {
  Archive02Icon,
  FolderTreeIcon,
  PlusSignIcon,
  Search01Icon,
  SquareLock02Icon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Account,
  type AccountType,
  contractErrorMap,
  createAccountInputSchema,
  isAccountPurpose,
  NORMAL_BALANCE,
  routes,
  updateAccountInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  filterTree,
  FormAlert,
  IconButton,
  Input,
  PageHeader,
  Pill,
  SegmentedControl,
  SelectField,
  TextAreaField,
  TextField,
  toast,
  TreeList,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useCallback, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

import { accountTree, groupOptions, suggestCode } from '../lib/account-tree';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import { accountsQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';

const CREATE_FIELDS = createAccountInputSchema.keyof().options;
const UPDATE_FIELDS = updateAccountInputSchema.keyof().options;
const KINDS = ['ledger', 'group'] as const;

function failureOf(error: Error | null): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiRequestError ? error.code : 'unknown_error';
}

// "Asset · grows with a debit" — the class every account under this group will have
function TypeLine({ type, prefix }: { type: AccountType; prefix?: string }) {
  const { t } = useLocale();
  const line = t('accounts.typeLine', {
    type: t(`accounts.types.${type}`),
    balance: t(`accounts.balances.${NORMAL_BALANCE[type]}`),
  });
  return <p className="text-label text-ink-3">{prefix ? `${prefix} · ${line}` : line}</p>;
}

function useRefresh() {
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: accountsQuery(tenantId).queryKey });
}

function NewAccountForm({
  accounts,
  parentId,
  onDone,
}: {
  accounts: Account[];
  // '' = the page's Add button (no group chosen yet); an id = a group row's + button
  parentId: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const groups = useMemo(() => groupOptions(accounts), [accounts]);
  const start = accounts.find((account) => account.id === parentId);
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm({
    resolver: zodResolver(createAccountInputSchema, { error: contractErrorMap }),
    defaultValues: {
      parentId,
      code: start ? suggestCode(start, accounts) : '',
      name: '',
      isGroup: false,
      description: '',
    },
  });
  const chosen = useWatch({ control, name: 'parentId' });
  const parent = accounts.find((account) => account.id === chosen);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.accounts.create, { body: values });
      await refresh();
      toast(t('accounts.created', { name: saved.name }));
      onDone();
    } catch (error) {
      applyApiError(error, CREATE_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('accounts.newTitle')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="account-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('accounts.add')}
          </Button>
        </>
      }
    >
      <form
        id="account-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <div className="grid gap-1.5">
          <SelectField
            label={t('accounts.parent')}
            options={[{ value: '', label: t('accounts.parentPlaceholder') }, ...groups]}
            {...register('parentId', {
              // A new group → a code that fits it. Not over a code the person typed themselves.
              onChange: (event: ChangeEvent<HTMLSelectElement>) => {
                if (dirtyFields.code) return;
                const next = accounts.find((account) => account.id === event.target.value);
                setValue('code', next ? suggestCode(next, accounts) : '');
              },
            })}
            error={errors.parentId?.message}
          />
          {parent && <TypeLine type={parent.type} />}
        </div>
        <Controller
          control={control}
          name="isGroup"
          render={({ field }) => (
            <div className="grid gap-1.5">
              {/* The visible label; the control's own legend (sr-only) is what screen readers use */}
              <span aria-hidden="true" className="text-label font-medium text-ink">
                {t('accounts.kind')}
              </span>
              <div>
                <SegmentedControl
                  label={t('accounts.kind')}
                  value={field.value ? 'group' : 'ledger'}
                  options={KINDS.map((kind) => ({
                    value: kind,
                    label: t(`accounts.kinds.${kind}`),
                  }))}
                  onChange={(kind) => {
                    field.onChange(kind === 'group');
                  }}
                />
              </div>
              <p className="text-label text-ink-3">
                {t(`accounts.kindHints.${field.value ? 'group' : 'ledger'}`)}
              </p>
            </div>
          )}
        />
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('accounts.code')}
            hint={t('accounts.codeHint')}
            inputMode="numeric"
            spellCheck={false}
            placeholder="1121"
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField
            label={t('accounts.name')}
            placeholder={t('accounts.namePlaceholder')}
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <TextAreaField
          label={t('accounts.about')}
          optional
          placeholder={t('accounts.aboutPlaceholder')}
          {...register('description')}
          error={errors.description?.message}
        />
      </form>
    </DialogContent>
  );
}

function EditAccountForm({
  account,
  accounts,
  onDone,
}: {
  account: Account;
  accounts: Account[];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const groups = useMemo(() => groupOptions(accounts, account), [accounts, account]);
  const top = account.parentId === null;
  // An unknown purpose (from a newer server) is still a system account: the server refuses to
  // archive or delete it, so the buttons stay hidden — only the hint needs a known purpose
  const system = account.purpose !== null;
  const purpose =
    account.purpose !== null && isAccountPurpose(account.purpose) ? account.purpose : null;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateAccountInputSchema, { error: contractErrorMap }),
    defaultValues: {
      parentId: account.parentId,
      code: account.code,
      name: account.name,
      description: account.description ?? '',
      version: account.version,
    },
  });

  const toggle = useMutation({
    mutationFn: () =>
      call(account.archivedAt === null ? routes.accounts.archive : routes.accounts.restore, {
        params: { id: account.id },
        body: { version: account.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(
        t(saved.archivedAt === null ? 'accounts.restoredToast' : 'accounts.archivedToast', {
          name: saved.name,
        }),
      );
      onDone();
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      call(routes.accounts.remove, {
        params: { id: account.id },
        query: { version: account.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('accounts.deleted', { name: account.name }));
      onDone();
    },
  });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = await call(routes.accounts.update, {
        params: { id: account.id },
        body: { ...fields, version },
      });
      await refresh();
      toast(t('accounts.updated', { name: saved.name }));
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
      title={t('accounts.editTitle', { code: account.code })}
      footer={
        <>
          {!top && !system && (
            // Left, away from Save. Delete takes two clicks: it cannot be undone.
            <div className="mr-auto flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  toggle.mutate();
                }}
              >
                {account.archivedAt === null ? t('accounts.archive') : t('accounts.restore')}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (confirming) remove.mutate();
                  else setConfirming(true);
                }}
              >
                {confirming
                  ? t('accounts.confirmDelete', { code: account.code })
                  : t('accounts.delete')}
              </Button>
            </div>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="account-form" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id="account-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {confirming && <p className="text-body-sm text-ink-2">{t('accounts.deleteWarning')}</p>}
        <TypeLine
          type={account.type}
          prefix={t(`accounts.kinds.${account.isGroup ? 'group' : 'ledger'}`)}
        />
        {top && <p className="text-body-sm text-ink-2">{t('accounts.topLevel')}</p>}
        {purpose && (
          <p className="text-body-sm text-ink-2">
            {t('accounts.systemHint', { purpose: t(`accounts.purposes.${purpose}`) })}
          </p>
        )}
        {/* A top-level group has no group to pick: it sends parentId null and stays on top */}
        {!top && (
          <SelectField
            label={t('accounts.parent')}
            options={groups}
            {...register('parentId')}
            error={errors.parentId?.message}
          />
        )}
        <div className="grid gap-5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-x-4">
          <TextField
            label={t('accounts.code')}
            hint={t('accounts.codeHint')}
            inputMode="numeric"
            spellCheck={false}
            {...register('code')}
            error={errors.code?.message}
          />
          <TextField
            label={t('accounts.name')}
            {...register('name')}
            error={errors.name?.message}
          />
        </div>
        <TextAreaField
          label={t('accounts.about')}
          optional
          placeholder={t('accounts.aboutPlaceholder')}
          {...register('description')}
          error={errors.description?.message}
        />
      </form>
    </DialogContent>
  );
}

// One row of the tree, right of the arrow: code, name, and what applies — System, Archived, +
function AccountRow({
  account,
  canManage,
  onOpen,
  onAdd,
}: {
  account: Account;
  canManage: boolean;
  onOpen: (account: Account) => void;
  onAdd: (group: Account) => void;
}) {
  const { t } = useLocale();
  const archived = account.archivedAt !== null;
  const nameClass = cn(
    'min-w-0 truncate text-left text-body-sm',
    account.isGroup ? 'font-medium text-ink' : 'text-ink-2',
    archived && 'text-ink-3',
  );
  return (
    <>
      <span className="w-11 shrink-0 font-mono text-caption text-ink-3 tabular-nums sm:w-14">
        {account.code}
      </span>
      {canManage ? (
        <button
          type="button"
          onClick={() => {
            onOpen(account);
          }}
          className={cn(nameClass, 'underline-offset-3 hover:underline')}
        >
          {account.name}
        </button>
      ) : (
        <span className={nameClass}>{account.name}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {account.purpose !== null && (
          <Pill tone="neutral" icon={SquareLock02Icon}>
            {t('accounts.system')}
          </Pill>
        )}
        {archived && (
          <Pill tone="neutral" icon={Archive02Icon}>
            {t('accounts.archived')}
          </Pill>
        )}
        {canManage && account.isGroup && !archived && (
          <IconButton
            icon={PlusSignIcon}
            label={t('accounts.addTo', { name: account.name })}
            // With a mouse: shown on the row's hover or keyboard focus — thirty "+" at rest are
            // noise. On touch screens there is no hover, so it always shows.
            className="-my-1 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100"
            onClick={() => {
              onAdd(account);
            }}
          />
        )}
      </span>
    </>
  );
}

type Editing = null | { kind: 'new'; parentId: string } | { kind: 'edit'; account: Account };

export function AccountsPage() {
  const { t } = useLocale();
  const me = useSession((state) => state.me);
  const tenantId = me?.tenant.id ?? '';
  const canManage = useCan()('accounting.account.manage');
  const { data: accounts, isError } = useQuery({
    ...accountsQuery(tenantId),
    enabled: me !== null,
  });
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // Closed groups, not open ones: a new chart opens fully, and a new group starts open
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const query = search.trim().toLowerCase();

  const tree = useMemo(() => {
    const visible = (accounts ?? []).filter(
      (account) => showArchived || account.archivedAt === null,
    );
    const full = accountTree(visible);
    if (query === '') return full;
    return filterTree(
      full,
      (account) =>
        account.code.toLowerCase().includes(query) || account.name.toLowerCase().includes(query),
    );
  }, [accounts, showArchived, query]);

  // While searching, every group on the way to a match is open, whatever was closed before
  const isOpen = useCallback(
    (id: string) => query !== '' || !collapsed.has(id),
    [query, collapsed],
  );
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const open = useCallback((account: Account) => {
    setEditing({ kind: 'edit', account });
  }, []);
  const add = useCallback((group: Account) => {
    setEditing({ kind: 'new', parentId: group.id });
  }, []);

  return (
    // grid-cols-1 = minmax(0, 1fr): without it the one column grows to the toolbar's unwrapped
    // width, and the page scrolls sideways on a phone (found by the 390px screenshot)
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader
        title={t('accounts.title')}
        description={t('accounts.description')}
        actions={
          canManage && (
            <Button
              disabled={!accounts?.length}
              onClick={() => {
                setEditing({ kind: 'new', parentId: '' });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('accounts.add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-60">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('accounts.searchLabel')}
            placeholder={t('accounts.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <Checkbox
          id="accounts-show-archived"
          label={t('accounts.showArchived')}
          checked={showArchived}
          onCheckedChange={(checked) => {
            setShowArchived(checked === true);
          }}
        />
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={query !== ''}
            onClick={() => {
              setCollapsed(new Set());
            }}
          >
            <HugeiconsIcon icon={UnfoldMoreIcon} size={16} strokeWidth={1.5} />
            {t('accounts.expandAll')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={query !== ''}
            onClick={() => {
              setCollapsed(new Set(accounts?.filter((a) => a.isGroup).map((a) => a.id)));
            }}
          >
            <HugeiconsIcon icon={UnfoldLessIcon} size={16} strokeWidth={1.5} />
            {t('accounts.collapseAll')}
          </Button>
        </div>
      </div>
      {!canManage && <p className="text-body-sm text-ink-3">{t('accounts.readOnly')}</p>}
      {isError && <p className="text-body-sm text-crit">{t('accounts.loadFailed')}</p>}
      {accounts?.length === 0 && (
        <EmptyState
          icon={FolderTreeIcon}
          title={t('accounts.emptyTitle')}
          description={t('accounts.emptyBody')}
        />
      )}
      {accounts && accounts.length > 0 && tree.length === 0 && (
        <EmptyState
          icon={Search01Icon}
          title={t('accounts.noMatchTitle', { query: search.trim() })}
          description={t('accounts.noMatchBody')}
        />
      )}
      {tree.length > 0 && (
        <TreeList
          label={t('accounts.title')}
          nodes={tree}
          isOpen={isOpen}
          onToggle={toggle}
          toggleLabel={(account, isShown) =>
            t(isShown ? 'accounts.collapse' : 'accounts.expand', { name: account.name })
          }
          renderRow={(account) => (
            <AccountRow account={account} canManage={canManage} onOpen={open} onAdd={add} />
          )}
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(isShown) => {
          if (!isShown) setEditing(null);
        }}
      >
        {accounts && editing?.kind === 'new' && (
          <NewAccountForm
            key={`new-${editing.parentId}`}
            accounts={accounts}
            parentId={editing.parentId}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
        {accounts && editing?.kind === 'edit' && (
          <EditAccountForm
            key={editing.account.id}
            account={editing.account}
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
