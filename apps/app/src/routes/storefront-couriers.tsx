import {
  Alert02Icon,
  Archive02Icon,
  ArchiveRestoreIcon,
  CheckmarkBadge01Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Edit02Icon,
  InformationCircleIcon,
  MoreHorizontalIcon,
  Plug01Icon,
  PlusSignIcon,
  ShippingTruck01Icon,
  WebhookIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  COURIER_ACCOUNT_STATUSES,
  type CourierAccount,
  type CourierAccountSaved,
  type CourierAccountStatus,
  type CourierSetup,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FormAlert,
  IconButton,
  Input,
  PageHeader,
  Pill,
  SegmentedControl,
  SelectField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useId, useMemo, useState } from 'react';

import { DocumentNotice } from '../components/document-notice';
import {
  StorefrontOffline,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { storefrontCouriersQuery, storefrontSetupQuery } from '../lib/storefront';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 28a: Storefront → Shop couriers (decision 15, approved with the mockup), storefront.manage.
// The "Book at Packed" card (the default account, decision 13), then the accounts with an Active /
// Archived control. An account opens in a dialog; a new API account, and a new webhook token, show
// the webhook's address and token once (decision 16). Online only, like the whole menu. No
// "Changes show in the shop" line: the shop never shows an account.

const column = dataTableColumns<CourierAccount>();

// The form's chunk loads the first time Add or Edit is opened (storefront-courier-form.tsx)
const AccountDialog = lazy(async () => ({
  default: (await import('../components/storefront-courier-form')).AccountDialog,
}));

const STATUS_PILLS = {
  active: { tone: 'good', icon: CheckmarkCircle02Icon },
  archived: { tone: 'neutral', icon: Archive02Icon },
} as const satisfies Record<CourierAccountStatus, { tone: string; icon: IconSvgElement }>;

// A line with its own icon and colour, so the colour is never the only sign
function Line({ tone, icon, children }: { tone: string; icon: IconSvgElement; children: string }) {
  return (
    <span className={cn('inline-flex items-start gap-1.5 text-body-sm', tone)}>
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// The default account

// Decision 13: the account the Packed dialog starts with. Its own small form (one select and
// Save), because it saves to its own route (PUT /storefront/couriers). Only an active account that
// books by API: a manual one has no code yet at Packed. Save waits for a change. Secondary: the
// page's one primary button is "Add courier account"
function DefaultCard({ setup }: { setup: CourierSetup }) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const choices = setup.accounts.filter(
    (account) => account.status === 'active' && account.provider !== 'manual',
  );
  const [value, setValue] = useState(setup.defaultAccountId ?? '');
  const save = useMutation({
    mutationFn: () => call(routes.shipping.setDefaultCourier, { body: { accountId: value } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(storefrontCouriersQuery(tenantId).queryKey, saved);
      const name = saved.accounts.find((account) => account.id === saved.defaultAccountId)?.name;
      toast(
        name === undefined
          ? t('storefront.couriers.default.cleared')
          : t('storefront.couriers.default.saved', { name }),
      );
    },
  });
  const failure =
    save.error instanceof ApiRequestError ? save.error.code : save.error ? 'unknown_error' : null;
  return (
    <Card>
      <CardHeader
        title={t('storefront.couriers.default.title')}
        subtitle={t('storefront.couriers.default.description')}
      />
      <div className="grid gap-3 p-5">
        {failure !== null && <FormAlert message={failure} />}
        {choices.length === 0 ? (
          <p className="flex items-start gap-1.5 text-label text-ink-2">
            <HugeiconsIcon
              icon={InformationCircleIcon}
              size={15}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0 text-ink-3"
            />
            {t('storefront.couriers.default.noApiAccount')}
          </p>
        ) : (
          // The button sits on the select's line from sm (its label's height above it), under
          // it on a phone
          <div className="grid gap-3 sm:flex sm:items-start">
            <div className="min-w-0 sm:w-full sm:max-w-[420px]">
              <SelectField
                label={t('storefront.couriers.default.label')}
                icon={ShippingTruck01Icon}
                name="defaultAccountId"
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
                options={[
                  { value: '', label: t('storefront.couriers.default.none') },
                  ...choices.map((account) => ({
                    value: account.id,
                    label: t('storefront.order.booking.accountOption', {
                      name: account.name,
                      courier: t(`storefront.couriers.names.${account.courier}`),
                    }),
                  })),
                ]}
                hint={t('storefront.couriers.default.hint')}
              />
            </div>
            <Button
              variant="secondary"
              className="justify-self-start sm:mt-[25px]"
              disabled={value === (setup.defaultAccountId ?? '') || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              {t('storefront.couriers.default.save')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialogs

// The browser's clipboard can refuse (an old browser, a page not on HTTPS): then the person selects
// the text in its box and copies it themselves (the share dialog's rule)
function useCopy(): (text: string) => void {
  const { t } = useLocale();
  return (text) => {
    navigator.clipboard.writeText(text).then(
      () => {
        toast(t('storefront.couriers.webhook.copied'));
      },
      () => {
        toast(t('documentOutput.copyFailed'));
      },
    );
  };
}

function CopyBox({
  label,
  value,
  copy,
  hint,
}: {
  label: string;
  value: string;
  copy: string;
  hint?: string;
}) {
  const id = useId();
  const copyText = useCopy();
  return (
    <Field id={id} label={label} hint={hint}>
      <div className="flex items-center gap-2">
        {/* Read only, and selected on focus: one tap selects it for copying by hand */}
        <div className="min-w-0 flex-1">
          <Input
            id={id}
            readOnly
            value={value}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => {
            copyText(value);
          }}
        >
          <HugeiconsIcon icon={Copy01Icon} size={16} strokeWidth={1.5} />
          {copy}
        </Button>
      </div>
    </Field>
  );
}

// Decision 16: the token is in the answer once (courierAccountSavedSchema). The dialog says so,
// and closing it any way is Done
function WebhookDialog({ saved }: { saved: CourierAccountSaved }) {
  const { t } = useLocale();
  return (
    <DialogContent
      title={t('storefront.couriers.webhook.title')}
      description={t('storefront.couriers.webhook.description')}
      footer={
        <DialogClose asChild>
          <Button>{t('storefront.couriers.webhook.done')}</Button>
        </DialogClose>
      }
    >
      <div className="grid gap-[18px]">
        <CopyBox
          label={t('storefront.couriers.webhook.url')}
          value={saved.account.webhookUrl ?? ''}
          copy={t('storefront.couriers.webhook.copyUrl')}
        />
        <CopyBox
          label={t('storefront.couriers.webhook.token')}
          value={saved.webhookToken ?? ''}
          copy={t('storefront.couriers.webhook.copyToken')}
          hint={t('storefront.couriers.webhook.tokenHint')}
        />
        <DocumentNotice tone="neutral">{t('storefront.couriers.webhook.poll')}</DocumentNotice>
      </div>
    </DialogContent>
  );
}

// New webhook token and Archive both ask first, with the same frame
function ConfirmDialog({
  title,
  body,
  submit,
  pending,
  error,
  onConfirm,
}: {
  title: string;
  body: string;
  submit: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  return (
    <DialogContent
      title={title}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button disabled={pending} onClick={onConfirm}>
            {submit}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {/* version_conflict: someone changed it meanwhile; Cancel and the list shows the new one */}
        {error !== null && <FormAlert message={error} />}
        <p className="text-body-sm text-ink-2">{body}</p>
      </div>
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------------------------
// The page

type Acting =
  | null
  | { kind: 'new' }
  | { kind: 'edit'; account: CourierAccount }
  | { kind: 'archive'; account: CourierAccount }
  | { kind: 'renew'; account: CourierAccount }
  | { kind: 'webhook'; saved: CourierAccountSaved };

function codeOf(error: unknown): string | null {
  if (error instanceof ApiRequestError) return error.code;
  return error ? 'unknown_error' : null;
}

export function StorefrontCouriersPage() {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const online = useOnline();
  const refresh = useStorefrontRefresh();
  const [view, setView] = useState<CourierAccountStatus>('active');
  const [acting, setActing] = useState<Acting>(null);
  const close = () => {
    setActing(null);
  };

  // "View shop" once the shop has an address. An account does not need the shop: it can be added
  // before the shop is set up
  const shop = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online }).data?.shop ?? null;
  const { data: setup, isError } = useQuery({
    ...storefrontCouriersQuery(tenantId),
    enabled: online,
  });

  // Test connection: a 200 whether the keys worked or not; the account's lastTest says which, and
  // the toast says it too
  const test = useMutation({
    mutationFn: (account: CourierAccount) =>
      call(routes.shipping.testCourier, { params: { id: account.id } }),
    onSuccess: async (saved) => {
      await refresh();
      const courier = t(`storefront.couriers.names.${saved.courier}`);
      const problem = saved.lastTest?.problem ?? null;
      toast(
        problem === null
          ? t('storefront.couriers.testedWorked', { courier })
          : problem === 'rejected'
            ? t('storefront.couriers.testedRejected', { courier })
            : t('storefront.couriers.testedUnreachable', { courier }),
      );
    },
    onError: (error) => {
      toast(errorText(codeOf(error) ?? 'unknown_error'));
    },
  });
  const restore = useMutation({
    mutationFn: (account: CourierAccount) =>
      call(routes.shipping.restoreCourier, {
        params: { id: account.id },
        body: { version: account.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('storefront.couriers.restored', { name: saved.name }));
    },
    onError: (error) => {
      toast(errorText(codeOf(error) ?? 'unknown_error'));
    },
  });
  const archive = useMutation({
    mutationFn: (account: CourierAccount) =>
      call(routes.shipping.archiveCourier, {
        params: { id: account.id },
        body: { version: account.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      setActing(null);
      toast(t('storefront.couriers.archived', { name: saved.name }));
    },
  });
  const renew = useMutation({
    mutationFn: (account: CourierAccount) =>
      call(routes.shipping.renewCourierWebhookToken, {
        params: { id: account.id },
        body: { version: account.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('storefront.couriers.tokenRenewed'));
      // The new token, once, in the same dialog as a new account's
      setActing({ kind: 'webhook', saved });
    },
  });
  // mutate is stable; the mutation objects are new on every render and would rebuild the columns
  const { mutate: testAccount } = test;
  const { mutate: restoreAccount } = restore;

  const defaultId = setup?.defaultAccountId ?? null;
  const columns = useMemo(() => {
    const when = (iso: string) => format.dateTime(new Date(iso), timeZone);
    return column.columns([
      column.accessor('name', {
        header: t('storefront.couriers.columns.account'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => {
          const account = row.original;
          const courier = t(`storefront.couriers.names.${account.courier}`);
          return (
            <span className="flex items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
                <HugeiconsIcon icon={ShippingTruck01Icon} size={16} strokeWidth={1.5} />
              </span>
              <span className="grid min-w-0">
                <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
                  {account.name}
                  {account.id === defaultId && (
                    <Pill tone="brand" icon={CheckmarkBadge01Icon}>
                      {t('storefront.couriers.isDefault')}
                    </Pill>
                  )}
                </span>
                <span className="text-caption font-normal text-ink-3">
                  {t(`storefront.couriers.providers.${account.provider}`, { courier })}
                </span>
              </span>
            </span>
          );
        },
      }),
      column.accessor('lastWebhookAt', {
        header: t('storefront.couriers.columns.news'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ row }) => {
          const account = row.original;
          if (account.provider === 'manual') {
            return (
              <span className="text-body-sm text-ink-3">{t('storefront.couriers.newsManual')}</span>
            );
          }
          if (account.lastWebhookAt !== null) {
            return (
              <span className="text-body-sm whitespace-nowrap text-ink tabular-nums">
                {t('storefront.couriers.newsAt', { date: when(account.lastWebhookAt) })}
              </span>
            );
          }
          // Decision 16 (approved with the mockup): warn, because the courier's news never
          // reached us, and the line under it says what to do
          return (
            <span className="grid max-w-[260px] gap-0.5">
              <span className="font-medium text-warn">
                <Line tone="text-warn" icon={Alert02Icon}>
                  {t('storefront.couriers.newsNever')}
                </Line>
              </span>
              <span className="text-caption text-ink-3">
                {t('storefront.couriers.newsNeverHint')}
              </span>
            </span>
          );
        },
      }),
      column.accessor('lastTest', {
        header: t('storefront.couriers.columns.test'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ row }) => {
          const account = row.original;
          // A manual account has nothing to test
          if (account.provider === 'manual') return <span className="text-ink-3">—</span>;
          const last = account.lastTest;
          if (last === null) {
            return (
              <span className="text-body-sm text-ink-3">
                {t('storefront.couriers.neverTested')}
              </span>
            );
          }
          const date = when(last.at);
          switch (last.problem) {
            case null:
              return (
                <Line tone="text-good" icon={CheckmarkCircle02Icon}>
                  {t('storefront.couriers.testWorked', { date })}
                </Line>
              );
            case 'rejected':
              return (
                <Line tone="text-crit" icon={Alert02Icon}>
                  {t('storefront.couriers.testRejected', { date })}
                </Line>
              );
            case 'unreachable':
              return (
                <Line tone="text-warn" icon={Alert02Icon}>
                  {t('storefront.couriers.testUnreachable', { date })}
                </Line>
              );
          }
        },
      }),
      column.accessor('status', {
        header: t('storefront.couriers.columns.status'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => {
          const status = getValue();
          const pill = STATUS_PILLS[status];
          return (
            <Pill tone={pill.tone} icon={pill.icon}>
              {t(`storefront.couriers.statuses.${status}`)}
            </Pill>
          );
        },
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">{t('storefront.couriers.columns.actions')}</span>,
        meta: { align: 'end', card: 'trailing' },
        cell: ({ row }) => {
          const account = row.original;
          const byApi = account.provider !== 'manual';
          return (
            // The row opens Edit on a click: the menu's events must not reach it (27c.7's lesson,
            // storefront-coupons.tsx). `contents`: the wrapper draws no box
            <div
              className="contents"
              onClick={(event) => {
                event.stopPropagation();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    icon={MoreHorizontalIcon}
                    label={t('storefront.couriers.actionsFor', { name: account.name })}
                    className="-my-1"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {account.status === 'archived' ? (
                    <DropdownMenuItem
                      icon={ArchiveRestoreIcon}
                      onSelect={() => {
                        restoreAccount(account);
                      }}
                    >
                      {t('storefront.couriers.restore')}
                    </DropdownMenuItem>
                  ) : (
                    <>
                      <DropdownMenuItem
                        icon={Edit02Icon}
                        onSelect={() => {
                          setActing({ kind: 'edit', account });
                        }}
                      >
                        {t('storefront.couriers.edit')}
                      </DropdownMenuItem>
                      {byApi && (
                        <DropdownMenuItem
                          icon={Plug01Icon}
                          onSelect={() => {
                            testAccount(account);
                          }}
                        >
                          {t('storefront.couriers.test')}
                        </DropdownMenuItem>
                      )}
                      {byApi && (
                        <DropdownMenuItem
                          icon={WebhookIcon}
                          onSelect={() => {
                            setActing({ kind: 'renew', account });
                          }}
                        >
                          {t('storefront.couriers.renewToken')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        icon={Archive02Icon}
                        onSelect={() => {
                          setActing({ kind: 'archive', account });
                        }}
                      >
                        {t('storefront.couriers.archive')}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      }),
    ]);
  }, [t, format, timeZone, defaultId, testAccount, restoreAccount]);

  const rows = setup?.accounts.filter((account) => account.status === view);
  const openNew = () => {
    setActing({ kind: 'new' });
  };
  const empty =
    view === 'archived' ? (
      <EmptyState
        icon={Archive02Icon}
        title={t('storefront.couriers.archivedEmptyTitle')}
        description={t('storefront.couriers.archivedEmptyBody')}
      />
    ) : (
      <EmptyState
        icon={ShippingTruck01Icon}
        title={t('storefront.couriers.emptyTitle')}
        description={t('storefront.couriers.emptyBody')}
        action={
          <Button size="sm" onClick={openNew}>
            <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
            {t('storefront.couriers.add')}
          </Button>
        }
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.couriers.title')}
        description={t('storefront.couriers.description')}
        actions={
          online && (
            <>
              {shop !== null && <ViewShopLink href={shop.shopUrl} />}
              <Button onClick={openNew}>
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('storefront.couriers.add')}
              </Button>
            </>
          )
        }
      />
      {!online && <StorefrontOffline />}
      {online && isError && (
        <p role="alert" className="text-body-sm text-crit">
          {t('storefront.couriers.loadFailed')}
        </p>
      )}
      {online && setup && (
        <>
          {/* key: a save elsewhere (an archive of the default) starts the select afresh */}
          <DefaultCard key={setup.defaultAccountId ?? 'none'} setup={setup} />
          <div>
            <SegmentedControl
              label={t('storefront.couriers.view')}
              value={view}
              options={COURIER_ACCOUNT_STATUSES.map((value) => ({
                value,
                label: t(`storefront.couriers.views.${value}`),
              }))}
              onChange={setView}
            />
          </div>
          {rows && (
            <DataTable
              label={t('storefront.couriers.title')}
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              // An archived account opens nothing: Restore (its menu) comes before a change
              onRowClick={
                view === 'active'
                  ? (account) => {
                      setActing({ kind: 'edit', account });
                    }
                  : undefined
              }
              empty={empty}
            />
          )}
        </>
      )}
      {(acting?.kind === 'new' || acting?.kind === 'edit') && (
        // fallback null: the chunk comes in a moment, and an empty dialog frame would flash first
        <Suspense fallback={null}>
          <AccountDialog
            account={acting.kind === 'new' ? null : acting.account}
            onClose={close}
            onSaved={async (saved) => {
              await refresh();
              // A new API account's webhook, once (decision 16); a manual one has none
              if (saved.webhookToken !== null) setActing({ kind: 'webhook', saved });
              else setActing(null);
            }}
          />
        </Suspense>
      )}
      {acting !== null &&
        (acting.kind === 'archive' || acting.kind === 'renew' || acting.kind === 'webhook') && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) {
                archive.reset();
                renew.reset();
                setActing(null);
              }
            }}
          >
            {acting.kind === 'webhook' && <WebhookDialog saved={acting.saved} />}
            {acting.kind === 'renew' && (
              <ConfirmDialog
                title={t('storefront.couriers.renewing.title', { name: acting.account.name })}
                body={t('storefront.couriers.renewing.body')}
                submit={t('storefront.couriers.renewing.submit')}
                pending={renew.isPending}
                error={codeOf(renew.error)}
                onConfirm={() => {
                  renew.mutate(acting.account);
                }}
              />
            )}
            {acting.kind === 'archive' && (
              <ConfirmDialog
                title={t('storefront.couriers.archiving.title', { name: acting.account.name })}
                // The default account: archiving it clears the default too (28a.2)
                body={
                  acting.account.id === defaultId
                    ? t('storefront.couriers.archiving.bodyDefault')
                    : t('storefront.couriers.archiving.body')
                }
                submit={t('storefront.couriers.archiving.submit')}
                pending={archive.isPending}
                error={codeOf(archive.error)}
                onConfirm={() => {
                  archive.mutate(acting.account);
                }}
              />
            )}
          </Dialog>
        )}
    </div>
  );
}
