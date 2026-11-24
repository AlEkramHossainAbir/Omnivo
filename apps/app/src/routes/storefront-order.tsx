import {
  Agreement01Icon,
  Alert02Icon,
  AlertCircleIcon,
  ArrowLeft01Icon,
  CancelCircleIcon,
  CreditCardAcceptIcon,
  DeliveryTruck01Icon,
  Image01Icon,
  PackageDeliveredIcon,
  PackageIcon,
  PackageReceiveIcon,
  ShippingTruck01Icon,
  ShoppingCart01Icon,
  SmartPhone01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  cancelStorefrontOrderInputSchema,
  contractErrorMap,
  type DocumentRef,
  isZeroMoney,
  routes,
  type ShopOrderStatus,
  type StorefrontOrder,
  type StorefrontOrderLine,
  type StorefrontShipment,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  TextAreaField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';

import { CancelDraftDialog } from '../components/cancel-draft-dialog';
import { DocumentNotice } from '../components/document-notice';
import {
  BookCourierDialog,
  ParcelCards,
  ParcelLabel,
} from '../components/storefront-order-parcels';
import { NeedsAttentionPill, OrderStatusPill } from '../components/storefront-order-pills';
import {
  invoiceTookPayment,
  PaymentsCard,
  refundCase,
  RefundNotice,
} from '../components/storefront-order-payments';
import { StorefrontOffline, useShopMoney } from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import {
  canBook,
  canCancel,
  nextStep,
  openParcel,
  type OrderStep,
  parcelFailed,
  storefrontOrderQuery,
} from '../lib/storefront-orders';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 27b: one shop order (decision 10). The next step's button and Cancel in the header, a
// notice that says what the button does, the lines and the timeline on the left, the shopper and
// the documents the order made in a 340px column. On a phone the cards stack in the order a packer
// reads them: lines, address, documents, timeline. Online only, like the whole menu.

// The Packed dialog has a form with nested lists; most visits to an order never open it, so it is
// its own chunk, loaded when "Mark packed" is pressed
const PackDialog = lazy(() =>
  import('../components/storefront-pack-dialog').then((module) => ({
    default: module.PackDialog,
  })),
);

// The timeline's icon per status, the same pictures as the status pills, plus the shop's own two
// steps: the cart for the moment it was placed, the phone for the code
const STEP_ICONS = {
  pending: ShoppingCart01Icon,
  confirmed: SmartPhone01Icon,
  packed: PackageIcon,
  shipped: DeliveryTruck01Icon,
  delivered: PackageDeliveredIcon,
  cancelled: CancelCircleIcon,
  returned: PackageReceiveIcon,
} as const satisfies Record<ShopOrderStatus, IconSvgElement>;

// Step 27d: an online order is confirmed by its payment, not by a code. A cash on delivery order
// keeps the phone's step even when a try was paid later (the code confirmed it)
function stepOf(order: StorefrontOrder, status: ShopOrderStatus) {
  return status === 'confirmed' && order.paymentMethod === 'online'
    ? ({ word: 'confirmedOnline', icon: CreditCardAcceptIcon } as const)
    : { word: status, icon: STEP_ICONS[status] };
}

const STEP_BUTTONS = {
  makeSalesOrder: Agreement01Icon,
  pack: PackageIcon,
  ship: DeliveryTruck01Icon,
  deliver: PackageDeliveredIcon,
} as const satisfies Record<OrderStep, IconSvgElement>;

type Dialogs = 'pack' | 'deliver' | 'cancel' | 'book' | null;

// After a move: the order's own answer at once, then every read the move changed. The orders (the
// list, the sidebar's count), and the sales, stock, books and customers, because Packed posts a
// challan and Delivered an invoice. The same keys useSalesRefresh() refreshes, without importing
// the sales pages' shared file into this chunk
function useApplyMove(): (saved: StorefrontOrder) => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(
    async (saved: StorefrontOrder) => {
      queryClient.setQueryData(storefrontOrderQuery(tenantId, saved.id).queryKey, saved);
      await Promise.all(
        ['storefront', 'sales', 'stock', 'journal', 'customers'].map((area) =>
          queryClient.invalidateQueries({
            queryKey: [area, tenantId],
            // Not the Packed dialog's plan: it is asked again each time the dialog opens (gcTime
            // 0), and refreshed here, while the dialog is still open, it would ask for the plan
            // of an order that is packed now, which the API refuses (409)
            predicate: (query) => query.queryKey[3] !== 'pack-plan',
          }),
        ),
      );
    },
    [queryClient, tenantId],
  );
}

function BackLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/storefront/orders"
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {t('storefront.order.back')}
    </Link>
  );
}

function Thumb({ line }: { line: StorefrontOrderLine }) {
  const { t } = useLocale();
  return line.image === null ? (
    <span
      title={t('storefront.order.noPhoto')}
      className="grid size-10 shrink-0 place-items-center rounded-lg bg-subtle text-ink-3"
    >
      <HugeiconsIcon icon={Image01Icon} size={16} strokeWidth={1.5} />
    </span>
  ) : (
    <img
      src={line.image.url}
      alt=""
      className="size-10 shrink-0 rounded-lg border border-line bg-surface object-contain"
    />
  );
}

function LinesCard({ order }: { order: StorefrontOrder }) {
  const { t, format } = useLocale();
  const money = useShopMoney();
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t('storefront.order.linesTitle')} />
      <ul className="mt-3">
        {order.lines.map((line) => (
          <li
            key={line.position}
            // Phone: the photo and the name on one row, the quantity and the amount under the
            // name. From sm the four share a row, the amounts lined up at the right
            className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-t border-line px-5 py-3 sm:grid-cols-[40px_minmax(0,1fr)_auto_96px] sm:gap-x-5"
          >
            <Thumb line={line} />
            <span className="col-span-2 grid min-w-0 sm:col-span-1">
              <span className="text-body-sm font-medium text-ink">{line.name}</span>
              <span className="truncate text-caption text-ink-3">
                <span className="font-mono">{line.sku}</span>
                {line.packSize !== '' && ` · ${line.packSize}`}
              </span>
            </span>
            <span className="col-start-2 text-body-sm text-ink-2 tabular-nums sm:col-start-3 sm:row-start-1 sm:text-right">
              {t('storefront.order.lineQuantity', {
                quantity: `${format.number(line.quantity)} ${line.unitCode}`,
                price: money(line.unitPrice),
              })}
            </span>
            <span className="text-right text-body-sm font-medium tabular-nums sm:col-start-4 sm:row-start-1">
              {money(line.lineTotal)}
            </span>
          </li>
        ))}
      </ul>
      <dl className="grid gap-2 border-t border-line bg-subtle px-5 py-4 text-body-sm tabular-nums">
        <div className="flex justify-between gap-4 text-ink-2">
          <dt>{t('storefront.order.subtotal')}</dt>
          <dd>{money(order.subtotal)}</dd>
        </div>
        {/* A coupon (27c) only; without one there is no discount line at all */}
        {!isZeroMoney(order.discount) && (
          <div className="flex justify-between gap-4 text-ink-2">
            <dt>
              {order.couponCode === null
                ? t('storefront.order.discount')
                : t('storefront.order.discountCode', { code: order.couponCode })}
            </dt>
            <dd>−{money(order.discount)}</dd>
          </div>
        )}
        <div className="flex justify-between gap-4 text-ink-2">
          <dt>{t('storefront.order.deliveryCharge')}</dt>
          {/* Zero is the shop's free delivery (its threshold), so it says so, as the shop did */}
          <dd>
            {isZeroMoney(order.deliveryCharge)
              ? t('storefront.order.free')
              : money(order.deliveryCharge)}
          </dd>
        </div>
        <div className="mt-1 flex justify-between gap-4 border-t border-line pt-3 font-medium text-ink">
          <dt>{t('storefront.order.total')}</dt>
          <dd>{money(order.total)}</dd>
        </div>
      </dl>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-caption font-medium text-ink-3">{label}</dt>
      <dd className="text-body-sm text-ink">{children}</dd>
    </div>
  );
}

