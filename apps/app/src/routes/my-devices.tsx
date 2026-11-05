import { ComputerPhoneSyncIcon, WifiDisconnected02Icon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { Button, DataTable, EmptyState, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';

import { type DeviceAction, useDeviceColumns } from '../components/device-parts';
import { useTenantId } from '../lib/workspace';
import { askForBranch, useDeviceState, useThisDeviceId } from '../lib/local-data';
import { myDevicesQuery } from '../lib/queries';
import { useNow } from '../lib/sync-summary';
import { useOnline } from '../lib/use-online';

// Loaded when a row's menu asks for one: the three forms bring react-hook-form and the dialog,
// which took both pages over their budget, for dialogs most visits never open
const DeviceDialogs = lazy(async () => ({
  default: (await import('../components/device-dialogs')).DeviceDialogs,
}));

// Step 18c (decision 1): the signed-in person's own devices in this workspace, from the account
// menu. Everyone has it, with no permission: renaming and revoking your own device is yours. One
// answer, not pages: a person has a few devices.
export function MyDevicesPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const device = useDeviceState();
  const thisDeviceId = useThisDeviceId();
  const now = useNow();
  const [acting, setActing] = useState<DeviceAction | null>(null);
  const { data, isError } = useQuery({ ...myDevicesQuery(tenantId), enabled: online });
  const columns = useDeviceColumns({
    withPerson: false,
    sortable: false,
    thisDeviceId,
    canMoveHere: device.kind === 'ready',
    now,
    onAction: setActing,
  });

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader title={t('devices.mineTitle')} description={t('devices.mineDescription')} />
      {/* The list is the server's: offline it says so instead of an old answer or an error */}
      {!online ? (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('devices.needsConnection')}
        />
      ) : isError ? (
        <p className="text-body-sm text-crit">{t('devices.loadFailed')}</p>
      ) : (
        data && (
          <DataTable
            label={t('devices.mineTitle')}
            data={data}
            columns={columns}
            getRowId={(item) => item.id}
            // Empty only before this browser was set up ("Not now" in 18a's branch dialog): the
            // button opens that dialog again
            empty={
              <EmptyState
                icon={ComputerPhoneSyncIcon}
                title={t('devices.mineEmptyTitle')}
                description={t('devices.mineEmptyBody')}
                action={
                  device.kind === 'not-set-up' && (
                    <Button onClick={askForBranch}>{t('sync.setUp')}</Button>
                  )
                }
              />
            }
          />
        )
      )}
      {acting && (
        <Suspense fallback={null}>
          <DeviceDialogs
            acting={acting}
            thisDeviceId={thisDeviceId}
            onClose={() => {
              setActing(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
