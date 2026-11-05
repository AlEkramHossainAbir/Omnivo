import { ArrowDownRight01Icon, ArrowUpRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { cn } from '../lib/cn.js';
import { Card } from './card.js';

// Step 21a: the change line of a cell. up = good with an arrow up, down = crit with an arrow down,
// flat = ink-3 with no arrow (no change, or a number given only to compare with). The words say
// "more" or "less" too, so the color is never the only sign.
export interface KpiChange {
  text: string;
  trend: 'up' | 'down' | 'flat';
}

export interface KpiCell {
  label: string;
  value: string;
  sub?: string | undefined;
  change?: KpiChange | undefined;
}

interface KpiStripProps {
  cells: readonly KpiCell[];
}

// By the number of cells. Whole class names, not `sm:grid-cols-${n}`: Tailwind only finds classes
// written out.
const COLUMNS = ['', 'sm:grid-cols-1', 'sm:grid-cols-2', 'sm:grid-cols-3', 'sm:grid-cols-4'];

const TREND = {
  up: { icon: ArrowUpRight01Icon, className: 'text-good' },
  down: { icon: ArrowDownRight01Icon, className: 'text-crit' },
  flat: { icon: null, className: 'text-ink-3' },
} satisfies Record<KpiChange['trend'], unknown>;

// CLAUDE.md → KPI strip: one card split by rules, a caption, a 26px value and an optional line.
// Moved here from the app's report-parts.tsx in step 13: the stock card uses it too, and importing
// it from the reports' file pulled the reports' code into the stock card's chunk.
// Step 21a: one to four cells (the Overview shows the ones the person's permissions allow), a
// change line, and four cells two by two on a phone. The rules are the line color of the card's
// background, showing through a 1px gap between the cells: a 2 × 2 grid gets every rule right,
// which divide-x / divide-y cannot do.
export function KpiStrip({ cells }: KpiStripProps) {
  return (
    <Card
      className={cn(
        'grid gap-px overflow-hidden bg-line',
        cells.length === 4 ? 'grid-cols-2' : 'grid-cols-1',
        COLUMNS[cells.length],
      )}
    >
      {cells.map((cell) => {
        const trend = cell.change && TREND[cell.change.trend];
        return (
          <div key={cell.label} className="grid content-start gap-1 bg-surface px-5 py-4">
            <span className="text-caption text-ink-3">{cell.label}</span>
            <span className="text-kpi tracking-[-0.03em] tabular-nums">{cell.value}</span>
            {cell.sub !== undefined && (
              <span className="text-caption text-ink-3 tabular-nums">{cell.sub}</span>
            )}
            {cell.change && trend && (
              <span
                className={cn(
                  'flex items-center gap-1 text-caption font-medium tabular-nums',
                  trend.className,
                )}
              >
                {trend.icon && (
                  <HugeiconsIcon
                    icon={trend.icon}
                    size={14}
                    strokeWidth={1.5}
                    className="shrink-0"
                  />
                )}
                {cell.change.text}
              </span>
            )}
          </div>
        );
      })}
    </Card>
  );
}
