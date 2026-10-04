import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { INVITE_PATH } from '@omnivo/contracts';

import { restoreSession } from './lib/session';
import { sessionStore } from './lib/session-store';

const rootRoute = createRootRoute({ component: Outlet });

// প্রতিটা পেজ আলাদা chunk (lazyRouteComponent): লগইন পেজ খুলতে ড্যাশবোর্ডের DataTable বা
// সাইডবারের মেনু ডাউনলোড করতে হয় না। বাজেট: প্রথম লোড < 200 KB gz (scripts/check-bundle-size.ts)

// লগইন করা ইউজার /login বা /sign-up-এ এলে সোজা ড্যাশবোর্ডে
async function redirectIfSignedIn(): Promise<void> {
  await restoreSession();
  if (sessionStore.getState().status === 'signed-in') {
    throw redirect({ to: '/' });
  }
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: redirectIfSignedIn,
  component: lazyRouteComponent(() => import('./routes/login'), 'LoginPage'),
});

// ইমেইলের লিংক। লগইন ছাড়াই খোলে, আর লগইন থাকলেও /-এ ফেরায় না (redirectIfSignedIn নেই): অন্য
// অ্যাকাউন্টে বসে থাকা কেউও আমন্ত্রণটা দেখে গ্রহণ করতে পারবে
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: INVITE_PATH,
  component: lazyRouteComponent(() => import('./routes/invite'), 'InvitePage'),
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
  beforeLoad: redirectIfSignedIn,
  component: lazyRouteComponent(() => import('./routes/sign-up'), 'SignUpPage'),
});

// Only someone who can change the settings runs the setup. Others use the app as it is; the
// owner finishes the setup when they sign in next.
function mustRunSetup(): boolean {
  const me = sessionStore.getState().me;
  return me?.tenant.setupStatus === 'pending' && me.permissions.includes('core.settings.manage');
}

// The setup wizard: signed in, but outside the AppShell — until the business type is picked,
// there is nothing else to go to
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  beforeLoad: async () => {
    await restoreSession();
    const { status, me } = sessionStore.getState();
    if (status !== 'signed-in') throw redirect({ to: '/login' });
    if (!me?.permissions.includes('core.settings.manage')) throw redirect({ to: '/' });
  },
  component: lazyRouteComponent(() => import('./routes/onboarding'), 'OnboardingPage'),
});

// pathless layout route: এর নিচের সব পেজ protected, আর সবগুলো AppShell-এর ভেতরে
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async () => {
    await restoreSession();
    if (sessionStore.getState().status !== 'signed-in') {
      throw redirect({ to: '/login' });
    }
    // A new workspace goes through the wizard first — right after sign-up, and on any later
    // visit until a business type is picked
    if (mustRunSetup()) throw redirect({ to: '/onboarding' });
  },
  // layout-ও lazy: সাইডবারের Radix মেনু (~৩০ KB gz) লগইনের আগে লাগে না
  component: lazyRouteComponent(() => import('./routes/app-shell'), 'AppShell'),
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: lazyRouteComponent(() => import('./routes/dashboard'), 'DashboardPage'),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: lazyRouteComponent(() => import('./routes/settings'), 'SettingsPage'),
});

const numberingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/numbering',
  component: lazyRouteComponent(() => import('./routes/numbering'), 'NumberingPage'),
});

const branchesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/branches',
  component: lazyRouteComponent(() => import('./routes/branches'), 'BranchesPage'),
});

const accountsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/accounts',
  component: lazyRouteComponent(() => import('./routes/accounts'), 'AccountsPage'),
});

const journalRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/journal',
  component: lazyRouteComponent(() => import('./routes/journal'), 'JournalPage'),
});

// '/journal/new' beats '/journal/$entryId': TanStack ranks a fixed segment above a parameter.
// Both pages live in one file and one chunk.
const newJournalEntryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/journal/new',
  component: lazyRouteComponent(() => import('./routes/journal-entry'), 'NewJournalEntryPage'),
});

const journalEntryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/journal/$entryId',
  component: lazyRouteComponent(() => import('./routes/journal-entry'), 'JournalEntryPage'),
});

