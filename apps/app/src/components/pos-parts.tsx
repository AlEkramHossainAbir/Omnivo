import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { SyncSettings } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import type { ComponentProps } from 'react';

import type { ReceiptCompany } from '../lib/pos';

// Step 20a: the small pieces the POS screen's chunks share. Here, not in pos-screen.tsx: the pay
// dialog's chunk (lazy) imports them, and importing them from the screen would tie the two chunks
// to each other.

// A whole amount shows without paisa (৳420); one with paisa shows them (৳247.50). The receipt
// always shows 2 decimals: it is a document the customer keeps.
export function hasPaisa(value: string): boolean {
  const [, fraction = ''] = value.split('.');
  return /[1-9]/.test(fraction.slice(0, 2));
}

// A key's name next to what it does (decision 12). Hidden on a phone, which has no F keys.
export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded-[5px] border border-line-strong bg-subtle px-1.5 font-mono text-caption text-ink-3 max-[860px]:hidden">
      {children}
    </kbd>
  );
}

// Step 20b: "Shift POS1-S0042 ▾", the shift menu's button (pos-shift-menu.tsx). Here too: the top
// bar draws it while the menu's chunk loads, so the bar does not jump. The menu passes its props
// (and its ref: a prop in React 19) through. On a phone only the number: the bar has no room for
// the word (its label still says it).
export function ShiftButton({ number, ...button }: ComponentProps<'button'> & { number: string }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      aria-label={t('pos.shift.menu', { number })}
      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-control border border-line-strong bg-surface px-3 text-body-sm font-medium shadow-sm transition-colors duration-150 hover:bg-subtle"
      {...button}
    >
      <span className="tabular-nums max-sm:hidden">{t('pos.shift.number', { number })}</span>
      <span className="tabular-nums sm:hidden">{number}</span>
      <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.5} className="text-ink-3" />
    </button>
  );
}

type CompanySettings = Pick<
  SyncSettings,
  'companyName' | 'legalName' | 'address' | 'bin' | 'phone' | 'timezone'
>;

export function useReceiptCompany(settings: CompanySettings): ReceiptCompany {
  const { t } = useLocale();
  return {
    name: settings.legalName ?? settings.companyName,
    lines: [
      ...(settings.address?.split('\n') ?? []),
      ...(settings.bin === null ? [] : [t('print.bin', { bin: settings.bin })]),
      ...(settings.phone === null ? [] : [t('print.phone', { phone: settings.phone })]),
    ],
    timeZone: settings.timezone,
  };
}
