import { type MeResponse, routes } from '@omnivo/contracts';
import { newDeviceId, readDevice, saveDevice } from '@omnivo/sync';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HEAD_OFFICES, meIn, WORKSPACES } from '../mocks/fixtures';
import { mock, problem, reply } from '../mocks/mock';
import { seedPeople } from '../mocks/people-data';
import { API_URL } from './api';

// Step 19a: the offline opening, the check when the server answers again, and the sign-out with
// no connection. A test "reloads the page" with vi.resetModules(): every module of the app starts
// again (the session store, restoreSession's promise, the offline check), and only the browser's
// localStorage stays, as after a real reload.

const server = setupServer();

const [garments] = WORKSPACES;
const me = meIn(garments, 'Rahman Garments Ltd.', { language: null, theme: 'system' }, 'ready');
const page = { items: seedPeople(garments).members.slice(0, 2), nextCursor: null };

// The part of localStorage the app uses. A Map, so a test can read what the app left there.
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

let storage = memoryStorage();

// apps/app's tests run in Node, with no DOM. The window is an EventTarget, for the `online` event
// the offline opening listens to, with the storage on it; the document has only what applyTheme
// touches.
function stubBrowser(): void {
  storage = memoryStorage();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }));
  vi.stubGlobal('document', {
    documentElement: { dataset: {}, removeAttribute: () => undefined },
  });
}

// The device copy of step 18a: a branch chosen for this person on this browser
function setUpDevice(): void {
  saveDevice(storage, garments.tenantId, me.user.id, {
    id: newDeviceId(),
    branchId: HEAD_OFFICES[garments.slug],
    later: false,
  });
}

// A new page load: new modules, the same storage
async function reload() {
  vi.resetModules();
  const [session, store, api] = await Promise.all([
    import('./session'),
    import('./session-store'),
    import('./api'),
  ]);
  return { ...session, sessionStore: store.sessionStore, call: api.call };
}

type App = Awaited<ReturnType<typeof reload>>;
let app: App | null = null;

// A page that was signed in online: the store remembered the person
async function signedInOnce(): Promise<App> {
  app = await reload();
  app.sessionStore.getState().signIn(me);
  app.sessionStore.getState().setAccessToken('first');
  return app;
}

// A reload with no connection, after an online visit on a device with a copy
async function openedOffline(): Promise<App> {
  setUpDevice();
  await signedInOnce();
  server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
  app = await reload();
  await app.restoreSession();
  return app;
}

function session(accessToken: string) {
  return { accessToken, accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString() };
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
beforeEach(() => {
  stubBrowser();
});
afterEach(() => {
  // A test that ends opened offline stops its watch for the server here
  app?.sessionStore.getState().signOut();
  app = null;
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  server.close();
});

describe('a reload with no answer from the server (step 19a)', () => {
  it('opens as the person who was signed in, with no token', async () => {
    const opened = await openedOffline();
    expect(opened.sessionStore.getState()).toMatchObject({
      status: 'signed-in',
      openedOffline: true,
      accessToken: null,
      me: { user: { id: me.user.id }, tenant: { id: garments.tenantId } },
    });
  });

  it('shows the sign-in page on a device with no copy for that person', async () => {
    await signedInOnce();
    server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState()).toMatchObject({ status: 'signed-out', me: null });
  });

  it('treats a 502 from a proxy as no answer, and a refusal as the end of the sign-in', async () => {
    setUpDevice();
    await signedInOnce();
    server.use(mock(routes.auth.refresh, () => problem(502, 'unknown_error')));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState().openedOffline).toBe(true);

    server.use(mock(routes.auth.refresh, () => problem(401, 'session_ended')));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState().status).toBe('signed-out');

    // The refusal forgot the person: no connection now opens nothing
    server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState().status).toBe('signed-out');
  });

  it('does not trust a remembered person the contract no longer accepts', async () => {
    setUpDevice();
    // What an older version of the app could have saved: a `me` without a field added since
    // (JSON leaves out a key whose value is undefined)
    storage.setItem('omnivo.me', JSON.stringify({ ...me, preferences: undefined }));
    server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState().status).toBe('signed-out');
  });
});

