import { loadCalendar } from '@omnivo/ui';

// Step 18b (decision 42): the code of every screen that works without a connection, fetched in
// the background while there is one. Each page is a chunk of its own, loaded the first time it
// opens. Until step 19's service worker keeps them, a chunk the browser never loaded cannot load
// offline: someone who opened the app at the office and lost the connection before ever opening
// "Add customer" would get an error page instead of the form. Each import() here is the same one
// the router or the form makes later, so the screen then finds its module already loaded.
const SCREENS = [
  // The lists read from the device (18a)
  () => import('../routes/products'),
  () => import('../routes/customers'),
  // A customer saved on the device
  () => import('../routes/customer-edit'),
  () => import('../components/customer-form'),
  // A draft order saved on the device, with its lines, the customer box and the date boxes
  () => import('../routes/sales-orders'),
  () => import('../routes/sales-order'),
  () => import('../components/sales-order-form'),
  () => import('../components/sales-line-editor'),
  () => import('../components/customer-picker'),
  () => import('../components/date-input'),
  loadCalendar,
  // The Sync page, the question before signing out with changes on the device, and the sign-in
  // page that signing out offline ends on
  () => import('../routes/sync'),
  () => import('../components/sign-out-dialog'),
  () => import('../routes/login'),
];

let loading: Promise<unknown> | null = null;

// Once per page load. A load that failed (the connection dropped half way) is tried again the
// next time it is called: the host calls it again when the browser is back online.
export function preloadOfflineScreens(): void {
  if (loading) return;
  loading = Promise.all(SCREENS.map((load) => load())).catch(() => {
    loading = null;
  });
}
