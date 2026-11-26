import {
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  CreditCardNotAcceptIcon,
  MoneyRemove01Icon,
  Unlink04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  routes,
  type ShopPaymentStatus,
  type StorefrontOrder,
  type StorefrontOrderPayment,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, FormAlert, Pill, toast } from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { DocumentNotice } from './document-notice';
import { useShopMoney } from './storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { useTimeZone } from '../lib/workspace';

// Step 27d: what the order page shows of the online payment. The Payments card lists every visit
// to the gateway (a "try"), the ones that did not pay too: when a shopper says "I paid", the staff
// find the visit by its transaction ID in SSLCommerz's own panel. The notice says when money has to
// go back (decision 7: the refund is made by hand in the gateway's panel, then recorded here).

// Started is work in progress (brand); a page that did not open, a failed and a cancelled try are
// over and ask nothing of the staff, so neutral, each with its own picture
const PAYMENT_PILLS = {
  started: { tone: 'brand', icon: Clock01Icon },
  not_opened: { tone: 'neutral', icon: Unlink04Icon },
  paid: { tone: 'good', icon: CheckmarkCircle02Icon },
  failed: { tone: 'neutral', icon: CreditCardNotAcceptIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
} as const satisfies Record<
  ShopPaymentStatus,
  { tone: 'brand' | 'good' | 'neutral'; icon: IconSvgElement }
>;

function PaymentPill({ status }: { status: ShopPaymentStatus }) {
  const { t } = useLocale();
  const pill = PAYMENT_PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`storefront.order.payments.statuses.${status}`)}
    </Pill>
  );
}

function paidTries(order: StorefrontOrder): StorefrontOrderPayment[] {
  return order.payments.filter((payment) => payment.status === 'paid');
}

// A delivered online order whose invoice took the payment's receipt (decision 6): the page says
// so in place of "Record the cash when the rider brings it back"
export function invoiceTookPayment(order: StorefrontOrder): boolean {
  return (
    order.status === 'delivered' &&
    order.paymentMethod === 'online' &&
    paidTries(order).some((payment) => payment.receipt !== null)
  );
}

// Decision 7: why the shop has to give money back, or null. Three cases, in this order:
// - cancelled: the order was cancelled (or returned) after the shopper paid;
// - cod: a cash on delivery order with a paid try (the shopper paid, then chose to pay the rider);
// - twice: an online order paid twice (two tabs).
// Step 28b: and
// - partly: an online order whose parcel came back in part. Its invoice took only what the shopper
//   kept (the sales return came before it), so the rest of the payment waits to be paid back.
//   Before twice: a return and a second payment both mean money back, and this one names it all.
export function refundCase(
  order: StorefrontOrder,
): 'cancelled' | 'cod' | 'twice' | 'partly' | null {
  const paid = paidTries(order);
  if (paid.length === 0) return null;
  if (order.status === 'cancelled' || order.status === 'returned') return 'cancelled';
  if (order.status === 'delivered' && order.salesReturn !== null) return 'partly';
  if (order.paymentMethod === 'cod') return 'cod';
  return paid.length > 1 ? 'twice' : null;
}

// The notice for refundCase. "Record refund" opens a new refund of the latest paid try's receipt,
// for someone who may write refunds; a try whose receipt could not be made has nothing to refund
// yet, so no link
export function RefundNotice({ order }: { order: StorefrontOrder }) {
  const { t } = useLocale();
  const money = useShopMoney();
  const can = useCan();
  const kind = refundCase(order);
  if (kind === null) return null;
  const paid = paidTries(order);
  // Every try asks for the order's total, so "twice" names one try's amount; the others name
  // everything paid
  const amount = money(
    kind === 'twice' ? (paid[0]?.amount ?? '0') : sumMoney(paid.map((payment) => payment.amount)),
  );
  const text = {
    cancelled: t('storefront.order.paidCancelled', { amount }),
    cod: t('storefront.order.paidOnCod', { amount }),
    twice: t('storefront.order.paidTwice', { amount }),
    partly: t('storefront.order.paidPartly', { amount }),
  }[kind];
  const withReceipt = paid.filter((payment) => payment.receipt !== null);
  const receipt = withReceipt[withReceipt.length - 1]?.receipt ?? null;
  const action = receipt !== null && can('sales.refund.manage') && (
    <Link
      to="/refunds/new"
      search={{ receiptId: receipt.id }}
      className="font-medium text-brand underline-offset-3 hover:underline"
    >
      {t('storefront.order.recordRefund')}
    </Link>
  );
  return (
    <DocumentNotice tone="warn" icon={MoneyRemove01Icon} action={action}>
      {text}
    </DocumentNotice>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-caption font-medium text-ink-3">{label}</dt>
      <dd className="text-body-sm break-words text-ink">{children}</dd>
    </div>
  );
}

