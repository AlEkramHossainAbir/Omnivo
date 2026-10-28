import type { SyncSettings } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';

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
