import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

// Step 18b: the three numbers the sidebar shows of the sync (decision 1). The session writes them
// (local-session.ts: the engine's status and a live count of the outbox), and the AppShell reads
// them. A file of its own that imports nothing of @omnivo/sync: the shell is on every page's path,
// and local-data.ts with the device's reads took it over its budget.
export interface SyncSummary {
  // A push or a pull runs in this tab
  syncing: boolean;
  // Commands on the device, and the refused ones among them
  waiting: number;
  failed: number;
}

export const NO_SUMMARY: SyncSummary = { syncing: false, waiting: 0, failed: 0 };

export const syncSummaryStore = createStore<SyncSummary>()(() => NO_SUMMARY);

export function useSyncSummary(): SyncSummary {
  return useStore(syncSummaryStore);
}
