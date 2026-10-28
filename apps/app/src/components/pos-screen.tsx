import { Search01Icon } from '@hugeicons/core-free-icons';
import {
  compareQuantity,
  type Product,
  type ProductVariant,
  SYNC_BLOCK_AFTER_DAYS,
  type SyncPosRegister,
  type SyncSettings,
  type TaxRate,
  todayIn,
  type Unit,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  allRows,
  type LocalCopy,
  lookUpPrices,
  productByBarcode,
  productPage,
  stockOf,
} from '@omnivo/sync';
import { cn, Input } from '@omnivo/ui';
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useLocalQuery } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import {
  addToCart,
  type Cart,
  cartAmounts,
  type CartLine,
  changeLine,
  EMPTY_CART,
  fefoBatch,
  itemName,
  lineReady,
  newLineKey,
  onHandOf,
  overridesOf,
  removeLine,
  shortLines,
} from '../lib/pos';
import { useSession } from '../lib/session-store';
import { useSyncAge } from '../lib/sync-summary';
import { useOnline } from '../lib/use-online';
import { DocumentNotice } from './document-notice';
import { PosCart } from './pos-cart';
import { hasPaisa, Kbd, useReceiptCompany } from './pos-parts';
import type { DoneSale } from './pos-pay';

// The payment, the done dialog, the shortcuts and the receipt: a chunk of their own, loaded the
// first time one opens (the screen's chunk stays in its budget). Offline too: the service worker
// keeps every chunk (step 19a).
const PayDialog = lazy(async () => ({ default: (await import('./pos-pay')).PayDialog }));
const DoneDialog = lazy(async () => ({ default: (await import('./pos-pay')).DoneDialog }));
const ShortcutsDialog = lazy(async () => ({
  default: (await import('./pos-pay')).ShortcutsDialog,
}));
const PosReceipt = lazy(async () => ({ default: (await import('./pos-receipt')).PosReceipt }));

// Step 20a (decision 12): the products on the left, the cart on the right; on a phone the products
// alone, with the cart as a bar at the bottom that opens over them. A whole sale works from the
// keyboard: a scanner types the barcode and Enter into the search box, which has the focus.

// How many tiles at once: two screens of a desktop's grid. A search narrows them; nobody scrolls
// through 10,000 products at a counter.
const TILE_LIMIT = 48;

async function readRates(copy: LocalCopy): Promise<TaxRate[]> {
  return allRows(copy, copy.db.taxRates);
}

async function readUnits(copy: LocalCopy): Promise<Unit[]> {
  return allRows(copy, copy.db.units);
}

// One tile: a variant of a product. Archived variants are not sold (the server keeps them for old
// documents only).
interface Tile {
  product: Product;
  variant: ProductVariant;
}

function tilesOf(products: readonly Product[]): Tile[] {
  return products
    .flatMap((product) =>
      product.variants
        .filter((variant) => variant.archivedAt === null)
        .map((variant) => ({ product, variant })),
    )
    .slice(0, TILE_LIMIT);
}