describe('when the server answers again (step 19a)', () => {
  it('checks the sign-in at the first request that gets a 401, then sends it again', async () => {
    const opened = await openedOffline();
    const seen: (string | null)[] = [];
    server.use(
      mock(routes.auth.refresh, () => reply(routes.auth.refresh, session('fresh'))),
      mock(routes.auth.me, () => reply(routes.auth.me, me)),
      mock(routes.members.list, ({ request }) => {
        const token = request.headers.get('authorization');
        seen.push(token);
        return token === 'Bearer fresh'
          ? reply(routes.members.list, page)
          : problem(401, 'sign_in_required');
      }),
    );
    await expect(opened.call(routes.members.list)).resolves.toMatchObject({ nextCursor: null });
    expect(seen).toEqual([null, 'Bearer fresh']);
    expect(opened.sessionStore.getState()).toMatchObject({
      status: 'signed-in',
      openedOffline: false,
      accessToken: 'fresh',
    });
  });

  it('runs one check at a time, so the rotated cookie is never sent twice', async () => {
    const opened = await openedOffline();
    let refreshes = 0;
    let meAsked = false;
    let answerMe: () => void = () => undefined;
    const meAnswered = new Promise<void>((resolve) => {
      answerMe = resolve;
    });
    server.use(
      mock(routes.auth.refresh, () => {
        refreshes += 1;
        return reply(routes.auth.refresh, session(`fresh-${String(refreshes)}`));
      }),
      // The check waits here, after its refresh: api.ts's own guard (one refresh in flight) is
      // over by then, and only the offline check's guard stops a second refresh
      mock(routes.auth.me, async () => {
        meAsked = true;
        await meAnswered;
        return reply(routes.auth.me, me);
      }),
    );
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(meAsked).toBe(true);
    });
    // The minute's timer, or a second `online`, while the first check still runs
    window.dispatchEvent(new Event('online'));
    answerMe();
    await vi.waitFor(() => {
      expect(opened.sessionStore.getState().openedOffline).toBe(false);
    });
    expect(refreshes).toBe(1);
  });

  it('signs out with a notice when the server refuses, and keeps the copy', async () => {
    const opened = await openedOffline();
    server.use(mock(routes.auth.refresh, () => problem(401, 'session_ended')));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(opened.sessionStore.getState()).toMatchObject({
        status: 'signed-out',
        notice: 'session_ended',
      });
    });
    // Decision 19: the device and its copy stay for the next online sign-in
    expect(readDevice(storage, garments.tenantId, me.user.id).branchId).toBe(
      HEAD_OFFICES[garments.slug],
    );
    // ...but the person is forgotten, so a reload with no connection shows the sign-in page
    server.use(http.post(`${API_URL}/auth/refresh`, () => HttpResponse.error()));
    app = await reload();
    await app.restoreSession();
    expect(app.sessionStore.getState().status).toBe('signed-out');
  });

  it('lets a sign-in from another tab win when the cookie is someone else’s', async () => {
    const opened = await openedOffline();
    const other: MeResponse = { ...me, user: { ...me.user, id: crypto.randomUUID() } };
    server.use(
      mock(routes.auth.refresh, () => reply(routes.auth.refresh, session('other'))),
      mock(routes.auth.me, () => reply(routes.auth.me, other)),
    );
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(opened.sessionStore.getState().openedOffline).toBe(false);
    });
    expect(opened.sessionStore.getState()).toMatchObject({
      status: 'signed-in',
      accessToken: 'other',
      me: { user: { id: other.user.id } },
    });
  });
});

describe('a sign-out with no connection (step 19a)', () => {
  // Signed in online, then the connection drops and the person signs out
  async function signedOutOffline(): Promise<App> {
    const signedIn = await signedInOnce();
    server.use(http.post(`${API_URL}/auth/logout`, () => HttpResponse.error()));
    await signedIn.logout();
    expect(signedIn.sessionStore.getState().status).toBe('signed-out');
    server.resetHandlers();
    return signedIn;
  }

  it('is sent at the next reload, which never refreshes the cookie', async () => {
    await signedOutOffline();
    const sent: string[] = [];
    server.use(
      mock(routes.auth.logout, () => {
        sent.push('logout');
        return reply(routes.auth.logout, undefined);
      }),
      mock(routes.auth.refresh, () => {
        sent.push('refresh');
        return reply(routes.auth.refresh, session('fresh'));
      }),
    );
    app = await reload();
    await app.restoreSession();
    expect(sent).toEqual(['logout']);
    expect(app.sessionStore.getState().status).toBe('signed-out');

    // Sent once: the reload after it refreshes as before step 19a
    app = await reload();
    server.use(mock(routes.auth.me, () => reply(routes.auth.me, me)));
    await app.restoreSession();
    expect(sent).toEqual(['logout', 'refresh']);
    expect(app.sessionStore.getState().status).toBe('signed-in');
  });

  it('keeps waiting while the server still does not answer', async () => {
    await signedOutOffline();
    let refreshes = 0;
    server.use(
      http.post(`${API_URL}/auth/logout`, () => HttpResponse.error()),
      mock(routes.auth.refresh, () => {
        refreshes += 1;
        return reply(routes.auth.refresh, session('fresh'));
      }),
    );
    for (let load = 0; load < 2; load += 1) {
      app = await reload();
      await app.restoreSession();
      expect(app.sessionStore.getState().status).toBe('signed-out');
    }
    expect(refreshes).toBe(0);
  });

  it('goes before the next sign-in', async () => {
    await signedOutOffline();
    const sent: string[] = [];
    server.use(
      mock(routes.auth.logout, () => {
        sent.push('logout');
        return reply(routes.auth.logout, undefined);
      }),
      mock(routes.auth.login, () => {
        sent.push('login');
        return reply(routes.auth.login, session('fresh'));
      }),
      mock(routes.auth.me, () => reply(routes.auth.me, me)),
    );
    app = await reload();
    await app.login({
      workspace: garments.slug,
      email: 'farhana@rahmangarments.com',
      password: 'Gazipur-knit-2026',
      keepSignedIn: true,
    });
    expect(sent).toEqual(['logout', 'login']);
    expect(app.sessionStore.getState()).toMatchObject({
      status: 'signed-in',
      accessToken: 'fresh',
    });
  });
});
