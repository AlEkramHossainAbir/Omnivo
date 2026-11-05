import { Alert02Icon, DeliveryTruck01Icon, Wrench01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type InvoiceLineFormValues,
  isZeroQuantity,
  MAX_INVOICE_LINES,
  type SalesLineFormValues,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogContent, Dialog, EmptyState, Select } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { challanLines, orderCharges, type SourcedLine } from '../lib/invoice-sources';
import { type LineOrigin, sourceIdOf } from '../lib/invoices';
import {
  billableOrdersQuery,
  challansToInvoiceQuery,
  deliveryQuery,
  salesOrderQuery,
  stockCardQuery,
} from '../lib/queries';
import { isServiceLine, type LineMeta, type SalesItem } from '../lib/sales';
import { firstMessage } from '../lib/stock';
import { failureOf } from './journal-parts';
import { LinesEditor, SalesField, useSalesPricing } from './sales-line-editor';
import { PickButton, PickProblem } from './sales-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { useIsoDate, useQuantity, useTenantId } from './stock-parts';

// The lines of an invoice (step 15c): the sales line editor of the quotation and the order, with
// three kinds of line. A challan line and an order's service line are billed whole, so their item,
// unit and quantity are fixed; a line of its own is a normal sales line, and a goods one picks its
// batch or serial numbers, because posting the invoice delivers it. Its own chunk, loaded by the
// invoice form (sales-line-editor.tsx says why the editor is lazy).

export type InvoiceLinesErrors = FieldErrors<{ lines: InvoiceLineFormValues[] }>['lines'];

// A product added with "Add items": a line of its own
function ownLine(line: SalesLineFormValues): InvoiceLineFormValues {
  return { ...line, deliveryLineId: '', orderLineId: '', batchId: '', serialNumbers: [] };
}

// Billed whole: a challan line, or an order's service line
function isBilled(line: InvoiceLineFormValues): boolean {
  return sourceIdOf(line) !== null;
}

type Add = (entries: readonly { line: InvoiceLineFormValues; meta: LineMeta }[]) => boolean;

