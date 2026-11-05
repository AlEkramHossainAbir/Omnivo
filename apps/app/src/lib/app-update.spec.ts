import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Step 19a (decision 3): what the update notice says, with a pretend service worker. The browser's
// part (a changed sw.js installs and waits, SKIP_WAITING makes it take over) is tested on the real
// build in e2e/offline.pwa.ts; this file tests the app's side of it: which state follows which
// event.

// A worker of one version. The browser moves it from installing to installed (it then waits) to
// activated; each move is a statechange event.
class FakeWorker extends EventTarget {
  state = 'installing';
  readonly posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  become(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  updates = 0;
  update(): Promise<void> {
    this.updates += 1;
    return Promise.resolve();
  }
  // A new version downloads and installs; it waits while an older one runs a page
  install(): FakeWorker {
    const worker = new FakeWorker();
    this.installing = worker;
    this.dispatchEvent(new Event('updatefound'));
    this.installing = null;
    this.waiting = worker;
    worker.become('installed');
    return worker;
  }
}

interface Browser {
  registration: FakeRegistration;
  // navigator.serviceWorker: controller = the worker that runs this page (null = none)
  container: EventTarget & { controller: FakeWorker | null; register: () => Promise<unknown> };
  reload: ReturnType<typeof vi.fn>;
}

// apps/app's tests run in Node: window, navigator and document are made here, with what
// app-update.ts reads of them
function stubBrowser(options: { controlled: boolean; loaded?: boolean }): Browser {
  const registration = new FakeRegistration();
  const controller = options.controlled ? new FakeWorker() : null;
  if (controller) registration.active = controller;
  const container = Object.assign(new EventTarget(), {
    controller,
    register: vi.fn(() => Promise.resolve(registration)),
  });
  const reload = vi.fn();
  vi.stubGlobal('navigator', { serviceWorker: container });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload } }));
  vi.stubGlobal('document', { readyState: options.loaded === false ? 'loading' : 'complete' });
  return { registration, container, reload };
}

// The module keeps the registration and its listeners: a fresh copy for every test
async function start() {
  vi.resetModules();
  const update = await import('./app-update');
  update.startAppUpdates();
  // register() runs after an await
  await vi.advanceTimersByTimeAsync(0);
  return { ...update, state: () => update.updateStore.getState().state };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the update notice (step 19a)', () => {
  it('says nothing about the first install, then shows the next version', async () => {
    const browser = stubBrowser({ controlled: false });
    const app = await start();
    // The first worker installs and takes the page over at once (clientsClaim in sw.ts)
    const first = browser.registration.install();
    expect(app.state()).toBe('none');
    browser.registration.waiting = null;
    browser.registration.active = first;
    browser.container.controller = first;
    browser.container.dispatchEvent(new Event('controllerchange'));
    expect(app.state()).toBe('none');
    expect(browser.reload).not.toHaveBeenCalled();

    browser.registration.install();
    expect(app.state()).toBe('ready');
  });

  it('shows a version that installs while the page runs', async () => {
    const browser = stubBrowser({ controlled: true });
    const app = await start();
    expect(browser.container.register).toHaveBeenCalledWith('/sw.js');
    expect(app.state()).toBe('none');
    browser.registration.install();
    expect(app.state()).toBe('ready');
  });

  it('shows a version that was already waiting when the page loaded', async () => {
    const browser = stubBrowser({ controlled: true });
    browser.registration.waiting = new FakeWorker();
    const app = await start();
    expect(app.state()).toBe('ready');
  });

  it('registers only after the page has loaded', async () => {
    const browser = stubBrowser({ controlled: true, loaded: false });
    await start();
    expect(browser.container.register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('load'));
    expect(browser.container.register).toHaveBeenCalledTimes(1);
  });

  it('asks the waiting version to take over on Reload, then reloads', async () => {
    const browser = stubBrowser({ controlled: true });
    const app = await start();
    const next = browser.registration.install();
    app.reloadApp();
    expect(next.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(app.state()).toBe('reloading');
    // Not yet: the page would load the old version's files again
    expect(browser.reload).not.toHaveBeenCalled();
    browser.container.dispatchEvent(new Event('controllerchange'));
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads anyway when the waiting version never takes over', async () => {
    const browser = stubBrowser({ controlled: true });
    const app = await start();
    browser.registration.install();
    app.reloadApp();
    await vi.advanceTimersByTimeAsync(4999);
    expect(browser.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });

  it('tells a tab that another tab took the update, and its Reload is a plain reload', async () => {
    const browser = stubBrowser({ controlled: true });
    const app = await start();
    const next = browser.registration.install();
    // Another tab clicked Reload: the new version takes over every tab
    browser.registration.waiting = null;
    browser.container.controller = next;
    browser.container.dispatchEvent(new Event('controllerchange'));
    expect(app.state()).toBe('other-tab');
    expect(browser.reload).not.toHaveBeenCalled();

    app.reloadApp();
    expect(next.posted).toEqual([]);
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });

  it('treats a page opened with Shift + Reload as running the old version', async () => {
    const browser = stubBrowser({ controlled: false });
    // A worker is active, but this one page loaded without it
    browser.registration.active = new FakeWorker();
    const app = await start();
    browser.container.dispatchEvent(new Event('controllerchange'));
    expect(app.state()).toBe('other-tab');
  });

  it('looks for a new version every hour and when the connection comes back', async () => {
    const browser = stubBrowser({ controlled: true });
    await start();
    expect(browser.registration.updates).toBe(0);
    window.dispatchEvent(new Event('online'));
    expect(browser.registration.updates).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(browser.registration.updates).toBe(2);
  });

  it('works on as before when the browser refuses the worker', async () => {
    const browser = stubBrowser({ controlled: false });
    browser.container.register = vi.fn(() => Promise.reject(new Error('SecurityError')));
    const app = await start();
    app.checkForUpdate();
    app.reloadApp();
    expect(browser.reload).toHaveBeenCalledTimes(1);
  });
});