// A key press inside a box is typing, not a shortcut ("?" in a reference)
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function PosScreen({
  copy,
  register,
  settings,
  shortcuts,
  onShortcuts,
}: {
  copy: LocalCopy;
  register: SyncPosRegister;
  settings: SyncSettings;
  shortcuts: boolean;
  onShortcuts: (open: boolean) => void;
}) {
  const { t, format, errorText } = useLocale();
  const can = useCan();
  const online = useOnline();
  const age = useSyncAge();
  const cashier = useSession((state) => state.me?.user.fullName) ?? '';
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search);
  // What the last scan or Enter found nothing for, said under the box
  const [message, setMessage] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [selected, setSelected] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState<DoneSale | null>(null);
  // A phone: the cart over the products
  const [cartOpen, setCartOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLButtonElement>(null);
  const billDiscountRef = useRef<HTMLInputElement>(null);

  const today = todayIn(settings.timezone);
  // The company on the receipt, from the device's copy of the settings (it prints offline)
  const company = useReceiptCompany(settings);
  const { allowNegativeStock, pricesIncludeVat } = settings;
  // Decision 11: without the permission the boxes say so, and Pay waits
  const canOverride = can('pos.price.override');
  // Step 18c's limit: offline more than 7 days after the last sync, no new work on this device
  const blocked = !online && age?.age === 'blocked';

  const findTiles = useCallback(
    async (open: LocalCopy) =>
      tilesOf(
        (
          await productPage(open, {
            search: deferred,
            categoryIds: null,
            sort: 'name',
            limit: TILE_LIMIT,
          })
        ).rows,
      ),
    [deferred],
  );
  const tiles = useLocalQuery(findTiles);
  const rates = useLocalQuery(readRates);
  const units = useLocalQuery(readUnits);

  // The stock of what is on the screen: the tiles and the cart. One read, again when either
  // changes or a pull writes stock. The ids as one sorted string, so the same set is the same read.
  const variantIds = useMemo(
    () =>
      [
        ...new Set([
          ...(tiles ?? []).map((tile) => tile.variant.id),
          ...cart.lines.map((line) => line.variantId),
        ]),
      ]
        .sort()
        .join(','),
    [tiles, cart.lines],
  );
  const readStock = useCallback(
    (open: LocalCopy) =>
      stockOf(open, register.warehouseId, variantIds === '' ? [] : variantIds.split(',')),
    [register.warehouseId, variantIds],
  );
  const stock = useLocalQuery(readStock);

  const amounts = useMemo(() => cartAmounts(cart, pricesIncludeVat), [cart, pricesIncludeVat]);
  const short = useMemo(
    () => shortLines(cart, stock ?? [], allowNegativeStock),
    [cart, stock, allowNegativeStock],
  );
  const overrides = useMemo(
    () => (canOverride ? [] : overridesOf(cart, register)),
    [cart, register, canOverride],
  );

  const payable =
    cart.lines.length > 0 &&
    cart.lines.every(lineReady) &&
    short.size === 0 &&
    overrides.length === 0 &&
    !blocked;

  // A tile's click, a scan or Enter: the line with its price, VAT rate and batch, from the copy.
  // The price as the customer's price list has it now (lookUpPrices, step 18b).
  const add = async (product: Product, variant: ProductVariant, unitId: string) => {
    setMessage(null);
    const [price] = await lookUpPrices(copy, cart.customer?.priceListId ?? null, [
      { variantId: variant.id, unitId },
    ]);
    // No VAT rate at all: a workspace whose rates are not set up yet
    if (!price) {
      setMessage(errorText('tax_rate_invalid'));
      return;
    }
    const goods = product.type === 'goods';
    const batched = goods && product.tracking === 'batch';
    const rows = batched ? await stockOf(copy, register.warehouseId, [variant.id]) : [];
    const batchId = batched ? fefoBatch(rows, today, allowNegativeStock) : null;
    if (batched && batchId === null) {
      setMessage(t('pos.noStock'));
      return;
    }
    const unit = units?.find((one) => one.id === unitId);
    const line: CartLine = {
      key: newLineKey(),
      productId: product.id,
      variantId: variant.id,
      unitId,
      factor:
        unitId === product.baseUnitId
          ? '1'
          : (product.units.find((pack) => pack.unitId === unitId)?.factor ?? '1'),
      name: itemName(product, variant),
      sku: variant.sku,
      unitCode: unit?.code ?? '',
      decimals: unit?.decimals ?? 0,
      tracking: product.tracking,
      goods,
      quantity: '1',
      unitPrice: price.price ?? '',
      startingPrice: price.price,
      discountType: 'percent',
      discount: '0',
      taxRateId: price.taxRateId,
      rate: rates?.find((rate) => rate.id === price.taxRateId)?.rate ?? '0',
      batchId,
      serialNumbers: [],
    };
    setCart((current) => addToCart(current, line));
    // A serial item opens at once: the next scan is its serial number
    setSelected(line.tracking === 'serial' ? line.key : null);
  };

  // The sales unit a tile adds: the one the product's sales forms start with, else the base unit
  const addTile = (tile: Tile) =>
    void add(tile.product, tile.variant, tile.product.salesUnitId ?? tile.product.baseUnitId);

  // Enter in the search box. A scanner's barcode first: a variant's (one base unit) or a pack's
  // (a product without variants has its packs' barcodes). Else the only tile that matches, like the
  // "Add items" dialog. The box empties after a hit, ready for the next scan.
  const enter = async () => {
    const typed = search.trim();
    if (typed === '') return;
    const product = await productByBarcode(copy, typed);
    if (product) {
      const variant = product.variants.find((one) => one.barcode === typed);
      const pack = product.units.find((one) => one.barcode === typed);
      const target = variant ?? product.variants.find((one) => one.archivedAt === null);
      if (target) {
        await add(
          product,
          target,
          variant ? product.baseUnitId : (pack?.unitId ?? product.baseUnitId),
        );
        setSearch('');
        return;
      }
    }
    const [only, ...more] = tiles ?? [];
    if (only && more.length === 0) {
      addTile(only);
      setSearch('');
      return;
    }
    if (!tiles?.length) {
      setMessage(
        /^\d+$/.test(typed)
          ? t('pos.noBarcode', { code: typed })
          : t('pos.noMatch', { query: typed }),
      );
    }
  };

  // The shortcuts (decision 12). Not while a dialog is open: it has its own keys (Enter completes
  // the sale, or starts the next one). F12 opens the browser's tools in some browsers; the page
  // asks first, and Chrome lets it.
  useEffect(() => {
    if (paying || done || shortcuts) return;
    const onKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'F2':
          event.preventDefault();
          searchRef.current?.focus();
          break;
        case 'F4':
          event.preventDefault();
          customerRef.current?.click();
          break;
        case 'F7':
          event.preventDefault();
          billDiscountRef.current?.focus();
          break;
        case 'F12':
          event.preventDefault();
          if (payable) setPaying(true);
          break;
        case '?':
          if (isTyping(event.target)) return;
          event.preventDefault();
          onShortcuts(true);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [paying, done, shortcuts, payable, onShortcuts]);

  const newSale = () => {
    setDone(null);
    setCartOpen(false);
    searchRef.current?.focus();
  };

  return (
    <div className="grid min-h-0 flex-1 min-[860px]:grid-cols-[minmax(0,1fr)_400px] print:hidden">
      <section className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 pb-24 min-[860px]:p-6">
        {blocked && (
          <DocumentNotice tone="warn">
            {t('sync.blockedFormNotice', { days: format.number(SYNC_BLOCK_AFTER_DAYS) })}
          </DocumentNotice>
        )}
        <label className="grid gap-1.5">
          <span className="text-label font-medium">{t('pos.search')}</span>
          <Input
            ref={searchRef}
            icon={Search01Icon}
            type="search"
            // The focus starts here: a scanner types into whatever has it
            autoFocus
            autoComplete="off"
            enterKeyHint="search"
            placeholder={t('pos.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setMessage(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void enter();
              }
            }}
            trailing={<Kbd>F2</Kbd>}
          />
          <span role="status" className="text-label text-ink-3">
            {message}
          </span>
        </label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))]">
          {(tiles ?? []).map((tile) => {
            const goods = tile.product.type === 'goods';
            const onHand = onHandOf(stock ?? [], tile.variant.id);
            const out = goods && !allowNegativeStock && compareQuantity(onHand, '0') <= 0;
            const unit = units?.find((one) => one.id === tile.product.baseUnitId);
            return (
              <button
                key={tile.variant.id}
                type="button"
                disabled={out}
                onClick={() => {
                  addTile(tile);
                }}
                className={cn(
                  'flex min-h-[104px] flex-col gap-1 rounded-control border border-line bg-surface p-3 text-left shadow-sm transition-colors duration-150 hover:border-ink-3',
                  'disabled:border-line disabled:bg-subtle disabled:shadow-none',
                )}
              >
                <span className="line-clamp-2 text-body-sm font-medium text-ink">
                  {itemName(tile.product, tile.variant)}
                </span>
                <span className="font-mono text-caption text-ink-3">{tile.variant.sku}</span>
                <span className="mt-auto flex items-baseline justify-between gap-2">
                  <span className="text-body-sm font-semibold tabular-nums">
                    {tile.variant.salePrice === null
                      ? '—'
                      : format.money(tile.variant.salePrice, {
                          decimals: hasPaisa(tile.variant.salePrice) ? 2 : 0,
                        })}
                  </span>
                  {goods && (
                    <span
                      className={cn('text-caption tabular-nums', out ? 'text-ink-3' : 'text-ink-2')}
                    >
                      {out
                        ? t('pos.outOfStock')
                        : `${format.number(onHand, unit?.decimals ?? 0)} ${unit?.code ?? ''}`}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <PosCart
        register={register}
        cart={cart}
        amounts={amounts}
        stock={stock ?? []}
        today={today}
        pricesIncludeVat={pricesIncludeVat}
        selected={selected}
        onSelect={setSelected}
        onCart={setCart}
        onLine={(key, change) => {
          setCart((current) => changeLine(current, key, change));
        }}
        onRemove={(key) => {
          setCart((current) => removeLine(current, key));
        }}
        short={short}
        overrides={overrides}
        canOverride={canOverride}
        payable={payable}
        onPay={() => {
          setPaying(true);
        }}
        open={cartOpen}
        onOpen={setCartOpen}
        customerRef={customerRef}
        billDiscountRef={billDiscountRef}
      />
      <Suspense fallback={null}>
        {paying && (
          <PayDialog
            copy={copy}
            register={register}
            cart={cart}
            total={amounts.totals.total}
            date={today}
            pricesIncludeVat={pricesIncludeVat}
            cashier={cashier}
            onClose={() => {
              setPaying(false);
            }}
            onDone={(sale: DoneSale) => {
              setPaying(false);
              setCart(EMPTY_CART);
              setSelected(null);
              setDone(sale);
            }}
          />
        )}
        {done && (
          <>
            <DoneDialog
              sale={done}
              offline={!online}
              onPrint={() => {
                window.print();
              }}
              onNew={newSale}
            />
            <PosReceipt receipt={done.receipt} company={company} printOnMount />
          </>
        )}
        {shortcuts && (
          <ShortcutsDialog
            onClose={() => {
              onShortcuts(false);
            }}
          />
        )}
      </Suspense>
    </div>
  );
}
