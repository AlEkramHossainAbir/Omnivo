import { Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';

interface CheckboxProps extends Omit<
  ComponentProps<typeof CheckboxPrimitive.Root>,
  'className' | 'children' | 'id'
> {
  id: string;
  label: ReactNode;
}

// CLAUDE.md → Checkbox: ১৭px, ৫px কোণ, checked-এ brand ভরাট। native checkbox-এর রং আর
// কোণ সব ব্রাউজারে বদলানো যায় না, তাই Radix (ভেতরে button role="checkbox", কীবোর্ডে Space)
export function Checkbox({ id, label, ...props }: CheckboxProps) {
  return (
    <div className="flex items-start gap-2.5">
      <CheckboxPrimitive.Root
        id={id}
        className="mt-px grid size-[17px] shrink-0 place-items-center rounded-[5px] border border-line-strong bg-surface shadow-sm transition-colors duration-150 hover:border-ink-3 data-[state=checked]:border-brand data-[state=checked]:bg-brand"
        {...props}
      >
        <CheckboxPrimitive.Indicator className="text-brand-ink">
          <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={1.5} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className="text-body-sm text-ink-2">
        {label}
      </label>
    </div>
  );
}
