import {
  CallIncoming01Icon,
  Files01Icon,
  LegalDocument01Icon,
  SecurityCheckIcon,
  Store01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { type ShopTextPageSlug, type StorefrontPageSummary, todayIn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DataTable, dataTableColumns, EmptyState, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';

import {
  PageStatusPill,
  ShopLine,
  StorefrontOffline,
  ViewShopLink,
} from '../components/storefront-parts';
import { storefrontSetupQuery } from '../lib/storefront';
import { storefrontPagesQuery } from '../lib/storefront-appearance';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 26h: the four text pages the shop's footer links (decision 5): always the four, in the
// footer's order, written or not. A page not written is left out of the footer, so the list says
// which are in it. A row opens the page's editor.

// One icon per page, so the four rows read apart at a glance (approved with the mockup)
const PAGE_ICONS: Readonly<Record<ShopTextPageSlug, IconSvgElement>> = {
  privacy: SecurityCheckIcon,
  terms: LegalDocument01Icon,
  about: Store01Icon,
  contact: CallIncoming01Icon,
};

const column = dataTableColumns<StorefrontPageSummary>();

export function StorefrontPagesPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const online = useOnline();
  const navigate = useNavigate();
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const pages = useQuery({ ...storefrontPagesQuery(tenantId), enabled: online && shop !== null });

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('slug', {
          header: t('storefront.pages.columns.page'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ getValue }) => (
            <span className="flex min-w-0 items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
                <HugeiconsIcon icon={PAGE_ICONS[getValue()]} size={16} strokeWidth={1.5} />
              </span>
              <span className="grid min-w-0">
                <span className="truncate font-medium text-ink">
                  {t(`storefront.pages.names.${getValue()}`)}
                </span>
                <span className="text-caption font-normal text-ink-3">
                  {t(`storefront.pages.hints.${getValue()}`)}
                </span>
              </span>
            </span>
          ),
        }),
        column.accessor('version', {
          id: 'status',
          header: t('storefront.pages.columns.status'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <PageStatusPill written={getValue() !== null} />,
        }),
        column.accessor('sectionCount', {
          header: t('storefront.pages.columns.sections'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row, getValue }) =>
            row.original.version === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="text-ink-2 tabular-nums">
                {t('storefront.pages.sections', {
                  count: getValue(),
                  formatted: format.number(getValue()),
                })}
              </span>
            ),
        }),
        column.accessor('updatedAt', {
          header: t('storefront.pages.columns.updated'),
          enableSorting: false,
          meta: { card: 'detail' },
          // The day in the workspace's time zone, like every other list's date
          cell: ({ getValue }) => {
            const value = getValue();
            return value === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="text-ink-2 tabular-nums">
                {format.date(new Date(`${todayIn(timeZone, new Date(value))}T00:00:00`))}
              </span>
            );
          },
        }),
        column.display({
          id: 'action',
          header: () => <span className="sr-only">{t('storefront.pages.columns.actions')}</span>,
          meta: { align: 'end', card: 'trailing' },
          // A real link too: the row's click is for the mouse, the link is for the keyboard
          cell: ({ row }) => (
            <Link
              to="/storefront/pages/$slug"
              params={{ slug: row.original.slug }}
              onClick={(event) => {
                event.stopPropagation();
              }}
              className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
            >
              {row.original.version === null
                ? t('storefront.pages.write')
                : t('storefront.pages.edit')}
              <span className="sr-only">: {t(`storefront.pages.names.${row.original.slug}`)}</span>
            </Link>
          ),
        }),
      ]),
    [t, format, timeZone],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.pages.title')}
        description={
          <>
            {t('storefront.pages.description')}
            {shop !== null && <ShopLine />}
          </>
        }
        actions={shop !== null && <ViewShopLink href={shop.shopUrl} />}
      />
      {!online && <StorefrontOffline />}
      {online && (setup.isError || pages.isError) && (
        <p className="text-body-sm text-crit">{t('storefront.pages.loadFailed')}</p>
      )}
      {online && setup.data && shop === null && (
        <EmptyState
          icon={Files01Icon}
          title={t('storefront.pages.notSetUpTitle')}
          description={t('storefront.pages.notSetUpBody')}
          action={
            <Button
              onClick={() => {
                void navigate({ to: '/storefront/settings' });
              }}
            >
              {t('storefront.pages.goToSettings')}
            </Button>
          }
        />
      )}
      {online && pages.data && (
        <DataTable
          label={t('storefront.pages.title')}
          data={pages.data}
          columns={columns}
          getRowId={(row) => row.slug}
          onRowClick={(row) =>
            void navigate({ to: '/storefront/pages/$slug', params: { slug: row.slug } })
          }
        />
      )}
    </div>
  );
}
