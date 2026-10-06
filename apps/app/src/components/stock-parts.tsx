import {
  Alert02Icon,
  ArrowLeft01Icon,
  CheckmarkCircle02Icon,
  DeliveryTruck01Icon,
  FileEditIcon,
  HourglassIcon,
  PackageDeliveredIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  DEFAULT_SETTINGS,
  todayIn,
  type StockDocumentStatus,
  type TransferStatus,
  type VariantRef,
  type Warehouse,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { parseIsoDate, Pill } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import { settingsQuery, unitsQuery, warehousesQuery } from '../lib/queries';
import { useSession } from '../lib/session-store';
import { daysUntil, expiryTone, variantName } from '../lib/stock';

// Shared by the stock pages and forms. Here, not in a route file: a route file is its own lazy
// chunk, and importing from one would pull that whole page into the others.

export function useTenantId(): string {
  return useSession((state) => state.me?.tenant.id) ?? '';
}

// "72 pcs", "2.74 m": a quantity with its unit's decimals and code, in the reader's digits. The
// units are a small list every product page already loaded.
export function useQuantity(): (value: string, unitId: string) => string {
  const { format } = useLocale();
  const units = useQuery(unitsQuery(useTenantId())).data;
  return useCallback(
    (value: string, unitId: string) => {
      const unit = units?.find((candidate) => candidate.id === unitId);
      return unit === undefined
        ? format.number(value, 0)
        : `${format.number(value, unit.decimals)} ${unit.code}`;
    },
    [units, format],
  );
}

// "case", "pcs": a unit's code, for "Cost per case" (step 14)
export function useUnitCode(): (unitId: string) => string {
  const units = useQuery(unitsQuery(useTenantId())).data;
  return useCallback(
    (unitId: string) => units?.find((unit) => unit.id === unitId)?.code ?? '',
    [units],
  );
}

// Every warehouse, archived ones too (old documents point at them), by id; and the active ones,
// for the forms' selects
export function useWarehouses(): {
  active: Warehouse[] | undefined;
  byId: Map<string, Warehouse>;
} {
  const tenantId = useTenantId();
  const active = useQuery(warehousesQuery(tenantId, 'active')).data;
  const archived = useQuery(warehousesQuery(tenantId, 'archived')).data;
  const byId = useMemo(
    () => new Map([...(active ?? []), ...(archived ?? [])].map((place) => [place.id, place])),
    [active, archived],
  );
  return { active, byId };
}

export function warehouseLabel(place: Warehouse | undefined): string {
  return place === undefined ? '—' : `${place.code} · ${place.name}`;
}

// "Today" in the company's time zone: the forms' default date, and the expiry countdown
export function useToday(): string {
  const timeZone =
    useQuery(settingsQuery(useTenantId())).data?.timezone ?? DEFAULT_SETTINGS.timezone;
  return todayIn(timeZone);
}

// After a posting: everything under ['stock', tenant] — the list, the cards, the reports and the
// documents — is fetched again. And from step 14 the books too (['journal', tenant]): a posting
// writes a journal entry, which changes the ledgers, the trial balance and the balance sheet.
export function useStockRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['stock', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
    ]);
  }, [queryClient, tenantId]);
}

// "৳3,600.00": a value on a stock document, with paisa — the journal entry it made shows them too,
// and both must visibly agree. null (no permission, or no cost yet) is a dash.
export function useValue(): (value: string | null) => string {
  const { format } = useLocale();
  return useCallback(
    (value: string | null) => (value === null ? '—' : format.money(value, { decimals: 2 })),
    [format],
  );
}

// A variant in a table: the product's name and values, and the code and SKU underneath
export function VariantCell({ item }: { item: VariantRef }) {
  return (
    <span className="grid max-w-[24rem] min-w-0">
      <span className="truncate font-medium text-ink">{variantName(item)}</span>
      <span className="truncate font-mono text-caption text-ink-3">{item.sku}</span>
    </span>
  );
}

export function AdjustmentStatusPill({ status }: { status: StockDocumentStatus }) {
  const { t } = useLocale();
  return status === 'draft' ? (
    <Pill tone="neutral" icon={FileEditIcon}>
      {t('adjustments.statuses.draft')}
    </Pill>
  ) : (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('adjustments.statuses.posted')}
    </Pill>
  );
}

// Draft, In transit (still on the road: attention), Received — and a separate "Short" pill when
// less arrived than was sent
export function TransferStatusPills({
  transfer,
}: {
  transfer: { status: TransferStatus; short: boolean };
}) {
  const { t } = useLocale();
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {transfer.status === 'draft' && (
        <Pill tone="neutral" icon={FileEditIcon}>
          {t('transfers.statuses.draft')}
        </Pill>
      )}
      {transfer.status === 'in_transit' && (
        <Pill tone="warn" icon={DeliveryTruck01Icon}>
          {t('transfers.statuses.in_transit')}
        </Pill>
      )}
      {transfer.status === 'received' && (
        <Pill tone="good" icon={PackageDeliveredIcon}>
          {t('transfers.statuses.received')}
        </Pill>
      )}
      {transfer.short && (
        <Pill tone="crit" icon={Alert02Icon}>
          {t('transfers.shortPill')}
        </Pill>
      )}
    </span>
  );
}

// Expired (crit), a month or less left (warn), or just the date. Never colour alone.
export function ExpiryPill({ expiresOn, today }: { expiresOn: string | null; today: string }) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  if (expiresOn === null) {
    return <span className="text-ink-3">{t('expiry.noExpiry')}</span>;
  }
  const tone = expiryTone(expiresOn, today);
  if (tone === 'neutral') return <span className="tabular-nums">{isoDate(expiresOn)}</span>;
  const days = daysUntil(expiresOn, today);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="tabular-nums">{isoDate(expiresOn)}</span>
      <Pill tone={tone} icon={HourglassIcon}>
        {days < 0 ? t('expiry.expired') : t('expiry.daysLeft', { count: days })}
      </Pill>
    </span>
  );
}

// "23 Sep 2026" from "2026-09-23", read with local date parts, never as UTC (the journal's helper,
// again here so the stock chunks do not load the journal's parts)
export function useIsoDate(): (iso: string) => string {
  const { format } = useLocale();
  return useCallback(
    (iso: string) => {
      const date = parseIsoDate(iso);
      return date ? format.date(date) : iso;
    },
    [format],
  );
}

export function BackLink({
  to,
  label,
}: {
  to:
    | '/stock'
    | '/stock/adjustments'
    | '/stock/transfers'
    | '/stock/valuation'
    | '/stock/revaluations';
  label: string;
}) {
  return (
    <Link
      to={to}
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {label}
    </Link>
  );
}
