import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { InputHTMLAttributes, ReactNode } from 'react';

import { cx } from '../lib/cx';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'> {
  id: string;
  label: string;
  icon?: IconSvgElement;
  suffix?: string;
  // exactOptionalPropertyTypes: caller `errors.email` (string | undefined) সরাসরি দিতে পারে
  error?: string | undefined;
  trailing?: ReactNode;
}

export function TextField({ id, label, icon, suffix, error, trailing, ...input }: TextFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-label font-medium text-ink">
        {label}
      </label>
      <div
        className={cx(
          'flex min-h-[42px] items-center gap-2.5 rounded-control border bg-surface px-3 shadow-sm transition-[border-color,box-shadow] duration-150',
          error
            ? 'border-crit focus-within:shadow-ring-crit'
            : 'border-line-strong hover:border-ink-3 focus-within:border-brand focus-within:shadow-ring',
        )}
      >
        {icon && (
          <HugeiconsIcon icon={icon} size={17} strokeWidth={1.5} className="shrink-0 text-ink-3" />
        )}
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="min-w-0 flex-1 bg-transparent py-2.5 text-body outline-none placeholder:text-ink-3"
          {...input}
        />
        {suffix && <span className="text-body-sm whitespace-nowrap text-ink-3">{suffix}</span>}
        {trailing}
      </div>
      {error && (
        <p id={errorId} className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