function PaymentRow({
  order,
  payment,
  number,
  onMade,
}: {
  order: StorefrontOrder;
  payment: StorefrontOrderPayment;
  number: number;
  onMade: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t, format, errorText } = useLocale();
  const timeZone = useTimeZone();
  const money = useShopMoney();
  const can = useCan();
  // "Make the receipt" tries again after the worker could not (decision 6: an account archived
  // since the gateway was saved, a closed day). The order's version guards it like every move
  const make = useMutation({
    mutationFn: () =>
      call(routes.storefrontOrders.makePaymentReceipt, {
        params: { id: order.id, paymentId: payment.id },
        body: { version: order.version },
      }),
    onSuccess: async (saved) => {
      await onMade(saved);
      const made = saved.payments.find((item) => item.id === payment.id)?.receipt;
      toast(t('storefront.order.payments.receiptMade', { receipt: made?.number ?? '' }));
    },
  });
  const makeError =
    make.error instanceof ApiRequestError ? make.error.code : make.error ? 'unknown_error' : null;
  const time = (at: string) => format.dateTime(new Date(at), timeZone);
  const paid = payment.status === 'paid';
  return (
    <li className="grid gap-3 border-t border-line px-5 py-4">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-body-sm font-medium text-ink">
            {t('storefront.order.payments.try', { number })}
          </span>
          <PaymentPill status={payment.status} />
          <span className="ml-auto text-body-sm font-medium tabular-nums">
            {money(payment.amount)}
          </span>
        </div>
        <p className="text-caption text-ink-3 tabular-nums">
          {t('storefront.order.payments.started', { date: time(payment.startedAt) })}
          {payment.settledAt !== null &&
            ` · ${t('storefront.order.payments.settled', { date: time(payment.settledAt) })}`}
        </p>
      </div>
      {/* Three facts a row from sm, two on a phone; a try that did not pay has only its ID */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Fact label={t('storefront.order.payments.tranId')}>
          <span className="font-mono">{payment.tranId}</span>
        </Fact>
        {paid && payment.cardType !== null && (
          <Fact label={t('storefront.order.payments.cardType')}>{payment.cardType}</Fact>
        )}
        {paid && payment.bankTranId !== null && (
          <Fact label={t('storefront.order.payments.bankTranId')}>
            <span className="font-mono">{payment.bankTranId}</span>
          </Fact>
        )}
        {paid && payment.storeAmount !== null && (
          <>
            <Fact label={t('storefront.order.payments.fee')}>
              <span className="tabular-nums">
                {money(subtractMoney(payment.amount, payment.storeAmount))}
              </span>
            </Fact>
            <Fact label={t('storefront.order.payments.storeAmount')}>
              <span className="tabular-nums">{money(payment.storeAmount)}</span>
            </Fact>
          </>
        )}
        {payment.receipt !== null && (
          <Fact label={t('storefront.order.payments.receipt')}>
            <Link
              to="/receipts/$receiptId"
              params={{ receiptId: payment.receipt.id }}
              className="font-mono font-medium text-brand tabular-nums underline-offset-3 hover:underline"
            >
              {payment.receipt.number ?? '—'}
            </Link>
          </Fact>
        )}
      </dl>
      {payment.receiptError !== null && (
        <div className="grid justify-items-start gap-3 rounded-control bg-subtle p-3">
          <p className="flex items-start gap-1.5 text-label text-crit">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={15}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0"
            />
            {t('storefront.order.payments.receiptError', {
              reason: errorText(payment.receiptError),
            })}
          </p>
          {makeError !== null && <FormAlert message={makeError} />}
          {can('storefront.order.manage') && (
            <Button
              variant="secondary"
              size="sm"
              disabled={make.isPending}
              onClick={() => {
                make.mutate();
              }}
            >
              {t('storefront.order.payments.makeReceipt')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

// Only for an order with a try: a cash on delivery order that never tried has no card
export function PaymentsCard({
  order,
  onMade,
}: {
  order: StorefrontOrder;
  onMade: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  if (order.payments.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t('storefront.order.payments.title')}
        subtitle={t('storefront.order.payments.description')}
      />
      <ol className="mt-3">
        {order.payments.map((payment, index) => (
          <PaymentRow
            key={payment.id}
            order={order}
            payment={payment}
            number={index + 1}
            onMade={onMade}
          />
        ))}
      </ol>
    </Card>
  );
}
