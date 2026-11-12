import { describe, expect, it } from 'vitest';

// Step 26a: the shop's import rules. They live here and not in .dependency-cruiser.cjs, because
// dependency-cruiser cannot read .astro files, and the pages are .astro files: a rule there would
// pass while a page broke it. Vite's import.meta.glob reads every source file as text.
// Step 26c: .tsx too, for the checkout's React island
const files = import.meta.glob<string>(['./**/*.{ts,tsx,astro}', '!./**/*.spec.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// The module names in `import x from '...'`, `import '...'` and `export ... from '...'`
const IMPORT = /^\s*(?:import|export)\s(?:[^'"]*\sfrom\s)?['"]([^'"]+)['"]/gm;

function importsOf(source: string, pattern = IMPORT): string[] {
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

// Step 26b: the imports that stay in the built JavaScript. `import type { X } from '...'` is
// removed by the compiler; `import { type X } from '...'` is not (an empty import still runs the
// module), so it counts
const VALUE_IMPORT = /^\s*import\s(?!type\s)(?:[^'"]*\sfrom\s)?['"]([^'"]+)['"]/gm;
const SCRIPT = /<script>([\s\S]*?)<\/script>/g;

describe('shop imports', () => {
  it('reads the source files', () => {
    // A broken glob would find nothing and pass every rule below
    expect(Object.keys(files).length).toBeGreaterThan(10);
  });

  it('reaches the mock only through data/source.ts', () => {
    // A page that imports the mock would stay on fake data when source.ts switches to the API
    const offenders = Object.entries(files)
      .filter(([path]) => !path.startsWith('./data/'))
      .filter(([, source]) => importsOf(source).some((name) => name.includes('/mock/')))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('never imports the ERP app or the API', () => {
    // The shop is a public site: their code would bring signed-in screens and server code into it
    const offenders = Object.entries(files)
      .filter(([, source]) =>
        importsOf(source).some((name) => /(^@omnivo\/(app|api)\b)|\/apps\/(app|api)\//.test(name)),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('reaches src/server only from the API routes, and the cookies from the pages', () => {
    // Step 26b: server/ is request handling (Response objects, the contracts, Zod). A component
    // that imported it could pull it into a <script> and ship Zod to every shopper's browser.
    // Step 26c: a page's frontmatter runs only on the server, and /checkout/verify and
    // /order/<no> read the order cookies. They may import server/cookies.ts, which imports
    // nothing, and only that
    const offenders = Object.entries(files)
      .filter(([path]) => !path.startsWith('./pages/api/') && !path.startsWith('./server/'))
      .filter(([path, source]) =>
        importsOf(source).some(
          (name) =>
            /(^|\/)server\//.test(name) &&
            !(path.startsWith('./pages/') && name.endsWith('/server/cookies')),
        ),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('keeps Zod, React and the translations out of the browser scripts', () => {
    // Step 26b: what runs in the shopper's browser is every <script> in a component and the lib
    // files those scripts import. The contracts bring Zod (25 KB gz), and '@omnivo/i18n' starts
    // i18next with its English words (about 150 KB gz); '@omnivo/i18n/format' is the small part
    // that formats numbers. Their types are free: `import type` leaves nothing behind
    const scripts = Object.entries(files)
      .filter(([path]) => path.endsWith('.astro'))
      .flatMap(([path, source]) =>
        [...source.matchAll(SCRIPT)].map((match) => ({ path, source: match[1] ?? '' })),
      );
    // '../lib/cart' in a component is ./lib/cart.ts here; then the lib files that one imports
    // ('./money'). One level is all the shop has
    const libs = new Set(
      scripts
        .flatMap(({ source }) => importsOf(source, VALUE_IMPORT))
        .flatMap((name) => /\/lib\/([\w-]+)$/.exec(name)?.[1] ?? [])
        .map((name) => `./lib/${name}.ts`),
    );
    for (const lib of [...libs]) {
      for (const name of importsOf(files[lib] ?? '', VALUE_IMPORT)) {
        const sibling = /^\.\/([\w-]+)$/.exec(name)?.[1];
        if (sibling) libs.add(`./lib/${sibling}.ts`);
      }
    }
    // A broken pattern would find nothing to check; cart, quote and money at least
    expect(libs.size).toBeGreaterThanOrEqual(3);

    const heavy = /^(zod|react|react-dom|@omnivo\/contracts|@omnivo\/i18n)$/;
    const offenders = [
      ...scripts,
      ...[...libs].map((path) => ({ path, source: files[path] ?? '' })),
    ]
      .filter(({ source }) => importsOf(source, VALUE_IMPORT).some((name) => heavy.test(name)))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  // Step 26c (decision 1): React, Zod and the form library reach the browser only in an island,
  // and only /checkout loads one. The rest of the shop stays plain HTML with small scripts
  const browserHeavy = /^(react|react-dom|zod|react-hook-form|@hookform\/resolvers(\/.*)?)$/;

  it('imports React, Zod and react-hook-form only in src/islands', () => {
    // '@hugeicons/react' is not on the list: an Astro component draws its icons on the server,
    // and nothing of it reaches the browser
    const offenders = Object.entries(files)
      .filter(([path]) => !path.startsWith('./islands/'))
      .filter(([, source]) =>
        importsOf(source, VALUE_IMPORT).some((name) => browserHeavy.test(name)),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('keeps the translations out of the islands', () => {
    // The page translates the words and passes them as props. `import type` is free; a value
    // import of '@omnivo/i18n' (or lib/locale.ts, which starts it) would put i18next and every
    // English word into the checkout's chunk
    const islands = Object.entries(files).filter(([path]) => path.startsWith('./islands/'));
    expect(islands.length).toBeGreaterThan(0);
    const offenders = islands
      .filter(([, source]) =>
        importsOf(source, VALUE_IMPORT).some(
          (name) => name === '@omnivo/i18n' || name.endsWith('/lib/locale'),
        ),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('hydrates islands only on the checkout pages', () => {
    // client:load and the other client:* directives are what send an island's JavaScript to the
    // browser. A product card with one would load React on every page of the shop
    const offenders = Object.entries(files)
      .filter(([path]) => path.endsWith('.astro') && !path.startsWith('./pages/checkout'))
      .filter(([, source]) => /\sclient:(load|idle|visible|media|only)\b/.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
