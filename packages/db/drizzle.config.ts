import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
config({ path: path.join(repoRoot, '.env'), quiet: true });

// drizzle-kit নিজের loader দিয়ে এই ফাইল পড়ে, তাই src/env.ts import না করে এখানেই চেক
const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) {
  throw new Error('Missing env var MIGRATOR_DATABASE_URL — copy .env.example to .env');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
});
