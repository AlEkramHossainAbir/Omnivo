import { defineConfig, devices } from '@playwright/test';

// আলাদা port: `pnpm dev` (5173) চালু থাকলেও e2e নিজের সার্ভার তোলে, একে অন্যের পথে পড়ে না
const PORT = 4173;

export default defineConfig({
  testDir: '.',
  // *.e2e.ts, *.spec.ts না: vitest-এর ডিফল্ট pattern *.spec.ts ধরে — নাম আলাদা না হলে `pnpm test`
  // Playwright-এর ফাইল চালাতে গিয়ে ভাঙত
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  // CI-তে ভুলে থাকা test.only পুরো স্যুট চুপচাপ ছোট করে দিত
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    // fail করলে পুরো রেকর্ড (DOM, network, screenshot) — `pnpm exec playwright show-trace` দিয়ে দেখা
    trace: 'retain-on-failure',
  },
  // CLAUDE.md-এর দুই আকার: ডেস্কটপ আর ৩৯০px ফোন (৮৬০px-এর নিচে টেবিল কার্ড হয়ে যায়)
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  // MSW-এর mock API-র উপর অ্যাপ (`pnpm dev:mock`-এর মতো) — API, Postgres বা Docker লাগে না, তাই CI-র
  // সাধারণ runner-এ চলে। আসল API-র সাথে flow integration টেস্টে পাহারা দেওয়া
  webServer: {
    command: `pnpm exec vite --mode mock --port ${String(PORT)} --strictPort`,
    cwd: '..',
    url: `http://localhost:${String(PORT)}`,
    reuseExistingServer: !process.env.CI,
  },
});
