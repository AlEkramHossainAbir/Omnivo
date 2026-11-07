import { describe, expect, it } from 'vitest';

// Step 26a: the shop's import rules. They live here and not in .dependency-cruiser.cjs, because
// dependency-cruiser cannot read .astro files, and the pages are .astro files: a rule there would
// pass while a page broke it. Vite's import.meta.glob reads every source file as text.
const files = import.meta.glob<string>(['./**/*.{ts,astro}', '!./**/*.spec.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// The module names in `import x from '...'`, `import '...'` and `export ... from '...'`
const IMPORT = /^\s*(?:import|export)\s(?:[^'"]*\sfrom\s)?['"]([^'"]+)['"]/gm;

function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

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
});