// Decision 37: what the shopper typed, then the ERP customer the phone found or made
function ShopperCard({ order }: { order: StorefrontOrder }) {
  const { t } = useLocale();
  return (
    <Card>
      <CardHeader title={t('storefront.order.shopperTitle')} />
      <dl className="grid gap-4 px-5 pt-4 pb-5">
        <Fact label={t('storefront.orders.columns.customer')}>{order.customerName}</Fact>
        <Fact label={t('storefront.order.phone')}>
          <span className="tabular-nums">{order.phone}</span>
        </Fact>
        <Fact label={t('storefront.order.address')}>
          <span className="whitespace-pre-line">{order.address}</span>
        </Fact>
        <div className="grid grid-cols-2 gap-4">
          <Fact label={t('storefront.order.zone')}>{order.zoneName}</Fact>
          <Fact label={t('storefront.order.payment')}>
            {t(`storefront.orderPayments.${order.paymentMethod}`)}
          </Fact>
        </div>
        <Fact label={t('storefront.order.customer')}>
          {order.customer === null ? (
            <span className="text-ink-3">{t('storefront.order.customerNotYet')}</span>
          ) : (
            <Link
              to="/customers/$customerId"
              params={{ customerId: order.customer.id }}
              className="font-medium text-brand underline-offset-3 hover:underline"
            >
              {order.customer.name}
            </Link>
          )}
        </Fact>
      </dl>
    </Card>
  );
}

const DOC_NUMBER =
  'font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline';

// The number as a link to its document. Every member reads the sales documents (there is no
// read permission for them), so every number links (decision 39). A document always has its number
// here: the order's documents are posted when they are made, never drafts
function DocumentLink({ kind, document }: { kind: DocumentKind; document: DocumentRef }) {
  const number = document.number ?? '—';
  switch (kind) {
    case 'salesOrder':
      return (
        <Link to="/sales-orders/$orderId" params={{ orderId: document.id }} className={DOC_NUMBER}>
          {number}
        </Link>
      );
    case 'delivery':
      return (
        <Link
          to="/deliveries/$deliveryId"
          params={{ deliveryId: document.id }}
          className={DOC_NUMBER}
        >
          {number}
        </Link>
      );
    case 'invoice':
      return (
        <Link to="/invoices/$invoiceId" params={{ invoiceId: document.id }} className={DOC_NUMBER}>
          {number}
        </Link>
      );
    case 'salesReturn':
      return (
        <Link
          to="/sales-returns/$returnId"
          params={{ returnId: document.id }}
          className={DOC_NUMBER}
        >
          {number}
        </Link>
      );
  }
}

const DOCUMENT_KINDS = ['salesOrder', 'delivery', 'invoice', 'salesReturn'] as const;
type DocumentKind = (typeof DOCUMENT_KINDS)[number];

// A row is a document made, or one still to come. A sales return never "comes": only a cancelled
// packed order gets one, so it has no "not yet" row (and no documentsWhen word)
type DocumentRow =
  | { kind: DocumentKind; document: DocumentRef }
  | { kind: Exclude<DocumentKind, 'salesReturn'>; document: null };

