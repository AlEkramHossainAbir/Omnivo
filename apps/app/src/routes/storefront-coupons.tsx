import {
  Archive02Icon,
  ArchiveRestoreIcon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  CouponPercentIcon,
  Edit02Icon,
  HourglassIcon,
  MoreHorizontalIcon,
  PlusSignIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  routes,
  STOREFRONT_COUPON_VIEWS,
  type StorefrontCoupon,
  type StorefrontCouponStatus,
  type StorefrontCouponView,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
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
  FormAlert,
  IconButton,
  Input,
  PageHeader,
  Pill,
  SegmentedControl,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';

import { failureOf } from '../components/journal-parts';
import {
  StorefrontOffline,
  useShopMoney,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { call } from '../lib/api';
import { storefrontCouponsQuery, storefrontSetupQuery } from '../lib/storefront';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 27c: Storefront → Shop coupons (decision 5), storefront.manage like the rest of the menu.
// The codes shoppers type in the checkout's promo box. A data table a page at a time (Current and
// Archived), one dialog form for a new coupon and a change, and an archive that asks first.
// Online only, like every storefront page. No "Changes show in the shop" line: the shop's quote
// reads the coupons fresh on every cart (step 27c.3), so a change works at once.

const column = dataTableColumns<StorefrontCoupon>();

// The form's chunk loads the first time Add coupon or a row is opened (storefront-coupon-form.tsx)
const CouponDialog = lazy(async () => ({
  default: (await import('../components/storefront-coupon-form')).CouponDialog,
}));

// The pill (STOREFRONT_COUPON_STATUSES, approved with the mockup): taken today = good, later =
// brand (work waiting to happen, not a problem), over = neutral, never warn: nothing to act on
const STATUS_PILLS = {
  active: { tone: 'good', icon: CheckmarkCircle02Icon },
  scheduled: { tone: 'brand', icon: Calendar03Icon },
  ended: { tone: 'neutral', icon: HourglassIcon },
  archived: { tone: 'neutral', icon: Archive02Icon },
} as const satisfies Record<StorefrontCouponStatus, { tone: string; icon: unknown }>;

function CouponStatusPill({ status }: { status: StorefrontCouponStatus }) {
  const { t } = useLocale();
  const pill = STATUS_PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`storefront.coupons.statuses.${status}`)}
    </Pill>
  );
}

// The list's words for a coupon, shared by the table's cells and the dialog's titles. The money as
// the shop shows it (paisa only when there is some), the days as the app shows a date. An ISO day
// is read with local parts, never as UTC midnight, which is the day before west of Greenwich
function useCouponWords() {
  const { t, format } = useLocale();
  const money = useShopMoney();
  return useMemo(() => {
    const day = (isoDate: string) => format.date(new Date(`${isoDate}T00:00:00`));
    return {
      discount: ({ discount, upTo }: StorefrontCoupon) => {
        if (discount.kind === 'amount') {
          return t('storefront.coupons.amountOff', { amount: money(discount.value) });
        }
        const percent = format.number(discount.value);
        return upTo === null
          ? t('storefront.coupons.percentOff', { percent })
          : t('storefront.coupons.percentOffUpTo', { percent, upTo: money(upTo) });
      },
      minimum: ({ minimum }: StorefrontCoupon) =>
        minimum === null
          ? t('storefront.coupons.anyAmount')
          : t('storefront.coupons.minimumFrom', { amount: money(minimum) }),
      days: ({ startsOn, lastDay }: StorefrontCoupon) => {
        if (startsOn !== null && lastDay !== null) {
          return t('storefront.coupons.daysBetween', { from: day(startsOn), to: day(lastDay) });
        }
        if (startsOn !== null) return t('storefront.coupons.daysFrom', { from: day(startsOn) });
        if (lastDay !== null) return t('storefront.coupons.daysUntil', { to: day(lastDay) });
        return t('storefront.coupons.anyDay');
      },
      used: ({ used, usageLimit }: StorefrontCoupon) =>
        usageLimit === null
          ? t('storefront.coupons.used', { count: used, formatted: format.number(used) })
          : t('storefront.coupons.usedOf', {
              formatted: format.number(used),
              limit: format.number(usageLimit),
            }),
    };
  }, [t, format, money]);
}

