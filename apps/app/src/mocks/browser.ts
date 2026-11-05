import { setupWorker } from 'msw/browser';

import { handlers } from './handlers';

// ব্রাউজারের service worker (public/mockServiceWorker.js) request গুলো মাঝপথে ধরে handler-এর
// উত্তর দেয় — app-এর কোড ভাবে আসল API-র সাথেই কথা বলছে, fetch-এ কিছু বদলাতে হয় না
export const worker = setupWorker(...handlers);