export function InvoiceLinesEditor({
  lines,
  onChange,
  getLines,
  initialMeta,
  customerId,
  pricesIncludeVat,
  errors,
  warehouseId,
  origins,
  orderPricing,
  onSourced,
}: {
  lines: InvoiceLineFormValues[];
  onChange: (lines: InvoiceLineFormValues[]) => void;
  getLines: () => InvoiceLineFormValues[];
  initialMeta: LineMeta[];
  customerId: string;
  pricesIncludeVat: boolean;
  errors: InvoiceLinesErrors;
  // Where the invoice's own goods leave from ('' = none picked)
  warehouseId: string;
  origins: ReadonlyMap<string, LineOrigin>;
  // How the order lines on the form write their prices (null = no order line yet)
  orderPricing: boolean | null;
  // Lines a picker added: the form keeps their origins, and takes a branch from the challan
  onSourced: (lines: readonly SourcedLine[], warehouseId: string | null) => void;
}) {
  const { t } = useLocale();
  const quantityText = useQuantity();
  const pricing = useSalesPricing(customerId);
  const [picking, setPicking] = useState<'challans' | 'charges' | null>(null);
  const onForm = new Set(lines.flatMap((line) => sourceIdOf(line) ?? []));

  const note = ({
    value,
    index,
    item,
    update,
  }: {
    value: InvoiceLineFormValues;
    index: number;
    item: SalesItem;
    update: (patch: Partial<InvoiceLineFormValues>) => void;
  }): ReactNode => {
    const lineErrors = errors?.[index];
    const origin = origins.get(sourceIdOf(value) ?? '');
    // The billed line's own problem (billed by another invoice since, not this customer's any more)
    const sourceError = lineErrors?.deliveryLineId?.message ?? lineErrors?.orderLineId?.message;
    if (value.deliveryLineId) {
      const returned = origin?.returnedQuantity ?? '0';
      return (
        <span className="grid gap-0.5 text-caption text-ink-3">
          <span className="font-medium text-ink-2">
            {t('invoices.fromChallan', { number: origin?.deliveryNumber ?? '' })}
            {origin?.orderNumber && ` · ${origin.orderNumber}`}
          </span>
          <span>{t('invoices.challanLineHint')}</span>
          {/* Step 15d: why the quantity is less than the challan's, and in the base unit */}
          {!isZeroQuantity(returned) && (
            <span className="tabular-nums">
              {t('invoices.returnedBeforeBilling', {
                quantity: quantityText(returned, item.baseUnitId),
              })}
            </span>
          )}
          <SourceError message={sourceError} />
        </span>
      );
    }
    if (value.orderLineId) {
      return (
        <span className="grid gap-0.5 text-caption">
          <span className="font-medium text-ink-2">
            {t('invoices.fromOrder', { number: origin?.orderNumber ?? '' })}
          </span>
          <SourceError message={sourceError} />
        </span>
      );
    }
    if (isServiceLine(item)) return null;
    return (
      <OwnStock
        index={index}
        item={item}
        line={value}
        warehouseId={warehouseId}
        update={update}
        errors={{
          batchId: lineErrors?.batchId?.message,
          serialNumbers: firstMessage(lineErrors?.serialNumbers),
        }}
      />
    );
  };

  return (
    <LinesEditor<InvoiceLineFormValues>
      lines={lines}
      onChange={onChange}
      getLines={getLines}
      initialMeta={initialMeta}
      pricing={pricing}
      pricesIncludeVat={pricesIncludeVat}
      errors={errors}
      newLine={ownLine}
      maxLines={MAX_INVOICE_LINES}
      fixed={isBilled}
      lineNote={note}
      moreAdds={(add) => (
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={customerId === ''}
            onClick={() => {
              setPicking('challans');
            }}
          >
            <HugeiconsIcon icon={DeliveryTruck01Icon} size={16} strokeWidth={1.5} />
            {t('invoices.addChallans')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={customerId === ''}
            onClick={() => {
              setPicking('charges');
            }}
          >
            <HugeiconsIcon icon={Wrench01Icon} size={16} strokeWidth={1.5} />
            {t('invoices.addCharges')}
          </Button>
          {customerId === '' && (
            <span className="self-center text-label text-ink-3">
              {t('invoices.pickCustomerFirst')}
            </span>
          )}
          <Dialog
            open={picking !== null}
            onOpenChange={(open) => {
              if (!open) setPicking(null);
            }}
          >
            {picking === 'challans' && (
              <ChallanPicker
                customerId={customerId}
                onForm={onForm}
                orderPricing={orderPricing}
                add={add}
                onSourced={onSourced}
              />
            )}
            {picking === 'charges' && (
              <ChargePicker
                customerId={customerId}
                onForm={onForm}
                orderPricing={orderPricing}
                add={add}
                onSourced={onSourced}
              />
            )}
          </Dialog>
        </>
      )}
    />
  );
}

function SourceError({ message }: { message: string | undefined }) {
  const { errorText } = useLocale();
  if (message === undefined) return null;
  return (
    <span className="flex items-start gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      {errorText(message)}
    </span>
  );
}

// The batch (from what the invoice's warehouse holds) or the serial numbers of a goods line the
// invoice delivers itself, like a challan line. The server checks them when it saves
// (resolveLines, the stock documents' own check), so a batch that ran out since says so there.
function OwnStock({
  index,
  item,
  line,
  warehouseId,
  update,
  errors,
}: {
  index: number;
  item: SalesItem;
  line: InvoiceLineFormValues;
  warehouseId: string;
  update: (patch: Partial<InvoiceLineFormValues>) => void;
  errors: { batchId: string | undefined; serialNumbers: string | undefined };
}) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
  const isoDate = useIsoDate();
  const card = useQuery({
    ...stockCardQuery(tenantId, item.variantId),
    enabled: item.tracking === 'batch' && warehouseId !== '',
  }).data;
  const batches = (card?.batches ?? []).filter((batch) => batch.warehouseId === warehouseId);
  const id = (field: string) => `lines.${String(index)}.${field}`;
  return (
    <div className="grid gap-2">
      <span className="text-caption font-medium text-ink-2">{t('invoices.ownLine')}</span>
      {item.tracking === 'batch' && (
        <SalesField id={id('batchId')} label={t('stockLines.batch')} error={errors.batchId}>
          <Select
            id={id('batchId')}
            value={line.batchId ?? ''}
            invalid={errors.batchId !== undefined}
            // The batches are the warehouse's: none to pick before the warehouse is
            disabled={warehouseId === ''}
            options={[
              {
                value: '',
                label:
                  warehouseId === ''
                    ? t('stockLines.pickWarehouse')
                    : t('stockLines.batchPlaceholder'),
              },
              ...batches.map((batch) => ({
                value: batch.batchId,
                label: t('stockLines.batchOption', {
                  lot: batch.lotNumber,
                  quantity: quantityText(batch.quantity, item.baseUnitId),
                  expiry: batch.expiresOn === null ? t('stock.noExpiry') : isoDate(batch.expiresOn),
                }),
              })),
            ]}
            onChange={(event) => {
              update({ batchId: event.target.value });
            }}
          />
        </SalesField>
      )}
      {item.tracking === 'serial' && (
        <SalesField
          id={id('serialNumbers')}
          label={t('stockLines.serials')}
          error={errors.serialNumbers}
        >
          <SerialNumbersInput
            id={id('serialNumbers')}
            value={line.serialNumbers}
            invalid={errors.serialNumbers !== undefined}
            onChange={(serialNumbers) => {
              update({ serialNumbers });
            }}
          />
          <span className="text-caption text-ink-3">{t('stockLines.serialsHint')}</span>
        </SalesField>
      )}
    </div>
  );
}

