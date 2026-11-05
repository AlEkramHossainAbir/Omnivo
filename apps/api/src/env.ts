import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// pnpm --filter চালালে cwd হয় apps/api, তাই root .env-এর পাথ ফাইলের লোকেশন থেকে বের করা
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: path.join(repoRoot, '.env'), quiet: true });