// ?account=<id>: an entry's line links straight to its account's ledger, and the address can be
// bookmarked. ?from=&to=: a report's account opens with the report's own dates (step 11).
// Anything else in the query string is dropped, and a date that is not a date is not trusted.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ledgerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/ledger',
  validateSearch: (
    search: Record<string, unknown>,
  ): { account?: string; from?: string; to?: string } => ({
    ...(typeof search.account === 'string' && { account: search.account }),
    ...(typeof search.from === 'string' && ISO_DATE.test(search.from) && { from: search.from }),
    ...(typeof search.to === 'string' && ISO_DATE.test(search.to) && { to: search.to }),
  }),
  component: lazyRouteComponent(() => import('./routes/ledger'), 'LedgerPage'),
});

const openingBalancesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/opening-balances',
  component: lazyRouteComponent(() => import('./routes/opening-balances'), 'OpeningBalancesPage'),
});

const yearEndRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/year-end',
  component: lazyRouteComponent(() => import('./routes/year-end'), 'YearEndPage'),
});

const trialBalanceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports/trial-balance',
  component: lazyRouteComponent(() => import('./routes/trial-balance'), 'TrialBalancePage'),
});

const profitAndLossRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports/profit-and-loss',
  component: lazyRouteComponent(() => import('./routes/profit-and-loss'), 'ProfitAndLossPage'),
});

const balanceSheetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports/balance-sheet',
  component: lazyRouteComponent(() => import('./routes/balance-sheet'), 'BalanceSheetPage'),
});

const reportExportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports/exports',
  component: lazyRouteComponent(() => import('./routes/report-exports'), 'ReportExportsPage'),
});

// Products (step 12). '/products/new', '/products/categories', '/products/units' and
// '/products/imports' beat '/products/$productId': a fixed segment ranks above a parameter.
const productsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products',
  component: lazyRouteComponent(() => import('./routes/products'), 'ProductsPage'),
});

const newProductRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/new',
  component: lazyRouteComponent(() => import('./routes/product'), 'NewProductPage'),
});

const productRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/$productId',
  component: lazyRouteComponent(() => import('./routes/product'), 'ProductPage'),
});

const productCategoriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/categories',
  component: lazyRouteComponent(
    () => import('./routes/product-categories'),
    'ProductCategoriesPage',
  ),
});

const unitsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/units',
  component: lazyRouteComponent(() => import('./routes/units'), 'UnitsPage'),
});

const productImportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/imports',
  component: lazyRouteComponent(() => import('./routes/product-imports'), 'ProductImportsPage'),
});

const customFieldsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/custom-fields',
  component: lazyRouteComponent(() => import('./routes/custom-fields'), 'CustomFieldsPage'),
});

const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/team',
  component: lazyRouteComponent(() => import('./routes/team'), 'TeamPage'),
});

const rolesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/roles',
  component: lazyRouteComponent(() => import('./routes/roles'), 'RolesPage'),
});

const auditLogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/audit-log',
  component: lazyRouteComponent(() => import('./routes/audit-log'), 'AuditLogPage'),
});

// শুধু `pnpm dev`-এ। production build-এ Vite import.meta.env.DEV-কে false বসায়, minifier পুরো
// শাখা মুছে দেয় — import() হারায়, তাই kitchen-sink-এর chunk তৈরিই হয় না
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => appRoute,
        path: '/kitchen-sink',
        component: lazyRouteComponent(() => import('./routes/kitchen-sink'), 'KitchenSinkPage'),
      }),
    ]
  : [];

const routeTree = rootRoute.addChildren([
  loginRoute,
  signUpRoute,
  inviteRoute,
  onboardingRoute,
  appRoute.addChildren([
    dashboardRoute,
    settingsRoute,
    numberingRoute,
    branchesRoute,
    accountsRoute,
    journalRoute,
    newJournalEntryRoute,
    journalEntryRoute,
    ledgerRoute,
    openingBalancesRoute,
    yearEndRoute,
    trialBalanceRoute,
    profitAndLossRoute,
    balanceSheetRoute,
    reportExportsRoute,
    productsRoute,
    newProductRoute,
    productRoute,
    productCategoriesRoute,
    unitsRoute,
    productImportsRoute,
    customFieldsRoute,
    teamRoute,
    rolesRoute,
    auditLogRoute,
    ...devRoutes,
  ]),
]);

export const router = createRouter({ routeTree });

// <Link to="…"> আর navigate({ to }) এখন route tree থেকে টাইপ পায় — ভুল path compile error
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
