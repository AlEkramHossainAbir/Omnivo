import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';

import { restoreSession } from './lib/session';
import { sessionStore } from './lib/session-store';
import { AppShell } from './routes/app-shell';
import { DashboardPage } from './routes/dashboard';
import { LoginPage } from './routes/login';
import { SignUpPage } from './routes/sign-up';

const rootRoute = createRootRoute({ component: Outlet });

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
  component: LoginPage,
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
  beforeLoad: redirectIfSignedIn,
  component: SignUpPage,
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
  },
  component: AppShell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: DashboardPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signUpRoute,
  appRoute.addChildren([dashboardRoute]),
]);

export const router = createRouter({ routeTree });

// <Link to="…"> আর navigate({ to }) এখন route tree থেকে টাইপ পায় — ভুল path compile error
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
