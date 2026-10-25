import {
  ComputerPhoneSyncIcon,
  ComputerRemoveIcon,
  Search01Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { DEVICE_STATUSES, type DeviceSort, type DeviceStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  DataTable,
  EmptyState,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';

import { type DeviceAction, useDeviceColumns } from '../components/device-parts';
import { useTenantId } from '../lib/workspace';
import { useDeviceState, useThisDeviceId } from '../lib/local-data';
import { useCan } from '../lib/permissions';
import { branchesQuery, deviceListQuery } from '../lib/queries';
import { useNow } from '../lib/sync-summary';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';

// Loaded when a row's menu asks for one: the three forms bring react-hook-form and the dialog,
// which took both pages over their budget, for dialogs most visits never open
const DeviceDialogs = lazy(async () => ({
  default: (await import('../components/device-dialogs')).DeviceDialogs,
}));

// Step 18c (decision 1): every device of the workspace, for the people with core.device.manage.
// Paged and sorted on the server (decision 8), like the other long lists: a search by the device's
// or the person's name, a branch, and the Active and Revoked tabs.

// Two columns sort: the device's name, and the last sync ('lastSync' = the oldest first, the
// devices that never synced before them; the order of an owner looking for the ones behind)
function sortOf(state: SortingState): DeviceSort {
  const [first] = state;
  if (first?.id === 'lastSyncAt') return first.desc ? '-lastSync' : 'lastSync';
  return first?.desc ? '-name' : 'name';
}

export function DevicesPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const canManage = useCan()('core.device.manage');
  const device = useDeviceState();
  const thisDeviceId = useThisDeviceId();
  const now = useNow();
  const [search, setSearch] = useState('');
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState<DeviceStatus>('active');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const [acting, setActing] = useState<DeviceAction | null>(null);
  const settled = useDebounced(search.trim());
  const filter = { search: settled, branchId, status, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...deviceListQuery(tenantId, filter),
    // Without the permission the API answers 403: the page says why instead of asking
    enabled: canManage && online,
  });
  const branches = useQuery({ ...branchesQuery(tenantId, 'active'), enabled: canManage }).data;
  const devices = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const columns = useDeviceColumns({
    withPerson: true,
    sortable: true,
    thisDeviceId,
    canMoveHere: device.kind === 'ready',
    now,
    onAction: setActing,
  });

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('devices.noMatchTitle', { query: settled })}
        description={t('devices.noMatchBody')}
      />
    ) : status === 'revoked' ? (
      <EmptyState
        icon={ComputerRemoveIcon}
        title={t('devices.emptyRevokedTitle')}
        description={t('devices.emptyRevokedBody')}
      />
    ) : (
      <EmptyState
        icon={ComputerPhoneSyncIcon}
        title={t('devices.emptyTitle')}
        description={t('devices.emptyBody')}
      />
    );

  if (!canManage) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <PageHeader title={t('devices.title')} description={t('devices.description')} />
        <p className="text-body-sm text-ink-3">{t('devices.readOnly')}</p>
      </div>
    );
  }

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader title={t('devices.title')} description={t('devices.description')} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('devices.searchLabel')}
            placeholder={t('devices.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-w-0 basis-56">
          <Select
            aria-label={t('devices.columns.branch')}
            options={[
              { value: '', label: t('devices.allBranches') },
              ...(branches ?? []).map((branch) => ({ value: branch.id, label: branch.name })),
            ]}
            value={branchId}
            onChange={(event) => {
              setBranchId(event.target.value);
            }}
          />
        </div>
        <SegmentedControl
          label={t('devices.show')}
          value={status}
          options={DEVICE_STATUSES.map((value) => ({
            value,
            label: t(`devices.statuses.${value}`),
          }))}
          onChange={setStatus}
        />
      </div>
      {!online ? (
        <EmptyState
          icon={WifiDisconnected02Icon}
          title={t('sync.needsConnectionTitle')}
          description={t('devices.needsConnection')}
        />
      ) : isError ? (
        <p className="text-body-sm text-crit">{t('devices.loadFailed')}</p>
      ) : (
        devices && (
          <DataTable
            label={t('devices.title')}
            data={devices}
            columns={columns}
            getRowId={(item) => item.id}
            sorting={{ state: sorting, onChange: setSorting }}
            onEndReached={loadMore}
            maxHeight={640}
            empty={empty}
            footer={
              isFetchingNextPage && (
                <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
              )
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
