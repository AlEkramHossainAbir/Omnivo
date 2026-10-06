import { AlertCircleIcon, Edit02Icon, TransactionHistoryIcon } from '@hugeicons/core-free-icons';
import {
  compareQuantity,
  isMovementKind,
  isZeroQuantity,
  negateQuantity,
  type StockMovement,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Card,
  CardHeader,
  DataTable,
  dataTableColumns,
  DatePicker,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  KpiStrip,
  PageHeader,
  Select,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';

import {
  BackLink,
  ExpiryPill,
  useIsoDate,
  useQuantity,
  useTenantId,
  useToday,
  useWarehouses,
  warehouseLabel,
} from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { stockCardQuery, stockMovementsQuery } from '../lib/queries';
import { documentRoute, variantName } from '../lib/stock';

const column = dataTableColumns<StockMovement>();

// The reorder level dialog is a chunk of its own: the form library is only needed when someone
// opens it, and with it this page was over its 100 KB budget
const ReorderLevelForm = lazy(async () => ({
  default: (await import('../components/reorder-level-form')).ReorderLevelForm,
}));

export function StockCardPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const { variantId = '' } = useParams({ strict: false });
  const tenantId = useTenantId();
  const can = useCan();
  const canSetLevels = can('inventory.product.manage');
  // Step 14: what it costs, for the people who may see it
  const canSeeValues = can('inventory.stock.value');
  const quantity = useQuantity();
  const isoDate = useIsoDate();
  const today = useToday();
  const { active, byId } = useWarehouses();
  const [editing, setEditing] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const { data: card, isError } = useQuery({
    ...stockCardQuery(tenantId, variantId),
    enabled: variantId !== '',
  });
  const history = useInfiniteQuery({
    ...stockMovementsQuery(tenantId, variantId, { warehouseId, ...range }),
    enabled: variantId !== '',
  });
  const movements = useMemo(
    () => history.data?.pages.flatMap((page) => page.items),
    [history.data],
  );
  const first = history.data?.pages[0];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = history;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const baseUnitId = card?.item.baseUnitId ?? '';
  const columns = useMemo(() => {
    const side = (value: string, sign: 1 | -1) =>
      compareQuantity(value, '0') * sign > 0
        ? quantity(sign === 1 ? value : negateQuantity(value), baseUnitId)
        : '';
    return column.columns([
      column.accessor('documentNumber', {
        header: t('stock.history.document'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => (
          <span className="grid">
            <span className="font-mono font-medium tabular-nums">
              {row.original.documentNumber}
            </span>
            <span className="text-caption text-ink-3 tabular-nums">
              {isoDate(row.original.date)} ·{' '}
              {isMovementKind(row.original.kind)
                ? t(`stock.kinds.${row.original.kind}`)
                : row.original.kind}
            </span>
          </span>
        ),
      }),
      column.accessor('warehouseId', {
        header: t('stock.history.warehouse'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => byId.get(getValue())?.code ?? '—',
      }),
      column.accessor((row) => row.lotNumber ?? row.serialNumber ?? '', {
        id: 'detail',
        header: t('stock.history.detail'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ getValue }) => <span className="font-mono text-caption">{getValue() || '—'}</span>,
      }),
      column.accessor('quantity', {
        id: 'in',
        header: t('stock.history.in'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => side(getValue(), 1),
      }),
      column.accessor('quantity', {
        id: 'out',
        header: t('stock.history.out'),
        enableSorting: false,
        meta: { align: 'end', card: 'detail' },
        cell: ({ getValue }) => side(getValue(), -1),
      }),
      column.accessor('balance', {
        header: t('stock.history.balance'),
        enableSorting: false,
        meta: { align: 'end', card: 'trailing' },
        cell: ({ getValue }) => (
          <span className="font-medium">{quantity(getValue(), baseUnitId)}</span>
        ),
      }),
      ...(canSeeValues
        ? [
            // Signed like the quantity: what each movement added to or took from the stock's value
            column.accessor('value', {
              header: t('stock.history.value'),
              enableSorting: false,
              meta: { align: 'end', card: 'detail' },
              cell: ({ getValue }) => {
                const value = getValue();
                return value === null ? '—' : format.money(value, { decimals: 2 });
              },
            }),
          ]
        : []),
    ]);
  }, [t, format, quantity, isoDate, byId, baseUnitId, canSeeValues]);

  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink to="/stock" label={t('stock.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('stock.title')}
          description={t('stock.cardFailed')}
        />
      </div>
    );
  }
  if (!card) return null;
  const { item } = card;
  const places = card.warehouses.filter((place) => !isZeroQuantity(place.onHand)).length;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink to="/stock" label={t('stock.back')} />
      <PageHeader
        title={variantName(item)}
        // A simple product's SKU is its code: once is enough
        description={
          item.sku === item.productCode ? item.productCode : `${item.productCode} · ${item.sku}`
        }
      />
      <KpiStrip
        cells={[
          { label: t('stock.kpis.onHand'), value: quantity(item.onHand, item.baseUnitId) },
          { label: t('stock.kpis.inTransit'), value: quantity(item.inTransit, item.baseUnitId) },
          // With the permission, what it costs takes the place of "warehouses with stock"
          ...(item.value === null
            ? [{ label: t('stock.kpis.places'), value: String(places) }]
            : [
                {
                  label: t('stock.kpis.unitCost'),
                  value:
                    item.unitCost === null
                      ? t('stock.noCost')
                      : format.money(item.unitCost, { decimals: 2 }),
                },
                { label: t('stock.kpis.value'), value: format.money(item.value) },
              ]),
        ]}
      />

      <Card className="overflow-x-auto">
        <CardHeader title={t('stock.byWarehouse')} subtitle={t('stock.byWarehouseSubtitle')} />
        <table className="mt-4 w-full min-w-[560px] border-collapse text-body-sm">
          <caption className="sr-only">{t('stock.byWarehouse')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('stock.warehouse')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('stock.columns.onHand')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('stock.columns.inTransit')}
              </th>
              <th scope="col" className="px-5 py-2.5">
                {t('stock.level')}
              </th>
              {canSetLevels && <th scope="col" className="w-12" />}
            </tr>
          </thead>
          <tbody>
            {card.warehouses.map((place) => (
              <tr key={place.warehouseId} className="border-t border-line">
                <td className="px-5 py-3 font-medium">
                  {warehouseLabel(byId.get(place.warehouseId))}
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  {quantity(place.onHand, item.baseUnitId)}
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  {isZeroQuantity(place.inTransit)
                    ? '—'
                    : quantity(place.inTransit, item.baseUnitId)}
                </td>
                <td className="px-5 py-3 text-ink-2 tabular-nums">
                  {place.minQuantity === null
                    ? t('stock.noLevel')
                    : [
                        t('stock.levelAt', {
                          quantity: quantity(place.minQuantity, item.baseUnitId),
                        }),
                        place.reorderQuantity !== null &&
                          t('stock.levelOrder', {
                            quantity: quantity(place.reorderQuantity, item.baseUnitId),
                          }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                </td>
                {canSetLevels && (
                  <td className="px-3 py-1.5">
                    {active?.some((warehouse) => warehouse.id === place.warehouseId) && (
                      <IconButton
                        icon={Edit02Icon}
                        label={t('stock.setLevel', {
                          warehouse: warehouseLabel(byId.get(place.warehouseId)),
                        })}
                        onClick={() => {
                          setEditing(place.warehouseId);
                        }}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {item.tracking === 'batch' && card.batches.length > 0 && (
        <Card className="overflow-x-auto">
          <CardHeader title={t('stock.batchesTitle')} subtitle={t('stock.batchesSubtitle')} />
          <table className="mt-4 w-full min-w-[560px] border-collapse text-body-sm">
            <caption className="sr-only">{t('stock.batchesTitle')}</caption>
            <thead>
              <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
                <th scope="col" className="px-5 py-2.5">
                  {t('stock.lot')}
                </th>
                <th scope="col" className="px-5 py-2.5">
                  {t('stock.warehouse')}
                </th>
                <th scope="col" className="px-5 py-2.5">
                  {t('stock.expires')}
                </th>
                <th scope="col" className="px-5 py-2.5 text-right">
                  {t('stock.columns.onHand')}
                </th>
              </tr>
            </thead>
            <tbody>
              {card.batches.map((batch) => (
                <tr key={`${batch.batchId}-${batch.warehouseId}`} className="border-t border-line">
                  <td className="px-5 py-3">
                    <span className="font-mono">{batch.lotNumber}</span>
                    {batch.manufacturedOn !== null && (
                      <span className="block text-caption text-ink-3">
                        {t('stock.made')} {isoDate(batch.manufacturedOn)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3">{byId.get(batch.warehouseId)?.code ?? '—'}</td>
                  <td className="px-5 py-3">
                    <ExpiryPill expiresOn={batch.expiresOn} today={today} />
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {quantity(batch.quantity, item.baseUnitId)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {item.tracking === 'serial' && card.serials.length > 0 && (
        <Card>
          <CardHeader title={t('stock.serialsTitle')} subtitle={t('stock.serialsSubtitle')} />
          <ul className="grid grid-cols-1 gap-x-6 px-5 pt-3 pb-4 sm:grid-cols-2 lg:grid-cols-3">
            {card.serials.map((serial) => (
              <li
                key={serial.serialNumber}
                className="flex items-center justify-between gap-3 border-b border-line py-2 text-body-sm"
              >
                <span className="font-mono">{serial.serialNumber}</span>
                <span className="text-caption text-ink-3">
                  {serial.warehouseId === null
                    ? t('stock.inTransitPlace')
                    : (byId.get(serial.warehouseId)?.code ?? '—')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <section className="grid grid-cols-1 gap-4">
        <header>
          <h2 className="text-h3">{t('stock.historyTitle')}</h2>
          <p className="text-label text-ink-3">{t('stock.historySubtitle')}</p>
        </header>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Field id="history-warehouse" label={t('stock.warehouse')}>
            <Select
              id="history-warehouse"
              options={[
                { value: '', label: t('stock.allWarehouses') },
                ...card.warehouses.map((place) => ({
                  value: place.warehouseId,
                  label: warehouseLabel(byId.get(place.warehouseId)),
                })),
              ]}
              value={warehouseId}
              onChange={(event) => {
                setWarehouseId(event.target.value);
              }}
            />
          </Field>
          <Field id="history-from" label={t('stock.from')}>
            <DatePicker
              id="history-from"
              value={range.from}
              onChange={(value) => {
                setRange((before) => ({ ...before, from: value }));
              }}
            />
          </Field>
          <Field id="history-to" label={t('stock.to')}>
            <DatePicker
              id="history-to"
              value={range.to}
              onChange={(value) => {
                setRange((before) => ({ ...before, to: value }));
              }}
            />
          </Field>
        </div>
        {first && range.from !== '' && (
          <p className="text-body-sm text-ink-2 tabular-nums">
            {t('stock.opening')}: {quantity(first.openingBalance, item.baseUnitId)} ·{' '}
            {t('stock.closing')}: {quantity(first.closingBalance, item.baseUnitId)}
          </p>
        )}
        {movements && (
          <DataTable
            label={t('stock.historyTitle')}
            data={movements}
            columns={columns}
            getRowId={(movement) => movement.id}
            onRowClick={(movement) => {
              const route = documentRoute(movement.kind);
              if (route === '/stock/adjustments/$adjustmentId') {
                void navigate({ to: route, params: { adjustmentId: movement.documentId } });
              } else if (route === '/stock/transfers/$transferId') {
                void navigate({ to: route, params: { transferId: movement.documentId } });
              } else if (route === '/stock/revaluations/$revaluationId') {
                void navigate({ to: route, params: { revaluationId: movement.documentId } });
              }
            }}
            onEndReached={loadMore}
            empty={
              <EmptyState
                icon={TransactionHistoryIcon}
                title={t('stock.historyTitle')}
                description={t('stock.historyEmpty')}
              />
            }
            footer={
              isFetchingNextPage && (
                <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
              )
            }
          />
        )}
      </section>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <Suspense fallback={null}>
            <ReorderLevelForm
              key={editing}
              card={card}
              warehouseId={editing}
              onDone={() => {
                setEditing(null);
              }}
            />
          </Suspense>
        )}
      </Dialog>
    </div>
  );
}
