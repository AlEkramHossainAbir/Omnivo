import type { Industry, Setup } from '@omnivo/contracts';

import { seedAccounts } from './accounting-data';
import { MockProblem } from './mock';
import { record, type WorkspaceData } from './workspace-data';

// How long the pretend setup job takes — long enough to see "Preparing the roles…"
const SETUP_DELAY_MS = 2_000;

// The same role names as the API's setup/templates.ts (the mock cannot import server code). Only
// names: the mock's new roles start with no permissions.
const TEMPLATE_ROLES = {
  garments: ['Accountant', 'Merchandiser', 'Store keeper'],
  pharma: ['Accountant', 'Depot manager', 'Sales representative'],
  distribution: ['Accountant', 'Depot manager', 'Sales officer'],
  manufacturing: ['Accountant', 'Production manager', 'Store keeper'],
  retail: ['Accountant', 'Shop manager', 'Cashier'],
  other: ['Accountant', 'Manager'],
} satisfies Record<Industry, string[]>;

export function startSetup(data: WorkspaceData, industry: Industry): Setup {
  if (data.setup.status !== 'pending') throw new MockProblem(409, 'setup_started');
  data.setup = { status: 'provisioning', industry };
  data.setupReadyAt = Date.now() + SETUP_DELAY_MS;
  record(data, 'workspace.setup_started', 'workspace', crypto.randomUUID(), {
    industry: { from: null, to: industry },
  });
  return data.setup;
}

// Called on every read: once the delay has passed, do what the worker would have done — roles,
// the chart of accounts, status, audit and a notification
export function settleSetup(data: WorkspaceData): void {
  const { industry } = data.setup;
  if (
    data.setup.status !== 'provisioning' ||
    industry === null ||
    data.setupReadyAt === null ||
    Date.now() < data.setupReadyAt
  ) {
    return;
  }
  const taken = new Set(data.people.roles.map((role) => role.name.toLowerCase()));
  const added = TEMPLATE_ROLES[industry].filter((name) => !taken.has(name.toLowerCase()));
  for (const name of added) {
    data.people.roles.push({
      id: crypto.randomUUID(),
      name,
      description: null,
      kind: 'custom',
      permissions: [],
      version: 1,
      updatedAt: new Date().toISOString(),
    });
  }
  if (data.accounts.length === 0) data.accounts = seedAccounts(industry);
  data.setup = { status: 'ready', industry };
  data.setupReadyAt = null;
  record(data, 'workspace.provisioned', 'workspace', crypto.randomUUID(), {
    industry: { from: null, to: industry },
    roles: { from: null, to: added.join(', ') || null },
    accounts: { from: null, to: data.accounts.length },
  });
  data.notifications.unshift({
    id: crypto.randomUUID(),
    type: 'workspace.ready',
    params: {},
    readAt: null,
    createdAt: new Date().toISOString(),
  });
}
