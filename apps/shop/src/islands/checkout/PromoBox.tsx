import { CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ShopCouponResult } from '@omnivo/contracts';
import { useId } from 'react';

import { discountText, errorText, fill } from './checkout';
import { FieldError } from './fields';
import type { CheckoutWords } from './words';

// Step 26c: the promo box (CLAUDE.md → Checkout lines; Figma at y 743): a 60px canvas pill with
// the code box and "Apply Coupon" inside it. Not part of the react-hook-form form: a code is not
// sent with Confirm Order as typed, but as the code the last quote applied (decision 2)
interface PromoBoxProps {
  words: CheckoutWords;
  money: (value: string) => string;
  text: string;
  onTextChange: (text: string) => void;
  onApply: () => void;
  onRemove: () => void;
  // The code is being priced: the button says "Applying…" and waits
  applying: boolean;
  // What the last quote did with the applied code. null: no code, or not answered yet
  result: Exclude<ShopCouponResult, { status: 'none' }> | null;
  // The box's own check failed ("A code has only letters, digits and dashes")
  formatError: string | null;
}

export function PromoBox({
  words,
  money,
  text,
  onTextChange,
  onApply,
  onRemove,
  applying,
  result,
  formatError,
}: PromoBoxProps) {
  const id = useId();
  const statusId = `${id}-status`;
  const remove = (
    <button
      type="button"
      onClick={onRemove}
      className="font-semibold text-brand underline underline-offset-3"
    >
      {words.removeCoupon}
    </button>
  );

  return (
    <div>
      <div className="flex h-[60px] items-center gap-2 rounded-full bg-canvas p-1 pl-6 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand md:pl-9">
        {/* The placeholder ("Add Promo") is not a label: it goes away while typing */}
        <label htmlFor={id} className="sr-only">
          {words.promo}
        </label>
        <input
          id={id}
          type="text"
          value={text}
          // Codes come from a flyer: no autofill, no spelling fixes, capitals on a phone keyboard
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={words.promoPlaceholder}
          aria-describedby={statusId}
          onChange={(event) => {
            onTextChange(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            // Enter applies the code; without this it would submit the whole order
            if (event.key !== 'Enter') return;
            event.preventDefault();
            onApply();
          }}
          className="h-full min-w-0 flex-1 bg-transparent font-semibold uppercase placeholder:text-muted placeholder:normal-case focus-visible:outline-none"
        />
        <button
          type="button"
          onClick={onApply}
          aria-disabled={applying}
          className="h-[52px] w-[156px] shrink-0 rounded-full bg-brand font-semibold text-accent transition-colors duration-150 not-aria-disabled:hover:bg-accent not-aria-disabled:hover:text-brand"
        >
          {applying ? words.applying : words.apply}
        </button>
      </div>
      {/* role="status": the answer comes after a request, and a screen reader says it then. The
          region is always in the page, empty or not: a live region that appears together with
          its text is often not read. Its 12px space only when it has something to say */}
      <div id={statusId} role="status" className="px-6 not-empty:pt-3 md:px-9">
        {formatError !== null ? (
          <FieldError text={formatError} />
        ) : result?.status === 'applied' ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sf-small font-medium">
            <span className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={16}
                strokeWidth={1.5}
                aria-hidden="true"
              />
              {fill(words.couponApplied, {
                code: result.code,
                off: discountText(result.discount, money),
              })}
            </span>
            {remove}
          </p>
        ) : result?.status === 'refused' ? (
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sf-small">
            <FieldError
              text={errorText(words, result.reason, {
                minimum: result.minimum === null ? '' : money(result.minimum),
              })}
            />
            {remove}
          </div>
        ) : null}
      </div>
    </div>
  );
}
