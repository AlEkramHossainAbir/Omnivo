import { spawnSync } from 'node:child_process';

import { APP_DIR, OUT_DIR, VITE_BIN } from './pwa-server.js';

// Step 19a: Playwright's globalSetup for *.pwa.ts, once per run: a production build of the app.
// Its API is an address where nothing answers (port 9, closed on every machine), so every request
// to the API fails at once, like no connection. Never the default localhost:3000: on a machine
// that runs `pnpm dev`, the real API would answer, and the offline tests would sign in for real.
export default function buildForTests(): void {
  const result = spawnSync(process.execPath, [VITE_BIN, 'build', '--outDir', OUT_DIR], {
    cwd: APP_DIR,
    env: { ...process.env, VITE_API_URL: 'http://127.0.0.1:9' },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('The build for the service worker tests failed');
}
