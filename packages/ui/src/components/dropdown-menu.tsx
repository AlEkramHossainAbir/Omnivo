import { Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

// Radix: কীবোর্ড (তীর, Enter, Esc, টাইপ করে খোঁজা), focus ফেরত আনা, স্ক্রিনের কিনারায়
// নিজে থেকে সরে যাওয়া — এগুলো হাতে লিখলে সপ্তাহ লাগত
export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    // Portal: সাইডবারের overflow বা stacking context মেনুকে কেটে ফেলতে পারে না
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-50 min-w-[220px] rounded-control border border-line bg-surface p-1 shadow-lg',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

// menuitem একটা div — global base rule শুধু button/a ধরে, তাই cursor-pointer এখানে নিজে (CLAUDE.md)
const itemClass =
  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-body-sm text-ink-2 outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[highlighted]:bg-subtle data-[highlighted]:text-ink';

interface DropdownMenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  icon?: IconSvgElement;
}

export function DropdownMenuItem({ className, icon, children, ...props }: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item className={cn(itemClass, className)} {...props}>
      {icon && (
        <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} className="shrink-0 text-ink-3" />
      )}
      {children}
    </MenuPrimitive.Item>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemClass, className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {/* বাছাই করাটার পাশে টিক — রং একা না, চিহ্নও (CLAUDE.md) */}
      <MenuPrimitive.ItemIndicator className="text-brand">
        <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={1.5} />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn('px-2.5 pt-2 pb-1 text-caption font-medium text-ink-3', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('my-1 h-px bg-line', className)} {...props} />;
}
