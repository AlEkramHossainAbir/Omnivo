import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

interface EmptyStateProps {
  icon: IconSvgElement;
  title: string;
  // কী করলে এখানে ডেটা আসবে — আসল উদাহরণ দিয়ে (buyer PO, LC), lorem ipsum না
  description: string;
  action?: ReactNode;
  // Step 21a: crit for a page that could not load its data (the Overview's "Couldn't load"), so it
  // does not look like an empty list; brand otherwise
  tone?: 'brand' | 'crit';
}

export function EmptyState({ icon, title, description, action, tone = 'brand' }: EmptyStateProps) {
  return (
    <div className="grid justify-items-center px-6 py-10 text-center">
      <span
        className={cn(
          'grid size-10 place-items-center rounded-lg',
          tone === 'crit' ? 'bg-crit-bg text-crit' : 'bg-brand-soft text-brand',
        )}
      >
        <HugeiconsIcon icon={icon} size={18} strokeWidth={1.5} />
      </span>
      <h3 className="mt-3 text-h3">{title}</h3>
      <p className="mt-1 max-w-sm text-body-sm text-ink-2">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
