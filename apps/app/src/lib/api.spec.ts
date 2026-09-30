import { routes } from '@omnivo/contracts';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WORKSPACES } from '../mocks/fixtures';
import { mock, problem, reply } from '../mocks/mock';
import { seedPeople } from '../mocks/people-data';
import { API_URL, ApiRequestError, call } from './api';
import { sessionStore } from './session-store';

// Node-এ MSW: fetch মাঝপথে ধরে — ব্রাউজারের একই handler, service worker ছাড়া
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  sessionStore.getState().signOut();
});

const page = { items: seedPeople(WORKSPACES[0]).members.slice(0, 2), nextCursor: 'next' };

describe('call', () => {
  it('builds the URL from the contract and returns the parsed response', async () => {
    let url = '';
    server.use(
      mock(routes.members.list, ({ request }) => {
        url = request.url;
        return reply(routes.members.list, page);
      }),
    );
    const result = await call(routes.members.list, { query: { sort: '-name', limit: 2 } });
    expect(url).toBe(`${API_URL}/members?sort=-name&limit=2`);
    expect(result.items.map((member) => member.fullName)).toEqual(
      page.items.map((member) => member.fullName),
    );
  });

  it('turns a problem response into an ApiRequestError with its code and field errors', async () => {
    server.use(
      mock(routes.auth.signUp, () => problem(409, 'slug_taken', { workspaceSlug: ['slug_taken'] })),
    );
    const error = await call(routes.auth.signUp, {
      body: {
        companyName: 'Rahman Garments Ltd.',
        workspaceSlug: 'rahman-garments',
        fullName: 'Farhana Rahman',
        email: 'farhana@rahmangarments.com',
        password: 'Gazipur-knit-2026',
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 409,
      code: 'slug_taken',
      problem: { fieldErrors: { workspaceSlug: ['slug_taken'] } },
    });
  });

  it('keeps working when a newer server sends a code this app does not know', async () => {
    server.use(
      http.get(`${API_URL}/auth/me`, () =>
        HttpResponse.json(
          { title: 'Conflict', status: 409, detail: 'x', code: 'brand_new_code' },
          { status: 409 },
        ),
      ),
    );
    await expect(call(routes.auth.me)).rejects.toMatchObject({ code: 'unknown_error' });
  });

  it('reports a body that breaks the contract instead of passing it on', async () => {
    server.use(http.get(`${API_URL}/members`, () => HttpResponse.json({ items: 'nope' })));
    await expect(call(routes.members.list)).rejects.toMatchObject({
      code: 'unexpected_response',
    });
  });

  it('reports a dropped connection as network_error, status 0', async () => {
    server.use(http.get(`${API_URL}/members`, () => HttpResponse.error()));
    await expect(call(routes.members.list)).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });

  it('refreshes an expired access token once and retries the request', async () => {
    sessionStore.getState().setAccessToken('expired');
    const seen: (string | null)[] = [];
    server.use(
      mock(routes.members.list, ({ request }) => {
        const token = request.headers.get('authorization');
        seen.push(token);
        return token === 'Bearer fresh'
          ? reply(routes.members.list, page)
          : problem(401, 'sign_in_required');
      }),
      mock(routes.auth.refresh, () =>
        reply(routes.auth.refresh, {
          accessToken: 'fresh',
          accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    );
    await expect(call(routes.members.list)).resolves.toMatchObject({ nextCursor: 'next' });
    expect(seen).toEqual(['Bearer expired', 'Bearer fresh']);
    expect(sessionStore.getState().accessToken).toBe('fresh');
  });
});
