import { PackageReceiveIcon, Wrench01Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { DialogContent, EmptyState } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { type BillSourcedLine, orderServiceLines, receiptBillLines } from '../lib/bill-sources';
import {
  goodsReceiptQuery,
  ordersToBillQuery,
  purchaseOrderQuery,
  receiptsToBillQuery,
} from '../lib/queries';
import { failureOf } from './journal-parts';
import { PickButton, PickProblem } from './sales-parts';
import { useIsoDate, useTenantId } from './stock-parts';

// The bill line editor's two pickers (step 17c), a chunk of their own loaded when one opens: with
// them inside, the editor's chunk was over its 100 KB budget, and most bills are typed with a
// picker opened once or not at all.

export type AddSourced = (
  sourced: readonly BillSourcedLine[],
  setting: boolean | null,
) => string | null;

// "Add goods receipts": the supplier's posted receipts with a line to bill. Each click adds what is
// left of that receipt, priced from its order. The dialog stays open: a month of deliveries from
// one mill goes on one bill.
export function ReceiptPicker({
  supplierId,
  onForm,
  addSourced,
}: {
  supplierId: string;
  onForm: ReadonlySet<string>;
  addSourced: AddSourced;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const { data: receipts } = useQuery(receiptsToBillQuery(tenantId, supplierId));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async (receiptId: string) => {
    setLoading(receiptId);
    setProblem(null);
    try {
      const receipt = await queryClient.query(goodsReceiptQuery(tenantId, receiptId));
      const { lines, order } = await receiptBillLines(queryClient, tenantId, receipt, onForm);
      const failed = addSourced(lines, order?.pricesIncludeVat ?? null);
      if (failed === null) setAdded((before) => new Set(before).add(receiptId));
      else setProblem(failed);
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('bills.receiptPickerTitle')}
      description={t('bills.receiptPickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {receipts?.length === 0 ? (
          <EmptyState
            icon={PackageReceiveIcon}
            title={t('bills.receiptPickerEmpty')}
            description={t('bills.receiptPickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {receipts?.map((receipt) => (
              <li
                key={receipt.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="font-mono text-body-sm font-medium tabular-nums">
                    {receipt.number ?? ''}
                  </span>
                  <span className="truncate text-caption text-ink-3 tabular-nums">
                    {isoDate(receipt.date)} ·{' '}
                    {t('bills.receiptLines', { count: receipt.lineCount })}
                    {receipt.order?.number && ` · ${receipt.order.number}`}
                    {receipt.supplierChallan && ` · ${receipt.supplierChallan}`}
                  </span>
                </span>
                <PickButton
                  added={added.has(receipt.id)}
                  loading={loading === receipt.id}
                  onClick={() => void pick(receipt.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}

// "Add order services": the supplier's orders with a service no posted bill bills yet; a click adds
// the order's services that are not on the form (a dyeing charge, a transport charge)
export function ServicePicker({
  supplierId,
  onForm,
  addSourced,
}: {
  supplierId: string;
  onForm: ReadonlySet<string>;
  addSourced: AddSourced;
}) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  const { data: orders } = useQuery(ordersToBillQuery(tenantId, supplierId));
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = async (orderId: string) => {
    setLoading(orderId);
    setProblem(null);
    try {
      const order = await queryClient.query(purchaseOrderQuery(tenantId, orderId));
      const services = orderServiceLines(order, onForm);
      if (services.length === 0) {
        setProblem(t('bills.noServicesLeft', { number: order.number ?? '' }));
        return;
      }
      const failed = addSourced(services, order.pricesIncludeVat);
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
      title={t('bills.servicePickerTitle')}
      description={t('bills.servicePickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <PickProblem message={problem} />
        {orders?.length === 0 ? (
          <EmptyState
            icon={Wrench01Icon}
            title={t('bills.servicePickerEmpty')}
            description={t('bills.servicePickerDescription')}
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
                    {[isoDate(order.date), order.supplierReference]
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
