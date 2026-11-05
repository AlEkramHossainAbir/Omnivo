import { i18n } from '@omnivo/i18n';
import { toast } from '@omnivo/ui';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

// Step 19a: installing the app (decision 20), and the count on its icon.

// Chromium's install prompt (Chrome, Edge, Samsung Internet). It is not a web standard, so
// TypeScript's DOM types do not have it: this is the one part the app uses, and isInstallPrompt
// checks an event against it instead of a cast (rule 3).
interface InstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
}

function isInstallPrompt(event: Event): event is InstallPromptEvent {
  return 'prompt' in event && typeof event.prompt === 'function';
}

// How this browser installs the app: its own prompt, or the steps of Safari's own command
export type InstallWay = 'prompt' | 'ios' | 'mac-safari';

const installStore = createStore<{ prompt: InstallPromptEvent | null; installed: boolean }>()(
  () => ({ prompt: null, installed: false }),
);

// Safari gives a page no install prompt, so the user agent is the only way to know it is there
function safariWay(): InstallWay | null {
  const agent = navigator.userAgent;
  // iPadOS says "Macintosh", like a Mac; only a touch screen tells them apart. Every browser on
  // iOS is Safari underneath and has Add to Home Screen in its share menu (iOS 16.4 and later).
  if (
    /iPhone|iPad|iPod/.test(agent) ||
    (agent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  ) {
    return 'ios';
  }
  // Safari on a Mac (File → Add to Dock, Safari 17 and later). Chrome, Edge and Opera say
  // "Safari" too, so they are named to be left out; Firefox on a Mac has no install at all.
  if (
    agent.includes('Macintosh') &&
    agent.includes('Safari/') &&
    !/Chrome|Chromium|Edg|OPR|Firefox/.test(agent)
  ) {
    return 'mac-safari';
  }
  return null;
}

// Called once by main.tsx, before the first render: Chrome sends its prompt once per page load,
// often before the AppShell is on the screen, and an event nobody listened to is gone.
export function watchInstall(): void {
  // The app already runs in its own window: there is nothing to install
  const standalone = window.matchMedia('(display-mode: standalone)');
  installStore.setState({ installed: standalone.matches });
  standalone.addEventListener('change', () => {
    installStore.setState({ installed: standalone.matches });
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    if (!isInstallPrompt(event)) return;
    // Kept for the menu item. Without preventDefault, Chrome on Android shows its own bar over
    // the bottom of the page, which on a phone is where a form's buttons are.
    event.preventDefault();
    installStore.setState({ prompt: event });
  });
  window.addEventListener('appinstalled', () => {
    installStore.setState({ prompt: null, installed: true });
    toast(i18n.t('shell.installed'));
  });
}

// null = nothing to show: installed already, or a browser with no way to install (Firefox)
export function useInstallWay(): InstallWay | null {
  const prompt = useStore(installStore, (store) => store.prompt);
  const installed = useStore(installStore, (store) => store.installed);
  if (installed) return null;
  return prompt ? 'prompt' : safariWay();
}

// The menu item's click (a user gesture, which the prompt needs). A prompt can be shown once:
// after it, the item hides until Chrome sends a new one (it does after a dismissal, later).
export function promptInstall(): void {
  const { prompt } = installStore.getState();
  if (!prompt) return;
  installStore.setState({ prompt: null });
  void prompt.prompt().catch(() => undefined);
}

// The number of changes waiting on the device, on the installed app's icon: Chrome and Edge on a
// computer, an app added to the Dock on a Mac. iOS shows it only with the notification permission,
// which the app does not ask for. A browser tab shows nothing, and an old browser lacks the call.
export function setIconCount(count: number): void {
  if (!('setAppBadge' in navigator)) return;
  const done = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  void done.catch(() => undefined);
}
