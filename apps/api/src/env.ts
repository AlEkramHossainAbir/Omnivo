import path from 'node:path';
import { config } from 'dotenv';

const repoRoot = path.resolve(__dirname, '../../..');
config({ path: path.join(repoRoot, '.env') });