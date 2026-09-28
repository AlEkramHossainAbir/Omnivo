import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode } from 'react';

import { cx } from '../lib/cx';

export type PillTone = 'good' | 'warn' | 'crit' | 'brand' | 'neutral';

// CLAUDE.md → Pill: প্রতিটা tone-এর soft background + মিলানো লেখা; কোনো tone বাদ পড়লে satisfies ধরবে
const toneClass = {
  good: 'bg-good-bg text-good',
  warn: 'bg-warn-bg text-warn',
  crit: 'bg-crit-bg text-crit',
  brand: 'bg-brand-soft text-brand',
  neutral: 'bg-subtle text-ink-3',
} satisfies Record<PillTone, string>;

interface PillProps {
  tone: PillTone;
  // status রঙ কখনো একা না — তাই icon বাধ্যতামূলক
  icon: IconSvgElement;
  children: ReactNode;
}

export function Pill({ tone, icon, children }: PillProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-[5px] rounded-full py-0.5 pr-2 pl-1.5 text-caption font-medium whitespace-nowrap',
        toneClass[tone],
      )}
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.5} className="shrink-0" />
      {children}
    </span>
  );
}
