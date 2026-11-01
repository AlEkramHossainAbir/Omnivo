import {
  LockIcon,
  MoneyAdd01Icon,
  MoneyRemove01Icon,
  Note01Icon,
} from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import type { DeviceShift } from '@omnivo/sync';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@omnivo/ui';
import { ShiftButton } from './pos-parts';
import type { ShiftRequest } from './pos-screen';

// Step 20b: "Shift POS1-S0042 ▾": who opened it and when, pay in, pay out, the held bills and the
// close. The screen opens the dialogs (they need its cart). A chunk of its own (routes/pos.tsx).
export function ShiftMenu({
  shift,
  held,
  cashier,
  timeZone,
  onRequest,
}: {
  shift: DeviceShift;
  held: number;
  cashier: string;
  timeZone: string;
  onRequest: (request: ShiftRequest) => void;
}) {
  const { t, format } = useLocale();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ShiftButton number={shift.number} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>
          {t('pos.shift.openedBy', {
            time: format.dateTime(new Date(shift.openedAt), timeZone),
            name: cashier,
          })}
        </DropdownMenuLabel>
        <DropdownMenuItem
          icon={MoneyAdd01Icon}
          onSelect={() => {
            onRequest('pay-in');
          }}
        >
          {t('pos.shift.payIn')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={MoneyRemove01Icon}
          onSelect={() => {
            onRequest('pay-out');
          }}
        >
          {t('pos.shift.payOut')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={Note01Icon}
          onSelect={() => {
            onRequest('held');
          }}
        >
          <span className="flex-1">{t('pos.hold.listTitle')}</span>
          <span className="text-caption text-ink-3 tabular-nums">{format.number(held)}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={LockIcon}
          onSelect={() => {
            onRequest('close');
          }}
        >
          {t('pos.shift.close')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
