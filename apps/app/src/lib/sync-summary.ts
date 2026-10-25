import { type SyncAge, syncAge } from '@omnivo/contracts';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

// Step 18b: what the sidebar shows of the sync (decision 1). The session writes them
// (local-session.ts: the engine's status and a live count of the outbox), and the AppShell reads
// them. A file of its own that imports nothing of @omnivo/sync: the shell is on every page's path,
// and local-data.ts with the device's reads took it over its budget.
export interface SyncSummary {
  // A push or a pull runs in this tab
  syncing: boolean;
  // Commands on the device, and the refused ones among them
  waiting: number;
  failed: number;
  // Step 18c: when the last pull ended, on this device's clock (syncedAtOf in @omnivo/sync). null =
  // no pull has ended, or no copy is open.
  syncedAt: number | null;
}

export const NO_SUMMARY: SyncSummary = { syncing: false, waiting: 0, failed: 0, syncedAt: null };

export const syncSummaryStore = createStore<SyncSummary>()(() => NO_SUMMARY);

export function useSyncSummary(): SyncSummary {
  return useStore(syncSummaryStore);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Step 18c: the clock, read again every minute. A page that shows "2 days ago" or a limit must change
// by itself when an hour passes with the page open; one minute is close enough for a limit counted
// in hours and days. Date.now() in a state, not in the render: a render must give the same answer
// for the same state.
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

export interface SyncAgeInfo {
  age: SyncAge;
  // Whole days since the last sync, for "Last synced 2 days ago"; 1 or more once age is not fresh
  days: number;
}

// Whole days between two times, never below 0
export function daysBetween(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

// Step 18c (decision 12): how far this device is from its last sync, as the limits see it. null =
// it never finished a pull: then there is no copy, and the screens already say so (LocalState).
export function useSyncAge(): SyncAgeInfo | null {
  const syncedAt = useStore(syncSummaryStore, (state) => state.syncedAt);
  const now = useNow();
  if (syncedAt === null) return null;
  // A pull that ended after the last tick is a little "in the future": syncAge counts that as fresh
  return { age: syncAge(now - syncedAt), days: daysBetween(syncedAt, now) };
}
