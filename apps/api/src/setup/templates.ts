import type {
  AccountPurpose,
  AccountType,
  CustomFieldType,
  Industry,
  PermissionKey,
  UnitDimension,
} from '@omnivo/contracts';

export interface RoleTemplate {
  name: string;
  description: string;
  permissions: PermissionKey[];
}

// One node of a template chart. With `children` it is a group (an empty list is a group the
// company fills itself, like "Bank accounts"); without, it is an account that entries post to.
export interface AccountTemplate {
  code: string;
  name: string;
  purpose?: AccountPurpose;
  children?: readonly AccountTemplate[];
}

// The five top-level groups, one per type. The type is written once here, not on every account:
// each account takes it from its top-level group, exactly as the database does (the parent FK).
export type ChartTemplate = Record<AccountType, AccountTemplate>;

// A unit of measure. ratio = how many of the dimension's reference unit (pcs, kg, m, m², l) one of
// it is; null = a pack whose size each product says.
export interface UnitTemplate {
  code: string;
  name: string;
  dimension: UnitDimension;
  ratio: string | null;
  decimals: number;
}

// A product category; with children, the categories under it
export interface CategoryTemplate {
  name: string;
  children?: readonly CategoryTemplate[];
}

export interface CustomFieldTemplate {
  key: string;
  label: string;
  type: CustomFieldType;
  options?: readonly string[];
  required?: boolean;
}

// What a new workspace needs before its first product (step 12)
export interface CatalogTemplate {
  units: readonly UnitTemplate[];
  categories: readonly CategoryTemplate[];
  customFields: readonly CustomFieldTemplate[];
}

// Starting data for each business type: the roles such a company is staffed with, its chart of
// accounts, and its units, product categories and custom fields (step 12; a pharma company's
// products start with batch tracking — contracts' trackingDefault()). Everything here is ordinary
// data once created: the workspace can rename, change or delete it, and a later change to this
// file never touches workspaces that already exist.
export interface IndustryTemplate {
  roles: RoleTemplate[];
  chart: ChartTemplate;
  catalog: CatalogTemplate;
}

// Some roles have few permissions today because the modules they will use (stock, sales) do not
// exist yet. Each of those steps adds its permissions to these templates for new workspaces.
const ACCOUNTANT: RoleTemplate = {
  name: 'Accountant',
  description: 'Books, VAT returns and Mushak 6.3',
  permissions: [
    'core.user.read',
    'core.audit.read',
    'accounting.account.manage',
    'accounting.journal.read',
    'accounting.journal.create',
    'accounting.journal.post',
    'accounting.period.close',
    'accounting.report.read',
  ],
};

const STORE_KEEPER: RoleTemplate = {
  name: 'Store keeper',
  description: 'Receives goods and writes GRNs',
  permissions: ['inventory.product.manage'],
};

function group(
  code: string,
  name: string,
  children: readonly AccountTemplate[] = [],
): AccountTemplate {
  return { code, name, children };
}

// exactOptionalPropertyTypes: `purpose: undefined` is not the same as no purpose, so the key is
// only added when there is one
function account(code: string, name: string, purpose?: AccountPurpose): AccountTemplate {
  return { code, name, ...(purpose !== undefined && { purpose }) };
}

// What differs by industry. Everything else — cash, banks, VAT, payables, capital, the common
// expenses — is the same for every company in Bangladesh and comes from standardChart().
interface IndustryAccounts {
  // At code 1150: one account for a trader, a group (raw materials → finished goods) for a maker.
  // Exactly one account in it has the 'inventory' purpose.
  stock: AccountTemplate;
  // Current assets from 1180 on
  currentAssets?: readonly AccountTemplate[];
  // Current liabilities from 2180 on
  currentLiabilities?: readonly AccountTemplate[];
  // Under 4100 Revenue. Exactly one has the 'sales' purpose.
  revenue: readonly AccountTemplate[];
  // Other income from 4230 on
  otherIncome?: readonly AccountTemplate[];
  // Under 5100 Cost of sales. Exactly one has the 'cost_of_goods_sold' purpose.
  costOfSales: readonly AccountTemplate[];
  // Selling and distribution expenses from 5330 on
  selling?: readonly AccountTemplate[];
}

