import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

// Step 19a: the service worker's tests (*.pwa.ts) run on a production build, served by
// `vite preview`. The mock app cannot test it: `pnpm dev:mock` never registers the worker.

export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
// Inside node_modules: git, ESLint and Prettier leave it alone, and `pnpm build`'s dist/ (which
// the bundle-size check reads) is never replaced by this build
export const OUT_DIR = join(APP_DIR, 'node_modules/.pwa-e2e');
// Vite's own command, started with this Node: killing it stops the server. A `pnpm exec` in
// between would be killed alone and leave the server running.
export const VITE_BIN = join(
  dirname(createRequire(import.meta.url).resolve('vite/package.json')),
  'bin/vite.js',
);

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

async function until(done: () => Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 80; tries += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The preview server ${what} in 20 seconds`);
}

// One server per test. A test stops it to be offline for real: Playwright's setOffline is the
// page's view, and a worker could still reach a server that runs.
class PreviewServer {
  private process: ChildProcess | null = null;
  private readonly url: string;
  private readonly worker = join(OUT_DIR, 'sw.js');
  private workerBefore: string | null = null;

  constructor(url: string) {
    this.url = url;
  }

  async start(): Promise<void> {
    // A server left from an earlier run would answer in this one's place, and could not be
    // stopped by it: the offline steps would then reach a server that runs
    if (await answers(this.url)) throw new Error(`Something already listens on ${this.url}`);
    const port = new URL(this.url).port;
    const child = spawn(
      process.execPath,
      [VITE_BIN, 'preview', '--outDir', OUT_DIR, '--port', port, '--strictPort'],
      { cwd: APP_DIR, stdio: 'ignore' },
    );
    this.process = child;
    try {
      await until(async () => {
        if (child.exitCode !== null) throw new Error('The preview server ended at its start');
        return answers(this.url);
      }, 'did not start');
    } catch (error) {
      // Never left running: the fixture's teardown does not run when its setup fails
      child.kill('SIGKILL');
      this.process = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    this.process = null;
    await until(async () => !(await answers(this.url)), 'did not stop');
  }

  // A new version of the app on the server: the browser compares sw.js byte by byte, so one
  // more line is a new worker. The fixture puts the file back after the test.
  publishNewWorker(): void {
    this.workerBefore ??= readFileSync(this.worker, 'utf8');
    appendFileSync(this.worker, '\n// the next version\n');
  }

  restoreWorker(): void {
    if (this.workerBefore !== null) writeFileSync(this.worker, this.workerBefore);
    this.workerBefore = null;
  }
}

// The server listens on the config's baseURL, so the tests' page.goto('/login') reaches it
export const test = base.extend<{ server: PreviewServer }>({
  server: [
    // `provide`, not Playwright's usual `use`: the React hooks lint rule reads `use(…)` as a hook
    async ({ baseURL }, provide) => {
      if (!baseURL) throw new Error('playwright.pwa.config.ts sets baseURL');
      const server = new PreviewServer(baseURL);
      await server.start();
      try {
        await provide(server);
      } finally {
        server.restoreWorker();
        await server.stop();
      }
    },
    // Its own time, apart from the test's 30 seconds: on a busy machine Vite can take a while
    // to start, and a start cut off by the test's timeout would leave the server running
    { timeout: 60_000 },
  ],
});
