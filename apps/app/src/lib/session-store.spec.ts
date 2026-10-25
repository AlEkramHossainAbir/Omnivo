import { beforeEach, describe, expect, it } from 'vitest';

import { meIn, WORKSPACES } from '../mocks/fixtures';
import { sessionStore } from './session-store';

const [workspace] = WORKSPACES;

function signIn(): void {
  sessionStore
    .getState()
    .signIn(meIn(workspace, 'Rahman Garments Ltd.', { language: 'en', theme: 'system' }, 'ready'));
}

describe('the sign-out notice (step 18c)', () => {
  beforeEach(() => {
    // A sign-in clears whatever the last test left
    signIn();
    sessionStore.getState().signOut();
  });

  it('keeps the reason when the requests still on their way sign out again', () => {
    signIn();
    sessionStore.getState().signOut('device_revoked');
    // api.ts after a 401 whose refresh failed: no reason of its own
    sessionStore.getState().signOut();
    sessionStore.getState().signOut();
    expect(sessionStore.getState()).toMatchObject({
      status: 'signed-out',
      notice: 'device_revoked',
    });
  });

  it('has no reason after a sign-out the person asked for, and none after the next sign-in', () => {
    signIn();
    sessionStore.getState().signOut();
    expect(sessionStore.getState().notice).toBeNull();

    sessionStore.getState().signOut('device_revoked');
    signIn();
    expect(sessionStore.getState()).toMatchObject({ status: 'signed-in', notice: null });
  });
});
