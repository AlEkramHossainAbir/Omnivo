import {
  Alert02Icon,
  ArrowLeft01Icon,
  Delete02Icon,
  MinusSignIcon,
  PlusSignIcon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  addQuantity,
  compareQuantity,
  isQuantity,
  isZeroMoney,
  type PosOverride,
  subtractQuantity,
  type SyncPosRegister,
  type SyncStock,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { findCustomers, type LocalCopy } from '@omnivo/sync';
import {
  Button,
  cn,
  Combobox,
  type ComboboxOption,
  DiscountInput,
  Field,
  IconButton,
  Input,
  MoneyInput,
  parseIsoDate,
  Select,
} from '@omnivo/ui';
import { type ReactNode, type Ref, useCallback, useDeferredValue, useState } from 'react';

import { useLocalQuery } from '../lib/local-data';
import { type Cart, type CartAmounts, type CartLine, EMPTY_CART } from '../lib/pos';
import { hasPaisa, Kbd } from './pos-parts';
import { SerialNumbersInput } from './serial-numbers-input';

// Step 20a: the cart (decision 12). A line folds to one row (name, amount, a −/+ stepper, its price
// and unit); the line picked opens its boxes: quantity, price, discount, batch, serial numbers.
// Under the lines, the totals on `subtle` and the Pay button. On a phone the cart is a bar at the
// bottom (the item count, the total, Pay) and opens over the products.

interface PosCartProps {
  register: SyncPosRegister;
  cart: Cart;
  amounts: CartAmounts;
  stock: readonly SyncStock[];
  today: string;
  pricesIncludeVat: boolean;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onCart: (update: (cart: Cart) => Cart) => void;
  onLine: (key: string, change: Partial<CartLine>) => void;
  onRemove: (key: string) => void;
  // shortLines(): the line's key → what the warehouse has of its variant
  short: ReadonlyMap<string, string>;
  // overridesOf(); empty for someone with pos.price.override
  overrides: readonly PosOverride[];
  canOverride: boolean;
  payable: boolean;
  onPay: () => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  customerRef: Ref<HTMLButtonElement>;
  billDiscountRef: Ref<HTMLInputElement>;
}

// Money on the screen: whole taka unless it has paisa (hasPaisa)
function useScreenMoney(): (value: string) => string {
  const { format } = useLocale();
  return (value) => format.money(value, { decimals: hasPaisa(value) ? 2 : 0 });
}

// Destructured whole: the React compiler's lint takes any read of the props object in the markup
// for a ref read, because two of the props are refs
export function PosCart({
  register,
  cart,
  amounts,
  stock,
  pricesIncludeVat,
  selected,
  onSelect,
  onCart,
  onLine,
  onRemove,
  short,
  overrides,
  canOverride,
  payable,
  onPay,
  open,
  onOpen,
  customerRef,
  billDiscountRef,
}: PosCartProps) {
  const { t, format } = useLocale();
  const money = useScreenMoney();
  const total = amounts.totals.total;
  const count = t('pos.itemCount', {
    count: cart.lines.length,
    formatted: format.number(cart.lines.length),
  });
  const billOver = overrides.some((override) => override.kind === 'bill_discount');

  return (
    <>
      <aside
        aria-label={t('pos.cart')}
        className={cn(
          'flex min-h-0 flex-col border-line bg-surface min-[860px]:border-l',
          // A phone: hidden until the bar opens it, then over the products, under the top bar
          open
            ? 'max-[860px]:fixed max-[860px]:inset-x-0 max-[860px]:top-14 max-[860px]:bottom-0 max-[860px]:z-30'
            : 'max-[860px]:hidden',
        )}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <IconButton
            icon={ArrowLeft01Icon}
            label={t('common.close')}
            className="min-[860px]:hidden"
            onClick={() => {
              onOpen(false);
            }}
          />
          <h2 className="text-h3 font-semibold">{t('pos.cart')}</h2>
          <span className="text-caption text-ink-3 tabular-nums">{count}</span>
          <span className="flex-1" />
          <IconButton
            icon={Delete02Icon}
            label={t('pos.clear')}
            disabled={cart.lines.length === 0}
            onClick={() => {
              onCart(() => EMPTY_CART);
              onSelect(null);
            }}
          />
        </div>
        <div className="border-b border-line px-4 py-3">
          <CustomerBox cart={cart} onCart={onCart} buttonRef={customerRef} />
        </div>
        {cart.lines.length === 0 ? (
          <div className="grid flex-1 place-content-center gap-1 p-6 text-center">
            <p className="text-h3 font-semibold">{t('pos.cartEmptyTitle')}</p>
            <p className="text-body-sm text-ink-2">{t('pos.cartEmptyBody')}</p>
          </div>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
            {cart.lines.map((line, index) => (
              <LineRow
                key={line.key}
                register={register}
                stock={stock}
                selected={selected}
                onSelect={onSelect}
                onLine={onLine}
                onRemove={onRemove}
                short={short}
                overrides={overrides}
                canOverride={canOverride}
                line={line}
                index={index}
                amount={amounts.lines[index]?.total ?? '0'}
              />
            ))}
          </ul>
        )}
        <div className="grid gap-2 border-t border-line bg-subtle px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="pos-bill-discount"
              className="flex items-center gap-2 text-body-sm text-ink-2"
            >
              {t('pos.billDiscount')} <Kbd>F7</Kbd>
            </label>
            <div className="w-40">
              <DiscountInput
                ref={billDiscountRef}
                id="pos-bill-discount"
                value={cart.billDiscount}
                onChange={(value) => {
                  onCart((current) => ({ ...current, billDiscount: value }));
                }}
                discountType={cart.billDiscountType}
                onDiscountTypeChange={(type) => {
                  onCart((current) => ({ ...current, billDiscountType: type }));
                }}
                invalid={billOver}
                aria-describedby={billOver ? 'pos-bill-discount-error' : undefined}
              />
            </div>
          </div>
          {billOver && (
            <Problem id="pos-bill-discount-error">
              {t('pos.overLimit', { max: format.number(register.maxDiscountPercent, 2) })}
            </Problem>
          )}
          {/* The lines' own discounts, only when there are any (like the sales totals block) */}
          {!isZeroMoney(amounts.totals.discount) && (
            <TotalRow
              label={t('pos.receipt.discount')}
              value={`−${money(amounts.totals.discount)}`}
            />
          )}
          <TotalRow
            label={
              pricesIncludeVat
                ? `${t('pos.receipt.vat')} (${t('pos.receipt.pricesWithVat')})`
                : t('pos.receipt.vat')
            }
            value={money(amounts.totals.vat)}
          />
          <div className="flex items-baseline justify-between gap-3 pt-1">
            <span className="text-body font-medium">{t('pos.receipt.total')}</span>
            <span className="text-kpi font-semibold tracking-[-0.03em] tabular-nums">
              {money(total)}
            </span>
          </div>
          <Button className="mt-1 w-full gap-2" disabled={!payable} onClick={onPay}>
            {t('pos.pay', { amount: money(total) })}
            <Kbd>F12</Kbd>
          </Button>
        </div>
      </aside>
      {/* A phone: the bar under the products. Hidden while the cart is open: it has its own Pay. */}
      {!open && (
        <div className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-3 border-t border-line bg-surface px-4 py-3 shadow-lg min-[860px]:hidden">
          <button
            type="button"
            onClick={() => {
              onOpen(true);
            }}
            className="flex min-w-0 flex-1 flex-col items-start rounded-control px-1 text-left"
          >
            <span className="text-caption text-ink-3 tabular-nums">{count}</span>
            <span className="text-h3 font-semibold tabular-nums">{money(total)}</span>
          </button>
          <Button disabled={!payable} onClick={onPay}>
            {t('pos.pay', { amount: money(total) })}
          </Button>
        </div>
      )}
    </>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-body-sm">
      <span className="text-ink-2">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

// What stops the sale, said where it happens: crit text with an icon, never colour alone
function Problem({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// The customer, from the device's copy (decision 5): walk-in until one is picked, and the first
// option takes the sale back to walk-in. A customer's price list prices the items added after it;
// the lines already in the cart keep their price (changing the customer never reprices by itself,
// as on every sales document).
function CustomerBox({
  cart,
  onCart,
  buttonRef,
}: {
  cart: Cart;
  onCart: (update: (cart: Cart) => Cart) => void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  const { t } = useLocale();
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const find = useCallback((open: LocalCopy) => findCustomers(open, deferred), [deferred]);
  const matches = useLocalQuery(find);
  const options: ComboboxOption[] = [
    ...(cart.customer ? [{ value: '', label: t('pos.walkInAgain') }] : []),
    ...(matches ?? []).map((customer) => ({
      value: customer.id,
      label: customer.name,
      detail: [customer.code, customer.phone].filter((part) => part !== null).join(' · '),
    })),
  ];
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <Combobox
          ref={buttonRef}
          aria-label={t('pos.customer')}
          value={cart.customer?.id ?? ''}
          selectedLabel={cart.customer?.name ?? null}
          options={options}
          search={search}
          onSearchChange={setSearch}
          onChange={(value) => {
            const customer = matches?.find((one) => one.id === value);
            onCart((current) => ({
              ...current,
              customer: customer
                ? { id: customer.id, name: customer.name, priceListId: customer.priceListId }
                : null,
            }));
          }}
          icon={UserIcon}
          placeholder={t('pos.walkIn')}
          searchPlaceholder={t('pos.customerPlaceholder')}
          emptyText={t('pos.noCustomerMatch')}
        />
      </div>
      <Kbd>F4</Kbd>
    </div>
  );
}

function LineRow({
  line,
  index,
  amount,
  selected,
  onSelect,
  onLine,
  onRemove,
  short,
  overrides,
  canOverride,
  register,
  stock,
}: Pick<
  PosCartProps,
  | 'register'
  | 'stock'
  | 'selected'
  | 'onSelect'
  | 'onLine'
  | 'onRemove'
  | 'short'
  | 'overrides'
  | 'canOverride'
> & { line: CartLine; index: number; amount: string }) {
  const { t, format } = useLocale();
  const money = useScreenMoney();
  const open = selected === line.key;
  const onHand = short.get(line.key);
  const priceOver = overrides.some((item) => item.kind === 'price' && item.line === index);
  const discountOver = overrides.some((item) => item.kind === 'discount' && item.line === index);
  const batch = stock.find((row) => row.batchId !== null && row.batchId === line.batchId);
  const id = `pos-line-${line.key}`;
  // The price box: anyone may type a price the line did not have; changing one it had needs the
  // permission (decision 11)
  const priceLocked = !canOverride && line.startingPrice !== null;
  const changed =
    line.startingPrice !== null && line.unitPrice !== '' && line.unitPrice !== line.startingPrice;
  // The stepper: never below 1 (the remove button takes a line away). A serial item's quantity
  // follows its serial numbers' count, so it has no stepper.
  const step = (by: 1 | -1) => {
    const quantity = isQuantity(line.quantity) ? line.quantity : '1';
    const next = by === 1 ? addQuantity(quantity, '1') : subtractQuantity(quantity, '1');
    if (compareQuantity(next, '1') >= 0) onLine(line.key, { quantity: next });
  };
  // The batches of this variant here, for the batch select: the one it has, and every other with
  // stock, first expiry first
  const batches = stock
    .filter(
      (row) =>
        row.variantId === line.variantId &&
        row.batchId !== null &&
        (row.batchId === line.batchId || compareQuantity(row.quantity, '0') > 0),
    )
    .sort((a, b) => (a.expiresOn ?? '9').localeCompare(b.expiresOn ?? '9'));
  const expiry = (date: string | null) => {
    const day = date === null ? undefined : parseIsoDate(date);
    return day ? format.date(day) : '';
  };

  return (
    <li className={cn('grid gap-2 px-4 py-3', open && 'bg-subtle')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-boxes`}
        onClick={() => {
          onSelect(open ? null : line.key);
        }}
        className="flex items-baseline justify-between gap-3 rounded-lg text-left"
      >
        <span className="min-w-0 text-body-sm font-medium">{line.name}</span>
        <span className="shrink-0 text-body-sm font-semibold tabular-nums">{money(amount)}</span>
      </button>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {line.tracking !== 'serial' && (
          <span className="inline-flex items-center rounded-lg border border-line-strong bg-surface">
            <button
              type="button"
              aria-label={`${t('pos.quantity')} −1`}
              onClick={() => {
                step(-1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={MinusSignIcon} size={14} strokeWidth={1.5} />
            </button>
            <span className="min-w-8 text-center text-body-sm font-medium tabular-nums">
              {format.number(isQuantity(line.quantity) ? line.quantity : '0', line.decimals)}
            </span>
            <button
              type="button"
              aria-label={`${t('pos.quantity')} +1`}
              onClick={() => {
                step(1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.5} />
            </button>
          </span>
        )}
        <span className="text-caption text-ink-3 tabular-nums">
          × {line.unitPrice === '' ? '—' : money(line.unitPrice)} · {line.unitCode}
        </span>
        <span className="flex-1" />
        <IconButton
          icon={Delete02Icon}
          label={t('pos.removeLine', { name: line.name })}
          onClick={() => {
            onRemove(line.key);
          }}
        />
      </div>
      {batch && (
        <p className="text-caption text-ink-3">
          {t('pos.batch')} <span className="font-mono text-ink-2">{batch.lotNumber}</span>
          {batch.expiresOn !== null && ` · ${expiry(batch.expiresOn)}`}
        </p>
      )}
      {onHand !== undefined && (
        <Problem>
          {compareQuantity(onHand, '0') > 0
            ? t('pos.shortStock', {
                quantity: `${format.number(onHand, line.decimals)} ${line.unitCode}`,
              })
            : t('pos.noStock')}
        </Problem>
      )}
      {open && (
        <div id={`${id}-boxes`} className="grid gap-3 pt-1">
          <div className="grid grid-cols-3 gap-2">
            {line.tracking !== 'serial' && (
              <Field id={`${id}-quantity`} label={t('pos.quantity')}>
                <Input
                  id={`${id}-quantity`}
                  inputMode="decimal"
                  align="end"
                  value={line.quantity}
                  onChange={(event) => {
                    onLine(line.key, { quantity: event.target.value.trim() });
                  }}
                />
              </Field>
            )}
            <Field
              id={`${id}-price`}
              label={t('pos.price')}
              hint={
                changed && line.startingPrice !== null
                  ? t('pos.priceChanged', { price: money(line.startingPrice) })
                  : undefined
              }
              error={priceOver ? t('pos.priceLocked') : undefined}
            >
              <MoneyInput
                id={`${id}-price`}
                readOnly={priceLocked}
                value={line.unitPrice}
                invalid={priceOver}
                onChange={(value) => {
                  onLine(line.key, { unitPrice: value });
                }}
              />
            </Field>
            <Field
              id={`${id}-discount`}
              label={t('pos.discount')}
              error={
                discountOver
                  ? t('pos.overLimit', { max: format.number(register.maxDiscountPercent, 2) })
                  : undefined
              }
            >
              <DiscountInput
                id={`${id}-discount`}
                value={line.discount}
                discountType={line.discountType}
                invalid={discountOver}
                onChange={(value) => {
                  onLine(line.key, { discount: value });
                }}
                onDiscountTypeChange={(type) => {
                  onLine(line.key, { discountType: type });
                }}
              />
            </Field>
          </div>
          {priceLocked && !priceOver && (
            <p className="text-caption text-ink-3">{t('pos.priceLocked')}</p>
          )}
          {line.tracking === 'batch' && batches.length > 1 && (
            <Field id={`${id}-batch`} label={t('pos.batch')}>
              <Select
                id={`${id}-batch`}
                value={line.batchId ?? ''}
                onChange={(event) => {
                  onLine(line.key, { batchId: event.target.value });
                }}
                options={batches.map((row) => ({
                  value: row.batchId ?? '',
                  label: [row.lotNumber, expiry(row.expiresOn), format.number(row.quantity, 0)]
                    .filter((part) => part !== null && part !== '')
                    .join(' · '),
                }))}
              />
            </Field>
          )}
          {line.tracking === 'serial' && (
            <Field id={`${id}-serials`} label={t('pos.serials')} hint={t('pos.serialsHint')}>
              <SerialNumbersInput
                id={`${id}-serials`}
                value={line.serialNumbers}
                aria-describedby={`${id}-serials-hint`}
                // One serial number per item: the count is the quantity
                onChange={(serials) => {
                  onLine(line.key, {
                    serialNumbers: serials,
                    quantity: String(Math.max(serials.length, 1)),
                  });
                }}
              />
            </Field>
          )}
        </div>
      )}
    </li>
  );
}
