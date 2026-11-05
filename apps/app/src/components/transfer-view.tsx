import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  plainQuantity,
  type ReceiveTransferFormValues,
  receiveTransferInputSchema,
  routes,
  type StockTransfer,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  DatePicker,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { Controller, type Path, useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { firstMessage } from '../lib/stock';
import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { LineField } from './journal-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { StockLinesTable } from './stock-lines-table';
import {
  BackLink,
  TransferStatusPills,
  useIsoDate,
  useQuantity,
  useStockRefresh,
  useWarehouses,
  VariantCell,
  warehouseLabel,
} from './stock-parts';

// A sent transfer. On its way, someone who can receive it sees the receipt form; received, it is
// read only — with what arrived and any shortage, line by line.
export function TransferView({
  transfer,
  canReceive,
  today,
}: {
  transfer: StockTransfer;
  canReceive: boolean;
  today: string;
}) {
  const { t } = useLocale();
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const to = warehouseLabel(byId.get(transfer.toWarehouseId));
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock/transfers" label={t('transfers.back')} />
      <PageHeader
        title={transfer.number ?? t('transfers.draftTitle')}
        description={`${warehouseLabel(byId.get(transfer.fromWarehouseId))} → ${to}`}
        actions={<TransferStatusPills transfer={transfer} />}
      />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact label={t('transfers.date')} value={isoDate(transfer.sentOn)} />
        {transfer.receivedOn !== null && (
          <Fact label={t('transfers.receiveDate')} value={isoDate(transfer.receivedOn)} />
        )}
        {transfer.note !== null && <Fact label={t('transfers.note')} value={transfer.note} />}
        {transfer.status !== 'draft' && (
          <EntryLinks label={t('transfers.entries')} entries={transfer.entries} none="—" />
        )}
      </Card>
      {transfer.status === 'in_transit' && canReceive ? (
        <ReceiveForm transfer={transfer} today={today} warehouse={to} />
      ) : (
        <StockLinesTable lines={transfer.lines} received={transfer.status === 'received'} />
      )}
    </div>
  );
}

type FormValues = ReceiveTransferFormValues;

const LINE_COLUMNS = '@3xl:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1.6fr)] @3xl:items-start';

// What arrived, line by line, in the base unit. Every line starts as "all of it arrived": the
// store keeper only changes what is short. A serial line counts the serial numbers left in its box.
function ReceiveForm({
  transfer,
  today,
  warehouse,
}: {
  transfer: StockTransfer;
  today: string;
  warehouse: string;
}) {
  const { t } = useLocale();
  const quantity = useQuantity();
  const refresh = useStockRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(receiveTransferInputSchema, { error: contractErrorMap }),
    defaultValues: {
      version: transfer.version,
      date: today,
      lines: transfer.lines.map((line) => ({
        lineId: line.id,
        receivedQuantity: plainQuantity(line.baseQuantity),
        serialNumbers: line.serialNumbers,
      })),
    },
  });

  const names: Path<FormValues>[] = [
    'date',
    'lines',
    ...transfer.lines.flatMap((_, index) => [
      rowPath('lines', index, 'receivedQuantity'),
      rowPath('lines', index, 'serialNumbers'),
    ]),
  ];

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.stockTransfers.receive, {
        params: { id: transfer.id },
        body: values,
      });
      await refresh();
      toast(t('transfers.received', { number: saved.number ?? '' }));
    } catch (error) {
      applyApiError(error, names, setError);
    }
  });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="grid grid-cols-1 gap-5">
      {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
      <Card className="@container grid grid-cols-1 overflow-hidden">
        <CardHeader
          title={t('transfers.receiveTitle', { warehouse })}
          subtitle={t('transfers.receiveSubtitle')}
        />
        <div className="grid grid-cols-1 gap-5 px-5 pt-4 pb-5 sm:max-w-[13rem]">
          <FormField control={control} name="date" label={t('transfers.receiveDate')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
        </div>
        <div
          aria-hidden="true"
          className={cn(
            'hidden gap-3 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
            LINE_COLUMNS,
          )}
        >
          <span>{t('stockLines.items')}</span>
          <span className="text-right">{t('transfers.sentQuantity')}</span>
          <span>{t('transfers.receivedQuantity')}</span>
        </div>
        {transfer.lines.map((line, index) => {
          const lineErrors = errors.lines?.[index];
          const path = rowPath('lines', index, 'receivedQuantity');
          const serials = rowPath('lines', index, 'serialNumbers');
          return (
            <div
              key={line.id}
              role="group"
              aria-label={t('stockLines.line', { number: index + 1 })}
              className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', LINE_COLUMNS)}
            >
              <div className="col-span-2 @3xl:col-span-1">
                <VariantCell item={line} />
              </div>
              <div className="grid content-start gap-1.5">
                <span className="text-label font-medium text-ink @3xl:sr-only">
                  {t('transfers.sentQuantity')}
                </span>
                <span className="py-2.5 text-body tabular-nums @3xl:text-right">
                  {quantity(line.baseQuantity, line.baseUnitId)}
                </span>
              </div>
              {line.tracking === 'serial' ? (
                <div className="col-span-2 @3xl:col-span-1">
                  <Controller
                    control={control}
                    name={serials}
                    render={({ field }) => {
                      const error = firstMessage(lineErrors?.serialNumbers);
                      return (
                        <LineField id={serials} label={t('transfers.serialsArrived')} error={error}>
                          <SerialNumbersInput
                            id={serials}
                            name={field.name}
                            ref={field.ref}
                            value={field.value}
                            onChange={(next) => {
                              field.onChange(next);
                              // A serial line's quantity is its serial numbers, one each
                              setValue(path, String(next.length));
                            }}
                            onBlur={field.onBlur}
                            invalid={error !== undefined}
                          />
                        </LineField>
                      );
                    }}
                  />
                </div>
              ) : (
                <LineField
                  id={path}
                  label={t('transfers.receivedQuantity')}
                  error={lineErrors?.receivedQuantity?.message}
                >
                  <Input
                    id={path}
                    inputMode="decimal"
                    autoComplete="off"
                    align="end"
                    invalid={lineErrors?.receivedQuantity !== undefined}
                    {...register(path)}
                  />
                </LineField>
              )}
            </div>
          );
        })}
      </Card>
      <div className="flex justify-end">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t('transfers.receiving') : t('transfers.receive')}
        </Button>
      </div>
    </form>
  );
}
