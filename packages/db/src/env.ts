import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// pnpm --filter চালালে cwd হয় packages/db, তাই root .env-এর পাথ ফাইলের লোকেশন থেকে বের করা
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function loadRootEnv(): void {
  config({ path: path.join(repoRoot, '.env'), quiet: true });
}

// `process.env.X!`-এর বদলে: মান না থাকলে চুপচাপ undefined না দিয়ে স্পষ্ট error
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var ${name} — copy .env.example to .env at the repo root`);
  }
  return value;
}
