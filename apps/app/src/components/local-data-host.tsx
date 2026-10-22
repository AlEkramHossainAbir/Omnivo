import { lazy, Suspense, useEffect } from 'react';
import { useStore } from 'zustand';

import { localDataStore, useDeviceState } from '../lib/local-data';
import { chooseBranch, chooseLater, startLocalData } from '../lib/local-session';
import { preloadOfflineScreens } from '../lib/offline-screens';
import { useSession } from '../lib/session-store';

// Step 18b: loaded when it opens, once per device at most. The push took this chunk (with Dexie)
// over its budget, and the dialog's code is 14 KB gz of it.
const DeviceBranchDialog = lazy(async () => ({
  default: (await import('./device-branch-dialog')).DeviceBranchDialog,
}));

// Step 18a: the device and its copy of the data, for the person signed in now. Rendered once,
// inside the AppShell, and loaded lazily with Dexie: the login page never downloads it. A switch
// to another workspace changes the tenant id, which stops this copy and starts that one.
export function LocalDataHost() {
  const userId = useSession((state) => state.me?.user.id);
  const tenantId = useSession((state) => state.me?.tenant.id);
  const asking = useStore(localDataStore, (state) => state.asking);
  const device = useDeviceState();

  useEffect(() => {
    if (userId === undefined || tenantId === undefined) return;
    return startLocalData({ tenantId, userId });
  }, [tenantId, userId]);

  // Step 18b (decision 42): the offline screens' code, while there is a connection
  useEffect(() => {
    preloadOfflineScreens();
    window.addEventListener('online', preloadOfflineScreens);
    return () => {
      window.removeEventListener('online', preloadOfflineScreens);
    };
  }, []);

  return asking && device.kind === 'not-set-up' ? (
    <Suspense fallback={null}>
      <DeviceBranchDialog
        branches={device.branches}
        chooseBranch={chooseBranch}
        chooseLater={chooseLater}
      />
    </Suspense>
  ) : null;
}
