import { Alert02Icon, HourglassIcon, InformationCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { cn } from '@omnivo/ui';
import type { ReactNode } from 'react';

// A notice above a document: what its state means and what to do next. Icon plus words, never
// colour alone; warn for an offer that has ended (step 15c: or an invoice past its due date),
// neutral otherwise. Here since 15c, not in quotation-view.tsx: the invoice and receipt pages use it
// too, and importing it from there would pull the quotation page into their chunks. Step 17a: a
// notice may bring its own icon (a requisition sent back is not an hourglass). Step 18c: moved here
// from sales-parts.tsx, which reaches the route map through stock-parts.tsx: the sign-in page must
// not load every module's schemas to show one notice. Step 27b: crit, for a shop order whose sales
// order could not be made (it blocks the next step, so it is an error, not a warning), and an
// action at the end of the line (a "Record payment" link), which wraps under the words on a phone.
const TONES = {
  warn: 'border-warn/30 bg-warn-bg text-warn',
  crit: 'border-crit/30 bg-crit-bg text-crit',
  neutral: 'border-line bg-subtle text-ink-2',
} as const;

const ICONS = { warn: HourglassIcon, crit: Alert02Icon, neutral: InformationCircleIcon } as const;

export function DocumentNotice({
  tone,
  icon,
  action,
  children,
}: {
  tone: keyof typeof TONES;
  icon?: IconSvgElement;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        'flex flex-wrap items-start gap-x-2 gap-y-1 rounded-control border px-3 py-2.5 text-body-sm',
        TONES[tone],
      )}
    >
      <HugeiconsIcon
        icon={icon ?? ICONS[tone]}
        size={17}
        strokeWidth={1.5}
        className="mt-px shrink-0"
      />
      <span className="min-w-0 flex-1 basis-60">{children}</span>
      {action}
    </p>
  );
}
