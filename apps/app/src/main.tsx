import './styles.css';
// প্রথম render-এর আগে i18n init — নাহলে প্রথম ঝলকে key ("nav.overview") দেখা যেত
import { languageReady } from '@omnivo/i18n';

import { Toaster } from '@omnivo/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { API_URL } from './lib/api';
import { queryClient } from './lib/query-client';
import { router } from './router';

// `pnpm dev:mock` (vite --mode mock): আসল API ছাড়াই, MSW-এর বানানো উত্তরে পুরো UI।
// production build-এ DEV = false বসে, minifier পুরো শাখা আর import() মুছে দেয় — msw bundle-এ যায় না
async function enableMocking(): Promise<void> {
  if (!import.meta.env.DEV || import.meta.env.MODE !== 'mock') return;
  const { worker } = await import('./mocks/browser');
  await worker.start({
    // API-র যে request-এর mock নেই সেটা console-এ error; font, Vite-এর HMR ইত্যাদি চুপচাপ যেতে দেওয়া
    onUnhandledRequest(request, print) {
      if (request.url.startsWith(API_URL)) print.error();
    },
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root is missing from index.html');
}

// worker চালু হওয়ার পরে render — নাহলে প্রথম request (session ফেরানো) mock-এর আগেই বেরিয়ে যেত.
// And after this device's language has arrived (Bangla is its own chunk since step 13).
void Promise.all([enableMocking(), languageReady]).then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
      {/* রুটের বাইরে: পেজ বদলালেও চলতি toast মুছে যায় না */}
      <Toaster />
    </StrictMode>,
  );
});
