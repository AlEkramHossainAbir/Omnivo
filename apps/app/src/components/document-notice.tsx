import { HourglassIcon, InformationCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode } from 'react';

// A notice above a document: what its state means and what to do next. Icon plus words, never
// colour alone; warn for an offer that has ended (step 15c: or an invoice past its due date),
// neutral otherwise. Here since 15c, not in quotation-view.tsx: the invoice and receipt pages use it
// too, and importing it from there would pull the quotation page into their chunks. Step 17a: a
// notice may bring its own icon (a requisition sent back is not an hourglass). Step 18c: moved here
// from sales-parts.tsx, which reaches the route map through stock-parts.tsx: the sign-in page must
// not load every module's schemas to show one notice.
export function DocumentNotice({
  tone,
  icon,
  children,
}: {
  tone: 'warn' | 'neutral';
  icon?: IconSvgElement;
  children: ReactNode;
}) {
  return (
    <p
      className={
        tone === 'warn'
          ? 'flex items-start gap-2 rounded-control border border-warn/30 bg-warn-bg px-3 py-2.5 text-body-sm text-warn'
          : 'flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2'
      }
    >
      <HugeiconsIcon
        icon={icon ?? (tone === 'warn' ? HourglassIcon : InformationCircleIcon)}
        size={17}
        strokeWidth={1.5}
        className="mt-px shrink-0"
      />
      <span>{children}</span>
    </p>
  );
}
