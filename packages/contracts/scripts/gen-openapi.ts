import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import SwaggerParser from '@apidevtools/swagger-parser';
import { routes } from '@omnivo/contracts';
import { buildOpenApiDocument } from '@omnivo/contracts/openapi';

// routes রেজিস্ট্রি → openapi.json (commit করা হয়)। PR-এ API-র চুক্তির বদল এই ফাইলের diff-এ
// চোখে পড়ে। --check (CI): ফাইল পুরনো হলে fail, লেখে না
const file = path.resolve(import.meta.dirname, '../openapi.json');
const json = `${JSON.stringify(buildOpenApiDocument(routes, { version: '0.0.0' }), null, 2)}\n`;
const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // ফাইল নেই = পুরনো, নিচে fail
  }
  if (current !== json) {
    console.error('openapi.json is out of date. Run `pnpm gen:openapi` and commit the result.');
    process.exit(1);
  }
} else {
  writeFileSync(file, json);
}

// আমাদের builder ভুল কিছু লিখলে (বাধ্যতামূলক ফিল্ড বাদ, ভুল $ref) এখানেই ধরা পড়ে —
// Swagger UI বা কোনো বাইরের client-generator ব্যবহারের দিনে না
await SwaggerParser.validate(file);
console.log(
  `${path.relative(process.cwd(), file)} is ${check ? 'up to date' : 'written'} and valid.`,
);