// Four-digit codes: the first digit is the type (1 asset … 5 expense), the second the group, the
// third the account. Gaps of 10 leave room for the company's own accounts in between.
function standardChart(industry: IndustryAccounts): ChartTemplate {
  return {
    asset: group('1000', 'Assets', [
      group('1100', 'Current assets', [
        account('1110', 'Cash in hand', 'cash'),
        // Empty: every company adds its own banks ("Dutch-Bangla Bank CD A/C …") and wallets
        group('1120', 'Bank accounts'),
        group('1130', 'Mobile wallets (bKash, Nagad)'),
        account('1140', 'Accounts receivable', 'accounts_receivable'),
        industry.stock,
        group('1160', 'Advances, deposits and prepayments', [
          account('1161', 'Advances to suppliers'),
          account('1162', 'Security deposits'),
          account('1163', 'Prepaid expenses'),
          account('1164', 'Advance income tax (AIT)'),
        ]),
        account('1170', 'Input VAT', 'vat_input'),
        ...(industry.currentAssets ?? []),
      ]),
      group('1200', 'Fixed assets', [
        account('1210', 'Land and buildings'),
        account('1220', 'Plant and machinery'),
        account('1230', 'Furniture and fixtures'),
        account('1240', 'Vehicles'),
        account('1250', 'Office equipment and computers'),
        account('1290', 'Accumulated depreciation'),
      ]),
    ]),
    liability: group('2000', 'Liabilities', [
      group('2100', 'Current liabilities', [
        account('2110', 'Accounts payable', 'accounts_payable'),
        account('2120', 'Output VAT', 'vat_output'),
        account('2130', 'VAT and tax deducted at source (VDS, TDS)'),
        account('2140', 'Salaries and wages payable'),
        account('2150', 'Accrued expenses'),
        account('2160', 'Advances from customers'),
        account('2170', 'Short-term loans and overdraft'),
        ...(industry.currentLiabilities ?? []),
      ]),
      group('2200', 'Long-term liabilities', [account('2210', 'Long-term loans')]),
    ]),
    equity: group('3000', 'Equity', [
      account('3100', 'Capital'),
      account('3200', 'Retained earnings', 'retained_earnings'),
      // The other side of the opening balances, entered in step 10 when the company moves its
      // books to Omnivo. It should read zero once everything is entered.
      account('3300', 'Opening balance equity', 'opening_balance_equity'),
    ]),
    income: group('4000', 'Income', [
      group('4100', 'Revenue', industry.revenue),
      group('4200', 'Other income', [
        account('4210', 'Interest income'),
        account('4220', 'Miscellaneous income'),
        ...(industry.otherIncome ?? []),
      ]),
    ]),
    expense: group('5000', 'Expenses', [
      group('5100', 'Cost of sales', industry.costOfSales),
      group('5200', 'Administrative expenses', [
        account('5210', 'Salaries and allowances'),
        account('5220', 'Office rent'),
        account('5230', 'Utilities (electricity, gas, water)'),
        account('5240', 'Transport and conveyance'),
        account('5250', 'Printing and stationery'),
        account('5260', 'Telephone and internet'),
        account('5270', 'Repairs and maintenance'),
        account('5280', 'Depreciation'),
      ]),
      group('5300', 'Selling and distribution expenses', [
        account('5310', 'Advertising and promotion'),
        account('5320', 'Delivery and carriage outward'),
        ...(industry.selling ?? []),
      ]),
      group('5400', 'Finance costs', [
        account('5410', 'Bank charges'),
        account('5420', 'Interest expense'),
      ]),
      account('5500', 'Income tax expense'),
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Units, categories and custom fields (step 12)

function unit(
  code: string,
  name: string,
  dimension: UnitDimension,
  ratio: string | null,
  decimals = 0,
): UnitTemplate {
  return { code, name, dimension, ratio, decimals };
}

function category(name: string, children?: readonly string[]): CategoryTemplate {
  return children === undefined
    ? { name }
    : { name, children: children.map((child) => ({ name: child })) };
}

// Every company counts, weighs and measures: these units are in every workspace. Packs (box,
// carton) have no ratio: a box of Napa holds 10 strips, a box of buttons 144 pieces.
const COMMON_UNITS = [
  unit('pcs', 'Pieces', 'count', '1'),
  unit('dozen', 'Dozen', 'count', '12'),
  unit('kg', 'Kilogram', 'weight', '1', 3),
  unit('g', 'Gram', 'weight', '0.001'),
  unit('m', 'Metre', 'length', '1', 2),
  unit('l', 'Litre', 'volume', '1', 3),
  unit('ml', 'Millilitre', 'volume', '0.001'),
  unit('box', 'Box', 'count', null),
  unit('carton', 'Carton', 'count', null),
] as const;

const TRADER_STOCK = account('1150', 'Inventory', 'inventory');
const COGS = account('5110', 'Cost of goods sold', 'cost_of_goods_sold');
// Makers post the sale's cost from finished goods; raw materials move there through production
const MAKER_COSTS = [
  COGS,
  account('5120', 'Direct labour'),
  account('5130', 'Factory overhead'),
] as const;

// satisfies Record<Industry, …>: a new industry in contracts does not compile until it has a template
export const INDUSTRY_TEMPLATES = {
  garments: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Merchandiser',
        description: 'Buyer POs, LCs and shipment dates',
        permissions: ['core.user.read', 'inventory.product.manage'],
      },
      STORE_KEEPER,
    ],
    chart: standardChart({
      stock: group('1150', 'Inventories', [
        account('1151', 'Fabrics and yarn'),
        account('1152', 'Trims and accessories'),
        account('1153', 'Work in progress'),
        account('1154', 'Finished garments', 'inventory'),
      ]),
      currentAssets: [
        account('1180', 'Export bills receivable'),
        account('1190', 'Cash incentive receivable'),
      ],
      currentLiabilities: [account('2180', 'Back-to-back LC payable')],
      revenue: [account('4110', 'Export sales', 'sales'), account('4120', 'Local sales')],
      otherIncome: [account('4230', 'Cash incentive on exports')],
      costOfSales: [...MAKER_COSTS, account('5140', 'Subcontract charges')],
      selling: [
        account('5330', 'Export freight and C&F charges'),
        account('5340', 'Buying house commission'),
      ],
    }),
    catalog: {
      units: [
        ...COMMON_UNITS,
        unit('yard', 'Yard', 'length', '0.9144', 2),
        unit('gross', 'Gross', 'count', '144'),
        unit('roll', 'Roll', 'count', null),
        unit('cone', 'Cone', 'count', null),
        unit('pair', 'Pair', 'count', null),
      ],
      categories: [
        category('Fabrics', ['Knit', 'Woven', 'Denim']),
        category('Yarn'),
        category('Trims and accessories', ['Buttons', 'Zippers', 'Labels', 'Sewing thread']),
        category('Packing materials', ['Poly bags', 'Cartons', 'Hangers']),
        category('Finished garments', ['T-shirts', 'Polo shirts', 'Trousers', 'Jackets']),
      ],
      customFields: [
        { key: 'buyer', label: 'Buyer', type: 'text' },
        { key: 'composition', label: 'Fabric composition', type: 'text' },
        { key: 'gsm', label: 'GSM', type: 'number' },
        { key: 'season', label: 'Season', type: 'text' },
      ],
    },
  },
  pharma: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Depot manager',
        description: 'Stock by batch and expiry at a depot',
        permissions: ['core.branch.manage', 'inventory.product.manage'],
      },
      { name: 'Sales representative', description: 'Orders from pharmacies', permissions: [] },
    ],
    chart: standardChart({
      stock: group('1150', 'Inventories', [
        account('1151', 'Raw materials'),
        account('1152', 'Packing materials'),
        account('1153', 'Work in progress'),
        account('1154', 'Finished goods', 'inventory'),
      ]),
      revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Sales returns')],
      costOfSales: MAKER_COSTS,
      selling: [
        account('5330', 'Medical promotion and samples'),
        account('5340', 'Field force allowances'),
        account('5350', 'Expired and damaged goods'),
      ],
    }),
    catalog: {
      units: [
        ...COMMON_UNITS,
        unit('strip', 'Strip', 'count', null),
        unit('bottle', 'Bottle', 'count', null),
        unit('vial', 'Vial', 'count', null),
        unit('ampoule', 'Ampoule', 'count', null),
        unit('tube', 'Tube', 'count', null),
        unit('sachet', 'Sachet', 'count', null),
      ],
      categories: [
        category('Finished products', [
          'Tablets',
          'Capsules',
          'Syrups and suspensions',
          'Injections',
          'Creams and ointments',
        ]),
        category('Raw materials', ['Active ingredients (API)', 'Excipients']),
        category('Packing materials', ['Foil and blister', 'Bottles and caps', 'Inner cartons']),
      ],
      customFields: [
        { key: 'generic_name', label: 'Generic name', type: 'text', required: true },
        { key: 'strength', label: 'Strength', type: 'text' },
        {
          key: 'dosage_form',
          label: 'Dosage form',
          type: 'select',
          options: ['Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Cream', 'Drops'],
        },
        { key: 'dar_number', label: 'DAR number', type: 'text' },
      ],
    },
  },
  distribution: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Depot manager',
        description: 'Stock and deliveries at a depot',
        permissions: ['core.branch.manage', 'inventory.product.manage'],
      },
      {
        name: 'Sales officer',
        description: 'Orders and collections from retailers',
        permissions: [],
      },
    ],
    chart: standardChart({
      stock: TRADER_STOCK,
      currentAssets: [account('1180', 'Claims receivable from principals')],
      revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Trade discounts')],
      otherIncome: [account('4230', 'Commission and incentives from principals')],
      costOfSales: [COGS],
      selling: [
        account('5330', 'Damaged and expired goods'),
        account('5340', 'Sales team allowances'),
      ],
    }),
    catalog: {
      units: [
        ...COMMON_UNITS,
        unit('case', 'Case', 'count', null),
        unit('pack', 'Pack', 'count', null),
        unit('bag', 'Bag', 'count', null),
        unit('bottle', 'Bottle', 'count', null),
      ],
      categories: [
        category('Beverages'),
        category('Snacks and biscuits'),
        category('Personal care'),
        category('Home care'),
        category('Dairy and baby food'),
      ],
      customFields: [
        { key: 'principal', label: 'Principal company', type: 'text' },
        { key: 'brand', label: 'Brand', type: 'text' },
      ],
    },
  },
  manufacturing: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Production manager',
        description: 'Production orders and material use',
        permissions: ['core.user.read', 'inventory.product.manage'],
      },
      STORE_KEEPER,
    ],
    chart: standardChart({
      stock: group('1150', 'Inventories', [
        account('1151', 'Raw materials'),
        account('1152', 'Work in progress'),
        account('1153', 'Finished goods', 'inventory'),
        account('1154', 'Stores and spares'),
      ]),
      revenue: [account('4110', 'Sales', 'sales')],
      costOfSales: [...MAKER_COSTS, account('5140', 'Factory power and fuel')],
    }),
    catalog: {
      units: [
        ...COMMON_UNITS,
        unit('ton', 'Metric ton', 'weight', '1000', 3),
        unit('ft', 'Foot', 'length', '0.3048', 2),
        unit('sqm', 'Square metre', 'area', '1', 2),
        unit('sqft', 'Square foot', 'area', '0.092903', 2),
        unit('drum', 'Drum', 'count', null),
        unit('bag', 'Bag', 'count', null),
      ],
      categories: [
        category('Raw materials'),
        category('Components'),
        category('Finished goods'),
        category('Spare parts'),
        category('Consumables'),
      ],
      customFields: [
        { key: 'specification', label: 'Specification', type: 'text' },
        { key: 'grade', label: 'Grade', type: 'text' },
      ],
    },
  },
  retail: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Shop manager',
        description: 'Runs a shop and its staff',
        permissions: ['core.user.read', 'core.branch.manage', 'inventory.product.manage'],
      },
      { name: 'Cashier', description: 'Sells at the counter', permissions: [] },
    ],
    chart: standardChart({
      stock: TRADER_STOCK,
      currentAssets: [account('1180', 'Card and wallet settlements receivable')],
      revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Sales returns')],
      costOfSales: [COGS],
      selling: [
        account('5330', 'Card and wallet charges'),
        account('5340', 'Shrinkage and damaged goods'),
      ],
    }),
    catalog: {
      units: [
        ...COMMON_UNITS,
        unit('pack', 'Pack', 'count', null),
        unit('bottle', 'Bottle', 'count', null),
        unit('sack', 'Sack', 'count', null),
        unit('tray', 'Tray', 'count', null),
      ],
      categories: [
        category('Groceries', ['Rice', 'Lentils', 'Oil', 'Spices', 'Flour and sugar']),
        category('Fresh', ['Fruits', 'Vegetables', 'Fish and meat', 'Eggs']),
        category('Beverages'),
        category('Snacks'),
        category('Personal care'),
        category('Household'),
      ],
      customFields: [{ key: 'brand', label: 'Brand', type: 'text' }],
    },
  },
  other: {
    roles: [
      ACCOUNTANT,
      {
        name: 'Manager',
        description: 'Runs day-to-day work',
        permissions: ['core.user.read', 'inventory.product.manage'],
      },
    ],
    chart: standardChart({
      stock: TRADER_STOCK,
      revenue: [account('4110', 'Sales', 'sales'), account('4120', 'Service income')],
      costOfSales: [COGS],
    }),
    catalog: {
      units: COMMON_UNITS,
      categories: [category('General')],
      customFields: [],
    },
  },
} satisfies Record<Industry, IndustryTemplate>;
