import type { ButtonHTMLAttributes } from 'react';

import { cx } from '../lib/cx';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export function Button({ variant = 'primary', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex min-h-[42px] items-center justify-center gap-2 rounded-control px-4 text-body font-medium whitespace-nowrap shadow-sm transition-colors duration-150 disabled:opacity-60',
        variant === 'primary'
          ? 'bg-brand text-brand-ink hover:bg-brand-hover'
          : 'border border-line-strong bg-surface text-ink hover:bg-subtle',
        className,
      )}
      {...props}
    />
  );
}
