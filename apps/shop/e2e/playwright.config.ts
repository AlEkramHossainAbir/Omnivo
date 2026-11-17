import { defineConfig, devices } from '@playwright/test';

// Step 26e: the storefront's own Playwright tests, on the built server (decision 8). Its own port:
// the shop's `pnpm dev` (4321) and the ERP app's tests (4173, 4174) can run at the same time.
const PORT = 4331;

export default defineConfig({
  testDir: '.',
  // *.e2e.ts, like the ERP app: vitest picks up *.spec.ts, and these files are not vitest tests
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  // A test.only left in by mistake would quietly make the CI run small
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    // On a failure, the whole record (DOM, network, screenshots): `pnpm exec playwright show-trace`
    trace: 'retain-on-failure',
  },
  // The two widths the storefront is drawn for (CLAUDE.md → Storefront shape and layout): Figma's
  // 1440px desktop, and a 390px phone, below `md`, where the phone layout applies
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  // The built server, as staging runs it (`node dist/server/entry.mjs`), not `astro dev`: the
  // cookies are Secure only in a build (src/server/cookies.ts), and `astro dev` adds its own
  // toolbar and scripts to every page. `astro build` without `astro check`: the type check is its
  // own CI step. The mock source answers, so no API, database or Docker is needed
  webServer: {
    command: 'pnpm exec astro build && node dist/server/entry.mjs',
    cwd: '..',
    env: { HOST: '127.0.0.1', PORT: String(PORT) },
    url: `http://127.0.0.1:${String(PORT)}`,
    // Room for the build on a slow CI runner: it takes a few seconds on a laptop
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
