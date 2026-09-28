import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

// CLAUDE.md → Card: surface, ১px line, ১৪px কোণ, shadow-sm
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn('rounded-card border border-line bg-surface shadow-sm', className)}
      {...props}
    />
  );
}

interface CardHeaderProps {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode;
}

// শিরোনাম ১৫px/600 + ১৩px ink-3 সাবটাইটেল, padding 18px 20px 0
export function CardHeader({ title, subtitle, actions }: CardHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-4 px-5 pt-[18px]">
      <div className="min-w-0">
        <h3 className="text-h3">{title}</h3>
        {subtitle && <p className="text-label text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
