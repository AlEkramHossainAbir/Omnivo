import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';

import { askForPin, lockNow, useDeviceState, useKeyStatus } from '../lib/local-data';
import { isLocked } from '../lib/remembered-session';
import { useSession } from '../lib/session-store';
import type { LockAction } from './app-shell';

// Step 19b: everything a signed-in page sits in. Before this step the AppShell was the route's
// component; now the shell is one of two things this frame shows, and the lock screen is the other.
// Both are lazy: the shell's menus and the lock screen's form are never loaded together.
const AppShell = lazy(async () => ({ default: (await import('./app-shell')).AppShell }));
const LockScreen = lazy(async () => ({
  default: (await import('../components/lock-screen')).LockScreen,
}));
// Step 18a: the device and its copy of the data (Dexie, the sync engine, the branch dialog) in a
// chunk of their own. The shell draws at once; the copy starts a moment later.
// Step 19b: here, beside the shell, not in it: the copy's session runs on while the lock screen
// takes the shell's place.
const LocalDataHost = lazy(async () => ({
  default: (await import('../components/local-data-host')).LocalDataHost,
}));

export function AppFrame() {
  const navigate = useNavigate();
  const status = useSession((state) => state.status);
  const openedOffline = useSession((state) => state.openedOffline);
  const device = useDeviceState();
  const keys = useKeyStatus();

  // refresh ব্যর্থ হলে (session শেষ, অন্য ট্যাবে লগআউট) api.ts store-এ signed-out বসায়
  // Step 19b: moved here from the AppShell, so a sign-out from the lock screen leaves too
  useEffect(() => {
    if (status === 'signed-out') void navigate({ to: '/login' });
  }, [status, navigate]);

  // The lock screen while the copy waits for the PIN, and while it is still opening when it is
  // going to ask (Lock now, an offline reload), so the shell never shows for a moment before it.
  // The shell is not drawn at all: no page keeps the workspace's data on the screen or in memory.
  const locked =
    device.kind === 'locked' || (device.kind === 'starting' && (openedOffline || isLocked()));

  // Decision 4: "Lock now" with a PIN; without one, the item opens the PIN dialog
  const lock: LockAction | undefined = keys
    ? {
        pin: keys.hasPin,
        run: keys.hasPin
          ? lockNow
          : () => {
              askForPin(keys.pinBlocked ? 'new' : 'set-up');
            },
      }
    : undefined;

  return (
    <>
      <Suspense fallback={null}>{locked ? <LockScreen /> : <AppShell lock={lock} />}</Suspense>
      {/* No fallback: the host draws nothing until a dialog is needed */}
      <Suspense fallback={null}>
        <LocalDataHost />
      </Suspense>
    </>
  );
}
