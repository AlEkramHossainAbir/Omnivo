import './styles.css';
// প্রথম render-এর আগে i18n init — নাহলে প্রথম ঝলকে key ("nav.overview") দেখা যেত
import '@omnivo/i18n';

import { Toaster } from '@omnivo/ui';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { router } from './router';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
    {/* রুটের বাইরে: পেজ বদলালেও চলতি toast মুছে যায় না */}
    <Toaster />
  </StrictMode>,
);
