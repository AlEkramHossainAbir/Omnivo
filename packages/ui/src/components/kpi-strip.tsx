import { cn } from '../lib/cn.js';
import { Card } from './card.js';

interface KpiStripProps {
  cells: readonly { label: string; value: string; sub?: string | undefined }[];
}

// CLAUDE.md → KPI strip: one card split by rules, a caption, a 26px value and an optional line.
// Moved here from the app's report-parts.tsx in step 13: the stock card uses it too, and importing
// it from the reports' file pulled the reports' code into the stock card's chunk.
// Three cells or four (step 14: the stock card and the valuation page show what the stock is
// worth). Whole class names, not `sm:grid-cols-${n}`: Tailwind only finds classes written out.
export function KpiStrip({ cells }: KpiStripProps) {
  return (
    <Card
      className={cn(
        'grid grid-cols-1 divide-y divide-line sm:divide-x sm:divide-y-0',
        cells.length === 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3',
      )}
    >
      {cells.map((cell) => (
        <div key={cell.label} className="grid gap-1 px-5 py-4">
          <span className="text-caption text-ink-3">{cell.label}</span>
          <span className="text-kpi tracking-[-0.03em] tabular-nums">{cell.value}</span>
          {cell.sub !== undefined && (
            <span className="text-caption text-ink-3 tabular-nums">{cell.sub}</span>
          )}
        </div>
      ))}
    </Card>
  );
}
