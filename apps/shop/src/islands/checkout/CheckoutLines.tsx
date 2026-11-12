import { Add01Icon, Alert02Icon, Delete02Icon, MinusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ShopCartQuoteLine } from '@omnivo/contracts';
import { useEffect, useRef, useState } from 'react';

import { MAX_QUANTITY, removeFromCart, setQuantity } from '../../lib/cart';
import { fill, parseQuantity } from './checkout';
import type { CheckoutWords } from './words';

// Step 26c: the cart's lines on the checkout card (CLAUDE.md → Checkout lines; Figma at y 438).
// The same parts as the cart drawer at a bigger size, written as React here because the island
// draws them; every change goes through lib/cart.ts, so the header's count and the drawer follow.

// The lines the page draws: an unavailable one has only its id, and leaves the cart
export type ShownLine = Exclude<ShopCartQuoteLine, { status: 'unavailable' }>;

interface CheckoutLinesProps {
  lines: ShownLine[];
  // The cart's own counts, which change at once; the quote's follow after the request
  quantities: ReadonlyMap<string, number>;
  // Lines whose price changed after a refused Confirm Order, with the old price
  changed: ReadonlyMap<string, string>;
  // Grey amounts while a newer cart is being priced
  pricing: boolean;
  // After the order is confirmed: the lines stay on screen behind the dialog, but cannot change
  frozen: boolean;
  words: CheckoutWords;
  money: (value: string) => string;
  count: (value: number) => string;
}

const stepButton =
  'grid size-10 shrink-0 place-items-center rounded-[5px] bg-cream transition-colors duration-150 not-aria-disabled:hover:bg-accent aria-disabled:text-muted';

export function CheckoutLines({
  lines,
  quantities,
  changed,
  pricing,
  frozen,
  words,
  money,
  count,
}: CheckoutLinesProps) {
  const list = useRef<HTMLUListElement>(null);
  // The line whose delete button should have the focus after the next drawing (see remove())
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    const id = focusNext.current;
    if (id === null) return;
    focusNext.current = null;
    list.current?.querySelector<HTMLElement>(`[data-remove="${CSS.escape(id)}"]`)?.focus();
  });

  // The focus goes to the next line's delete button (or the one before), so a shopper clearing
  // the cart from the keyboard keeps pressing Enter. The line is gone only after React draws the
  // new cart, so the effect above moves the focus then
  function remove(index: number, listingId: string): void {
    const neighbour = lines[index + 1] ?? lines[index - 1];
    focusNext.current = neighbour?.listingId ?? null;
    removeFromCart(new Set([listingId]));
  }

  return (
    <ul ref={list} aria-label={words.items} className="flex flex-col gap-5">
      {lines.map((line, index) => {
        const quantity = quantities.get(line.listingId) ?? line.quantity;
        const inStock = line.status === 'available';
        const name = { name: line.name };
        const was = changed.get(line.listingId);
        // Out of stock or frozen: the count cannot change; only the delete button works
        const locked = !inStock || frozen;
        return (
          <li key={line.listingId} className="flex gap-4 md:gap-5">
            {/* 155×130 from md (Figma), the drawer's 96×80 on a phone, where the stepper needs the
                width. A block, not a grid: see the drawer's note on tall photos */}
            <span className="block h-20 w-24 shrink-0 overflow-hidden rounded-lg bg-canvas md:h-[130px] md:w-[155px]">
              <img
                src={line.image.url}
                alt=""
                className="size-full object-contain mix-blend-multiply"
              />
            </span>
            {/* Centered beside the 130px photo, as in Figma (the name 15px from its top) */}
            <div className="flex min-w-0 flex-1 flex-col gap-3 md:gap-5 md:self-center">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <a
                    href={`/p/${encodeURIComponent(line.slug)}`}
                    className="line-clamp-2 max-w-72 font-semibold hover:underline md:text-sf-subtitle"
                  >
                    {line.name}
                  </a>
                  {was !== undefined && (
                    <p className="text-sf-small font-medium text-muted">
                      {fill(words.priceChanged, { old: money(was) })}
                    </p>
                  )}
                  {!inStock && (
                    <p className="flex items-center gap-1 text-sf-small font-medium text-promo">
                      <HugeiconsIcon
                        icon={Alert02Icon}
                        size={16}
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      {words.outOfStock}
                    </p>
                  )}
                </div>
                {inStock && (
                  <span
                    className={`shrink-0 font-semibold tabular-nums transition-colors duration-150 md:text-sf-subtitle ${pricing ? 'text-muted' : 'text-price'}`}
                  >
                    {money(line.lineTotal)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  {/* aria-disabled, not disabled: a disabled button loses the focus, and the
                      shopper pressing "one less" down to 1 would be thrown out of the stepper */}
                  <button
                    type="button"
                    aria-label={fill(words.decrease, name)}
                    aria-disabled={locked || quantity <= 1}
                    onClick={() => {
                      if (!locked && quantity > 1) setQuantity(line.listingId, quantity - 1);
                    }}
                    className={stepButton}
                  >
                    <HugeiconsIcon
                      icon={MinusSignIcon}
                      size={14}
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  </button>
                  <QuantityBox
                    quantity={quantity}
                    label={fill(words.quantity, name)}
                    disabled={locked}
                    count={count}
                    onCommit={(wanted) => {
                      setQuantity(line.listingId, wanted);
                    }}
                  />
                  <button
                    type="button"
                    aria-label={fill(words.increase, name)}
                    aria-disabled={locked || quantity >= MAX_QUANTITY}
                    onClick={() => {
                      if (!locked && quantity < MAX_QUANTITY) {
                        setQuantity(line.listingId, quantity + 1);
                      }
                    }}
                    className={stepButton}
                  >
                    <HugeiconsIcon
                      icon={Add01Icon}
                      size={14}
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  </button>
                </div>
                <button
                  type="button"
                  data-remove={line.listingId}
                  aria-label={fill(words.remove, name)}
                  aria-disabled={frozen}
                  onClick={() => {
                    if (!frozen) remove(index, line.listingId);
                  }}
                  className="grid size-10 shrink-0 place-items-center rounded-[5px] bg-promo-soft text-promo transition-colors duration-150 not-aria-disabled:hover:bg-promo not-aria-disabled:hover:text-white"
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    size={24}
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// The typed count. It changes the cart on Enter or when the box loses the focus, not on every
// key: typing "12" never sets the line to 1 on the way. While the shopper types, the box shows
// what they typed (`draft`); otherwise the cart's number, so a click on the stepper shows here
interface QuantityBoxProps {
  quantity: number;
  label: string;
  disabled: boolean;
  count: (value: number) => string;
  onCommit: (quantity: number) => void;
}

function QuantityBox({ quantity, label, disabled, count, onCommit }: QuantityBoxProps) {
  const [draft, setDraft] = useState<string | null>(null);

  function commit(): void {
    if (draft === null) return;
    // A typed 0 becomes 1 and 500 becomes 99 (cart.ts → withQuantity); letters put the old
    // number back
    const typed = parseQuantity(draft);
    if (typed !== undefined) onCommit(typed);
    setDraft(null);
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      disabled={disabled}
      value={draft ?? count(quantity)}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        // Enter in a text box submits its form: here it only sets the count
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit();
      }}
      className="h-10 w-15 rounded-[5px] border-[1.5px] border-cream bg-card text-center text-[20px] tabular-nums disabled:text-muted"
    />
  );
}
