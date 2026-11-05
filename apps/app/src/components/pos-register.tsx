import { CashierIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { formatPosNumber, routes, type SyncPosRegister } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { keepClaim, type LocalCopy } from '@omnivo/sync';
import { Button, Card, FormAlert, SelectField, toast } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import { requestSync, useThisDeviceId } from '../lib/local-data';
import { useSession } from '../lib/session-store';
import { useOnline } from '../lib/use-online';
import { DocumentNotice } from './document-notice';

// Step 20a (decision 14): "Which counter is this?". The device takes a register once, online: the
// server says which ones are free and gives the last number, and the device counts on from it.
// The list comes from the server, not the copy: who holds a register changes at the counter next
// door, and the copy hears of it only at its next pull. The copy's registers say only which branch
// to ask for (a device sees its own branch's).
export function RegisterChooser({
  copy,
  registers,
}: {
  copy: LocalCopy;
  registers: readonly SyncPosRegister[];
}) {
  const { t } = useLocale();
  const online = useOnline();
  const deviceId = useThisDeviceId();
  const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
  const branchId = registers[0]?.branchId;
  const list = useQuery({
    queryKey: ['pos-registers', tenantId, branchId],
    queryFn: () => call(routes.pos.listRegisters, { query: { status: 'active', branchId } }),
    enabled: online && branchId !== undefined,
  });
  // The one the server says this device holds already (the claim was lost): picked at once
  const held = list.data?.items.find(
    (item) => item.deviceId !== null && item.deviceId === deviceId,
  );
  const [picked, setPicked] = useState<string | null>(null);
  const value = picked ?? held?.id ?? '';
  // An error code: FormAlert says it in the page's language
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Starts empty, like the branch dialog: a counter is picked on purpose, never by default. A
  // register another device holds stays in the list, named with that device, so the cashier sees
  // why it cannot be taken (the claim says pos_register_in_use).
  const options = [
    { value: '', label: t('pos.choosePlaceholder') },
    ...(list.data?.items ?? []).map((item) => ({
      value: item.id,
      label:
        item.holder && item.deviceId !== deviceId
          ? t('pos.heldBy', { code: item.code, device: item.holder.deviceName })
          : t('pos.register', { code: item.code, name: item.name }),
    })),
  ];

  const choose = async () => {
    if (!deviceId || value === '') return;
    setBusy(true);
    setError(null);
    try {
      const claimed = await call(routes.pos.claimRegister, {
        params: { id: value },
        body: { deviceId },
      });
      const claim = await keepClaim(copy, claimed);
      // The next pull brings the register with this device as its holder
      requestSync();
      toast(
        t('pos.claimed', {
          code: claimed.code,
          number: formatPosNumber(claimed.code, claim.last + 1),
        }),
      );
    } catch (failure) {
      setError(failure instanceof ApiRequestError ? failure.code : 'unknown_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="w-full max-w-[440px] p-6 max-sm:p-[18px]">
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void choose();
        }}
      >
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
            <HugeiconsIcon icon={CashierIcon} size={20} strokeWidth={1.5} />
          </span>
          <div className="grid gap-1">
            <h1 className="text-h3 font-semibold text-balance">{t('pos.chooseTitle')}</h1>
            <p className="text-label text-ink-3">{t('pos.chooseDescription')}</p>
          </div>
        </div>
        {error && <FormAlert message={error} />}
        {online ? (
          <SelectField
            id="pos-register"
            label={t('pos.chooseLabel')}
            options={options}
            value={value}
            onChange={(event) => {
              setPicked(event.target.value);
            }}
          />
        ) : (
          <DocumentNotice tone="neutral" icon={WifiDisconnected02Icon}>
            {t('pos.chooseOffline')}
          </DocumentNotice>
        )}
        <Button type="submit" disabled={!online || value === '' || busy}>
          {t('pos.choose')}
        </Button>
      </form>
    </Card>
  );
}
