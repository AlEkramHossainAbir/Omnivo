import { describe, expect, it } from 'vitest';

import {
  deviceListItemSchema,
  deviceListQuerySchema,
  deviceRoutes,
  moveDeviceInputSchema,
  renameDeviceInputSchema,
  syncAge,
} from './devices.js';

const DEVICE = '0192f1c6-0000-7000-8000-000000000001';
const USER = '0192f1c6-0000-7000-8000-000000000002';
const BRANCH = '0192f1c6-0000-7000-8000-000000000003';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('device list', () => {
  it('starts with the active devices by name, 50 a page', () => {
    expect(deviceListQuerySchema.parse({})).toEqual({ limit: 50, status: 'active', sort: 'name' });
  });

  it('reads a search, a branch, the revoked tab and the oldest sync first', () => {
    expect(
      deviceListQuerySchema.parse({
        search: '  Counter ',
        branchId: BRANCH,
        status: 'revoked',
        sort: 'lastSync',
        limit: '20',
      }),
    ).toEqual({
      search: 'Counter',
      branchId: BRANCH,
      status: 'revoked',
      sort: 'lastSync',
      limit: 20,
    });
  });

  it('refuses a sort the server cannot do', () => {
    expect(deviceListQuerySchema.safeParse({ sort: 'person' }).success).toBe(false);
  });

  it('names the person, the branch and who revoked it', () => {
    // The counter computer of the Chattogram depot, revoked by the owner after it was replaced
    const counter = {
      id: DEVICE,
      name: 'Counter 2',
      branchId: BRANCH,
      userId: USER,
      lastSyncAt: '2026-10-20T04:30:00.000Z',
      revokedAt: '2026-10-22T09:00:00.000Z',
      createdAt: '2026-10-01T03:00:00.000Z',
      version: 3,
      userName: 'Tanvir Ahmed',
      branchName: 'Chattogram depot',
      revokedByName: 'Farhana Akter',
    };
    expect(deviceListItemSchema.parse(counter)).toEqual(counter);
  });
});

describe('rename and move', () => {
  it('trims the new name, and needs the version the person saw', () => {
    expect(renameDeviceInputSchema.parse({ name: ' Sales laptop ', version: 2 })).toEqual({
      name: 'Sales laptop',
      version: 2,
    });
    expect(renameDeviceInputSchema.safeParse({ name: 'Sales laptop' }).success).toBe(false);
  });

  it('refuses a one-letter name and an empty branch, each with its code', () => {
    expect(
      renameDeviceInputSchema.safeParse({ name: 'L', version: 1 }).error?.issues[0]?.message,
    ).toBe('device_name_required');
    expect(
      moveDeviceInputSchema.safeParse({ branchId: '', version: 1 }).error?.issues[0]?.message,
    ).toBe('device_branch_invalid');
  });
});

describe('routes', () => {
  it("needs core.device.manage for the workspace's list only", () => {
    expect(deviceRoutes.list.permission).toBe('core.device.manage');
    // Your own device needs no permission; the service checks someone else's
    expect('permission' in deviceRoutes.mine).toBe(false);
    expect('permission' in deviceRoutes.rename).toBe(false);
    expect('permission' in deviceRoutes.move).toBe(false);
    expect('permission' in deviceRoutes.revoke).toBe(false);
  });
});

describe('the offline time limits', () => {
  it('is fresh for a day, warns after 24 hours and blocks after 7 days', () => {
    expect(syncAge(0)).toBe('fresh');
    expect(syncAge(DAY - 1)).toBe('fresh');
    expect(syncAge(DAY)).toBe('warn');
    expect(syncAge(7 * DAY - 1)).toBe('warn');
    expect(syncAge(7 * DAY)).toBe('blocked');
    expect(syncAge(40 * DAY)).toBe('blocked');
  });

  it('counts a clock set back as fresh', () => {
    expect(syncAge(-3 * HOUR)).toBe('fresh');
  });
});
