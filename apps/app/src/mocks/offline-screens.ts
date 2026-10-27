// Step 19a: mock mode has no service worker of ours (MSW's worker needs the same scope, decision
// 11), so a chunk the browser never loaded cannot load offline there. The Playwright tests run in
// this mode and go offline (context.setOffline), so the code of every screen that works without a
// connection is fetched in the background at start, as the app did in every mode in step 18b. A
// production build has the service worker instead, which keeps every chunk.
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
  // The Sync page, the question before signing out with changes on the device, and the sign-in
  // page that signing out offline ends on
  () => import('../routes/sync'),
  () => import('../components/sign-out-dialog'),
  () => import('../routes/login'),
  // Step 19b: "Lock now" offline closes the shell, and the lock screen takes its place; the PIN
  // dialog (a change with the current PIN works offline)
  () => import('../components/lock-screen'),
  () => import('../components/pin-dialog'),
];

// Once, by main.tsx's enableMocking. The dev server is on this computer, so it does not fail.
export function preloadOfflineScreens(): void {
  void Promise.all(SCREENS.map((load) => load())).catch(() => undefined);
}
