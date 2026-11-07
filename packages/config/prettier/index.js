// Step 26a: imported here, not named as a string, so Prettier finds the plugin in this package's
// node_modules wherever the command runs from (a string is looked up from the working directory)
import * as astroPlugin from 'prettier-plugin-astro';

/** @type {import("prettier").Config} */
export default {
  semi: true,
  singleQuote: true,
  printWidth: 100,
  trailingComma: 'all',
  // The shop's .astro files: without the plugin Prettier cannot parse them, and `pnpm format`
  // skips them without a word
  plugins: [astroPlugin],
  overrides: [{ files: '*.astro', options: { parser: 'astro' } }],
};
