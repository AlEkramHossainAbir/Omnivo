import { useEffect } from 'react';
import { useStore } from 'zustand';

import { localDataStore, useDeviceState } from '../lib/local-data';
import { startLocalData } from '../lib/local-session';
import { useSession } from '../lib/session-store';
import { DeviceBranchDialog } from './device-branch-dialog';

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

  return asking && device.kind === 'not-set-up' ? (
    <DeviceBranchDialog branches={device.branches} />
  ) : null;
}
