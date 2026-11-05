import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ComponentProps } from 'react';

import { cn } from '../lib/cn.js';

type ButtonVariant = 'primary' | 'secondary';
type ButtonSize = 'md' | 'sm';

// CLAUDE.md → Primary / Secondary button। কোনো variant বাদ পড়লে satisfies ধরবে
const variantClass = {
  primary: 'bg-brand text-brand-ink text-body hover:bg-brand-hover',
  secondary: 'border border-line-strong bg-surface text-ink text-body-sm hover:bg-subtle',
} satisfies Record<ButtonVariant, string>;

const sizeClass = {
  md: 'min-h-[42px] px-4',
  sm: 'min-h-9 px-3',
} satisfies Record<ButtonSize, string>;

// ComponentProps<'button'>-এ React 19-এ ref-ও আছে — Radix-এর asChild ref পাঠাতে পারে
interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      // ডিফল্ট "submit" না: ফর্মের ভেতরের যেকোনো বাটন ভুল করে ফর্ম জমা দিত
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap shadow-sm transition-colors duration-150 disabled:opacity-60',
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...props}
    />
  );
}

interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children' | 'aria-label'> {
  icon: IconSvgElement;
  // শুধু আইকনের বাটনে লেখা নেই — স্ক্রিন রিডারের জন্য label বাধ্যতামূলক, টাইপেই
  label: string;
}

export function IconButton({ icon, label, className, type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cn(
        'grid place-items-center rounded-lg p-2 text-ink-3 transition-colors duration-150 hover:bg-subtle hover:text-ink',
        className,
      )}
      {...props}
    >
      <HugeiconsIcon icon={icon} size={18} strokeWidth={1.5} />
    </button>
  );
}
