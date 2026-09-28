import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 rounded-control border border-line bg-surface p-3 shadow-lg outline-none',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
