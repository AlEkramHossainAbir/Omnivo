import { InformationCircleIcon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  deliverStorefrontOrderInputSchema,
  returnStorefrontOrderInputSchema,
  routes,
  type StorefrontOrder,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DialogClose,
  DialogContent,
  FormAlert,
  FormField,
  MoneyInput,
  TextAreaField,
} from '@omnivo/ui';
import { useForm } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { asksCollected, collectedStart, doorParcel } from '../lib/storefront-orders';
import { DocumentNotice } from './document-notice';
import { useShopMoney } from './storefront-parts';

// Step 28b.6: the two small dialogs of a shipped order at the shopper's door (approved with the
// mockup): Mark delivered, which now asks what the rider collected, and Receive the return. They
// load with the order page: both are a few boxes. "Record what came back" has lists and its own
// read, so it is a chunk of its own (storefront-came-back.tsx).

// The toast after Delivered or Record what came back: it names the COD receipt only when one was
// made (a COD account and something collected). The door parcel of the answer, the delivered one
export function deliveredToast(
  t: ReturnType<typeof useLocale>['t'],
  saved: StorefrontOrder,
): string {
  const receipt = doorParcel(saved)?.receipt?.number ?? null;
  const words = { number: saved.orderNo, invoice: saved.invoice?.number ?? '' };
  if (saved.salesReturn !== null) {
    const partly = { ...words, salesReturn: saved.salesReturn.number ?? '' };
    return receipt === null
      ? t('storefront.order.partlyDelivered', partly)
      : t('storefront.order.partlyDeliveredWithReceipt', { ...partly, receipt });
  }
  return receipt === null
    ? t('storefront.order.delivered', words)
    : t('storefront.order.deliveredWithReceipt', { ...words, receipt });
}

const DELIVER_FIELDS = ['collectedAmount'] as const;

// The API refused the amount as more than the parcel's COD amount (both door dialogs)
export function collectedOver(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'storefront_order_collected_over';
}

// Mark delivered (decisions 4 and 5, mine 41). Three bodies: a COD receipt will be made (the box
// asks what the rider collected), the order was paid online (the invoice takes that receipt), or
// neither (the invoice stays unpaid, 27b's words). The box starts with what the courier said, else
// what the rider was to collect
export function DeliverDialog({
  order,
  onDone,
}: {
  order: StorefrontOrder;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t, errorText } = useLocale();
  const money = useShopMoney();
  const door = doorParcel(order);
  const asks = asksCollected(door);
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(deliverStorefrontOrderInputSchema, { error: contractErrorMap }),
    defaultValues: { version: order.version, collectedAmount: asks ? collectedStart(door) : '' },
  });
  const total = money(order.total);
  const body = asks
    ? t('storefront.order.deliverBodyCod', { total, courier: door.account.name })
    : order.paymentMethod === 'online'
      ? t('storefront.order.deliverBodyPaid', { total })
      : t('storefront.order.deliverBody', { total });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.storefrontOrderDeliveries.deliverOrder, {
        params: { id: order.id },
        body: values,
      });
      await onDone(saved);
    } catch (error) {
      applyApiError(error, DELIVER_FIELDS, setError);
      // Its words name the parcel's COD amount, and a field shows a code without its params
      // ("at most {{amount}}", found by storefront-cod.e2e.ts): written out here, as
      // credit-parts.tsx writes out the credit limit's
      if (collectedOver(error) && door !== null) {
        setError('collectedAmount', {
          message: errorText('storefront_order_collected_over', { amount: money(door.codAmount) }),
        });
      }
    }
  });

  return (
    <DialogContent
      title={t('storefront.order.deliverTitle', { number: order.orderNo })}
      description={body}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="deliver-shop-order" disabled={isSubmitting}>
            {t('storefront.order.deliver')}
          </Button>
        </>
      }
    >
      <form
        id="deliver-shop-order"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        {asks && (
          <FormField
            control={control}
            name="collectedAmount"
            label={t('storefront.order.collected')}
            hint={t('storefront.order.collectedHint', { amount: money(door.codAmount) })}
          >
            {/* The form keeps '' for an empty box: the schema makes it null, and the API then
                takes what the courier said, else the whole amount */}
            {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
          </FormField>
        )}
      </form>
    </DialogContent>
  );
}

// Receive the return (decision 7, mine 42): the whole parcel is back. The body says what it posts;
// the check that the goods are on the shelf is its own neutral notice, so it is not lost in the body
export function ReceiveDialog({
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
    resolver: zodResolver(returnStorefrontOrderInputSchema, { error: contractErrorMap }),
    defaultValues: { version: order.version, reason: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.storefrontOrderDeliveries.returnOrder, {
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
      title={t('storefront.order.receiving.title', { number: order.orderNo })}
      description={t('storefront.order.receiving.body', {
        delivery: order.delivery?.number ?? '',
      })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('storefront.order.receiving.keep')}</Button>
          </DialogClose>
          <Button type="submit" form="receive-shop-order" disabled={isSubmitting}>
            {t('storefront.order.receiving.submit')}
          </Button>
        </>
      }
    >
      <form
        id="receive-shop-order"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <DocumentNotice tone="neutral" icon={InformationCircleIcon}>
          {t('storefront.order.receiving.check')}
        </DocumentNotice>
        <TextAreaField
          label={t('storefront.order.receiving.reason')}
          optional
          placeholder={t('storefront.order.receiving.reasonPlaceholder')}
          hint={t('storefront.order.receiving.reasonHint')}
          maxLength={200}
          {...register('reason')}
          error={errors.reason?.message}
        />
      </form>
    </DialogContent>
  );
}