// What both pickers share: add the lines unless they would mix the orders' two ways of writing
// prices (the API's invoice_vat_mixed) or pass the line limit; say why in the dialog otherwise
function useAddSourced(
  orderPricing: boolean | null,
  add: Add,
  onSourced: (lines: readonly SourcedLine[], warehouseId: string | null) => void,
) {
  const { t, errorText } = useLocale();
  return (
    sourced: readonly SourcedLine[],
    pricing: boolean | null,
    warehouseId: string | null,
  ): string | null => {
    if (pricing !== null && orderPricing !== null && pricing !== orderPricing) {
      return errorText('invoice_vat_mixed');
    }
    if (!add(sourced.map(({ line, meta }) => ({ line, meta })))) {
      return t('salesLines.tooMany', { max: MAX_INVOICE_LINES });
    }
    onSourced(sourced, warehouseId);
    return null;
  };
}

// "Add challans": the customer's posted challans with something left to bill. Each click adds what
// is left of that challan, priced from its order. The dialog stays open: a month of challans for
// one depot goes on one invoice.
function ChallanPicker({
  customerId,
  onForm,
  orderPricing,
  add,
  onSourced,
}: {
  customerId: string;
  onForm: ReadonlySet<string>;
  orderPricing: boolean | null;
  add: Add;
  onSourced: (lines: readonly SourcedLine[], warehouseId: string | null) => void;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const addSourced = useAddSourced(orderPricing, add, onSourced);
  const { data: challans } = useQuery(challansToInvoiceQuery(tenantId, customerId));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async (deliveryId: string) => {
    setLoading(deliveryId);
    setProblem(null);
    try {
      const delivery = await queryClient.query(deliveryQuery(tenantId, deliveryId));
      const { lines, order } = await challanLines(queryClient, tenantId, delivery, onForm);
      const failed = addSourced(lines, order?.pricesIncludeVat ?? null, delivery.warehouseId);
      if (failed === null) setAdded((before) => new Set(before).add(deliveryId));
      else setProblem(failed);
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('invoices.challanPickerTitle')}
      description={t('invoices.challanPickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {challans?.length === 0 ? (
          <EmptyState
            icon={DeliveryTruck01Icon}
            title={t('invoices.challanPickerEmpty')}
            description={t('invoices.challanPickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {challans?.map((challan) => (
              <li
                key={challan.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="font-mono text-body-sm font-medium tabular-nums">
                    {challan.number ?? ''}
                  </span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {isoDate(challan.date)} ·{' '}
                    {t('invoices.challanLines', { count: challan.lineCount })}
                    {challan.order?.number && ` · ${challan.order.number}`}
                  </span>
                </span>
                <PickButton
                  added={added.has(challan.id)}
                  loading={loading === challan.id}
                  onClick={() => void pick(challan.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}

// "Add order charges": the customer's orders; a click adds the order's services not billed yet
// (a delivery charge, an embroidery charge). The list cannot tell which orders still have one, so
// an order with nothing left says so when it is opened.
function ChargePicker({
  customerId,
  onForm,
  orderPricing,
  add,
  onSourced,
}: {
  customerId: string;
  onForm: ReadonlySet<string>;
  orderPricing: boolean | null;
  add: Add;
  onSourced: (lines: readonly SourcedLine[], warehouseId: string | null) => void;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const addSourced = useAddSourced(orderPricing, add, onSourced);
  const { data: orders } = useQuery(billableOrdersQuery(tenantId, customerId));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async (orderId: string) => {
    setLoading(orderId);
    setProblem(null);
    try {
      const order = await queryClient.query(salesOrderQuery(tenantId, orderId));
      const charges = orderCharges(order, onForm);
      if (charges.length === 0) {
        setProblem(t('invoices.noChargesLeft', { number: order.number ?? '' }));
        return;
      }
      const failed = addSourced(charges, order.pricesIncludeVat, order.warehouseId);
      if (failed === null) setAdded((before) => new Set(before).add(orderId));
      else setProblem(failed);
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('invoices.chargePickerTitle')}
      description={t('invoices.chargePickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {orders?.length === 0 ? (
          <EmptyState
            icon={Wrench01Icon}
            title={t('invoices.chargePickerEmpty')}
            description={t('invoices.chargePickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {orders?.map((order) => (
              <li
                key={order.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="font-mono text-body-sm font-medium tabular-nums">
                    {order.number ?? ''}
                  </span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {[isoDate(order.date), order.customerReference]
                      .filter((part) => part !== null)
                      .join(' · ')}
                  </span>
                </span>
                <PickButton
                  added={added.has(order.id)}
                  loading={loading === order.id}
                  onClick={() => void pick(order.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
