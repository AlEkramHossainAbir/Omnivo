import { defineConfig, devices } from '@playwright/test';

// Step 19a: the service worker on a production build (pwa-build.ts builds it, pwa-server.ts
// serves it). Its own port: `pnpm test:e2e` (4173) can run at the same time.
const PORT = 4174;

export default defineConfig({
  testDir: '.',
  testMatch: '*.pwa.ts',
  globalSetup: './pwa-build.ts',
  // One test at a time: each starts and stops the server on the same port, and the update test
  // changes the built sw.js
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    trace: 'retain-on-failure',
  },
  // Chromium only: the worker's code is the same on a phone, and Playwright's offline mode and
  // service worker support are Chromium's
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
