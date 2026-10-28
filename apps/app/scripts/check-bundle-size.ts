import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { z } from 'zod';

// system-design §৬.১: প্রথম লোডের JS < 200 KB gz, প্রতিটা lazy chunk < 100 KB gz. Step 17c: the
// first load is 210 KB for now. All the English words load with it (about 48 KB gz), and every
// step adds its own, so 17c's words alone took it to 200.7 KB. Loading each module's words with
// its pages is the real fix, a step of its own; until then the budget still stops anything else
// from growing the first load unnoticed. Step 19a: 215 KB (you chose this). 19a's words and the
// offline sign-in took it to 211.6 KB; from now on the service worker keeps these files, so only
// the very first visit downloads them. Step 20a: 220 KB (you chose this). 20a's words (the
// registers, the POS screen, its sales and the sold-short list) took it to 217.9 KB.
const INITIAL_BUDGET = 220 * 1024;
// Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
// table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
// that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
// pages is the real fix, a step of its own, like the words above. Step 18b: 110 KB (you chose this).
// The customer box and the pickers now read the device's customers with the outbox on top, and the
// line editors and the shell were already at 104–105 KB. Step 20a: 115 KB (you chose this). The
// script counts a lazy chunk together with the chunk it loads from, so the POS screen with its
// payment dialog is one number: 112.3 KB.
const CHUNK_BUDGET = 115 * 1024;
// Step 19a: everything the service worker downloads the first time, gz (the fonts do not shrink).
// 1.3 MB at 19a. It is downloaded once per device; a new version downloads only the files that
// changed.
const PRECACHE_BUDGET = 2 * 1024 * 1024;

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

// Step 19a: the files the service worker keeps (sw/sw.ts). The build writes their list into sw.js
// as JSON ({"revision":…,"url":"assets/…"}). Workbox leaves a file out with only a warning in the
// build log: one over 2 MiB, or a kind the glob in vite.config.ts does not name (a .webp someone
// imports later). That screen would then fail offline, so every built asset must be in the list.
const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
const precached = new Set([...sw.matchAll(/"url":"([^"]+)"/g)].flatMap((match) => match[1] ?? []));
// *.woff is left out on purpose (vite.config.ts): every browser we support loads the woff2
const missing = readdirSync(path.join(dist, 'assets'))
  .map((file) => `assets/${file}`)
  .filter((file) => !file.endsWith('.woff') && !precached.has(file));
for (const file of missing) console.error(`not precached  ${file}`);
if (missing.length > 0 || !precached.has('index.html')) failed = true;

const precacheBytes = [...precached].reduce((sum, file) => sum + gzipBytes(file), 0);
console.log(
  `precache    ${String(precached.size)} files  ${kb(precacheBytes)} gz  (budget ${kb(PRECACHE_BUDGET)})`,
);
if (precacheBytes > PRECACHE_BUDGET) failed = true;

if (failed) {
  console.error(
    'Bundle budget exceeded or a file not precached — lazy-load the heavy part, remove a dependency, or add the file kind to globPatterns in vite.config.ts.',
  );
  process.exit(1);
}