function DocumentsCard({ order }: { order: StorefrontOrder }) {
  const { t } = useLocale();
  // A cancelled order shows only what it made: "When it is packed" would promise a step that never
  // comes. The sales return has no "not yet" line at all (it is only for a cancelled packed order)
  const ended = order.status === 'cancelled' || order.status === 'returned';
  const rows = DOCUMENT_KINDS.flatMap((kind): DocumentRow[] => {
    const document = order[kind];
    if (document !== null) return [{ kind, document }];
    if (ended || kind === 'salesReturn') return [];
    return [{ kind, document: null }];
  });
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t('storefront.order.documentsTitle')}
        subtitle={t('storefront.order.documentsHint')}
      />
      <ul className="mt-3">
        {rows.map((row) => (
          <li
            key={row.kind}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line px-5 py-3"
          >
            <span className="text-body-sm text-ink-2">
              {t(`storefront.order.documents.${row.kind}`)}
            </span>
            {row.document === null ? (
              <span className="text-caption text-ink-3">
                {t(`storefront.order.documentsWhen.${row.kind}`)}
              </span>
            ) : (
              <DocumentLink kind={row.kind} document={row.document} />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TimelineCard({ order }: { order: StorefrontOrder }) {
  const { t, format } = useLocale();
  const timeZone = useTimeZone();
  const last = order.history.length - 1;
  return (
    <Card>
      <CardHeader title={t('storefront.order.timelineTitle')} />
      <ol className="grid px-5 pt-4 pb-5">
        {order.history.map((step, index) => {
          const shown = stepOf(order, step.status);
          return (
            <li
              key={`${step.status}-${step.at}`}
              className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0"
            >
              {/* The line down to the next step, behind the dots; none after the last one */}
              {index < last && (
                <span
                  aria-hidden="true"
                  className="absolute top-7 bottom-1 left-[11.5px] w-px bg-line"
                />
              )}
              {/* The step the order is at is brand; the earlier ones are done and step back */}
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-6 place-items-center rounded-full',
                  index === last ? 'bg-brand-soft text-brand' : 'bg-subtle text-ink-3',
                )}
              >
                <HugeiconsIcon icon={shown.icon} size={14} strokeWidth={1.5} />
              </span>
              <span className="grid min-w-0">
                <span className="text-body-sm font-medium text-ink">
                  {t(`storefront.order.history.${shown.word}`)}
                </span>
                <span className="text-caption text-ink-3 tabular-nums">
                  {format.dateTime(new Date(step.at), timeZone)}
                </span>
                {/* Decision 19: the staff's reason, under the step it explains */}
                {step.status === 'cancelled' && order.cancelReason !== null && (
                  <span className="mt-1 text-body-sm text-ink-2">
                    {t('storefront.order.cancelReason', { reason: order.cancelReason })}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

// Decision 8: a reason for the staff, then Cancel. The body says what happens to the stock, which
// differs for a new and a packed order
function CancelDialog({
  order,
  onDone,
}: {
  order: StorefrontOrder;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(cancelStorefrontOrderInputSchema, { error: contractErrorMap }),
    defaultValues: { version: order.version, reason: '' },
  });
  // A parcel the courier has a code for. One still booking is refused by the API
  // (storefront_order_parcel_booking), and that error shows above the box
  const open = openParcel(order);
  const booked = open?.status === 'booked' ? open : null;
  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.storefrontOrders.cancelOrder, {
        params: { id: order.id },
        body: values,
      });
      await onDone(saved);
    } catch (error) {
      applyApiError(error, ['reason'], setError);
    }
  });
  return (
    <DialogContent
      title={t('storefront.order.cancelling.title', { number: order.orderNo })}
      description={
        order.status === 'packed'
          ? t('storefront.order.cancelling.bodyPacked')
          : t('storefront.order.cancelling.bodyConfirmed')
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('storefront.order.cancelling.keep')}</Button>
          </DialogClose>
          <Button type="submit" form="cancel-shop-order" disabled={isSubmitting}>
            {t('storefront.order.cancelling.submit')}
          </Button>
        </>
      }
    >
      <form
        id="cancel-shop-order"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        {/* Step 28a (decision 21): a booked parcel is cancelled here too, but the courier is not
            told (Steadfast has no cancel call), so the member must cancel it on its panel. warn:
            it is theirs to do (approved with the mockup) */}
        {booked !== null && (
          <DocumentNotice tone="warn" icon={Alert02Icon}>
            {t('storefront.order.cancelling.parcelBooked', { courier: booked.account.name })}
          </DocumentNotice>
        )}
        <TextAreaField
          label={t('storefront.order.cancelling.reason')}
          optional
          placeholder={t('storefront.order.cancelling.reasonPlaceholder')}
          hint={t('storefront.order.cancelling.reasonHint')}
          maxLength={200}
          {...register('reason')}
          error={errors.reason?.message}
        />
      </form>
    </DialogContent>
  );
}

function OrderView({ order }: { order: StorefrontOrder }) {
  const { t, errorText, format } = useLocale();
  const timeZone = useTimeZone();
  const money = useShopMoney();
  const can = useCan();
  const canManage = can('storefront.order.manage');
  const applyMove = useApplyMove();
  const [dialog, setDialog] = useState<Dialogs>(null);
  // Step 28a: the parcel whose label is printing (ParcelLabel prints once, then clears this)
  const [printing, setPrinting] = useState<StorefrontShipment | null>(null);
  const step = nextStep(order);
  const cancellable = canCancel(order);
  const failed = parcelFailed(order);
  const open = openParcel(order);
  const bookable = canBook(order);
  const stopPrinting = useCallback(() => {
    setPrinting(null);
  }, []);
  // Step 28a (decision 5): the step's line once a packed order is with a courier, or a shipped one
  // is with an API courier. null keeps the status's own line (next.*)
  const parcelText = ((): string | null => {
    if (order.status === 'packed') {
      if (open === null) return t('storefront.order.nextNoParcel');
      const courier = open.account.name;
      if (open.status === 'booking') return t('storefront.order.nextBooking', { courier });
      return open.account.provider === 'manual'
        ? t('storefront.order.nextManual', { courier })
        : t('storefront.order.nextBooked', { courier });
    }
    if (order.status === 'shipped' && open !== null && open.account.provider !== 'manual') {
      return t('storefront.order.nextShipped', { courier: open.account.name });
    }
    return null;
  })();

  // Step 28a: "Book again" on a parcel that failed five times books the same parcel (the same
  // invoice) once more, in the worker
  const retry = useMutation({
    mutationFn: (parcel: StorefrontShipment) =>
      call(routes.storefrontOrders.retryShipment, {
        params: { id: order.id, shipmentId: parcel.id },
        body: { version: order.version },
      }),
    onSuccess: async (saved) => {
      await applyMove(saved);
      toast(t('storefront.order.bookingAgain', { number: saved.orderNo }));
    },
  });

  // The two moves with no dialog of their own (Make the sales order, Shipped), and Delivered's
  // confirm. Their refusals (version_conflict, storefront_order_step_invalid, a sales error on the
  // retry) belong to no box, so they show above the cards, or in the Delivered dialog
  const move = useMutation({
    mutationFn: (kind: 'makeSalesOrder' | 'ship' | 'deliver') => {
      const body = { version: order.version };
      const params = { id: order.id };
      switch (kind) {
        case 'makeSalesOrder':
          return call(routes.storefrontOrders.makeSalesOrder, { params, body });
        case 'ship':
          return call(routes.storefrontOrders.shipOrder, { params, body });
        case 'deliver':
          return call(routes.storefrontOrders.deliverOrder, { params, body });
      }
    },
    onSuccess: async (saved, kind) => {
      await applyMove(saved);
      setDialog(null);
      toast(
        kind === 'makeSalesOrder'
          ? t('storefront.order.salesOrderMade', {
              number: saved.orderNo,
              salesOrder: saved.salesOrder?.number ?? '',
            })
          : kind === 'ship'
            ? t('storefront.order.shipped', { number: saved.orderNo })
            : t('storefront.order.delivered', {
                number: saved.orderNo,
                invoice: saved.invoice?.number ?? '',
              }),
      );
    },
  });
  const moveError =
    move.error instanceof ApiRequestError ? move.error.code : move.error ? 'unknown_error' : null;

  const afterDialog = async (saved: StorefrontOrder, message: string) => {
    await applyMove(saved);
    setDialog(null);
    toast(message);
  };

  const press = (next: OrderStep) => {
    move.reset();
    if (next === 'pack' || next === 'deliver') setDialog(next);
    else move.mutate(next);
  };

  // The notice under the header (decision 1, 29 and the `next` lines). A failed sales order comes
  // first: nothing else can happen before it is made
  const notices = [];
  if (order.documentError !== null) {
    notices.push(
      <DocumentNotice key="error" tone="crit">
        {t('storefront.order.documentError', { reason: errorText(order.documentError) })}
      </DocumentNotice>,
    );
  } else if (step === 'makeSalesOrder') {
    notices.push(
      <DocumentNotice key="no-so" tone="neutral">
        {t('storefront.order.noSalesOrder')}
      </DocumentNotice>,
    );
  }
  // Step 27d (decision 7): money to give back. For every reader: the one who packs needs to know
  // the rider takes no cash too
  if (refundCase(order) !== null) notices.push(<RefundNotice key="refund" order={order} />);
  // The two notices above say what comes first; the step's own line only after them
  const blocked = order.documentError !== null || step === 'makeSalesOrder';
  if (!blocked && invoiceTookPayment(order)) {
    // Step 27d (decision 6): nothing to record, the invoice took the online payment's receipt
    notices.push(
      <DocumentNotice key="next" tone="neutral">
        {t('storefront.order.deliveredPaid')}
      </DocumentNotice>,
    );
  } else if (!blocked && failed !== null) {
    // Step 28a (decision 4): the booking failed five times. crit: nothing moves until someone
    // books it again. Its reason is the error's own words; the courier's are on the parcel card
    notices.push(
      <DocumentNotice
        key="next"
        tone="crit"
        icon={Alert02Icon}
        action={
          canManage && (
            <button
              type="button"
              disabled={retry.isPending}
              className="font-medium text-brand underline-offset-3 hover:underline"
              onClick={() => {
                retry.mutate(failed);
              }}
            >
              {t('storefront.order.bookAgain')}
            </button>
          )
        }
      >
        {t('storefront.order.parcelFailed', {
          courier: failed.account.name,
          reason: errorText(failed.error ?? 'unknown_error'),
        })}
      </DocumentNotice>,
    );
  } else if (!blocked && canManage && parcelText !== null) {
    // Step 28a (decision 5): once the order has a parcel, the line says who moves the order
    notices.push(
      <DocumentNotice key="next" tone="neutral">
        {parcelText}
      </DocumentNotice>,
    );
  } else if (!blocked && canManage && order.status !== 'cancelled' && order.status !== 'returned') {
    // Decision 7: a delivered order's money comes in as an ordinary receipt for its invoice, for
    // someone who may write one
    const receipt = order.status === 'delivered' &&
      order.invoice !== null &&
      order.customer !== null &&
      can('sales.receipt.manage') && (
        <Link
          to="/receipts/new"
          search={{ customerId: order.customer.id, invoiceId: order.invoice.id }}
          className="font-medium text-brand underline-offset-3 hover:underline"
        >
          {t('storefront.order.recordPayment')}
        </Link>
      );
    notices.push(
      <DocumentNotice key="next" tone="neutral" action={receipt}>
        {t(`storefront.order.next.${order.status}`)}
      </DocumentNotice>,
    );
  }
  // A reader sees why there are no buttons, while there would be some to press
  if (!canManage && (step !== null || cancellable)) {
    notices.push(
      <DocumentNotice key="read-only" tone="neutral">
        {t('storefront.order.cantManage')}
      </DocumentNotice>,
    );
  }

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink />
      {/* The PageHeader's look, with the pills beside the number (approved with the mockup) */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-h1">{order.orderNo}</h1>
            <span className="flex flex-wrap gap-1.5">
              <OrderStatusPill status={order.status} />
              {/* The sales order could not be made, or (step 28a) the parcel failed to book */}
              {order.needsAttention && <NeedsAttentionPill />}
            </span>
          </div>
          <p className="mt-1 text-label text-ink-3 tabular-nums">
            {t('storefront.order.placedOn', {
              date: format.dateTime(new Date(order.placedAt), timeZone),
            })}
          </p>
        </div>
        {canManage && (step !== null || cancellable) && (
          // Phone: the two buttons share the row (approved with the mockup)
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
            {cancellable && (
              <Button
                variant="secondary"
                className={cn(step === null && 'col-span-2')}
                onClick={() => {
                  move.reset();
                  setDialog('cancel');
                }}
              >
                <HugeiconsIcon icon={CancelCircleIcon} size={17} strokeWidth={1.5} />
                {t('storefront.order.cancel')}
              </Button>
            )}
            {/* Step 28a: a packed order with no parcel on its way (approved with the mockup) */}
            {bookable && (
              <Button
                variant="secondary"
                onClick={() => {
                  setDialog('book');
                }}
              >
                <HugeiconsIcon icon={ShippingTruck01Icon} size={17} strokeWidth={1.5} />
                {t('storefront.order.book')}
              </Button>
            )}
            {step !== null && (
              <Button
                className={cn(
                  (!cancellable || bookable) && 'col-span-2',
                  bookable && 'sm:col-span-1',
                )}
                disabled={move.isPending}
                onClick={() => {
                  press(step);
                }}
              >
                <HugeiconsIcon icon={STEP_BUTTONS[step]} size={17} strokeWidth={1.5} />
                {t(`storefront.order.${step}`)}
              </Button>
            )}
          </div>
        )}
      </header>
      {moveError !== null && dialog === null && <FormAlert message={moveError} />}
      {retry.error !== null && (
        <FormAlert
          message={retry.error instanceof ApiRequestError ? retry.error.code : 'unknown_error'}
        />
      )}
      {notices.length > 0 && <div className="grid gap-2.5">{notices}</div>}
      {/* Two columns from xl. Below it the wrappers are `contents`, so the four cards are one
          stack, and `order` puts the address and the documents before the timeline */}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="contents xl:grid xl:gap-5">
          <div className="order-1">
            <LinesCard order={order} />
          </div>
          {/* Step 28a: under the lines and before the payments (approved with the mockup). On a
              phone order-2 too, so the DOM order puts it before the payments */}
          {order.shipments.length > 0 && (
            <div className="order-2">
              <ParcelCards order={order} onPrint={setPrinting} />
            </div>
          )}
          {/* Step 27d: under the lines, the gateway's visits (none: no card, and the empty
              wrapper takes no gap, being `contents` on a phone and empty in the xl grid) */}
          {order.payments.length > 0 && (
            <div className="order-2">
              <PaymentsCard order={order} onMade={applyMove} />
            </div>
          )}
          <div className="order-5">
            <TimelineCard order={order} />
          </div>
        </div>
        <div className="contents xl:grid xl:gap-5">
          <div className="order-3">
            <ShopperCard order={order} />
          </div>
          <div className="order-4">
            <DocumentsCard order={order} />
          </div>
        </div>
      </div>

      {dialog === 'deliver' && (
        // Decision 35: Delivered posts an invoice, so it asks first. The dialog of a cancelled
        // draft, with this step's words
        <CancelDraftDialog
          title={t('storefront.order.deliverTitle', { number: order.orderNo })}
          body={t('storefront.order.deliverBody', { total: money(order.total) })}
          keep={t('common.cancel')}
          confirm={t('storefront.order.deliver')}
          pending={move.isPending}
          error={moveError ?? undefined}
          onConfirm={() => {
            move.mutate('deliver');
          }}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
      <Dialog
        open={dialog === 'cancel'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        {dialog === 'cancel' && (
          <CancelDialog
            order={order}
            onDone={(saved) =>
              afterDialog(saved, t('storefront.order.cancelled', { number: saved.orderNo }))
            }
          />
        )}
      </Dialog>
      <Dialog
        open={dialog === 'book'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        {dialog === 'book' && (
          <BookCourierDialog
            order={order}
            onDone={(saved, message) => void afterDialog(saved, message)}
          />
        )}
      </Dialog>
      {printing !== null && (
        <ParcelLabel order={order} parcel={printing} onPrinted={stopPrinting} />
      )}
      <Dialog
        open={dialog === 'pack'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        {dialog === 'pack' && (
          <Suspense fallback={null}>
            <PackDialog
              order={order}
              onDone={(saved) => {
                // Step 28a: Packed asked a courier for the parcel. The toast says the booking
                // started, not that it worked: the worker books it a moment later
                const booking = openParcel(saved);
                const words = { number: saved.orderNo, delivery: saved.delivery?.number ?? '' };
                return afterDialog(
                  saved,
                  booking?.status === 'booking'
                    ? t('storefront.order.packedBooking', {
                        ...words,
                        courier: booking.account.name,
                      })
                    : t('storefront.order.packed', words),
                );
              }}
            />
          </Suspense>
        )}
      </Dialog>
    </div>
  );
}

export function StorefrontOrderPage() {
  const { t } = useLocale();
  const { orderId = '' } = useParams({ strict: false });
  const online = useOnline();
  const { data: order, error } = useQuery({
    ...storefrontOrderQuery(useTenantId(), orderId),
    enabled: online && orderId !== '',
    // Step 28a: the worker books a parcel a moment after Packed (or after Book again), so the page
    // asks again every 3 seconds while one is booking, and stops once it is booked or failed. The
    // courier's later news come minutes apart; a reload or the next visit shows them
    refetchInterval: (query) =>
      query.state.data?.shipments.some((parcel) => parcel.status === 'booking') === true
        ? 3000
        : false,
  });

  if (!online) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink />
        <StorefrontOffline />
      </div>
    );
  }
  if (error) {
    // 404: no such order, or a pending one the ERP never shows (decision 13)
    const missing = error instanceof ApiRequestError && error.status === 404;
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink />
        <EmptyState
          icon={AlertCircleIcon}
          tone={missing ? 'brand' : 'crit'}
          title={t('storefront.orders.title')}
          description={missing ? t('storefront.order.notFound') : t('storefront.order.loadFailed')}
        />
      </div>
    );
  }
  if (!order) return null;
  // key: a new answer (a move made in another tab) starts the dialogs and the mutation afresh
  return <OrderView key={`${order.id}-${String(order.version)}`} order={order} />;
}
