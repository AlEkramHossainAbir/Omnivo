import {
  ArrowDataTransferHorizontalIcon,
  BalanceScaleIcon,
  BankIcon,
  Book02Icon,
  BookOpen02Icon,
  CalendarClockIcon,
  CalendarLock01Icon,
  Cashier02Icon,
  CashierIcon,
  ChartIncreaseIcon,
  ChartLineData01Icon,
  CheckmarkBadge01Icon,
  Coins01Icon,
  ComputerPhoneSyncIcon,
  CouponPercentIcon,
  DashboardSquare01Icon,
  DeliveryReturn01Icon,
  DeliveryTruck01Icon,
  Factory01Icon,
  FileDownloadIcon,
  FileImportIcon,
  Files01Icon,
  FolderLibraryIcon,
  FolderTreeIcon,
  HourglassIcon,
  Invoice01Icon,
  Invoice03Icon,
  Invoice04Icon,
  Layers01Icon,
  LayoutGridIcon,
  LeftToRightListNumberIcon,
  MoneyExchange01Icon,
  MoneyExchange03Icon,
  MoneyReceive02Icon,
  MoneyReceiveCircleIcon,
  MoneySend02Icon,
  Note01Icon,
  Notebook02Icon,
  NoteRemoveIcon,
  PackageIcon,
  PackageMovingIcon,
  PackageOutOfStockIcon,
  PackageReceiveIcon,
  PackageRemoveIcon,
  PaintBoardIcon,
  Payment02Icon,
  PieChartIcon,
  ReceiptDollarIcon,
  ReturnRequestIcon,
  RulerIcon,
  SecurityCheckIcon,
  Settings02Icon,
  ShippingTruck01Icon,
  ShoppingBag01Icon,
  ShoppingBasket01Icon,
  ShoppingCart01Icon,
  Store01Icon,
  Store04Icon,
  TableIcon,
  Tag01Icon,
  TaskAdd01Icon,
  TaskEdit01Icon,
  TaxesIcon,
  TextIcon,
  Time04Icon,
  TimeQuarterPassIcon,
  TruckReturnIcon,
  UserCheck01Icon,
  UserGroup02Icon,
  UserGroup03Icon,
  UserGroupIcon,
  UserMultiple02Icon,
  UserTime01Icon,
  WarehouseIcon,
  WebDesign01Icon,
  WorkHistoryIcon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import type { PermissionKey } from '@omnivo/contracts';
import type { Messages } from '@omnivo/i18n';

// Step 29: the navigation as data, in one place (CLAUDE.md → Module rail, Module menu). Before
// this step the shell drew 78 links as JSX, every group open at once, so a cashier scrolled past
// thirty links to reach the counter. Now the rail holds the eight modules and the menu holds only
// the open one's links.
//
// Why data and not JSX per module: the three rules that used to be written by hand at every group
// — a link shows by its permission, a section shows when any of its links does, a module shows
// when any of its sections does — are now one function each, and `moduleOf` can answer "which
// module is this page in?" from the same table the menu is drawn from. A new page is one line.

type Can = (permission: PermissionKey) => boolean;

// Only the keys of nav whose value is a string: `nav.modules` and `nav.sections` are objects, so
// they cannot be a link's label by mistake
type StringKeys<T> = { [K in keyof T]-?: T[K] extends string ? K : never }[keyof T];

type NavKey = `nav.${StringKeys<Messages['nav']>}`;
type SectionKey = `nav.sections.${StringKeys<Messages['nav']['sections']>}`;
type ModuleKey = `nav.modules.${StringKeys<Messages['nav']['modules']>}`;

export type ModuleId =
  'home' | 'sell' | 'buy' | 'stock' | 'accounts' | 'shop' | 'reports' | 'setup';

// The counts polled by the shell. A module with one shows a crit dot on its rail item
export type NavBadge = 'approvals' | 'shopOrders';

interface NavLeaf {
  // `to` is declared as a plain string here so that the type of NAV_MODULES stays free of the
  // router's types; `as const` below keeps every path a literal, so <NavLink to={leaf.to}> is
  // still checked against the route tree and a path that does not exist is a compile error
  readonly to: string;
  readonly labelKey: NavKey;
  readonly icon: IconSvgElement;
  // The route has children (`/products` → `/products/categories`), so the link is active on its
  // own page only
  readonly exact?: boolean;
  // Opens without the shell (the POS screen), so it is never a module's landing page
  readonly bare?: boolean;
  readonly dev?: boolean;
  readonly badge?: NavBadge;
  // Hidden in the menu is only a convenience — the API's PermissionGuard is the real guard. What
  // would answer 403 is not shown: a dead link is worse than no link
  readonly show?: (can: Can) => boolean;
}

interface NavSection {
  // A module of five links or fewer has no section label (CLAUDE.md → Module menu)
  readonly labelKey?: SectionKey;
  readonly items: readonly NavLeaf[];
}

interface NavModule {
  readonly id: ModuleId;
  readonly labelKey: ModuleKey;
  readonly icon: IconSvgElement;
  // Where the rail item goes. It must be one of this module's own links, and never a `bare` one
  readonly landing: string;
  readonly sections: readonly NavSection[];
}

// Everyone reads the chart of accounts (every entry form picks accounts from it); the books
// themselves — salaries, margins — need the read permission
const books = (can: Can): boolean => can('accounting.journal.read');

// Step 21b: Exports lists the kinds of report the person may read, so it shows whenever any
// report does
const anyReport = (can: Can): boolean =>
  can('accounting.report.read') ||
  can('sales.report.read') ||
  can('purchase.report.read') ||
  can('inventory.report.read');

export const NAV_MODULES = [
  {
    id: 'home',
    labelKey: 'nav.modules.home',
    icon: DashboardSquare01Icon,
    landing: '/',
    sections: [
      {
        items: [
          // exact: without it "/" is every route's ancestor, so Overview looked active everywhere
          { to: '/', labelKey: 'nav.overview', icon: DashboardSquare01Icon, exact: true },
          { to: '/kitchen-sink', labelKey: 'nav.kitchenSink', icon: LayoutGridIcon, dev: true },
        ],
      },
    ],
  },
  {
    id: 'sell',
    labelKey: 'nav.modules.sell',
    icon: ShoppingCart01Icon,
    // Not /pos: the counter screen opens without the shell, so it can never be a landing page
    landing: '/sales-orders',
    sections: [
      {
        labelKey: 'nav.sections.counter',
        items: [
          {
            to: '/pos',
            labelKey: 'nav.pointOfSale',
            icon: CashierIcon,
            bare: true,
            show: (can) => can('pos.sale.create'),
          },
          { to: '/pos/sales', labelKey: 'nav.posSales', icon: ReceiptDollarIcon },
          { to: '/pos/returns', labelKey: 'nav.posReturns', icon: ReturnRequestIcon },
          // Step 20b (decision 26): the shifts show how short a drawer was, so they are only for
          // the people who look after the counters
          {
            to: '/pos/shifts',
            labelKey: 'nav.posShifts',
            icon: UserTime01Icon,
            show: (can) => can('pos.shift.manage'),
          },
        ],
      },
      {
        labelKey: 'nav.sections.orders',
        items: [
          { to: '/quotations', labelKey: 'nav.quotations', icon: Note01Icon },
          { to: '/sales-orders', labelKey: 'nav.salesOrders', icon: ShoppingCart01Icon },
          { to: '/deliveries', labelKey: 'nav.deliveries', icon: DeliveryTruck01Icon },
        ],
      },
      {
        labelKey: 'nav.sections.moneyIn',
        items: [
          { to: '/invoices', labelKey: 'nav.invoices', icon: Invoice03Icon },
          { to: '/receipts', labelKey: 'nav.receipts', icon: MoneyReceive02Icon },
        ],
      },
      {
        labelKey: 'nav.sections.comesBack',
        items: [
          { to: '/sales-returns', labelKey: 'nav.salesReturns', icon: DeliveryReturn01Icon },
          { to: '/credit-notes', labelKey: 'nav.creditNotes', icon: Invoice04Icon },
          { to: '/refunds', labelKey: 'nav.refunds', icon: MoneySend02Icon },
        ],
      },
      {
        labelKey: 'nav.sections.customers',
        items: [
          { to: '/customers', labelKey: 'nav.customers', icon: UserMultiple02Icon },
          { to: '/customer-groups', labelKey: 'nav.customerGroups', icon: UserGroup03Icon },
          { to: '/price-lists', labelKey: 'nav.priceLists', icon: Tag01Icon },
        ],
      },
    ],
  },
  {
    id: 'buy',
    labelKey: 'nav.modules.buy',
    icon: ShoppingBasket01Icon,
    landing: '/purchase-orders',
    sections: [
      {
        labelKey: 'nav.sections.ordering',
        items: [
          { to: '/requisitions', labelKey: 'nav.requisitions', icon: TaskAdd01Icon },
          { to: '/purchase-orders', labelKey: 'nav.purchaseOrders', icon: ShoppingBasket01Icon },
          { to: '/goods-receipts', labelKey: 'nav.goodsReceipts', icon: PackageReceiveIcon },
        ],
      },
      {
        labelKey: 'nav.sections.moneyOut',
        items: [
          // Step 17c: not the sales invoice's and receipt's icons — a person scanning for the
          // customer's money must not land here
          { to: '/bills', labelKey: 'nav.bills', icon: Invoice01Icon },
          { to: '/supplier-payments', labelKey: 'nav.supplierPayments', icon: Payment02Icon },
        ],
      },
      {
        labelKey: 'nav.sections.goesBack',
        items: [
          { to: '/purchase-returns', labelKey: 'nav.purchaseReturns', icon: TruckReturnIcon },
          { to: '/debit-notes', labelKey: 'nav.debitNotes', icon: NoteRemoveIcon },
          {
            to: '/supplier-refunds',
            labelKey: 'nav.supplierRefunds',
            icon: MoneyReceiveCircleIcon,
          },
        ],
      },
      {
        labelKey: 'nav.sections.approvals',
        items: [
          // "Waiting for me": anyone may hold a level's role, so it is there for everyone, with a
          // crit count while something waits
          {
            to: '/approvals',
            labelKey: 'nav.approvals',
            icon: CheckmarkBadge01Icon,
            badge: 'approvals',
          },
          { to: '/suppliers', labelKey: 'nav.suppliers', icon: Factory01Icon },
          { to: '/supplier-groups', labelKey: 'nav.supplierGroups', icon: UserGroup02Icon },
        ],
      },
    ],
  },
  {
    id: 'stock',
    labelKey: 'nav.modules.stock',
    icon: PackageIcon,
    landing: '/stock',
    sections: [
      {
        labelKey: 'nav.sections.products',
        items: [
          // Everyone reads products (every sales and stock line picks one); imports change them
          { to: '/products', labelKey: 'nav.products', icon: PackageIcon, exact: true },
          { to: '/products/categories', labelKey: 'nav.categories', icon: FolderTreeIcon },
          { to: '/products/units', labelKey: 'nav.units', icon: RulerIcon },
          {
            to: '/products/imports',
            labelKey: 'nav.productImports',
            icon: FileImportIcon,
            show: (can) => can('inventory.product.manage'),
          },
        ],
      },
      {
        labelKey: 'nav.sections.stockLevels',
        items: [
          // Everyone reads the stock — a sales officer checks it before promising a delivery.
          // Adjusting and moving it is checked on the pages and by the API
          { to: '/stock', labelKey: 'nav.stockOnHand', icon: Layers01Icon, exact: true },
          { to: '/stock/adjustments', labelKey: 'nav.adjustments', icon: TaskEdit01Icon },
          {
            to: '/stock/transfers',
            labelKey: 'nav.transfers',
            icon: ArrowDataTransferHorizontalIcon,
          },
          { to: '/stock/batches', labelKey: 'nav.expiry', icon: HourglassIcon },
          { to: '/stock/sold-short', labelKey: 'nav.soldShort', icon: PackageRemoveIcon },
          { to: '/stock/reorder', labelKey: 'nav.reorder', icon: PackageOutOfStockIcon },
          // Step 14: what it costs — only for the people who may see it
          {
            to: '/stock/valuation',
            labelKey: 'nav.valuation',
            icon: Coins01Icon,
            show: (can) => can('inventory.stock.value'),
          },
          {
            to: '/stock/revaluations',
            labelKey: 'nav.revaluations',
            icon: MoneyExchange01Icon,
            show: (can) => can('inventory.stock.revalue'),
          },
        ],
      },
      {
        labelKey: 'nav.sections.places',
        items: [{ to: '/warehouses', labelKey: 'nav.warehouses', icon: WarehouseIcon }],
      },
    ],
  },
  {
    id: 'accounts',
    labelKey: 'nav.modules.accounts',
    icon: BookOpen02Icon,
    landing: '/accounts',
    sections: [
      {
        items: [
          { to: '/accounts', labelKey: 'nav.chartOfAccounts', icon: BookOpen02Icon },
          { to: '/journal', labelKey: 'nav.journal', icon: Notebook02Icon, show: books },
          { to: '/ledger', labelKey: 'nav.ledger', icon: Book02Icon, show: books },
          {
            to: '/opening-balances',
            labelKey: 'nav.openingBalances',
            icon: BalanceScaleIcon,
            show: books,
          },
          { to: '/year-end', labelKey: 'nav.yearEnd', icon: CalendarLock01Icon, show: books },
        ],
      },
    ],
  },
  {
    id: 'shop',
    labelKey: 'nav.modules.shop',
    icon: Store04Icon,
    landing: '/storefront/orders',
    sections: [
      {
        labelKey: 'nav.sections.ordersAndMoney',
        items: [
          // Decision 34: the page the shop's staff open every day. The count is the orders that
          // wait to be packed, crit like the approvals count: work to do
          {
            to: '/storefront/orders',
            labelKey: 'nav.storefrontOrders',
            icon: ShoppingBag01Icon,
            badge: 'shopOrders',
            show: (can) => can('storefront.order.read'),
          },
          // Step 28c (decision 13): the money those accounts hold. The icon is Bank, not Money
          // receipts' MoneyReceive02 (P1): an accountant sees both
          {
            to: '/storefront/payouts',
            labelKey: 'nav.storefrontPayouts',
            icon: BankIcon,
            show: (can) => can('storefront.payout.manage'),
          },
        ],
      },
      {
        labelKey: 'nav.sections.catalog',
        items: [
          {
            to: '/storefront/listings',
            labelKey: 'nav.storefrontCatalog',
            icon: Store04Icon,
            show: (can) => can('storefront.manage'),
          },
          {
            to: '/storefront/coupons',
            labelKey: 'nav.storefrontCoupons',
            icon: CouponPercentIcon,
            show: (can) => can('storefront.manage'),
          },
          {
            to: '/storefront/categories',
            labelKey: 'nav.storefrontCategories',
            icon: FolderLibraryIcon,
            show: (can) => can('storefront.manage'),
          },
        ],
      },
      {
        labelKey: 'nav.sections.look',
        items: [
          {
            to: '/storefront/appearance',
            labelKey: 'nav.storefrontAppearance',
            icon: PaintBoardIcon,
            show: (can) => can('storefront.manage'),
          },
          {
            to: '/storefront/pages',
            labelKey: 'nav.storefrontPages',
            icon: Files01Icon,
            show: (can) => can('storefront.manage'),
          },
        ],
      },
      {
        labelKey: 'nav.sections.shopSetup',
        items: [
          {
            to: '/storefront/settings',
            labelKey: 'nav.storefrontSettings',
            icon: WebDesign01Icon,
            show: (can) => can('storefront.manage'),
          },
          {
            to: '/storefront/couriers',
            labelKey: 'nav.storefrontCouriers',
            icon: ShippingTruck01Icon,
            show: (can) => can('storefront.manage'),
          },
        ],
      },
    ],
  },
  {
    id: 'reports',
    labelKey: 'nav.modules.reports',
    icon: ChartLineData01Icon,
    landing: '/reports/trial-balance',
    sections: [
      {
        labelKey: 'nav.sections.books',
        items: [
          // The statements: for anyone with the report permission, journal or not (a director)
          {
            to: '/reports/trial-balance',
            labelKey: 'nav.trialBalance',
            icon: TableIcon,
            show: (can) => can('accounting.report.read'),
          },
          {
            to: '/reports/profit-and-loss',
            labelKey: 'nav.profitAndLoss',
            icon: ChartIncreaseIcon,
            show: (can) => can('accounting.report.read'),
          },
          {
            to: '/reports/balance-sheet',
            labelKey: 'nav.balanceSheet',
            icon: PieChartIcon,
            show: (can) => can('accounting.report.read'),
          },
          // Step 21c: VAT belongs to the accounts (decision 11)
          {
            to: '/reports/vat',
            labelKey: 'nav.vatReport',
            icon: TaxesIcon,
            show: (can) => can('accounting.report.read'),
          },
        ],
      },
      {
        labelKey: 'nav.sections.trade',
        items: [
          {
            to: '/reports/sales',
            labelKey: 'nav.salesReport',
            icon: ChartLineData01Icon,
            show: (can) => can('sales.report.read'),
          },
          {
            to: '/reports/ar-aging',
            labelKey: 'nav.arAging',
            icon: TimeQuarterPassIcon,
            show: (can) => can('sales.report.read'),
          },
          {
            to: '/reports/purchases',
            labelKey: 'nav.purchaseReport',
            icon: ShoppingBag01Icon,
            show: (can) => can('purchase.report.read'),
          },
          {
            to: '/reports/ap-aging',
            labelKey: 'nav.apAging',
            icon: Time04Icon,
            show: (can) => can('purchase.report.read'),
          },
        ],
      },
      {
        labelKey: 'nav.sections.stockReports',
        items: [
          {
            to: '/reports/stock-movement',
            labelKey: 'nav.stockMovement',
            icon: PackageMovingIcon,
            show: (can) => can('inventory.report.read'),
          },
        ],
      },
      {
        labelKey: 'nav.sections.files',
        items: [
          {
            to: '/reports/exports',
            labelKey: 'nav.exports',
            icon: FileDownloadIcon,
            show: anyReport,
          },
          // Step 21c: the scheduled emails, for the people who may make them
          {
            to: '/reports/schedules',
            labelKey: 'nav.reportSchedules',
            icon: CalendarClockIcon,
            show: (can) => can('core.report.schedule'),
          },
        ],
      },
    ],
  },
  {
    id: 'setup',
    labelKey: 'nav.modules.setup',
    icon: Settings02Icon,
    landing: '/settings',
    sections: [
      {
        labelKey: 'nav.sections.people',
        items: [
          {
            to: '/team',
            labelKey: 'nav.team',
            icon: UserGroupIcon,
            show: (can) => can('core.user.read') || can('core.user.invite'),
          },
          {
            to: '/roles',
            labelKey: 'nav.roles',
            icon: SecurityCheckIcon,
            show: (can) => can('core.user.read') || can('core.role.manage'),
          },
          // Step 17a: a workspace setting, next to the roles its levels name
          {
            to: '/approval-rules',
            labelKey: 'nav.approvalRules',
            icon: UserCheck01Icon,
            show: (can) => can('core.settings.manage'),
          },
        ],
      },
      {
        labelKey: 'nav.sections.counterSetup',
        items: [
          // Step 20a: everyone reads the registers (read-only without pos.register.manage), and
          // the cash reasons next to them (decision 67)
          { to: '/pos/registers', labelKey: 'nav.registers', icon: Cashier02Icon },
          { to: '/pos/cash-reasons', labelKey: 'nav.cashReasons', icon: MoneyExchange03Icon },
        ],
      },
      {
        labelKey: 'nav.sections.workspace',
        items: [
          { to: '/custom-fields', labelKey: 'nav.customFields', icon: TextIcon },
          { to: '/branches', labelKey: 'nav.branches', icon: Store01Icon },
          // Step 18c (decision 22): after the branches the devices are in, for the people who may
          // see them all
          {
            to: '/devices',
            labelKey: 'nav.devices',
            icon: ComputerPhoneSyncIcon,
            show: (can) => can('core.device.manage'),
          },
          {
            to: '/numbering',
            labelKey: 'nav.numbering',
            icon: LeftToRightListNumberIcon,
            show: (can) => can('core.settings.manage'),
          },
          {
            to: '/audit-log',
            labelKey: 'nav.auditLog',
            icon: WorkHistoryIcon,
            show: (can) => can('core.audit.read'),
          },
          { to: '/settings', labelKey: 'nav.settings', icon: Settings02Icon },
        ],
      },
    ],
  },
] as const satisfies readonly NavModule[];

export type NavModuleItem = (typeof NAV_MODULES)[number];
export type NavLeafItem = NavModuleItem['sections'][number]['items'][number];
// Every path the navigation can point at, as a union of literals, so a rail item's `to` is
// checked against the route tree like a hand-written one
export type NavTo = NavLeafItem['to'];

// `dev` is read from the bundle, not from the session: the kitchen sink is not built into
// production at all
const DEV = import.meta.env.DEV;

export function leafVisible(leaf: NavLeaf, can: Can): boolean {
  if (leaf.dev === true && !DEV) return false;
  return leaf.show?.(can) ?? true;
}

// `as const` above keeps every path a literal, which also means a leaf written without `badge` or
// `exact` has no such property in its type. These three read them through the wide NavLeaf and
// NavSection types, so the menu can ask every leaf the same question
export function leafBadge(leaf: NavLeaf): NavBadge | undefined {
  return leaf.badge;
}

export function leafExact(leaf: NavLeaf): boolean {
  return leaf.exact === true;
}

export function leafBare(leaf: NavLeaf): boolean {
  return leaf.bare === true;
}

export function sectionLabel(section: NavSection): SectionKey | undefined {
  return section.labelKey;
}

// How much work waits in a module: the counts of its visible links with a badge. The rail turns
// it into one crit dot and says the number in the item's accessible name
export function waitingIn(
  module: NavModule,
  can: Can,
  counts: Readonly<Record<NavBadge, number>>,
): number {
  let total = 0;
  for (const section of module.sections) {
    for (const leaf of section.items) {
      const badge = leafBadge(leaf);
      if (badge && leafVisible(leaf, can)) total += counts[badge];
    }
  }
  return total;
}

export function moduleVisible(module: NavModule, can: Can): boolean {
  return module.sections.some((section) => section.items.some((leaf) => leafVisible(leaf, can)));
}

// The rail, in the order of the table. A module whose every link is hidden is left out: a rail
// item that opens a 403 is worse than no item
export function visibleModules(can: Can): readonly NavModuleItem[] {
  return NAV_MODULES.filter((module) => moduleVisible(module, can));
}

export function moduleById(id: ModuleId): NavModuleItem {
  const found = NAV_MODULES.find((module) => module.id === id);
  // The id comes from this table, so this cannot happen; find's type says it can
  if (!found) throw new Error(`Unknown module: ${id}`);
  return found;
}

// Where a rail item goes. The module's own landing page when the person may open it, else its
// first visible link that is not the POS screen (which has no shell)
export function landingFor(module: NavModuleItem, can: Can): NavTo {
  // A loop, not flatMap: `sections` is a union of readonly tuples (one per module), and flatMap
  // infers its element type from the first member of that union, which makes the rest an error
  const leaves: NavLeafItem[] = [];
  for (const section of module.sections) {
    for (const leaf of section.items) leaves.push(leaf);
  }
  const landing = leaves.find((leaf) => leaf.to === module.landing && leafVisible(leaf, can));
  if (landing) return landing.to;
  const first = leaves.find((leaf) => !leafBare(leaf) && leafVisible(leaf, can));
  return first ? first.to : module.landing;
}

// pathname → module, built once from the same table. Longest exact path first, then the longest
// prefix: `/pos/registers` is Setup while `/pos/sales` is Sell, and both start with `/pos`
const EXACT = new Map<string, ModuleId>();
const PREFIXES: { readonly prefix: string; readonly module: ModuleId }[] = [];
for (const module of NAV_MODULES) {
  for (const section of module.sections) {
    for (const leaf of section.items) {
      EXACT.set(leaf.to, module.id);
      // "/" is every path's prefix, and Overview is matched exactly anyway
      if (leaf.to !== '/') PREFIXES.push({ prefix: `${leaf.to}/`, module: module.id });
    }
  }
}
PREFIXES.sort((a, b) => b.prefix.length - a.prefix.length);

/**
 * Which module a page belongs to, or null for a page that belongs to none: the sync page and My
 * devices, which are reached from every module. The rail then marks nothing, because marking Home
 * would say the person is somewhere they are not.
 */
export function moduleOf(pathname: string): ModuleId | null {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const exact = EXACT.get(path);
  if (exact) return exact;
  const prefix = PREFIXES.find((entry) => path.startsWith(entry.prefix));
  return prefix ? prefix.module : null;
}
