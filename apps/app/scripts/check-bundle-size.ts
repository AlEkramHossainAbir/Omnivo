import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { z } from 'zod';

// system-design §৬.১: প্রথম লোডের JS < 200 KB gz, প্রতিটা lazy chunk < 100 KB gz
const INITIAL_BUDGET = 200 * 1024;
const CHUNK_BUDGET = 100 * 1024;

const dist = path.resolve(import.meta.dirname, '../dist');

// JSON.parse ফেরত দেয় any — Zod দিয়ে আকার যাচাই করে টাইপ পাওয়া (rule ৩)
const manifestSchema = z.record(
  z.string(),
  z.object({
    file: z.string(),
    isEntry: z.boolean().optional(),
    isDynamicEntry: z.boolean().optional(),
    imports: z.array(z.string()).optional(),
  }),
);

const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8')),
);

function gzipBytes(file: string): number {
  return gzipSync(readFileSync(path.join(dist, file))).length;
}

// "প্রথম লোড" = entry আর যা কিছু সে static import করে (import(), মানে lazy, বাদ)।
// শুধু index-*.js ফাইল মাপলে ভুল হতো: Vite শেয়ার করা কোড আলাদা chunk-এ ভাগ করে
function collect(key: string, seen: Set<string>): void {
  if (seen.has(key)) return;
  seen.add(key);
  for (const child of manifest[key]?.imports ?? []) collect(child, seen);
}

const initial = new Set<string>();
for (const [key, chunk] of Object.entries(manifest)) {
  if (chunk.isEntry) collect(key, initial);
}

const sumBytes = (keys: Iterable<string>) =>
  [...keys].reduce((sum, key) => sum + gzipBytes(manifest[key]?.file ?? ''), 0);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
let failed = false;

const initialBytes = sumBytes(initial);
console.log(`initial JS  ${kb(initialBytes)} gz  (budget ${kb(INITIAL_BUDGET)})`);
if (initialBytes > INITIAL_BUDGET) failed = true;

// একটা রুটে ঢুকলে যা নতুন নামে: তার chunk + সে যেসব শেয়ার করা chunk টানে, যা প্রথম লোডে
// আসেনি। শুধু রুটের নিজের ফাইল মাপলে DataTable-এর মতো শেয়ার করা chunk হিসাবের বাইরে থেকে যেত
for (const [key, chunk] of Object.entries(manifest)) {
  if (!chunk.isDynamicEntry) continue;
  const route = new Set<string>();
  collect(key, route);
  const bytes = sumBytes([...route].filter((child) => !initial.has(child)));
  console.log(`lazy ${key}  ${kb(bytes)} gz  (budget ${kb(CHUNK_BUDGET)})`);
  if (bytes > CHUNK_BUDGET) failed = true;
}

if (failed) {
  console.error('Bundle budget exceeded — lazy-load the heavy part or remove a dependency.');
  process.exit(1);
}
