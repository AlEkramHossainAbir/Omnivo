import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';

import { DecimalInput, type DecimalInputProps } from './money-input.js';

// The two ways a sales line takes a discount off: the same values as DISCOUNT_TYPES in
// @omnivo/contracts (this package does not depend on the contracts)
export type DiscountType = 'percent' | 'amount';

interface DiscountInputProps extends Omit<
  DecimalInputProps,
  'prefix' | 'suffix' | 'trailing' | 'scale'
> {
  discountType: DiscountType;
  onDiscountTypeChange: (discountType: DiscountType) => void;
  // The select's name for screen readers; the default says what it switches
  typeLabel?: string | undefined;
}

// A discount box: the amount, then a small select that says what the amount means. The select
// sits inside the box, so one column of a line editor holds both, and the box's focus ring
// (focus-within) shows while either part has the focus.
export function DiscountInput({
  discountType,
  onDiscountTypeChange,
  typeLabel,
  disabled,
  ...props
}: DiscountInputProps) {
  const { t } = useLocale();
  return (
    <DecimalInput
      {...props}
      disabled={disabled}
      // A discount is kept to 2 decimals, as a percent (12.25) or as taka (contracts' DISCOUNT)
      scale={2}
      trailing={
        <span className="relative flex shrink-0 items-center border-l border-line pl-2">
          <select
            aria-label={typeLabel ?? t('ui.discountInput.type')}
            value={discountType}
            disabled={disabled}
            onChange={(event) => {
              // Narrowed by comparison, not cast: an option this code did not write cannot slip in
              onDiscountTypeChange(event.target.value === 'amount' ? 'amount' : 'percent');
            }}
            // appearance-none + pr-5: our arrow instead of the browser's, like Select
            className="appearance-none bg-transparent py-1 pr-5 text-body-sm font-medium text-ink-2 outline-none"
          >
            <option value="percent">%</option>
            <option value="amount">৳</option>
          </select>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={16}
            strokeWidth={1.5}
            className="pointer-events-none absolute right-0 text-ink-3"
          />
        </span>
      }
    />
  );
}
