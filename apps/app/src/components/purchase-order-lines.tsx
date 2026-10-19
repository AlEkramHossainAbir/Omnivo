import { Alert02Icon, Search01Icon, TaskAdd01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  defaultLineDescription,
  isZeroQuantity,
  MAX_PURCHASE_LINES,
  type OpenRequisitionLine,
  plainQuantity,
  type PurchaseOrderLineFormValues,
  routes,
  type SalesLineFormValues,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Dialog, DialogContent, Input } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { call } from '../lib/api';
import { purchaseUnitOf, startingPrice } from '../lib/purchase';
import { openRequisitionLinesQuery, productQuery, taxRatesQuery } from '../lib/queries';
import { type LineMeta, productItemOf } from '../lib/sales';
import { useDebounced } from '../lib/use-debounced';
import { failureOf } from './journal-parts';
import { type LinePricing, LinesEditor, linePriceKey } from './sales-line-editor';
import { PickButton, PickProblem } from './sales-parts';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The lines of a purchase order (step 17b): the sales line editor (decision 6: the same price,
// discount and VAT), priced from the supplier's last prices, with a link under each line that buys
// for a requisition, and "Add lines still to order" beside "Add items" (decision 18). A lazy chunk
// of its own, loaded as the order form opens, like the sales editor.

export type PurchaseOrderLinesErrors = FieldErrors<{
  lines: PurchaseOrderLineFormValues[];
}>['lines'];

// The requisition each line buys for, by the requisition line's id: the line holds only the id,
// and the link under it needs the requisition's number
export type RequisitionLinks = ReadonlyMap<string, { requisitionId: string; number: string }>;

// The supplier's prices (decision 19): its own last price, else anyone's, else the average cost.
// The lookup sends the net; startingPrice() adds the VAT when the order's prices include it.
function usePurchasePricing(supplierId: string, pricesIncludeVat: boolean): LinePricing {
  const { t } = useLocale();
  const rates = useQuery(taxRatesQuery(useTenantId())).data;
  const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
  return {
    partyId: supplierId,
    unitOf: purchaseUnitOf,
    lookUp: async (items) => {
      const answer = await call(routes.purchaseCosts.lookup, {
        body: { supplierId: supplierId === '' ? null : supplierId, items: [...items] },
      });
      return new Map(
        answer.items.map((item) => [
          linePriceKey(item.variantId, item.unitId),
          {
            price: startingPrice(item.cost, rateOf(item.taxRateId), pricesIncludeVat),
            source: item.source,
            taxRateId: item.taxRateId,
          },
        ]),
      );
    },
    sourceText: (source) =>
      source === 'supplier_price'
        ? t('purchaseLines.fromSupplierPrice')
        : source === 'last_price'
          ? t('purchaseLines.fromLastPrice')
          : source === 'average_cost'
            ? t('purchaseLines.fromAverage')
            : t('purchaseLines.noPrice'),
    words: {
      noLines: t('purchaseLines.noOrderLines'),
      reprice: t('purchaseLines.reprice'),
      repriced: t('purchaseLines.repriced'),
    },
    picker: { words: 'purchaseLines', description: t('purchaseLines.orderPickerDescription') },
  };
}

// A line from "Add items" buys for no requisition; one from "lines still to order" names its line
const ownLine = (line: SalesLineFormValues): PurchaseOrderLineFormValues => ({
  ...line,
  requisitionLineId: '',
});

type Add = (entries: readonly { line: PurchaseOrderLineFormValues; meta: LineMeta }[]) => boolean;

let lastKey = 0;
function nextKey(): string {
  lastKey += 1;
  return `open-${String(lastKey)}`;
}

export function PurchaseOrderLinesEditor({
  lines,
  onChange,
  getLines,
  initialMeta,
  initialLinks,
  supplierId,
  warehouseId,
  pricesIncludeVat,
  errors,
  startPicking,
}: {
  lines: PurchaseOrderLineFormValues[];
  onChange: (lines: PurchaseOrderLineFormValues[]) => void;
  getLines: () => PurchaseOrderLineFormValues[];
  initialMeta: LineMeta[];
  initialLinks: RequisitionLinks;
  supplierId: string;
  // The lines still to order are per warehouse: '' = none picked yet
  warehouseId: string;
  pricesIncludeVat: boolean;
  errors: PurchaseOrderLinesErrors;
  // "Make purchase order" on a requisition: the dialog opens at once, narrowed to it
  startPicking: string | null;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const pricing = usePurchasePricing(supplierId, pricesIncludeVat);
  const [links, setLinks] = useState<RequisitionLinks>(initialLinks);
  // The requisition the dialog is narrowed to ('' = every requisition of the warehouse)
  const [picking, setPicking] = useState<{ requisitionId: string } | null>(
    startPicking === null ? null : { requisitionId: startPicking },
  );

  // A requisition line as an order line: in the requisition's unit and quantity when nothing of it
  // was ordered yet (40 bags), else what is left in the base unit (120 kg), like a goods receipt's
  // "what is left". The description stays only when the store wrote one ("Navy, for
  // PO-HM-2026-1187"); the product's name follows the product. false = too many lines.
  const addOpen = async (open: OpenRequisitionLine, add: Add): Promise<boolean> => {
    const product = await queryClient.query(productQuery(tenantId, open.productId));
    const variant = product.variants.find((each) => each.id === open.variantId);
    // The requisition line's variant is the product's (a foreign key); a missing one is a bug
    if (!variant) throw new Error('variant not found');
    const untouched = isZeroQuantity(open.orderedQuantity);
    const unitId = untouched ? open.unitId : open.baseUnitId;
    const found = (await pricing.lookUp([{ variantId: open.variantId, unitId }])).get(
      linePriceKey(open.variantId, unitId),
    );
    const added = add([
      {
        line: {
          variantId: open.variantId,
          unitId,
          quantity: plainQuantity(untouched ? open.quantity : open.remainingQuantity),
          description: open.description === defaultLineDescription(open) ? '' : open.description,
          unitPrice: found?.price ?? '',
          discountType: 'percent',
          discount: '',
          taxRateId: found?.taxRateId ?? '',
          requisitionLineId: open.id,
        },
        meta: {
          key: nextKey(),
          item: productItemOf(product, variant),
          source: found?.source ?? null,
          pricedFor: supplierId,
        },
      },
    ]);
    if (added) {
      setLinks((before) =>
        new Map(before).set(open.id, {
          requisitionId: open.requisition.id,
          number: open.requisition.number,
        }),
      );
    }
    return added;
  };

  return (
    <LinesEditor<PurchaseOrderLineFormValues>
      lines={lines}
      onChange={onChange}
      getLines={getLines}
      initialMeta={initialMeta}
      pricing={pricing}
      pricesIncludeVat={pricesIncludeVat}
      errors={errors}
      newLine={ownLine}
      maxLines={MAX_PURCHASE_LINES}
      lineNote={({ value, index }) => {
        const link = value.requisitionLineId ? links.get(value.requisitionLineId) : undefined;
        // purchase_requisition_line_invalid (closed meanwhile, another warehouse) or _twice
        const error = errors?.[index]?.requisitionLineId?.message;
        if (link === undefined && error === undefined) return null;
        return (
          <span className="grid gap-0.5">
            {link && (
              <Link
                to="/requisitions/$requisitionId"
                params={{ requisitionId: link.requisitionId }}
                className="w-fit text-caption font-medium text-brand underline-offset-3 hover:underline"
              >
                {t('purchaseOrders.forRequisition', { number: link.number })}
              </Link>
            )}
            {error !== undefined && (
              <span className="flex items-start gap-1.5 text-label text-crit">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  size={15}
                  strokeWidth={1.5}
                  className="mt-px shrink-0"
                />
                {errorText(error)}
              </span>
            )}
          </span>
        );
      }}
      moreAdds={(add) => (
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={warehouseId === ''}
            onClick={() => {
              setPicking({ requisitionId: '' });
            }}
          >
            <HugeiconsIcon icon={TaskAdd01Icon} size={16} strokeWidth={1.5} />
            {t('purchaseOrders.addFromRequisitions')}
          </Button>
          {warehouseId === '' && (
            <p className="basis-full text-label text-ink-3">
              {t('purchaseOrders.pickWarehouseFirst')}
            </p>
          )}
          <Dialog
            open={picking !== null && warehouseId !== ''}
            onOpenChange={(open) => {
              if (!open) setPicking(null);
            }}
          >
            {picking !== null && warehouseId !== '' && (
              <OpenLinesPicker
                warehouseId={warehouseId}
                requisitionId={picking.requisitionId}
                onForm={new Set(getLines().flatMap((line) => line.requisitionLineId ?? []))}
                onAdd={(open) => addOpen(open, add)}
              />
            )}
          </Dialog>
        </>
      )}
    />
  );
}

// "Lines still to order": the approved requisitions' lines of the order's warehouse, oldest first,
// searched on the server. The dialog stays open, so an order for ten lines is put together without
// closing it; a line already on the order says "Added" (one order line per requisition line).
function OpenLinesPicker({
  warehouseId,
  requisitionId,
  onForm,
  onAdd,
}: {
  warehouseId: string;
  requisitionId: string;
  onForm: ReadonlySet<string>;
  onAdd: (line: OpenRequisitionLine) => Promise<boolean>;
}) {
  const { t, errorText } = useLocale();
  const isoDate = useIsoDate();
  const quantity = useQuantity();
  const { byId } = useWarehouses();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: open } = useQuery(
    openRequisitionLinesQuery(useTenantId(), { warehouseId, requisitionId, search: settled }),
  );

  const add = async (line: OpenRequisitionLine) => {
    setLoading(line.id);
    setProblem(null);
    try {
      if (await onAdd(line)) setAdded((before) => new Set(before).add(line.id));
      else setProblem(t('purchaseLines.tooMany', { max: MAX_PURCHASE_LINES }));
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('purchaseOrders.openLinesTitle')}
      description={t('purchaseOrders.openLinesDescription', {
        warehouse: warehouseLabel(byId.get(warehouseId)),
      })}
    >
      <div className="grid grid-cols-1 gap-4">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t('purchaseOrders.openLinesSearch')}
          placeholder={t('purchaseOrders.openLinesSearch')}
          autoFocus
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        <PickProblem message={problem} />
        {open?.length === 0 ? (
          <p className="py-6 text-center text-body-sm text-ink-2">
            {t('purchaseOrders.openLinesEmpty')}
          </p>
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {open?.map((line) => (
              <li
                key={line.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium">{line.description}</span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {line.requisition.neededBy === null
                      ? line.requisition.number
                      : t('purchaseOrders.openLineNeededBy', {
                          number: line.requisition.number,
                          date: isoDate(line.requisition.neededBy),
                        })}
                  </span>
                  <span className="text-caption text-ink-2 tabular-nums">
                    {t('purchaseOrders.openLineLeft', {
                      quantity: quantity(line.remainingQuantity, line.baseUnitId),
                    })}
                  </span>
                </span>
                <PickButton
                  added={added.has(line.id) || onForm.has(line.id)}
                  loading={loading === line.id}
                  onClick={() => void add(line)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
