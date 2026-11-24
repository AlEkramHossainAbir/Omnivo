import {
  Alert02Icon,
  CancelCircleIcon,
  Clock01Icon,
  DeliveryBox01Icon,
  DeliveryDelay01Icon,
  DeliveryReturn01Icon,
  DeliveryTracking01Icon,
  DeliveryTruck01Icon,
  Loading03Icon,
  PackageDeliveredIcon,
  PackageMovingIcon,
  PackageReceiveIcon,
  PackageRemoveIcon,
  PrinterIcon,
  ShippingTruck01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  bookShipmentInputSchema,
  type BookShipmentFormValues,
  contractErrorMap,
  isZeroMoney,
  routes,
  type ShipmentStatus,
  type StorefrontOrder,
  type StorefrontShipment,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  DialogClose,
  DialogContent,
  FormAlert,
  Pill,
  SelectField,
  TextField,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { settingsQuery } from '../lib/queries';
import { parcelsNewestFirst, storefrontCourierChoicesQuery } from '../lib/storefront-orders';
import { useTenantId, useTimeZone } from '../lib/workspace';
import { useShopMoney } from './storefront-parts';

// Step 28a.6: a shop order's parcels on its page (approved with the mockup), the Book courier
// dialog and the parcel's label. A file of its own, loaded with the order page: the list never
// shows a parcel, and the Packed dialog only needs the choices query.

// The pill of each of the twelve statuses (approved with the mockup). Work on its way is brand, as
// the order's own pills (CLAUDE.md → Sales document statuses); delivered is good; a failed booking
// is crit, because nothing moves until someone books it again; warn for what the shop must act on
// (the courier holds it, it comes back, part of it came back); over and done is neutral. The
// courier's news on the card use the same icons, so a step reads the same in both places
export const PARCEL_PILLS = {
  booking: { tone: 'brand', icon: Clock01Icon },
  booking_failed: { tone: 'crit', icon: Alert02Icon },
  booked: { tone: 'brand', icon: DeliveryBox01Icon },
  picked_up: { tone: 'brand', icon: PackageMovingIcon },
  in_transit: { tone: 'brand', icon: DeliveryTruck01Icon },
  out_for_delivery: { tone: 'brand', icon: DeliveryTracking01Icon },
  delivered: { tone: 'good', icon: PackageDeliveredIcon },
  partly_delivered: { tone: 'warn', icon: PackageRemoveIcon },
  on_hold: { tone: 'warn', icon: DeliveryDelay01Icon },
  returning: { tone: 'warn', icon: DeliveryReturn01Icon },
  returned: { tone: 'neutral', icon: PackageReceiveIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
} as const satisfies Record<
  ShipmentStatus,
  { tone: 'brand' | 'good' | 'warn' | 'crit' | 'neutral'; icon: IconSvgElement }
>;

export function ParcelPill({ status }: { status: ShipmentStatus }) {
  const { t } = useLocale();
  const pill = PARCEL_PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`storefront.order.parcels.statuses.${status}`)}
    </Pill>
  );
}

// What the rider collects, as the shop writes money (paisa only when there is some), or that the
// order is paid. A label always shows paisa: its own formatting is in ParcelLabel
function useCollect(): (amount: string) => string {
  const { t, format } = useLocale();
  return (amount) => {
    if (isZeroMoney(amount)) return t('storefront.order.parcels.codNothing');
    const paisa = /\.(\d+)$/.exec(amount)?.[1] ?? '';
    return format.money(amount, { decimals: /[1-9]/.test(paisa) ? 2 : 0 });
  };
}

