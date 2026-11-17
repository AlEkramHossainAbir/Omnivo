import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  FileEditIcon,
  LinkSquare02Icon,
  MinusSignCircleIcon,
  Store04Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { StorefrontListingStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, cn, EmptyState, Pill } from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useTenantId } from '../lib/workspace';

// Step 26g: what the four Storefront pages share. Kept out of lib/storefront.ts so the lib (queries,
// form values) has no React and its spec runs without a DOM.

// After any save in the menu: every storefront read again (settings' checklist, the catalog, the
// categories' counts), because one change shows in several places
export function useStorefrontRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['storefront', tenantId] }),
    [queryClient, tenantId],
  );
}

// Decision 4: the shop's server keeps its answers for 30 seconds, so a save is not on the shop at
// once. Under every page's description, so nobody wonders why the shop still shows the old price
export function ShopLine() {
  const { t } = useLocale();
  return (
    <span className="mt-1.5 flex items-center gap-2 text-label text-ink-3">
      <HugeiconsIcon icon={Clock01Icon} size={14} strokeWidth={1.5} />
      {t('storefront.changesSoon')}
    </span>
  );
}

// The shop in a new tab. A link that looks like the secondary button: it goes to another site, so
// it is an <a> (middle-click, "copy link"), never a button with window.open.
// Step 26h: exported, with a small one, for the router's links that look like buttons ("Edit hero
// banner", "Add collection"): they go to another page, so they are links too
export const LINK_BUTTON =
  'inline-flex min-h-[42px] items-center justify-center gap-2 rounded-control border border-line-strong bg-surface px-4 text-body-sm font-medium whitespace-nowrap text-ink shadow-sm transition-colors duration-150 hover:bg-subtle';
export const LINK_BUTTON_SM =
  'inline-flex min-h-9 items-center justify-center gap-2 rounded-control border border-line-strong bg-surface px-3 text-body-sm font-medium whitespace-nowrap text-ink shadow-sm transition-colors duration-150 hover:bg-subtle';

export function ViewShopLink({
  href,
  label,
  className,
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  const { t } = useLocale();
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn(LINK_BUTTON, className)}>
      <HugeiconsIcon icon={LinkSquare02Icon} size={17} strokeWidth={1.5} />
      {label ?? t('storefront.viewShop')}
    </a>
  );
}

export function ListingStatusPill({ status }: { status: StorefrontListingStatus }) {
  const { t } = useLocale();
  return status === 'published' ? (
    <Pill tone="good" icon={Store04Icon}>
      {t('storefront.statuses.published')}
    </Pill>
  ) : (
    <Pill tone="neutral" icon={FileEditIcon}>
      {t('storefront.statuses.draft')}
    </Pill>
  );
}

// Step 26h: a text page in the footer or not (Shop pages and the page's editor)
export function PageStatusPill({ written }: { written: boolean }) {
  const { t } = useLocale();
  return written ? (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('storefront.pages.written')}
    </Pill>
  ) : (
    <Pill tone="neutral" icon={MinusSignCircleIcon}>
      {t('storefront.pages.notWritten')}
    </Pill>
  );
}

// null: the shop has no warehouse yet, so nobody knows
export function StockPill({ inStock }: { inStock: boolean | null }) {
  const { t } = useLocale();
  if (inStock === null) {
    return <span className="text-ink-3">{t('storefront.catalog.noWarehouse')}</span>;
  }
  return inStock ? (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('storefront.catalog.inStock')}
    </Pill>
  ) : (
    <Pill tone="warn" icon={Alert02Icon}>
      {t('storefront.catalog.outOfStock')}
    </Pill>
  );
}

// Every page of the menu reads and writes on the server (decision 5: online only)
export function StorefrontOffline() {
  const { t } = useLocale();
  return (
    <EmptyState
      icon={WifiDisconnected02Icon}
      title={t('sync.needsConnectionTitle')}
      description={t('storefront.needsConnection')}
    />
  );
}

// A shop price the way the counter shows money: whole taka, or with paisa when it has some
// ("৳229", "৳247.50"), so a price typed with paisa never looks rounded
export function useShopMoney(): (value: string) => string {
  const { format } = useLocale();
  return useCallback(
    (value: string) => {
      const paisa = /\.(\d+)$/.exec(value)?.[1] ?? '';
      return format.money(value, { decimals: /[1-9]/.test(paisa) ? 2 : 0 });
    },
    [format],
  );
}

// The bar under a long form while it has changes: the buttons stay in reach wherever the person
// scrolled (the roles page's bar). Sticky, so it sits at the end of the form when that is in view
export function SaveBar({
  saving,
  onDiscard,
  formId,
  blocked = false,
}: {
  saving: boolean;
  onDiscard: () => void;
  formId: string;
  // Save waits (a photo still uploading or being prepared)
  blocked?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-card border border-line bg-surface px-5 py-3 shadow-md">
      <p className="mr-auto text-body-sm text-ink-2">{t('storefront.unsaved')}</p>
      <Button variant="secondary" disabled={saving} onClick={onDiscard}>
        {t('storefront.discard')}
      </Button>
      <Button type="submit" form={formId} disabled={saving || blocked}>
        {saving ? t('common.saving') : t('common.save')}
      </Button>
    </div>
  );
}
