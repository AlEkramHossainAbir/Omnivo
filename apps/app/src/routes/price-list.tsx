import {
  AlertCircleIcon,
  Archive02Icon,
  ArrowLeft01Icon,
  Delete02Icon,
  PackageSearchIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  Search01Icon,
  Tag01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  compareMoney,
  MAX_PRICE_LIST_CHANGES,
  type PriceList,
  type PriceListItem,
  type Product,
  type ProductSummary,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  FormAlert,
  IconButton,
  Input,
  MoneyInput,
  PageHeader,
  Pill,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';

import { LineError } from '../components/journal-parts';
import { PriceListForm } from '../components/price-list-form';
import { ApiRequestError, call } from '../lib/api';
import { useCan } from '../lib/permissions';
import {
  priceListItemsQuery,
  priceListQuery,
  productQuery,
  productSearchQuery,
  settingsQuery,
  unitsQuery,
} from '../lib/queries';
import { useSession } from '../lib/session-store';
import { useDebounced } from '../lib/use-debounced';

// One row of the page: a price the list holds (from the server), or an item just added from the
// picker that has no price yet. A price is per variant and per unit.
interface Row {
  key: string;
  variantId: string;
  unitId: string;
  productName: string;
  sku: string;
  optionValues: string[];
  // The saved price, or '' for a new row
  price: string;
  isNew: boolean;
}

// A change waiting for "Save prices". price '' takes the item out of the list.
interface Change {
  variantId: string;
  unitId: string;
  price: string;
}

const keyOf = (variantId: string, unitId: string) => `${variantId}:${unitId}`;

function rowOf(item: PriceListItem): Row {
  return {
    key: keyOf(item.variantId, item.unitId),
    variantId: item.variantId,
    unitId: item.unitId,
    productName: item.productName,
    sku: item.sku,
    optionValues: item.optionValues,
    price: item.price,
    isNew: false,
  };
}

// A product from the picker → one row per active version and per unit it is sold in (the base
// unit and every pack): a carton is often priced apart from 24 single pieces
function rowsOf(product: Product): Row[] {
  const unitIds = [product.baseUnitId, ...product.units.map((pack) => pack.unitId)];
  return product.variants
    .filter((variant) => variant.archivedAt === null)
    .flatMap((variant) =>
      unitIds.map((unitId) => ({
        key: keyOf(variant.id, unitId),
        variantId: variant.id,
        unitId,
        productName: product.name,
        sku: variant.sku,
        optionValues: variant.optionValues,
        price: '',
        isNew: true,
      })),
    );
}

// "Napa 500 mg" or "Polo shirt · M / Navy blue"
function rowName(row: Row): string {
  return row.optionValues.length === 0
    ? row.productName
    : `${row.productName} · ${row.optionValues.join(' / ')}`;
}

// The server names a refused change by its place in the batch ("changes.3.unitId"); the page
// needs the row it came from
const CHANGE_FIELD = /^changes\.(\d+)\./;

// Item, unit, price, remove: one template for the header and every row, so the columns line up
const ROW = '@3xl:grid-cols-[minmax(0,1fr)_7rem_12rem_2.25rem] @3xl:items-start';

// "Add items": search the products, then add one; each of its versions gets a row for every unit
function ItemPicker({ onAdd }: { onAdd: (product: Product) => void }) {
  const { t } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const { data: products } = useQuery(productSearchQuery(tenantId, settled));

  // The list sends a summary; the versions and the packs come with the product itself
  const add = async (summary: ProductSummary) => {
    setLoading(summary.id);
    try {
      onAdd(await queryClient.query(productQuery(tenantId, summary.id)));
      setAdded((before) => new Set(before).add(summary.id));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('priceLists.pickerTitle')}
      description={t('priceLists.pickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t('priceLists.pickerSearch')}
          placeholder={t('priceLists.searchPlaceholder')}
          autoFocus
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        {products?.length === 0 ? (
          <EmptyState
            icon={PackageSearchIcon}
            title={t('priceLists.pickerEmpty')}
            description={t('priceLists.pickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {products?.map((product) => (
              <li
                key={product.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium">{product.name}</span>
                  <span className="truncate text-caption text-ink-3">
                    <span className="font-mono tabular-nums">{product.code}</span>
                    {product.hasVariants &&
                      ` · ${t('products.variantCount', { count: product.variantCount })}`}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading === product.id}
                  onClick={() => void add(product)}
                >
                  <HugeiconsIcon
                    icon={added.has(product.id) ? Tick02Icon : PlusSignIcon}
                    size={16}
                    strokeWidth={1.5}
                  />
                  {added.has(product.id) ? t('priceLists.pickerAdded') : t('priceLists.pickerAdd')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}

function PriceListView({ priceList }: { priceList: PriceList }) {
  const { t, format } = useLocale();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const queryClient = useQueryClient();
  const mayManage = useCan()('sales.price_list.manage');
  // An archived list keeps its prices but takes no new ones (the API refuses them): restore it
  // first, from the Edit dialog
  const canManage = mayManage && priceList.archivedAt === null;
  const pricesIncludeVat = useQuery(settingsQuery(tenantId)).data?.pricesIncludeVat;
  const units = useQuery(unitsQuery(tenantId)).data;
  const unitCode = useMemo(() => new Map(units?.map((unit) => [unit.id, unit.code])), [units]);
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim());
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    priceListItemsQuery(tenantId, priceList.id, settled),
  );
  // The page's own state, until "Save prices": the rows added from the picker, the changed
  // prices, and the server's errors by row
  const [added, setAdded] = useState<Row[]>([]);
  const [changes, setChanges] = useState<ReadonlyMap<string, Change>>(new Map());
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);

  const saved = useMemo(() => data?.pages.flatMap((page) => page.items.map(rowOf)) ?? [], [data]);
  // New rows on top, and never twice: an item the list already holds keeps its own row
  const rows = useMemo(() => {
    const known = new Set(saved.map((row) => row.key));
    return [...added.filter((row) => !known.has(row.key)), ...saved];
  }, [added, saved]);
  // One save sends at most this many: past it, finish this batch first
  const full = changes.size >= MAX_PRICE_LIST_CHANGES;

  // The next page when the end of the list scrolls into view
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = end.current;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Typing the saved price back is no change at all: the row leaves the count
  const setPrice = (row: Row, price: string) => {
    setChanges((before) => {
      const next = new Map(before);
      const same =
        price === '' ? row.price === '' : row.price !== '' && compareMoney(price, row.price) === 0;
      if (same) next.delete(row.key);
      else next.set(row.key, { variantId: row.variantId, unitId: row.unitId, price });
      return next;
    });
  };

  // A new row goes away; a saved one keeps its row with an empty box, and "Save prices" takes it
  // out of the list
  const removeRow = (row: Row) => {
    if (row.isNew) {
      setAdded((before) => before.filter((item) => item.key !== row.key));
      setChanges((before) => {
        const next = new Map(before);
        next.delete(row.key);
        return next;
      });
    } else {
      setPrice(row, '');
    }
  };

  const discard = () => {
    setAdded([]);
    setChanges(new Map());
    setRowErrors(new Map());
    setFailure(null);
  };

  const save = async () => {
    const batch = [...changes.entries()];
    setSaving(true);
    setFailure(null);
    try {
      const result = await call(routes.priceLists.setItems, {
        params: { id: priceList.id },
        body: { changes: batch.map(([, change]) => change) },
      });
      queryClient.setQueryData(priceListQuery(tenantId, priceList.id).queryKey, result);
      await queryClient.invalidateQueries({ queryKey: ['price-lists', tenantId] });
      discard();
      toast(t('priceLists.pricesSaved'));
    } catch (error) {
      // All or nothing: nothing was saved. Each error goes under its row; the rest on top.
      const byRow = new Map<string, string>();
      let other: string | null = null;
      if (error instanceof ApiRequestError) {
        for (const [field, codes] of Object.entries(error.problem.fieldErrors ?? {})) {
          const index = CHANGE_FIELD.exec(field)?.[1];
          const key = index === undefined ? undefined : batch[Number(index)]?.[0];
          const code = codes[0];
          if (key !== undefined && code !== undefined) byRow.set(key, code);
        }
        if (byRow.size === 0) other = error.code;
      } else {
        other = 'unknown_error';
      }
      setRowErrors(byRow);
      setFailure(other);
    } finally {
      setSaving(false);
    }
  };

  const filtered = settled !== '';

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <Link
        to="/price-lists"
        className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
        {t('priceLists.back')}
      </Link>
      <PageHeader
        title={priceList.name}
        description={priceList.description}
        actions={
          mayManage && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(true);
                }}
              >
                <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
                {t('priceLists.edit')}
              </Button>
              {canManage && (
                <Button
                  disabled={full}
                  onClick={() => {
                    setPicking(true);
                  }}
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                  {t('priceLists.addItems')}
                </Button>
              )}
            </>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
        {/* The workspace setting the prices follow (Settings → Sales) */}
        {pricesIncludeVat !== undefined && (
          <Pill tone="neutral" icon={Tag01Icon}>
            {pricesIncludeVat ? t('priceLists.withVat') : t('priceLists.withoutVat')}
          </Pill>
        )}
        {priceList.archivedAt !== null && (
          <>
            <Pill tone="neutral" icon={Archive02Icon}>
              {t('priceLists.statuses.archived')}
            </Pill>
            <span>{t('priceLists.archivedNotice')}</span>
          </>
        )}
      </div>
      {!mayManage && <p className="text-body-sm text-ink-3">{t('priceLists.readOnly')}</p>}
      <div className="max-w-md">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t('priceLists.searchLabel')}
          placeholder={t('priceLists.searchPlaceholder')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </div>
      {failure && <FormAlert message={failure} />}
      {isError && <p className="text-body-sm text-crit">{t('priceLists.itemsLoadFailed')}</p>}
      {data &&
        (rows.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={Search01Icon}
              title={t('priceLists.itemsNoMatchTitle', { query: settled })}
              description={t('priceLists.itemsNoMatchBody')}
            />
          ) : (
            <EmptyState
              icon={Tag01Icon}
              title={t('priceLists.itemsEmptyTitle')}
              description={t('priceLists.itemsEmptyBody')}
              action={
                canManage && (
                  <Button
                    onClick={() => {
                      setPicking(true);
                    }}
                  >
                    <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                    {t('priceLists.addItems')}
                  </Button>
                )
              }
            />
          )
        ) : (
          <Card
            className="@container grid grid-cols-1 overflow-hidden"
            aria-label={t('priceLists.title')}
          >
            <div
              aria-hidden="true"
              className={cn(
                'hidden gap-3 bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @3xl:grid',
                ROW,
              )}
            >
              <span>{t('priceLists.itemColumns.item')}</span>
              <span>{t('priceLists.itemColumns.unit')}</span>
              <span className="text-right">{t('priceLists.itemColumns.price')}</span>
            </div>
            <ul className="grid grid-cols-1">
              {rows.map((row) => {
                const change = changes.get(row.key);
                const name = rowName(row);
                const unit = unitCode.get(row.unitId) ?? '';
                const id = `price-${row.key}`;
                const error = rowErrors.get(row.key);
                return (
                  <li
                    key={row.key}
                    role="group"
                    aria-label={name}
                    className={cn(
                      'grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-line px-5 py-3 first:border-t-0',
                      ROW,
                    )}
                  >
                    <div className="grid min-w-0 content-start gap-0.5 @3xl:pt-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-body-sm font-medium">{name}</span>
                        {row.isNew && (
                          <Pill tone="brand" icon={PlusSignIcon}>
                            {t('priceLists.new')}
                          </Pill>
                        )}
                      </span>
                      <span className="truncate font-mono text-caption text-ink-3">{row.sku}</span>
                    </div>
                    <span className="self-start pt-2 font-mono text-body-sm text-ink-2">
                      {unit}
                    </span>
                    <div className="col-span-2 grid grid-cols-1 gap-1.5 @3xl:col-span-1">
                      <MoneyInput
                        id={id}
                        aria-label={t('priceLists.priceOf', { name, unit })}
                        placeholder={t('priceLists.pricePlaceholder')}
                        value={change?.price ?? row.price}
                        disabled={!canManage || (full && change === undefined)}
                        invalid={error !== undefined}
                        aria-describedby={error ? `${id}-error` : undefined}
                        onChange={(value) => {
                          setPrice(row, value);
                        }}
                      />
                      <LineError id={id} error={error} />
                    </div>
                    {canManage && (
                      <IconButton
                        icon={Delete02Icon}
                        label={t('priceLists.remove', { name, unit })}
                        className="col-span-2 justify-self-end @3xl:col-span-1"
                        disabled={!row.isNew && (change?.price ?? row.price) === ''}
                        onClick={() => {
                          removeRow(row);
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            <div ref={end} />
            {isFetchingNextPage && (
              <p className="border-t border-line px-5 py-3 text-caption text-ink-3">
                {t('common.loadingMore')}
              </p>
            )}
          </Card>
        ))}

      {/* Shows only while something changed (CLAUDE.md → Permission matrix's save bar) */}
      {changes.size + added.length > 0 && (
        <Card className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 px-5 py-3 shadow-md">
          <span className="text-body-sm text-ink-2 tabular-nums">
            {full
              ? t('priceLists.tooMany', { max: format.number(MAX_PRICE_LIST_CHANGES) })
              : t('priceLists.unsaved', { count: changes.size })}
          </span>
          <span className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={saving} onClick={discard}>
              {t('priceLists.discard')}
            </Button>
            <Button disabled={saving || changes.size === 0} onClick={() => void save()}>
              {saving ? t('common.saving') : t('priceLists.savePrices')}
            </Button>
          </span>
        </Card>
      )}

      <Dialog open={editing} onOpenChange={setEditing}>
        {editing && (
          <PriceListForm
            priceList={priceList}
            onDone={() => {
              setEditing(false);
            }}
          />
        )}
      </Dialog>
      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ItemPicker
            onAdd={(product) => {
              setAdded((before) => {
                const known = new Set(before.map((row) => row.key));
                return [...rowsOf(product).filter((row) => !known.has(row.key)), ...before];
              });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

export function PriceListPage() {
  const { t } = useLocale();
  const { priceListId = '' } = useParams({ strict: false });
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const { data: priceList, isError } = useQuery({
    ...priceListQuery(tenantId, priceListId),
    enabled: priceListId !== '',
  });
  if (isError) {
    return (
      <div className="grid max-w-5xl grid-cols-1 gap-5">
        <Link
          to="/price-lists"
          className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          ← {t('priceLists.back')}
        </Link>
        <EmptyState
          icon={AlertCircleIcon}
          title={t('priceLists.title')}
          description={t('priceLists.notFound')}
        />
      </div>
    );
  }
  if (!priceList) return null;
  // key: another list opened from here starts with no pending changes
  return <PriceListView key={priceList.id} priceList={priceList} />;
}