function Fact({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-caption text-ink-3">{label}</dt>
      <dd
        className={cn(
          'text-body-sm break-words text-ink tabular-nums',
          mono && 'font-mono text-[13px]',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function ParcelCard({
  parcel,
  title,
  onPrint,
}: {
  parcel: StorefrontShipment;
  title: string;
  onPrint: (parcel: StorefrontShipment) => void;
}) {
  const { t, format, errorText } = useLocale();
  const timeZone = useTimeZone();
  const collect = useCollect();
  const money = useShopMoney();
  const when = (iso: string) => format.dateTime(new Date(iso), timeZone);
  const byApi = parcel.account.provider !== 'manual';
  const courier = t(`storefront.couriers.names.${parcel.courier}`);
  // The courier's news, newest first like the shop's tracking page (approved with the mockup).
  // Only an API parcel has news; a manual one moves with the order's buttons
  const events = [...parcel.events].reverse();

  const facts: { label: string; value: ReactNode; mono?: boolean }[] = [];
  if (parcel.trackingCode !== null) {
    facts.push({ label: t('storefront.order.parcels.courier'), value: courier });
    facts.push({
      label: t('storefront.order.parcels.trackingCode'),
      value: parcel.trackingCode,
      mono: true,
    });
  }
  if (parcel.consignmentId !== null) {
    facts.push({
      label: t('storefront.order.parcels.consignmentId'),
      value: parcel.consignmentId,
      mono: true,
    });
  }
  facts.push({ label: t('storefront.order.parcels.cod'), value: collect(parcel.codAmount) });
  // Step 28b (decision 5, approved with the mockup): what the courier's notice said, or what the
  // member typed at Delivered, beside what the rider was to collect. As the shop writes money
  // (paisa only when there is some); zero is real (nothing collected), so money(), not collect()
  if (parcel.collectedAmount !== null) {
    facts.push({
      label: t('storefront.order.parcels.collected'),
      value: money(parcel.collectedAmount),
    });
  }
  if (parcel.courierCharge !== null) {
    facts.push({ label: t('storefront.order.parcels.charge'), value: money(parcel.courierCharge) });
  }
  // Decision 4: the COD receipt, as a link (every member reads the sales documents)
  if (parcel.receipt !== null) {
    facts.push({
      label: t('storefront.order.parcels.receipt'),
      value: (
        <Link
          to="/receipts/$receiptId"
          params={{ receiptId: parcel.receipt.id }}
          className="font-mono text-[13px] font-medium text-brand underline-offset-3 hover:underline"
        >
          {parcel.receipt.number ?? '—'}
        </Link>
      ),
    });
  }
  if (parcel.bookedAt !== null) {
    facts.push({ label: t('storefront.order.parcels.bookedAt'), value: when(parcel.bookedAt) });
    if (byApi) {
      facts.push({
        label: t('storefront.order.parcels.lastSynced'),
        value:
          parcel.lastSyncedAt === null
            ? t('storefront.order.parcels.neverSynced')
            : when(parcel.lastSyncedAt),
      });
    }
  }

  return (
    <Card className="overflow-hidden">
      {/* CardHeader's own markup: its title is text only, and the pill sits beside the title */}
      <header className="flex items-start justify-between gap-4 px-5 pt-[18px]">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-h3">
            {title}
            <ParcelPill status={parcel.status} />
          </h3>
          <p className="text-label text-ink-3">
            {t('storefront.order.parcels.description', { account: parcel.account.name })}
          </p>
        </div>
        {/* A label needs the courier's code; a cancelled parcel goes nowhere */}
        {parcel.trackingCode !== null && parcel.status !== 'cancelled' && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => {
              onPrint(parcel);
            }}
          >
            <HugeiconsIcon icon={PrinterIcon} size={16} strokeWidth={1.5} />
            {t('storefront.order.parcels.printLabel')}
          </Button>
        )}
      </header>
      <div className="grid gap-1.5 px-5 pt-3.5 pb-[18px]">
        {parcel.status === 'booking' && (
          // role=status: the worker books it in a moment, and the page asks again (28a.6's
          // refetchInterval on the order), so a screen reader hears when it moves on
          <div role="status" className="grid gap-1">
            <p className="flex items-center gap-2 text-body-sm font-medium text-brand">
              <HugeiconsIcon
                icon={Loading03Icon}
                size={17}
                strokeWidth={1.5}
                className="motion-safe:animate-spin"
              />
              {t('storefront.order.parcels.bookingNow', { courier: parcel.account.name })}
            </p>
            {parcel.attempts > 0 && (
              <p className="text-caption text-ink-3">
                {t('storefront.order.parcels.bookingRetry', {
                  count: parcel.attempts,
                  formatted: format.number(parcel.attempts),
                })}
              </p>
            )}
          </div>
        )}
        {parcel.status === 'booking_failed' && (
          <p className="flex items-start gap-1.5 text-label text-crit">
            <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-0.5" />
            <span>
              {/* The courier's own words say what to fix ("Invalid phone number"); without them,
                  our error's words */}
              {parcel.errorDetail !== null
                ? t('storefront.order.parcels.courierSaid', { detail: parcel.errorDetail })
                : errorText(parcel.error ?? 'unknown_error')}
            </span>
          </p>
        )}
        {/* Step 28b (mine 14, approved with the mockup): the COD receipt's error sits on its
            parcel. The button is in the page's notice ("Make the receipt"), as Book again is */}
        {parcel.receiptError !== null && (
          <p className="flex items-start gap-1.5 text-label text-crit">
            <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-0.5" />
            <span>
              {t('storefront.order.parcels.receiptError', {
                reason: errorText(parcel.receiptError),
              })}
            </span>
          </p>
        )}
        {!byApi && parcel.status === 'booked' && (
          <p className="text-body-sm text-ink-2">{t('storefront.order.parcels.manual')}</p>
        )}
        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {facts.map((fact) => (
            <Fact
              key={fact.label}
              label={fact.label}
              value={fact.value}
              mono={fact.mono ?? false}
            />
          ))}
        </dl>
      </div>
      {byApi && parcel.bookedAt !== null && (
        <section className="border-t border-line px-5 pt-3.5 pb-1">
          <h4 className="text-label font-medium text-ink">
            {t('storefront.order.parcels.eventsTitle')}
          </h4>
          {events.length === 0 ? (
            <p className="pt-1 pb-4 text-caption text-ink-3">
              {t('storefront.order.parcels.noEvents')}
            </p>
          ) : (
            // The order's Timeline card's look: 24px dots, a 1px line, the newest on brand-soft
            <ol className="grid pt-2.5 pb-4">
              {events.map((event, index) => (
                <li
                  key={`${event.at}-${event.status}-${String(index)}`}
                  className="relative grid grid-cols-[24px_1fr] gap-3 pb-4 last:pb-0"
                >
                  {index < events.length - 1 && (
                    <span className="absolute top-7 bottom-1 left-[11.5px] w-px bg-line" />
                  )}
                  <span
                    className={cn(
                      'grid size-6 place-items-center rounded-full',
                      index === 0 ? 'bg-brand-soft text-brand' : 'bg-subtle text-ink-3',
                    )}
                  >
                    <HugeiconsIcon
                      icon={PARCEL_PILLS[event.status].icon}
                      size={14}
                      strokeWidth={1.5}
                    />
                  </span>
                  <span className="grid">
                    <span className="text-body-sm font-medium text-ink">
                      {t(`storefront.order.parcels.statuses.${event.status}`)}
                    </span>
                    <span className="text-caption text-ink-3 tabular-nums">{when(event.at)}</span>
                    {event.note !== null && (
                      <span className="text-body-sm text-ink-2">{event.note}</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </Card>
  );
}

// One card per parcel, newest first. "Parcel" alone for the usual one; numbered once there are
// more, by their place (1 = the first), so "Parcel 2" sits above "Parcel 1"
export function ParcelCards({
  order,
  onPrint,
}: {
  order: StorefrontOrder;
  onPrint: (parcel: StorefrontShipment) => void;
}) {
  const { t } = useLocale();
  const many = order.shipments.length > 1;
  const count = order.shipments.length;
  return (
    <div className="grid gap-5">
      {parcelsNewestFirst(order).map((parcel, index) => (
        <ParcelCard
          key={parcel.id}
          parcel={parcel}
          title={
            many
              ? t('storefront.order.parcels.titleNumber', { number: count - index })
              : t('storefront.order.parcels.title')
          }
          onPrint={onPrint}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Book courier

// The form keeps the tracking code as typed: the schema upper-cases it on the way out, so the box
// does not jump while typing. The account's '' is "Pick an account" (courier_pick_account)
const BOOK_FIELDS = ['accountId', 'trackingCode'] as const;

export function BookCourierDialog({
  order,
  onDone,
}: {
  order: StorefrontOrder;
  onDone: (saved: StorefrontOrder, toast: string) => void;
}) {
  const { t } = useLocale();
  const collect = useCollect();
  const choices = useQuery(storefrontCourierChoicesQuery(useTenantId()));
  const accounts = choices.data?.accounts ?? [];
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<BookShipmentFormValues>({
    resolver: zodResolver(bookShipmentInputSchema, { error: contractErrorMap }),
    // The default account first, like the Packed dialog (decision 13); none = pick one
    values: {
      version: order.version,
      accountId: choices.data?.defaultAccountId ?? '',
      trackingCode: '',
    },
    resetOptions: { keepDirtyValues: true },
  });
  const accountId = useWatch({ control, name: 'accountId' });
  const account = accounts.find((one) => one.id === accountId) ?? null;
  const manual = account?.provider === 'manual';

  const onSubmit = handleSubmit(async (values) => {
    try {
      // A code for an API account is ignored by the API; send none, so nothing typed before the
      // account changed travels
      const body = manual ? values : { ...values, trackingCode: '' };
      const saved = await call(routes.storefrontOrders.bookShipment, {
        params: { id: order.id },
        body,
      });
      const parcel = saved.shipments.at(-1);
      const name = account?.name ?? '';
      onDone(
        saved,
        parcel?.trackingCode !== null && parcel?.trackingCode !== undefined && manual
          ? t('storefront.order.booked', {
              number: saved.orderNo,
              courier: name,
              code: parcel.trackingCode,
            })
          : t('storefront.order.bookingStarted', { number: saved.orderNo, courier: name }),
      );
    } catch (error) {
      applyApiError(error, BOOK_FIELDS, setError);
    }
  });
  const serverError = errors.root?.server?.message;

  return (
    <DialogContent
      title={t('storefront.order.booking.title', { number: order.orderNo })}
      description={
        isZeroMoney(order.codAmount)
          ? t('storefront.order.booking.descriptionPaid')
          : t('storefront.order.booking.description', { amount: collect(order.codAmount) })
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            type="submit"
            form="book-courier"
            disabled={isSubmitting || accounts.length === 0}
          >
            {t('storefront.order.booking.submit')}
          </Button>
        </>
      }
    >
      <form
        id="book-courier"
        noValidate
        className="grid gap-[18px]"
        onSubmit={(event) => void onSubmit(event)}
      >
        {serverError !== undefined && <FormAlert message={serverError} />}
        {choices.isError && <FormAlert message="unknown_error" />}
        {choices.data && accounts.length === 0 ? (
          <p className="text-body-sm text-ink-2">{t('storefront.order.booking.noAccounts')}</p>
        ) : (
          <SelectField
            label={t('storefront.order.booking.account')}
            icon={ShippingTruck01Icon}
            options={[
              { value: '', label: t('storefront.order.booking.accountPlaceholder') },
              ...accounts.map((one) => ({
                value: one.id,
                label: t('storefront.order.booking.accountOption', {
                  name: one.name,
                  courier: t(`storefront.couriers.names.${one.courier}`),
                }),
              })),
            ]}
            hint={
              account !== null && !manual
                ? t('storefront.order.booking.apiHint', {
                    courier: t(`storefront.couriers.names.${account.courier}`),
                  })
                : undefined
            }
            {...register('accountId')}
            error={errors.accountId?.message}
          />
        )}
        {manual && (
          <TextField
            label={t('storefront.order.booking.trackingCode')}
            icon={DeliveryTracking01Icon}
            placeholder={t('storefront.order.booking.trackingCodePlaceholder')}
            autoComplete="off"
            spellCheck={false}
            hint={t('storefront.order.booking.trackingCodeHint')}
            {...register('trackingCode')}
            error={errors.trackingCode?.message}
          />
        )}
      </form>
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------------------------
// The label

// The parcel's label (approved with the mockup): an A6 sheet (105 × 148 mm), which is a 4 × 6 in
// thermal label's size and a quarter of A4. Black on white with no fills, like the POS receipt. Like
// PrintSheet it goes straight into <body> with data-print-sheet, so styles.css prints it and nothing
// else; its own @page wins while it is there, and goes with it. It prints once when it mounts, then
// tells the page it is done (window.print() waits for the dialog), so the page unmounts it. No
// barcode: the courier prints its own label from its panel; this one is for the shop's own shelf
// and for a courier booked by hand.
export function ParcelLabel({
  order,
  parcel,
  onPrinted,
}: {
  order: StorefrontOrder;
  parcel: StorefrontShipment;
  onPrinted: () => void;
}) {
  const { t, format } = useLocale();
  const settings = useQuery(settingsQuery(useTenantId())).data;
  const printed = useRef(false);
  useEffect(() => {
    // The company comes first: printing before it arrives would print a label with no sender.
    // The ref: React's second run of the effect in development must not print twice
    if (settings === undefined || printed.current) return;
    printed.current = true;
    window.print();
    onPrinted();
  }, [settings, onPrinted]);
  if (settings === undefined) return null;
  const courier = t(`storefront.couriers.names.${parcel.courier}`);
  return createPortal(
    <article
      data-print-sheet=""
      aria-label={t('storefront.order.label.title', { number: order.orderNo })}
      className="hidden h-[148mm] w-[105mm] bg-surface p-[6mm] text-ink print:block"
    >
      <style>{'@page { size: A6; margin: 0; }'}</style>
      <div className="grid content-start gap-3.5 text-[13px] leading-snug">
        <p className="border-b-2 border-ink pb-2.5 font-mono text-[18px] font-medium">
          {t('storefront.order.label.courierLine', { courier, code: parcel.trackingCode ?? '' })}
        </p>
        <p className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] font-semibold tracking-wide uppercase">
            {t('storefront.order.label.order')}
          </span>
          <span className="font-mono text-[16px] font-medium">{order.orderNo}</span>
        </p>
        <div className="grid gap-0.5">
          <span className="text-[10px] font-semibold tracking-wide uppercase">
            {t('storefront.order.label.to')}
          </span>
          <span className="text-[16px] font-semibold">{order.customerName}</span>
          <span className="tabular-nums">{order.phone}</span>
          {/* The address keeps the shopper's own line breaks */}
          <span className="whitespace-pre-line">{order.address}</span>
          <span>{order.zoneName}</span>
        </div>
        {/* Always with paisa (decision 20's amount, as the courier was told): it is printed */}
        <p className="border-2 border-ink p-2.5 text-center text-[20px] font-semibold tabular-nums">
          {isZeroMoney(parcel.codAmount)
            ? t('storefront.order.label.paid')
            : t('storefront.order.label.collect', {
                amount: format.money(parcel.codAmount, { decimals: 2 }),
              })}
        </p>
        <div className="grid gap-0.5 border-t border-ink pt-2.5 text-[11.5px]">
          <span className="text-[10px] font-semibold tracking-wide uppercase">
            {t('storefront.order.label.from')}
          </span>
          <span className="text-[13px] font-semibold">
            {settings.legalName ?? settings.companyName}
          </span>
          {settings.address !== null && (
            <span className="whitespace-pre-line">{settings.address}</span>
          )}
          {settings.phone !== null && <span className="tabular-nums">{settings.phone}</span>}
        </div>
      </div>
    </article>,
    document.body,
  );
}
