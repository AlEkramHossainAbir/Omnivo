import type { Industry, PermissionKey } from '@omnivo/contracts';

export interface RoleTemplate {
  name: string;
  description: string;
  permissions: PermissionKey[];
}

// Starting data for each business type. Now: roles that match how such a company is staffed.
// Step 9 adds the chart of accounts here, step 12 the product tracking (batch for pharma).
// These roles are ordinary custom roles: the workspace can rename, change or delete them, and a
// later change to this file never touches workspaces that already exist.
export interface IndustryTemplate {
  roles: RoleTemplate[];
}

// Some roles have few permissions today because the modules they will use (stock, sales) do not
// exist yet. Each of those steps adds its permissions to these templates for new workspaces.
const ACCOUNTANT: RoleTemplate = {
  name: 'Accountant',
  description: 'Books, VAT returns and Mushak 6.3',
  permissions: ['core.user.read', 'core.audit.read'],
};

const STORE_KEEPER: RoleTemplate = {
  name: 'Store keeper',
  description: 'Receives goods and writes GRNs',
  permissions: [],
};

// satisfies Record<Industry, …>: a new industry in contracts does not compile until it has a template
export const INDUSTRY_TEMPLATES = {
  garments: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Merchandiser',
        description: 'Buyer POs, LCs and shipment dates',
        permissions: ['core.user.read'],
      },
      STORE_KEEPER,
    ],
  },
  pharma: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Depot manager',
        description: 'Stock by batch and expiry at a depot',
        permissions: ['core.branch.manage'],
      },
      { name: 'Sales representative', description: 'Orders from pharmacies', permissions: [] },
    ],
  },
  distribution: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Depot manager',
        description: 'Stock and deliveries at a depot',
        permissions: ['core.branch.manage'],
      },
      {
        name: 'Sales officer',
        description: 'Orders and collections from retailers',
        permissions: [],
      },
    ],
  },
  manufacturing: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Production manager',
        description: 'Production orders and material use',
        permissions: ['core.user.read'],
      },
      STORE_KEEPER,
    ],
  },
  retail: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Shop manager',
        description: 'Runs a shop and its staff',
        permissions: ['core.user.read', 'core.branch.manage'],
      },
      { name: 'Cashier', description: 'Sells at the counter', permissions: [] },
    ],
  },
  other: {
    roles: [
      ACCOUNTANT,
      { name: 'Manager', description: 'Runs day-to-day work', permissions: ['core.user.read'] },
    ],
  },
} satisfies Record<Industry, IndustryTemplate>;