// Decision 31: an archive asks first (the shop stops taking the code at once); a restore does not
function ArchiveDialog({ coupon, onDone }: { coupon: StorefrontCoupon; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const archive = useMutation({
    mutationFn: () =>
      call(routes.storefrontCoupons.archiveCoupon, {
        params: { id: coupon.id },
        body: { version: coupon.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('storefront.coupons.archivedToast', { code: saved.code }));
      onDone();
    },
  });
  const failure = failureOf(archive.error);
  return (
    <DialogContent
      title={t('storefront.coupons.confirmArchive', { code: coupon.code })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={archive.isPending}
            onClick={() => {
              archive.mutate();
            }}
          >
            {t('storefront.coupons.archive')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {/* version_conflict: someone changed it meanwhile; Cancel and the list shows the new one */}
        {failure && <FormAlert message={failure} />}
        <p className="text-body-sm text-ink-2">{t('storefront.coupons.archiveBody')}</p>
      </div>
    </DialogContent>
  );
}

type Acting =
  | null
  | { kind: 'new' }
  | { kind: 'edit'; coupon: StorefrontCoupon }
  | { kind: 'archive'; coupon: StorefrontCoupon };

export function StorefrontCouponsPage() {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const refresh = useStorefrontRefresh();
  const words = useCouponWords();
  const [view, setView] = useState<StorefrontCouponView>('current');
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 300);
  const [acting, setActing] = useState<Acting>(null);

  // "View shop" once the shop has an address. A coupon does not need the shop (the approved
  // mockup's last screen): it can be made before the shop is set up and waits for it
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...storefrontCouponsQuery(tenantId, { view, search: settled }),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const restore = useMutation({
    mutationFn: (coupon: StorefrontCoupon) =>
      call(routes.storefrontCoupons.restoreCoupon, {
        params: { id: coupon.id },
        body: { version: coupon.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('storefront.coupons.restoredToast', { code: saved.code }));
    },
    // No dialog to show it in: the toast says what went wrong (a version conflict)
    onError: (error) => {
      toast(errorText(failureOf(error) ?? 'unknown_error'));
    },
  });
  // mutate is stable; the mutation object is new on every render and would rebuild the columns
  const { mutate: restoreCoupon, isPending: restoring } = restore;

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('code', {
          header: t('storefront.coupons.columns.code'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* A code is typed by shoppers letter by letter: Geist Mono, like an order number */}
              <span className="font-mono font-medium whitespace-nowrap text-ink">
                {row.original.code}
              </span>
              {row.original.onePerPhone && (
                <span className="text-caption font-normal text-ink-3">
                  {t('storefront.coupons.onePerPhone')}
                </span>
              )}
            </span>
          ),
        }),
        column.accessor('discount', {
          header: t('storefront.coupons.columns.discount'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => <span className="tabular-nums">{words.discount(row.original)}</span>,
        }),
        column.accessor('minimum', {
          header: t('storefront.coupons.columns.minimum'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="text-ink-2 tabular-nums">{words.minimum(row.original)}</span>
          ),
        }),
        column.display({
          id: 'days',
          header: t('storefront.coupons.columns.days'),
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="whitespace-nowrap text-ink-2 tabular-nums">
              {words.days(row.original)}
            </span>
          ),
        }),
        column.accessor('used', {
          header: t('storefront.coupons.columns.used'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) => (
            <span className="whitespace-nowrap text-ink-2 tabular-nums">
              {words.used(row.original)}
            </span>
          ),
        }),
        column.accessor('status', {
          header: t('storefront.coupons.columns.status'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <CouponStatusPill status={getValue()} />,
        }),
        column.display({
          id: 'actions',
          header: () => <span className="sr-only">{t('storefront.coupons.columns.actions')}</span>,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => {
            const coupon = row.original;
            return (
              // The row opens the form on a click or Enter. React passes a menu's events up its
              // own tree, through the menu's portal too, so without this wrapper a click on the
              // button or on "Archive" also reached the row, and the Edit form opened in place of
              // the archive dialog (found by 27c.7's Playwright test). `contents`: the wrapper
              // draws no box
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
                      label={t('storefront.coupons.actions', { code: coupon.code })}
                      className="-my-1"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {coupon.status === 'archived' ? (
                      <DropdownMenuItem
                        icon={ArchiveRestoreIcon}
                        disabled={restoring}
                        onSelect={() => {
                          restoreCoupon(coupon);
                        }}
                      >
                        {t('storefront.coupons.restore')}
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem
                          icon={Edit02Icon}
                          onSelect={() => {
                            setActing({ kind: 'edit', coupon });
                          }}
                        >
                          {t('storefront.coupons.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          icon={Archive02Icon}
                          onSelect={() => {
                            setActing({ kind: 'archive', coupon });
                          }}
                        >
                          {t('storefront.coupons.archive')}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          },
        }),
      ]),
    [t, words, restoreCoupon, restoring],
  );

  const add = (
    <Button
      onClick={() => {
        setActing({ kind: 'new' });
      }}
    >
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('storefront.coupons.add')}
    </Button>
  );

  // Why the table is empty: a search that found nothing first (it looks in this tab only), then
  // the tab itself. Only the first tab offers Add coupon: an empty Archived tab is good news
  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('storefront.coupons.noMatchTitle')}
        description={t('storefront.coupons.noMatchBody')}
      />
    ) : view === 'archived' ? (
      <EmptyState
        icon={Archive02Icon}
        title={t('storefront.coupons.emptyArchivedTitle')}
        description={t('storefront.coupons.emptyArchivedBody')}
      />
    ) : (
      <EmptyState
        icon={CouponPercentIcon}
        title={t('storefront.coupons.emptyTitle')}
        description={t('storefront.coupons.emptyBody')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setActing({ kind: 'new' });
            }}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
            {t('storefront.coupons.add')}
          </Button>
        }
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.coupons.title')}
        description={t('storefront.coupons.description')}
        actions={
          online && (
            <>
              {shop !== null && <ViewShopLink href={shop.shopUrl} />}
              {add}
            </>
          )
        }
      />
      {!online && <StorefrontOffline />}
      {online && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-60 sm:max-w-80">
              <Input
                type="search"
                icon={Search01Icon}
                aria-label={t('storefront.coupons.searchLabel')}
                placeholder={t('storefront.coupons.searchPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </div>
            <SegmentedControl
              label={t('storefront.coupons.view')}
              value={view}
              options={STOREFRONT_COUPON_VIEWS.map((value) => ({
                value,
                label: t(`storefront.coupons.views.${value}`),
              }))}
              onChange={setView}
            />
          </div>
          {isError && (
            <p role="alert" className="text-body-sm text-crit">
              {t('storefront.coupons.loadFailed')}
            </p>
          )}
          {rows && (
            <DataTable
              label={t('storefront.coupons.title')}
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              // An archived coupon opens nothing: it is out of play, and Restore (its menu) comes
              // before a change
              onRowClick={
                view === 'current'
                  ? (coupon) => {
                      setActing({ kind: 'edit', coupon });
                    }
                  : undefined
              }
              onEndReached={loadMore}
              empty={empty}
              footer={
                isFetchingNextPage && (
                  <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                )
              }
            />
          )}
        </>
      )}
      {acting?.kind === 'archive' && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setActing(null);
          }}
        >
          <ArchiveDialog
            coupon={acting.coupon}
            onDone={() => {
              setActing(null);
            }}
          />
        </Dialog>
      )}
      {(acting?.kind === 'new' || acting?.kind === 'edit') && (
        // fallback null: the chunk comes in a moment, and an empty dialog frame would flash first
        <Suspense fallback={null}>
          <CouponDialog
            coupon={acting.kind === 'new' ? null : acting.coupon}
            onClose={() => {
              setActing(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
